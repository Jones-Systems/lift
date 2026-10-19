import ExpoModulesCore
import Foundation
import HealthKit

private struct HealthQueryInput: Decodable {
  let type: String
  let from: String
  let to: String
  let anchor: String?
  let limit: Int
}

private struct HealthPageUnit {
  let record: HealthRecord?
  let tombstones: [HealthTombstone]
  var size: Int { (record?.values.count ?? 0) + tombstones.count }
}

private final class HealthQueryRun {
  let id = UUID()
  let epoch: UInt64
  let context: HealthQueryContext
  let promise: Promise
  let input: HealthQueryInput
  let baseline: HealthJournal
  var members: [String: HealthMember]
  var buckets: [String: HealthBucket]
  var ledger: [String: HealthBucketLedger]
  var anchor: HKQueryAnchor?
  var dirty = Set<String>()
  var deleted = Set<String>()
  var scanned = 0
  var rounds = 0
  var units: [HealthPageUnit] = []
  var revision: Int64
  var activeQuery: HKQuery?
  var deadline: DispatchWorkItem?
  var expectedByBucket: [String: Set<String>] = [:]

  init(epoch: UInt64, context: HealthQueryContext, promise: Promise, input: HealthQueryInput,
       baseline: HealthJournal, stream: HealthStreamJournal) throws {
    self.epoch = epoch; self.context = context; self.promise = promise; self.input = input; self.baseline = baseline
    members = stream.members; buckets = stream.buckets; ledger = baseline.ledger; revision = baseline.revision
    if let data = stream.anchor {
      guard data.count <= 64 * 1024, let decoded = try NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data) else {
        throw healthFailure("health_anchor_invalid")
      }
      anchor = decoded
    }
  }
}

// Main-queue ownership matches FormHealthModule. No observer/update handler is registered.
final class HealthQueryEngine: @unchecked Sendable {
  private let healthStore: () -> HKHealthStore
  private var binding: (context: HealthQueryContext, journalId: String)?
  private var run: HealthQueryRun?
  private var epoch: UInt64 = 0

  init(healthStore: @escaping () -> HKHealthStore) { self.healthStore = healthStore }

  var isQueryInFlight: Bool { run != nil }

  func cancel(_ code: String) {
    epoch &+= 1
    let previous = run
    run = nil
    binding = nil
    previous?.deadline?.cancel()
    let query = previous?.activeQuery
    previous?.activeQuery = nil
    if let query { healthStore().stop(query) }
    previous?.promise.reject(healthFailure(code))
  }

  func bind(context raw: [String: Any], checkpoint rawCheckpoint: [String: Any], mode: String) throws -> [String: Any] {
    cancel("health_context_changed")
    let context = try decodeContext(raw)
    let checkpoint = try decodeCheckpoint(rawCheckpoint, context: context)
    let store = try HealthQueryJournalStore()
    var journal: HealthJournal
    if mode == "create_connection" {
      guard checkpoint.cursor == nil else { throw healthFailure("health_checkpoint_mismatch") }
      journal = try store.create(context.namespace)
    } else {
      guard mode == "resume" || mode == "create_stream" else { throw healthFailure("health_invalid_context") }
      journal = try store.load(context.namespace)
    }
    if let existing = journal.streams[context.contextId] {
      guard mode == "resume", existing.context.matches(context) else { throw healthFailure("health_context_mismatch") }
    } else {
      guard mode != "resume", checkpoint.cursor == nil, journal.streams.count < HealthQueryLimits.streams,
        journal.streams.values.allSatisfy({ $0.prepared == nil }) else { throw healthFailure("health_reconciliation_required") }
      // A stream cannot change its normalization or timezone by opening a new local context.
      guard !journal.streams.values.contains(where: {
        $0.context.stream == context.stream && !$0.context.matches(context)
      }) else { throw healthFailure("health_context_mismatch") }
      journal.streams[context.contextId] = HealthStreamJournal(context: context, cursor: nil, anchor: nil, members: [:], buckets: [:], prepared: nil)
      journal = try store.save(journal, expectedSerial: journal.serial)
    }
    journal = try reconcile(journal, context: context, checkpoint: checkpoint, store: store)
    binding = (context, journal.journalId)
    return receipt(journal, context: context)
  }

