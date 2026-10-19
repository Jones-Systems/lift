import Foundation
import HealthKit

enum HealthBucketBuilder {
  static func sampleType(_ type: String) throws -> HKSampleType {
    let result: HKSampleType?
    switch type {
    case "workouts": result = HKObjectType.workoutType()
    case "steps": result = HKObjectType.quantityType(forIdentifier: .stepCount)
    case "activeEnergy": result = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)
    case "restingHeartRate": result = HKObjectType.quantityType(forIdentifier: .restingHeartRate)
    case "hrvSdnn": result = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)
    case "sleep": result = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
    case "bodyMass": result = HKObjectType.quantityType(forIdentifier: .bodyMass)
    default: result = nil
    }
    guard let result else { throw healthFailure("health_invalid_types") }
    return result
  }

  static func sourceKey(_ sample: HKSample) -> String {
    healthDigest([sample.sourceRevision.source.bundleIdentifier, sample.device?.localIdentifier ?? "",
      sample.device?.model ?? "", sample.sourceRevision.productType ?? ""])
  }

  static func metrics(_ sample: HKSample, type: String) throws -> [String] {
    switch type {
    case "workouts":
      guard let workout = sample as? HKWorkout else { throw healthFailure("health_sample_invalid") }
      return ["workout_duration"] + (workout.totalEnergyBurned == nil ? [] : ["workout_energy"])
        + (workout.totalDistance == nil ? [] : ["workout_distance"])
    case "sleep":
      guard let category = sample as? HKCategorySample else { throw healthFailure("health_sample_invalid") }
      if category.value == HKCategoryValueSleepAnalysis.inBed.rawValue { return ["sleep_in_bed"] }
      if [HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue, HKCategoryValueSleepAnalysis.asleepCore.rawValue,
          HKCategoryValueSleepAnalysis.asleepDeep.rawValue, HKCategoryValueSleepAnalysis.asleepREM.rawValue].contains(category.value) {
        return ["sleep_asleep"]
      }
      guard category.value == HKCategoryValueSleepAnalysis.awake.rawValue else { throw healthFailure("health_sample_invalid") }
      return []
    case "steps": return ["steps"]
    case "activeEnergy": return ["active_energy"]
    case "restingHeartRate": return ["resting_hr"]
    case "hrvSdnn": return ["hrv_sdnn"]
    case "bodyMass": return ["body_mass"]
    default: throw healthFailure("health_invalid_types")
    }
  }

  static func buckets(_ sample: HKSample, context: HealthQueryContext) throws -> [HealthBucket] {
    let start = try healthDate(context.from), end = try healthDate(context.to)
    let calendar = context.calendar
    guard sample.startDate <= sample.endDate else { throw healthFailure("health_sample_invalid") }
    let source = sourceKey(sample)
    let bundle = sample.sourceRevision.source.bundleIdentifier
    let name = sample.sourceRevision.source.name
    guard !bundle.isEmpty, bundle.utf8.count <= 300, !name.isEmpty, name.utf8.count <= 300,
      sample.device?.model == nil || (!(sample.device!.model!.isEmpty) && sample.device!.model!.utf8.count <= 300) else {
      throw healthFailure("health_source_invalid")
    }
    let formatter = DateFormatter()
    formatter.calendar = calendar; formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = calendar.timeZone; formatter.dateFormat = "yyyy-MM-dd"
    var days: [Date] = []
    if context.type == "sleep" {
      var day = calendar.startOfDay(for: max(sample.startDate, start))
      while day < min(sample.endDate, end) {
        guard days.count < 31, let next = calendar.date(byAdding: .day, value: 1, to: day) else {
          throw healthFailure("health_bucket_boundary")
        }
        days.append(day); day = next
      }
    } else {
      guard sample.startDate >= start, sample.startDate < end else { return [] }
      days = [calendar.startOfDay(for: sample.startDate)]
    }
    return try days.map { day in
      guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { throw healthFailure("health_bucket_boundary") }
      // Quantity samples crossing a calendar boundary are not silently clipped or prorated.
      if context.type != "sleep" && context.type != "workouts" && sample.endDate > next {
        throw healthFailure("health_bucket_boundary")
      }
      let date = formatter.string(from: day)
      let workoutId = context.type == "workouts" ? sample.uuid.uuidString.lowercased() : nil
      let key = healthDigest([context.namespace, context.type, context.timeZone, "1", source, workoutId ?? date])
      return HealthBucket(key: key, type: context.type, day: date,
        start: healthISO(workoutId == nil ? day : sample.startDate),
        end: healthISO(workoutId == nil ? next : sample.endDate), sourceKey: source,
        sourceBundleId: bundle, sourceName: name, deviceModel: sample.device?.model, workoutId: workoutId)
    }
  }

  static func values(_ samples: [HKSample], bucket: HealthBucket) throws -> [HealthValue] {
    guard samples.count <= HealthQueryLimits.bucketSamples else { throw healthFailure("health_bucket_capacity") }
    if samples.isEmpty { return [] }
    if bucket.type == "workouts" {
      guard samples.count == 1, let workout = samples[0] as? HKWorkout else { throw healthFailure("health_sample_invalid") }
      var result = [HealthValue(metric: "workout_duration", value: workout.duration, unit: "s", aggregation: "workout")]
      if let energy = workout.totalEnergyBurned {
        result.append(HealthValue(metric: "workout_energy", value: energy.doubleValue(for: .kilocalorie()), unit: "kcal", aggregation: "workout"))
      }
      if let distance = workout.totalDistance {
        result.append(HealthValue(metric: "workout_distance", value: distance.doubleValue(for: .meter()), unit: "m", aggregation: "workout"))
      }
      return try checked(result)
    }
    if bucket.type == "sleep" {
      let from = try healthDate(bucket.start), to = try healthDate(bucket.end)
      var byMetric: [String: [(Date, Date)]] = [:]
      for sample in samples {
        for metric in try metrics(sample, type: "sleep") {
          let start = max(from, sample.startDate), end = min(to, sample.endDate)
          if start < end { byMetric[metric, default: []].append((start, end)) }
        }
      }
      return try checked(byMetric.keys.sorted().map { metric in
        let intervals = byMetric[metric]!.sorted { $0.0 == $1.0 ? $0.1 < $1.1 : $0.0 < $1.0 }
        var merged: [(Date, Date)] = []
        for interval in intervals {
          if let previous = merged.last, interval.0 <= previous.1 {
            merged[merged.count - 1] = (previous.0, max(previous.1, interval.1))
          } else { merged.append(interval) }
        }
        return HealthValue(metric: metric, value: merged.reduce(0) { $0 + $1.1.timeIntervalSince($1.0) }, unit: "s", aggregation: "interval_union")
      })
    }
    let unit: HKUnit, metric: String, label: String, aggregation: String
    switch bucket.type {
    case "steps": unit = .count(); metric = "steps"; label = "count"; aggregation = "sum"
    case "activeEnergy": unit = .kilocalorie(); metric = "active_energy"; label = "kcal"; aggregation = "sum"
    case "restingHeartRate": unit = HKUnit.count().unitDivided(by: .minute()); metric = "resting_hr"; label = "bpm"; aggregation = "mean"
    case "hrvSdnn": unit = .secondUnit(with: .milli); metric = "hrv_sdnn"; label = "ms"; aggregation = "mean"
    case "bodyMass": unit = .gramUnit(with: .kilo); metric = "body_mass"; label = "kg"; aggregation = "latest"
    default: throw healthFailure("health_invalid_types")
    }
    let ordered = samples.sorted {
      if $0.endDate != $1.endDate { return $0.endDate < $1.endDate }
      if $0.startDate != $1.startDate { return $0.startDate < $1.startDate }
      return $0.uuid.uuidString < $1.uuid.uuidString
    }
    let quantities = try ordered.map { sample -> Double in
      guard let sample = sample as? HKQuantitySample, sample.quantity.is(compatibleWith: unit) else {
        throw healthFailure("health_sample_invalid")
      }
      let value = sample.quantity.doubleValue(for: unit)
      guard value.isFinite, value >= 0 else { throw healthFailure("health_sample_invalid") }
      return value
    }
    let value: Double
    if aggregation == "latest" { value = quantities.last! }
    else { value = quantities.reduce(0, +) / (aggregation == "mean" ? Double(quantities.count) : 1) }
    return try checked([HealthValue(metric: metric, value: value, unit: label, aggregation: aggregation)])
  }

  private static func checked(_ values: [HealthValue]) throws -> [HealthValue] {
    guard values.count <= 3, values.allSatisfy({ $0.value.isFinite && $0.value >= 0 }) else {
      throw healthFailure("health_sample_invalid")
    }
    return values.sorted { $0.metric < $1.metric }
  }
}
