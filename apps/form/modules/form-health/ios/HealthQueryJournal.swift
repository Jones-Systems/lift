import CryptoKit
import Darwin
import ExpoModulesCore
import Foundation

enum HealthQueryLimits {
  static let members = 50_000
  static let bucketSamples = 10_000
  static let fileBytes = 16 * 1024 * 1024
  static let pages = 100
  static let streams = 7
  static let activeNamespaces = 8
  static let namespaceMarkers = 64
  static let revision: Int64 = 9_007_199_254_740_991
}

func healthFailure(_ code: String) -> Exception {
  Exception(name: code, description: "HealthKit source operation requires a valid current checkpoint and complete accessible buckets.", code: code)
}

func healthDigest(_ fields: [String]) -> String {
  let data = try! JSONEncoder().encode(fields)
  return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func healthDecode<T: Decodable>(_ input: [String: Any], keys: Set<String>, as: T.Type) throws -> T {
  guard Set(input.keys) == keys, JSONSerialization.isValidJSONObject(input) else { throw healthFailure("health_invalid_context") }
  do { return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: input)) }
  catch { throw healthFailure("health_invalid_context") }
}

func healthObject<T: Encodable>(_ value: T) throws -> [String: Any] {
  guard let result = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] else {
    throw healthFailure("health_invalid_response")
  }
  return result
}

func healthDate(_ text: String) throws -> Date {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = formatter.date(from: text) { return date }
  formatter.formatOptions = [.withInternetDateTime]
  guard let date = formatter.date(from: text) else { throw healthFailure("health_invalid_window") }
  return date
}

func healthISO(_ date: Date) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: date)
}

struct HealthQueryContext: Codable, Equatable {
  let accountId: String
  let sessionGeneration: String
  let connectionId: String
  let generation: Int
  let deviceGeneration: String
  let type: String
  let from: String
  let to: String
  let timeZone: String
  let normalizationVersion: Int

  var namespace: String { healthDigest([accountId, connectionId, String(generation), deviceGeneration]) }
  var contextId: String { healthDigest([namespace, type, from, to, timeZone, String(normalizationVersion)]) }
  var stream: String {
    String(data: try! JSONEncoder().encode(["healthkit-v1", type, from, to]), encoding: .utf8)!
  }
  var calendar: Calendar {
    var result = Calendar(identifier: .gregorian)
    result.timeZone = TimeZone(identifier: timeZone)!
    return result
  }
  func validate() throws {
    let identifiers = [accountId, sessionGeneration, connectionId, deviceGeneration]
    guard identifiers.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 200 && !$0.unicodeScalars.contains(where: { $0.value < 32 }) }),
      generation >= 0, generation <= Int(HealthQueryLimits.revision), normalizationVersion == 1,
      ["workouts", "steps", "activeEnergy", "restingHeartRate", "hrvSdnn", "sleep", "bodyMass"].contains(type),
      TimeZone(identifier: timeZone) != nil else { throw healthFailure("health_invalid_context") }
    let start = try healthDate(from), end = try healthDate(to)
    let days = calendar.dateComponents([.day], from: start, to: end).day ?? 0
    guard start < end, calendar.startOfDay(for: start) == start, calendar.startOfDay(for: end) == end,
      days > 0, days <= 31 else { throw healthFailure("health_invalid_window") }
  }
  func matches(_ other: HealthQueryContext) -> Bool {
    namespace == other.namespace && type == other.type && from == other.from && to == other.to
      && timeZone == other.timeZone && normalizationVersion == other.normalizationVersion
  }
}

struct HealthServerCheckpoint: Codable {
  let stream: String
  let cursor: String?
}

struct HealthRevision: Codable {
  let token: String
  let order: Int64
}

struct HealthValue: Codable {
  let metric: String
  let value: Double
  let unit: String
  let aggregation: String
}

struct HealthRecord: Codable {
  let id: String
  let kind: String
  let type: String
  let day: String
  let zone: String?
  let start: String
  let end: String
  let sourceBundleId: String
  let sourceName: String
  let deviceModel: String?
  let algorithm: String?
  let originalId: String?
  let revision: HealthRevision
  let quality: String
  let values: [HealthValue]