  func reconcile(contextId: String, checkpoint raw: [String: Any]) throws -> [String: Any] {
    guard run == nil, let binding, binding.context.contextId == contextId else { throw healthFailure("health_context_unbound") }
    let store = try HealthQueryJournalStore()
    let current = try store.load(binding.context.namespace)
    guard current.journalId == binding.journalId else { throw healthFailure("health_context_mismatch") }
    let checkpoint = try decodeCheckpoint(raw, context: binding.context)
    let next = try reconcile(current, context: binding.context, checkpoint: checkpoint, store: store)
    return receipt(next, context: binding.context)
  }

  private func reconcile(_ journal: HealthJournal, context: HealthQueryContext, checkpoint: HealthServerCheckpoint,
                         store: HealthQueryJournalStore) throws -> HealthJournal {
    var next = journal
    guard var stream = next.streams[context.contextId], stream.context.matches(context) else { throw healthFailure("health_context_mismatch") }
    if checkpoint.cursor == stream.cursor { return journal }
    guard var prepared = stream.prepared else { throw healthFailure("health_checkpoint_mismatch") }
    let index = prepared.acknowledgedThrough + 1
    guard index >= 0, index < prepared.pages.count, index <= prepared.issuedThrough,
      prepared.pages[index].output.anchor == checkpoint.cursor,
      prepared.pages[index].inputCursor == stream.cursor else { throw healthFailure("health_checkpoint_mismatch") }
    prepared.acknowledgedThrough = index
    stream.cursor = checkpoint.cursor
    if index == prepared.pages.count - 1 {
      stream.anchor = prepared.anchor
      stream.members = prepared.members
      stream.buckets = prepared.buckets
      next.ledger = prepared.ledger
      stream.prepared = nil
    } else { stream.prepared = prepared }
    next.streams[context.contextId] = stream
    return try store.save(next, expectedSerial: journal.serial)
  }

  func forget(context raw: [String: Any], journalId: String, expectedSerial: Int64, receipt: String) throws {
    let context = try decodeContext(raw)
    if let binding, binding.context.namespace != context.namespace { throw healthFailure("health_purge_mismatch") }
    cancel("health_context_forgotten")
    try HealthQueryJournalStore().forget(namespace: context.namespace, journalId: journalId, expectedSerial: expectedSerial, receipt: receipt)
  }

