import ExpoModulesCore
import HealthKit
import UIKit

public final class FormHealthModule: Module, @unchecked Sendable {
  // All lifecycle state and promise settlement stay on the main queue.
  private var store: HKHealthStore?
  private var epoch: UInt64 = 0
  private var destroyed = false
  private var backgrounded = false
  private var pending: (id: UUID, epoch: UInt64, promise: Promise)?
  // HealthKit cannot cancel an authorization sheet. Keep its latch until its callback.
  private var authorizationInFlight: UUID?
  private lazy var queryEngine = HealthQueryEngine { [unowned self] in
    let result = self.store ?? HKHealthStore()
    self.store = result
    return result
  }

  public func definition() -> ModuleDefinition {
    Name("FormHealth")

    AsyncFunction("availability") { () -> String in
      try self.availability()
    }.runOnQueue(.main)

    AsyncFunction("requestRead") { (types: [String], promise: Promise) in
      self.requestRead(types, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("bindQueryContext") { (context: [String: Any], checkpoint: [String: Any], mode: String) -> [String: Any] in
      guard !self.destroyed, !self.backgrounded else { throw healthFailure("health_context_unavailable") }
      return try self.queryEngine.bind(context: context, checkpoint: checkpoint, mode: mode)
    }.runOnQueue(.main)

    AsyncFunction("reconcileQueryCheckpoint") { (contextId: String, checkpoint: [String: Any]) -> [String: Any] in
      guard !self.destroyed, !self.backgrounded else { throw healthFailure("health_context_unavailable") }
      return try self.queryEngine.reconcile(contextId: contextId, checkpoint: checkpoint)
    }.runOnQueue(.main)

    AsyncFunction("forgetQueryContext") { (context: [String: Any], journalId: String, serial: Int64, receipt: String) in
      guard !self.destroyed else { throw healthFailure("health_module_destroyed") }
      try self.queryEngine.forget(context: context, journalId: journalId, expectedSerial: serial, receipt: receipt)
    }.runOnQueue(.main)

    AsyncFunction("query") { (input: [String: Any], promise: Promise) in
      do {
        guard try self.availability() == "available" else { throw healthFailure("health_native_unavailable") }
        guard !self.backgrounded, UIApplication.shared.applicationState == .active else { throw healthFailure("health_backgrounded") }
        guard self.pending == nil, self.authorizationInFlight == nil else { throw healthFailure("health_busy") }
        self.queryEngine.query(input, promise: promise)
      } catch { promise.reject(error) }
    }.runOnQueue(.main)

    AsyncFunction("cancelAll") { () in
      self.cancelPending(code: "health_cancelled")
    }.runOnQueue(.main)

    OnAppEntersBackground {
      DispatchQueue.main.async {
        self.backgrounded = true
        self.cancelPending(code: "health_backgrounded")
      }
    }
    OnAppEntersForeground {
      DispatchQueue.main.async { self.backgrounded = false }
    }
    OnDestroy {
      DispatchQueue.main.async {
        self.destroyed = true
        self.cancelPending(code: "health_module_destroyed")
      }
    }
  }

  private func availability() throws -> String {
    guard !destroyed else { throw failure("health_module_destroyed", "Health module was destroyed.") }
    guard HKHealthStore.isHealthDataAvailable() else { return "unavailable_device" }
    guard let purpose = Bundle.main.object(forInfoDictionaryKey: "NSHealthShareUsageDescription") as? String,
      !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw failure("health_configuration_missing", "A HealthKit read usage description is required.")
    }
    return "available"
  }

  private func readTypes(_ names: [String]) throws -> Set<HKObjectType> {
    guard !names.isEmpty, names.count <= 7, Set(names).count == names.count else {
      throw failure("health_invalid_types", "Choose a nonempty unique subset of supported health types.")
    }
    return try Set(names.map { name -> HKObjectType in
      let type: HKObjectType?
      switch name {
      case "workouts": type = HKObjectType.workoutType()
      case "steps": type = HKObjectType.quantityType(forIdentifier: .stepCount)
      case "activeEnergy": type = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)
      case "restingHeartRate": type = HKObjectType.quantityType(forIdentifier: .restingHeartRate)
      case "hrvSdnn": type = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)
      case "sleep": type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
      case "bodyMass": type = HKObjectType.quantityType(forIdentifier: .bodyMass)
      default: throw failure("health_invalid_types", "Unsupported health type.")
      }
      guard let type else { throw failure("health_type_unavailable", "Requested health type is unavailable.") }
      return type
    })
  }

  private func requestRead(_ names: [String], promise: Promise) {
    let types: Set<HKObjectType>
    do {
      types = try readTypes(names)
      guard try availability() == "available" else {
        promise.reject("health_native_unavailable", "HealthKit is unavailable on this device.")
        return
      }
    } catch {
      promise.reject(error)
      return
    }
    guard !backgrounded, UIApplication.shared.applicationState == .active else {
      promise.reject("health_backgrounded", "Request HealthKit access from the active app.")
      return
    }
    guard pending == nil, authorizationInFlight == nil, !queryEngine.isQueryInFlight else {
      promise.reject("health_busy", "A HealthKit operation is still in progress.")
      return
    }
    let healthStore = store ?? HKHealthStore()
    store = healthStore
    let id = UUID()
    let generation = epoch
    pending = (id, generation, promise)
    healthStore.getRequestStatusForAuthorization(toShare: Set<HKSampleType>(), read: types) { [weak self] status, error in
      DispatchQueue.main.async {
        guard let self, self.isCurrent(id, generation) else { return }
        guard error == nil else { self.reject(id, code: "health_request_status_failed"); return }
        switch status {
        case .unnecessary:
          self.resolve(id, result: "unnecessary")
        case .shouldRequest:
          guard !self.backgrounded, UIApplication.shared.applicationState == .active else {
            self.cancelPending(code: "health_backgrounded")
            return
          }
          self.authorizationInFlight = id
          healthStore.requestAuthorization(toShare: Set<HKSampleType>(), read: types) { [weak self] success, error in
            DispatchQueue.main.async {
              guard let self else { return }
              if self.authorizationInFlight == id { self.authorizationInFlight = nil }
              guard self.isCurrent(id, generation) else { return }
              guard success, error == nil else { self.reject(id, code: "health_request_failed"); return }
              // Completion reports request processing, never a read grant or denial.
              self.resolve(id, result: "prompted")
            }
          }
        case .unknown:
          self.reject(id, code: "health_request_status_unknown")
        @unknown default:
          self.reject(id, code: "health_request_status_unknown")
        }
      }
    }
  }

  private func isCurrent(_ id: UUID, _ generation: UInt64) -> Bool {
    !destroyed && !backgrounded && epoch == generation && pending?.id == id && pending?.epoch == generation
  }

  private func resolve(_ id: UUID, result: String) {
    guard let operation = pending, operation.id == id else { return }
    pending = nil
    operation.promise.resolve(result)
  }

  private func reject(_ id: UUID, code: String) {
    guard let operation = pending, operation.id == id else { return }
    pending = nil
    operation.promise.reject(code, "HealthKit authorization request could not complete.")
  }

  private func cancelPending(code: String) {
    epoch &+= 1
    let operation = pending
    pending = nil
    operation?.promise.reject(code, "Form cancelled this HealthKit operation; system permissions are unchanged.")
    queryEngine.cancel(code)
  }

  private func failure(_ code: String, _ message: String) -> Exception {
    Exception(name: code, description: message, code: code)
  }
}