  // The frozen JS record shape requires explicit nulls rather than omitted optionals.
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(id, forKey: .id); try values.encode(kind, forKey: .kind); try values.encode(type, forKey: .type)
    try values.encode(day, forKey: .day); try values.encode(zone, forKey: .zone)
    try values.encode(start, forKey: .start); try values.encode(end, forKey: .end)
    try values.encode(sourceBundleId, forKey: .sourceBundleId); try values.encode(sourceName, forKey: .sourceName)
    try values.encode(deviceModel, forKey: .deviceModel); try values.encode(algorithm, forKey: .algorithm)
    try values.encode(originalId, forKey: .originalId); try values.encode(revision, forKey: .revision)
    try values.encode(quality, forKey: .quality); try values.encode(self.values, forKey: .values)
  }
}

struct HealthTombstone: Codable {
  let id: String
  let revision: HealthRevision
}

struct HealthPage: Codable {
  let records: [HealthRecord]
  let tombstones: [HealthTombstone]
  let anchor: String
  let more: Bool
  let logicalBucketsComplete: Bool
}

struct HealthBucket: Codable {
  let key: String
  let type: String
  let day: String
  let start: String
  let end: String
  let sourceKey: String
  let sourceBundleId: String
  let sourceName: String
  let deviceModel: String?
  let workoutId: String?
}

struct HealthMember: Codable {
  let buckets: [String]
  let metrics: [String]
}

struct HealthBucketLedger: Codable {
  var incarnation: String
  var metrics: [String]
  var contributors: [String: [String]]
  var retired: Bool
}

struct HealthPreparedPage: Codable {
  let inputCursor: String?
  let output: HealthPage
}

struct HealthPreparedBatch: Codable {
  let limit: Int
  var issuedThrough: Int
  var acknowledgedThrough: Int
  let pages: [HealthPreparedPage]
  let anchor: Data
  let members: [String: HealthMember]
  let buckets: [String: HealthBucket]
  let ledger: [String: HealthBucketLedger]
}

struct HealthStreamJournal: Codable {
  let context: HealthQueryContext
  var cursor: String?
  var anchor: Data?
  var members: [String: HealthMember]
  var buckets: [String: HealthBucket]
  var prepared: HealthPreparedBatch?
}

struct HealthJournal: Codable {
  let version: Int
  let namespace: String
  let journalId: String
  var revision: Int64
  var serial: Int64
  var streams: [String: HealthStreamJournal]
  var ledger: [String: HealthBucketLedger]
}

private struct HealthJournalIdentity: Codable {
  let version: Int
  let namespace: String
  let journalId: String
  var retiredReceipt: String?
}

// Each namespace has a permanent identity marker. A missing journal never silently
// recreates an existing generation; retirement retains the marker as a reset fence.
final class HealthQueryJournalStore {
  private let manager = FileManager.default
  private let root: URL

  init() throws {
    root = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
      .appendingPathComponent("FormHealthQuery-v1", isDirectory: true)
  }

  private func url(_ namespace: String, _ suffix: String) -> URL { root.appendingPathComponent(namespace + suffix) }