  func query(_ raw: [String: Any], promise: Promise) {
    var started: HealthQueryRun?
    do {
      guard run == nil else { throw healthFailure("health_busy") }
      guard let binding else { throw healthFailure("health_context_unbound") }
      let input = try healthDecode(raw, keys: ["type", "from", "to", "anchor", "limit"], as: HealthQueryInput.self)
      let context = binding.context
      guard input.type == context.type, input.from == context.from, input.to == context.to,
        input.limit >= 1, input.limit <= 100 else { throw healthFailure("health_query_mismatch") }
      let store = try HealthQueryJournalStore()
      var journal = try store.load(context.namespace)
      guard journal.journalId == binding.journalId, var stream = journal.streams[context.contextId],
        stream.context.matches(context), stream.cursor == input.anchor else { throw healthFailure("health_checkpoint_mismatch") }
      guard !journal.streams.contains(where: { $0.key != context.contextId && $0.value.prepared != nil }) else {
        throw healthFailure("health_pending_other_context")
      }
      if var prepared = stream.prepared {
        let index = prepared.acknowledgedThrough + 1
        guard prepared.limit == input.limit, index >= 0, index < prepared.pages.count,
          prepared.pages[index].inputCursor == input.anchor else { throw healthFailure("health_replay_mismatch") }
        if prepared.issuedThrough < index {
          prepared.issuedThrough = index
          stream.prepared = prepared
          journal.streams[context.contextId] = stream
          _ = try store.save(journal, expectedSerial: journal.serial)
        }
        promise.resolve(try healthObject(prepared.pages[index].output))
        return
      }
      let operation = try HealthQueryRun(epoch: epoch, context: context, promise: promise, input: input, baseline: journal, stream: stream)
      started = operation
      run = operation
      let deadline = DispatchWorkItem { [weak self, weak operation] in
        guard let self, let operation else { return }
        self.finish(operation, error: healthFailure("health_query_timeout"))
      }
      operation.deadline = deadline
      DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: deadline)
      try scan(operation)
    } catch {
      if let operation = started { finish(operation, error: error) }
      else { promise.reject(error) }
    }
  }

  private func current(_ operation: HealthQueryRun) -> Bool {
    run?.id == operation.id && epoch == operation.epoch && binding?.context == operation.context
  }

  private func finish(_ operation: HealthQueryRun, error: Error) {
    guard current(operation) else { return }
    let query = operation.activeQuery
    operation.activeQuery = nil
    if let query { healthStore().stop(query) }
    operation.deadline?.cancel()
    run = nil
    operation.promise.reject(error)
  }

  private func predicate(_ context: HealthQueryContext) throws -> NSPredicate {
    HKQuery.predicateForSamples(withStart: try healthDate(context.from), end: try healthDate(context.to),
      options: context.type == "sleep" ? [] : .strictStartDate)
  }

  private func scan(_ operation: HealthQueryRun) throws {
    guard current(operation) else { return }
    guard operation.rounds < 201 else { throw healthFailure("health_scan_capacity") }
    operation.rounds += 1
    let query = HKAnchoredObjectQuery(type: try HealthBucketBuilder.sampleType(operation.context.type),
      predicate: try predicate(operation.context), anchor: operation.anchor, limit: 256) { [weak self] _, samples, deletions, anchor, error in
      DispatchQueue.main.async {
        guard let self, self.current(operation) else { return }
        operation.activeQuery = nil
        do {
          guard error == nil, let samples, let deletions, let anchor else { throw healthFailure("health_read_failed") }
          guard samples.count + deletions.count <= HealthQueryLimits.members - operation.scanned else { throw healthFailure("health_scan_capacity") }
          operation.scanned += samples.count + deletions.count
          for deleted in deletions {
            let id = deleted.uuid.uuidString.lowercased()
            guard let previous = operation.members.removeValue(forKey: id) else { throw healthFailure("health_unknown_deletion") }
            operation.deleted.insert(id)
            operation.dirty.formUnion(previous.buckets)
          }
          for sample in samples {
            let id = sample.uuid.uuidString.lowercased()
            guard !operation.deleted.contains(id) else { throw healthFailure("health_sample_conflict") }
            let buckets = try HealthBucketBuilder.buckets(sample, context: operation.context)
            let member = HealthMember(buckets: buckets.map(\.key), metrics: try HealthBucketBuilder.metrics(sample, type: operation.context.type))
            if let previous = operation.members[id] { operation.dirty.formUnion(previous.buckets) }
            operation.members[id] = member
            for bucket in buckets {
              operation.buckets[bucket.key] = bucket; operation.dirty.insert(bucket.key)
              guard operation.buckets.count <= HealthQueryLimits.bucketSamples else { throw healthFailure("health_bucket_capacity") }
            }
          }
          let otherMembers = operation.baseline.streams.filter { $0.key != operation.context.contextId }.values.reduce(0) { $0 + $1.members.count }
          guard operation.members.count + otherMembers <= HealthQueryLimits.members else { throw healthFailure("health_member_capacity") }
          operation.anchor = anchor
          if !samples.isEmpty || !deletions.isEmpty { try self.scan(operation) }
          else {
            for (id, member) in operation.members {
              for bucket in member.buckets { operation.expectedByBucket[bucket, default: []].insert(id) }
            }
            try self.recompute(operation, keys: operation.dirty.sorted(), index: 0)
          }
        } catch { self.finish(operation, error: error) }
      }
    }
    operation.activeQuery = query
    healthStore().execute(query)
  }

  private func recompute(_ operation: HealthQueryRun, keys: [String], index: Int) throws {
    guard current(operation) else { return }
    guard index < keys.count else { try verifyStable(operation); return }
    guard keys.count <= HealthQueryLimits.bucketSamples, let bucket = operation.buckets[keys[index]] else {
      throw healthFailure("health_bucket_capacity")
    }
    let expected = operation.expectedByBucket[bucket.key] ?? []
    let filter: NSPredicate
    if let id = bucket.workoutId, let uuid = UUID(uuidString: id) {
      filter = HKQuery.predicateForObject(with: uuid)
    } else {
      filter = HKQuery.predicateForSamples(withStart: try healthDate(bucket.start), end: try healthDate(bucket.end),
        options: bucket.type == "sleep" ? [] : .strictStartDate)
    }
    let query = HKSampleQuery(sampleType: try HealthBucketBuilder.sampleType(bucket.type), predicate: filter,
      limit: HealthQueryLimits.bucketSamples + 1, sortDescriptors: nil) { [weak self] _, results, error in
      DispatchQueue.main.async {
        guard let self, self.current(operation) else { return }
        operation.activeQuery = nil
        do {
          guard error == nil, let results else { throw healthFailure("health_read_failed") }
          guard results.count <= HealthQueryLimits.bucketSamples else { throw healthFailure("health_bucket_capacity") }
          let samples = try results.filter {
            try HealthBucketBuilder.buckets($0, context: operation.context).contains(where: { $0.key == bucket.key })
          }
          let seen = Set(samples.map { $0.uuid.uuidString.lowercased() })
          guard seen == expected, seen.count == samples.count else { throw healthFailure("health_missing_survivors") }
          let values = try HealthBucketBuilder.values(samples, bucket: bucket)
          var contributors: [String: [String]] = [:]
          for sample in samples {
            let id = sample.uuid.uuidString.lowercased()
            let metrics = try HealthBucketBuilder.metrics(sample, type: bucket.type)
            guard operation.members[id]?.metrics == metrics else { throw healthFailure("health_sample_conflict") }
            for metric in metrics { contributors[metric, default: []].append(id) }
          }
          try self.appendUnit(operation, bucket: bucket, values: values, contributors: contributors)
          try self.recompute(operation, keys: keys, index: index + 1)
        } catch { self.finish(operation, error: error) }
      }
    }
    operation.activeQuery = query
    healthStore().execute(query)
  }

  private func appendUnit(_ operation: HealthQueryRun, bucket: HealthBucket, values: [HealthValue],
                          contributors: [String: [String]]) throws {
    let previous = operation.ledger[bucket.key]
    // Loss of access is indistinguishable from missing data. Only explicit deletion
    // of every absent known contributor can justify retiring a published metric.
    if let previous, !previous.retired {
      let survivors = Set(contributors.values.flatMap { $0 })
      for id in Set(previous.contributors.values.flatMap { $0 }).subtracting(survivors) {
        guard operation.deleted.contains(id) else { throw healthFailure("health_missing_survivors") }
      }
    }
    let metrics = values.map(\.metric)
    if values.isEmpty && (previous == nil || previous?.retired == true) { return }
    guard operation.revision < HealthQueryLimits.revision else { throw healthFailure("health_revision_exhausted") }
    operation.revision += 1
    let revision = HealthRevision(token: "hk1:" + operation.baseline.journalId + ":" + String(operation.revision), order: operation.revision)
    let removed = Set(previous?.metrics ?? []).subtracting(metrics)
    let retire = previous != nil && previous?.retired == false && !removed.isEmpty
    var tombstones: [HealthTombstone] = []
    if retire, let previous {
      let old = "hk1:" + bucket.key + ":" + previous.incarnation
      tombstones = previous.metrics.sorted().map { HealthTombstone(id: old + ":" + $0, revision: revision) }
    }
    let incarnation = previous == nil || previous?.retired == true || retire ? UUID().uuidString.lowercased() : previous!.incarnation
    let record: HealthRecord? = values.isEmpty ? nil : HealthRecord(id: "hk1:" + bucket.key + ":" + incarnation,
      kind: bucket.type == "workouts" ? "workout" : "daily", type: bucket.type, day: bucket.day, zone: operation.context.timeZone,
      start: bucket.start, end: bucket.end, sourceBundleId: bucket.sourceBundleId, sourceName: bucket.sourceName,
      deviceModel: bucket.deviceModel, algorithm: nil, originalId: bucket.workoutId, revision: revision,
      quality: "unknown", values: values)
    operation.ledger[bucket.key] = HealthBucketLedger(incarnation: incarnation, metrics: metrics,
      contributors: contributors.mapValues { $0.sorted() }, retired: values.isEmpty)
    guard operation.ledger.count <= HealthQueryLimits.bucketSamples else { throw healthFailure("health_bucket_capacity") }
    operation.units.append(HealthPageUnit(record: record, tombstones: tombstones))
  }

  private func verifyStable(_ operation: HealthQueryRun) throws {
    guard current(operation) else { return }
    let query = HKAnchoredObjectQuery(type: try HealthBucketBuilder.sampleType(operation.context.type),
      predicate: try predicate(operation.context), anchor: operation.anchor, limit: 1) { [weak self] _, samples, deletions, anchor, error in
      DispatchQueue.main.async {
        guard let self, self.current(operation) else { return }
        operation.activeQuery = nil
        do {
          guard error == nil, let samples, let deletions, let anchor else { throw healthFailure("health_read_failed") }
          guard samples.isEmpty, deletions.isEmpty else { throw healthFailure("health_store_changed") }
          operation.anchor = anchor
          try self.persist(operation)
        } catch { self.finish(operation, error: error) }
      }
    }
    operation.activeQuery = query
    healthStore().execute(query)
  }

  private func persist(_ operation: HealthQueryRun) throws {
    guard current(operation), let anchor = operation.anchor else { throw healthFailure("health_cancelled") }
    var groups: [[HealthPageUnit]] = []
    var group: [HealthPageUnit] = []
    var records = 0, size = 0
    for unit in operation.units {
      let recordCount = unit.record == nil ? 0 : 1
      if !group.isEmpty && (records + recordCount > operation.input.limit || size + unit.size > 500) {
        groups.append(group); group = []; records = 0; size = 0
      }
      group.append(unit); records += recordCount; size += unit.size
    }
    if !group.isEmpty || groups.isEmpty { groups.append(group) }
    guard groups.count <= HealthQueryLimits.pages else { throw healthFailure("health_page_capacity") }
    var cursor = operation.input.anchor
    var pages: [HealthPreparedPage] = []
    for (index, units) in groups.enumerated() {
      let next = "hk1:" + operation.baseline.journalId + ":" + UUID().uuidString.lowercased()
      let page = HealthPage(records: units.compactMap(\.record), tombstones: units.flatMap(\.tombstones),
        anchor: next, more: index < groups.count - 1, logicalBucketsComplete: true)
      pages.append(HealthPreparedPage(inputCursor: cursor, output: page))
      cursor = next
    }
    let anchorData = try NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
    guard anchorData.count <= 64 * 1024 else { throw healthFailure("health_anchor_invalid") }
    var journal = operation.baseline
    journal.revision = operation.revision
    guard var stream = journal.streams[operation.context.contextId] else { throw healthFailure("health_context_mismatch") }
    stream.prepared = HealthPreparedBatch(limit: operation.input.limit, issuedThrough: 0, acknowledgedThrough: -1,
      pages: pages, anchor: anchorData, members: operation.members, buckets: operation.buckets, ledger: operation.ledger)
    journal.streams[operation.context.contextId] = stream
    _ = try HealthQueryJournalStore().save(journal, expectedSerial: journal.serial)
    guard current(operation) else { throw healthFailure("health_cancelled") }
    let result = try healthObject(pages[0].output)
    operation.deadline?.cancel()
    run = nil
    operation.promise.resolve(result)
  }

  private func decodeContext(_ input: [String: Any]) throws -> HealthQueryContext {
    let context = try healthDecode(input, keys: ["accountId", "sessionGeneration", "connectionId", "generation", "deviceGeneration",
      "type", "from", "to", "timeZone", "normalizationVersion"], as: HealthQueryContext.self)
    try context.validate()
    return context
  }

  private func decodeCheckpoint(_ input: [String: Any], context: HealthQueryContext) throws -> HealthServerCheckpoint {
    let checkpoint = try healthDecode(input, keys: ["stream", "cursor"], as: HealthServerCheckpoint.self)
    guard checkpoint.stream == context.stream, checkpoint.cursor == nil || (checkpoint.cursor!.utf8.count <= 200 && !checkpoint.cursor!.isEmpty) else {
      throw healthFailure("health_checkpoint_mismatch")
    }
    return checkpoint
  }

  private func receipt(_ journal: HealthJournal, context: HealthQueryContext) -> [String: Any] {
    ["version": 1, "context": try! healthObject(context), "contextId": context.contextId, "journalId": journal.journalId,
     "journalSerial": journal.serial, "revisionOrder": journal.revision, "stream": context.stream,
     "cursor": journal.streams[context.contextId]!.cursor.map { $0 as Any } ?? NSNull()]
  }
}