  private func prepareDirectory() throws {
    if !manager.fileExists(atPath: root.path) {
      try manager.createDirectory(at: root, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
    }
    let info = try root.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
    guard info.isDirectory == true, info.isSymbolicLink != true else { throw healthFailure("health_journal_invalid") }
    var directory = root
    var resource = URLResourceValues(); resource.isExcludedFromBackup = true
    try directory.setResourceValues(resource)
  }

  private func read<T: Decodable>(_ path: URL, as: T.Type) throws -> T {
    let info = try path.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard info.isRegularFile == true, info.isSymbolicLink != true, let size = info.fileSize,
      size > 0, size <= HealthQueryLimits.fileBytes else { throw healthFailure("health_journal_invalid") }
    do { return try JSONDecoder().decode(T.self, from: Data(contentsOf: path)) }
    catch { throw healthFailure("health_journal_invalid") }
  }

  private func synchronizeDirectory() throws {
    let fd = Darwin.open(root.path, O_RDONLY)
    guard fd >= 0 else { throw healthFailure("health_journal_effect_unknown") }
    defer { Darwin.close(fd) }
    guard Darwin.fsync(fd) == 0 else { throw healthFailure("health_journal_effect_unknown") }
  }

  private func write<T: Encodable>(_ value: T, to path: URL) throws {
    let data = try JSONEncoder().encode(value)
    guard data.count <= HealthQueryLimits.fileBytes else { throw healthFailure("health_journal_capacity") }
    let staging = path.appendingPathExtension("next")
    guard !manager.fileExists(atPath: staging.path) else { throw healthFailure("health_journal_recovery_required") }
    var created = false
    var renamed = false
    do {
      let fd = Darwin.open(staging.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
      guard fd >= 0 else { throw healthFailure("health_journal_write_failed") }
      created = true
      let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
      defer { try? handle.close() }
      try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: staging.path)
      try handle.write(contentsOf: data)
      try handle.synchronize()
      guard Darwin.rename(staging.path, path.path) == 0 else { throw healthFailure("health_journal_write_failed") }
      renamed = true
      try synchronizeDirectory()
      guard try Data(contentsOf: path) == data else { throw healthFailure("health_journal_effect_unknown") }
    } catch {
      if created && !renamed {
        do { try manager.removeItem(at: staging) }
        catch { throw healthFailure("health_journal_recovery_required") }
      }
      throw error
    }
  }

  func load(_ namespace: String) throws -> HealthJournal {
    let marker = url(namespace, ".identity")
    let file = url(namespace, ".json")
    guard manager.fileExists(atPath: marker.path), manager.fileExists(atPath: file.path) else {
      throw healthFailure("health_journal_missing")
    }
    guard !manager.fileExists(atPath: marker.appendingPathExtension("next").path),
      !manager.fileExists(atPath: file.appendingPathExtension("next").path) else {
      throw healthFailure("health_journal_recovery_required")
    }
    let identity = try read(marker, as: HealthJournalIdentity.self)
    let journal = try read(file, as: HealthJournal.self)
    guard identity.version == 1, identity.namespace == namespace, identity.retiredReceipt == nil,
      journal.version == 1, journal.namespace == namespace, journal.journalId == identity.journalId,
      journal.revision >= 0, journal.revision <= HealthQueryLimits.revision, journal.serial >= 0,
      journal.serial <= HealthQueryLimits.revision, journal.streams.count <= HealthQueryLimits.streams,
      journal.ledger.count <= HealthQueryLimits.bucketSamples,
      journal.streams.values.allSatisfy({ $0.buckets.count <= HealthQueryLimits.bucketSamples
        && ($0.prepared?.pages.count ?? 0) <= HealthQueryLimits.pages }),
      journal.streams.values.reduce(0, { $0 + $1.members.count + ($1.prepared?.members.count ?? 0) }) <= HealthQueryLimits.members * 2 else {
      throw healthFailure("health_journal_invalid")
    }
    for (key, stream) in journal.streams {
      try stream.context.validate()
      guard stream.context.namespace == namespace, key == stream.context.contextId,
        (stream.anchor?.count ?? 0) <= 64 * 1024 else { throw healthFailure("health_journal_invalid") }
      if let prepared = stream.prepared {
        let count = prepared.pages.count
        guard count > 0, count <= HealthQueryLimits.pages, prepared.limit >= 1, prepared.limit <= 100,
          prepared.acknowledgedThrough >= -1, prepared.acknowledgedThrough < count - 1,
          prepared.issuedThrough >= 0, prepared.issuedThrough < count,
          prepared.issuedThrough >= prepared.acknowledgedThrough, prepared.issuedThrough <= prepared.acknowledgedThrough + 1,
          prepared.pages[prepared.acknowledgedThrough + 1].inputCursor == stream.cursor,
          prepared.anchor.count <= 64 * 1024, prepared.buckets.count <= HealthQueryLimits.bucketSamples,
          prepared.ledger.count <= HealthQueryLimits.bucketSamples else { throw healthFailure("health_journal_invalid") }
        for (index, page) in prepared.pages.enumerated() {
          guard page.output.logicalBucketsComplete, page.output.more == (index < count - 1),
            page.output.records.count <= prepared.limit,
            page.output.records.reduce(0, { $0 + $1.values.count }) + page.output.tombstones.count <= 500,
            page.output.anchor.hasPrefix("hk1:" + journal.journalId + ":"),
            index == 0 || page.inputCursor == prepared.pages[index - 1].output.anchor else {
            throw healthFailure("health_journal_invalid")
          }
        }
      }
    }
    try synchronizeDirectory()
    return journal
  }

  func create(_ namespace: String) throws -> HealthJournal {
    try prepareDirectory()
    guard let entries = manager.enumerator(at: root, includingPropertiesForKeys: nil,
      options: [.skipsSubdirectoryDescendants]) else { throw healthFailure("health_journal_invalid") }
    var count = 0, markers = 0
    var active = Set<String>()
    for case let path as URL in entries {
      count += 1
      guard count <= HealthQueryLimits.namespaceMarkers * 4 else { throw healthFailure("health_journal_capacity") }
      if path.pathExtension == "identity" { markers += 1 }
      let name = path.lastPathComponent
      if name.hasSuffix(".json") || name.hasSuffix(".json.next") { active.insert(String(name.prefix(64))) }
    }
    guard markers < HealthQueryLimits.namespaceMarkers, active.count < HealthQueryLimits.activeNamespaces else {
      throw healthFailure("health_journal_capacity")
    }
    for suffix in [".identity", ".identity.next", ".json", ".json.next"] {
      guard !manager.fileExists(atPath: url(namespace, suffix).path) else { throw healthFailure("health_journal_exists") }
    }
    let id = UUID().uuidString.lowercased()
    let journal = HealthJournal(version: 1, namespace: namespace, journalId: id, revision: 0, serial: 0, streams: [:], ledger: [:])
    try write(HealthJournalIdentity(version: 1, namespace: namespace, journalId: id, retiredReceipt: nil), to: url(namespace, ".identity"))
    try write(journal, to: url(namespace, ".json"))
    return try load(namespace)
  }

  func save(_ journal: HealthJournal, expectedSerial: Int64) throws -> HealthJournal {
    let current = try load(journal.namespace)
    guard current.journalId == journal.journalId, current.serial == expectedSerial,
      expectedSerial < HealthQueryLimits.revision else { throw healthFailure("health_journal_changed") }
    var next = journal
    next.serial = expectedSerial + 1
    try write(next, to: url(next.namespace, ".json"))
    return try load(next.namespace)
  }

  func forget(namespace: String, journalId: String, expectedSerial: Int64, receipt: String) throws {
    let marker = url(namespace, ".identity")
    var identity = try read(marker, as: HealthJournalIdentity.self)
    guard identity.namespace == namespace, identity.journalId == journalId, !receipt.isEmpty, receipt.utf8.count <= 200 else {
      throw healthFailure("health_purge_mismatch")
    }
    if let retired = identity.retiredReceipt {
      guard retired == receipt else { throw healthFailure("health_purge_mismatch") }
    } else {
      let current = try load(namespace)
      guard current.serial == expectedSerial else { throw healthFailure("health_journal_changed") }
      identity.retiredReceipt = receipt
      try write(identity, to: marker)
    }
    // The confirmed receipt retires this entire connection/device generation, never a sibling namespace.
    for suffix in [".json", ".json.next"] {
      let target = url(namespace, suffix)
      if manager.fileExists(atPath: target.path) { try manager.removeItem(at: target) }
    }
    try synchronizeDirectory()
    guard !manager.fileExists(atPath: url(namespace, ".json").path),
      !manager.fileExists(atPath: url(namespace, ".json.next").path) else { throw healthFailure("health_journal_effect_unknown") }
  }
}
