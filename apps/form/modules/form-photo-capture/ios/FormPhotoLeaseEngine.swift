import AVFoundation
import ExpoModulesCore
import Foundation
import CoreFoundation
import UIKit
import ImageIO

struct PhotoLease: Equatable {
  let id: String
  let account: String
  let generation: Double
  let requestID: String
  let operationID: String?

  init(_ value: [String: Any]) throws {
    guard Set(value.keys) == Set(["leaseId", "accountId", "generation", "requestId"])
        || Set(value.keys) == Set(["leaseId", "accountId", "generation", "requestId", "operationId"]) else {
      throw Exception(name: "invalid_lease", description: "Original creator identity is required.", code: "invalid_lease")
    }
    guard let requestID = value["requestId"] as? String, !requestID.isEmpty, requestID.utf16.count <= 128,
      let id = value["leaseId"] as? String, let account = value["accountId"] as? String,
      let generation = value["generation"] as? NSNumber,
      CFGetTypeID(generation) != CFBooleanGetTypeID(),
      !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, id.count <= 128,
      !account.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, account.count <= 128,
      generation.doubleValue.isFinite, generation.doubleValue >= 0,
      generation.doubleValue <= 9007199254740991, generation.doubleValue.rounded() == generation.doubleValue else {
      throw Exception(name: "invalid_lease", description: "An exact bounded photo lease is required.", code: "invalid_lease")
    }
    self.id = id; self.account = account; self.generation = generation.doubleValue
    self.requestID = requestID
    if let operation = value["operationId"] {
      guard let operation = operation as? String, !operation.isEmpty, operation.utf16.count <= 128 else {
        throw Exception(name: "invalid_lease", description: "Exact producer identity is required.", code: "invalid_lease")
      }
      self.operationID = operation
    } else { self.operationID = nil }
  }
  func sameCreator(_ other: PhotoLease) -> Bool {
    id == other.id && account == other.account && generation == other.generation && requestID == other.requestID
  }
}

final class FormPhotoLeaseEngine {
  let queue = DispatchQueue(label: "form.photo.capture")
  // Source guard only. A new reviewed source revision plus native qualification is required to enable it.
  private let activationEnabled = false
  private let lifecycleLock = NSLock()
  private var lifecycleGeneration: UInt64 = 0
  private var isForeground = true
  private var destroyed = false
  private var lease: PhotoLease?
  private var leaseLifecycle: UInt64?
  private var leaseScope: PhotoScope?
  private let previews = PhotoPreviewRegistry()
  private var permissionRequest: PhotoPermissionRequest?
  private let permissionRetirements = PhotoPermissionRetirementRegistry()
  private var releasedLease: PhotoLease?
  private var releasedScope: PhotoScope?
  private var session: AVCaptureSession?
  private var output: AVCapturePhotoOutput?
  private var frames: [String: PhotoStoredFrame] = [:]
  private var views = Set<String>()
  private var request: PhotoRequest?
  private var interruptionObserver: NSObjectProtocol?
  private var runtimeErrorObserver: NSObjectProtocol?
  private var leaseDeadline: DispatchWorkItem?

  func availability() -> [String: Any] {
    guard activationEnabled else { return denied("native_capture_unqualified") }
    guard lifecycleSnapshot() != nil else { return denied("native_capture_unavailable") }
    guard let purpose = Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String,
      !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return denied("configuration_missing") }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return denied("permission_required") }
    guard AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil else {
      return denied("native_capture_unavailable")
    }
    return ["ready": true, "reason": "ready"]
  }

  func acquire(_ value: [String: Any], scope scopeValue: [String: Any]?) throws -> [String: String] {
    guard activationEnabled else { throw failure("native_capture_unqualified") }
    let creator = try PhotoLease(value)
    guard creator.operationID == nil else { throw failure("invalid_lease") }
    var acknowledged = value; acknowledged["operationId"] = UUID().uuidString
    let requested = try PhotoLease(acknowledged)
    guard let scopeValue else { throw failure("invalid_scope") }
    let scope = try PhotoScope(scopeValue)
    guard scope.matches(requested) else { throw failure("scope_mismatch") }
    guard lease == nil, session == nil, request == nil, permissionRequest == nil else { throw failure("native_cleanup_unknown") }
    let readiness = availability()
    guard readiness["ready"] as? Bool == true, let stamp = lifecycleSnapshot(),
      let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
      throw failure(readiness["reason"] as? String ?? "native_capture_unavailable")
    }
    let captureSession = AVCaptureSession()
    lease = requested; leaseLifecycle = stamp; leaseScope = scope; releasedLease = nil; session = captureSession
    previews.bind(requested, scope: scope)
    captureSession.beginConfiguration()
    do {
      guard captureSession.canSetSessionPreset(.photo) else { throw failure("native_capture_unavailable") }
      captureSession.sessionPreset = .photo
      let input = try AVCaptureDeviceInput(device: camera)
      let photoOutput = AVCapturePhotoOutput()
      guard captureSession.canAddInput(input), captureSession.canAddOutput(photoOutput) else {
        throw failure("native_capture_unavailable")
      }
      captureSession.addInput(input); captureSession.addOutput(photoOutput); output = photoOutput
      captureSession.commitConfiguration()
    } catch {
      captureSession.commitConfiguration()
      _ = release(requested)
      throw error
    }
    guard current(requested) else { _ = release(requested); throw failure("stale_session") }
    installObservers(captureSession)
    // Apple's start/stop calls block; every session operation stays on this dedicated serial queue.
    captureSession.startRunning()
    guard current(requested), captureSession.isRunning else {
      _ = release(requested); throw failure("native_capture_unavailable")
    }
    let deadline = DispatchWorkItem { [weak self] in
      guard let self, self.lease == requested else { return }
      _ = self.release(requested)
    }
    leaseDeadline = deadline
    queue.asyncAfter(deadline: .now() + 60, execute: deadline)
    return ["leaseId": requested.id, "requestId": requested.requestID, "operationId": requested.operationID!]
  }

  func capture(_ value: [String: Any], view: String, scope scopeValue: [String: Any]?, promise: Promise) {
    do {
      guard activationEnabled else { throw failure("native_capture_unqualified") }
      let requested = try PhotoLease(value)
      guard let scopeValue else { throw failure("invalid_scope") }
      let scope = try PhotoScope(scopeValue)
      guard current(requested), leaseScope == scope, scope.matches(requested), let output, session?.isRunning == true else { throw failure("stale_session") }
      guard request == nil, ["front", "side"].contains(view), !views.contains(view), frames.count < 2 else {
        throw failure("capture_unavailable")
      }
      beginCapture(requested, view: view, replacedFrame: nil, output: output, promise: promise)
    } catch { promise.reject("capture_unavailable", "Native photo capture did not start.") }
  }

  private func beginCapture(_ requested: PhotoLease, view: String, replacedFrame: String?, output: AVCapturePhotoOutput, promise: Promise) {
      let delegate = PhotoRequest(lease: requested, view: view, replacedFrame: replacedFrame, promise: promise, engine: self)
      request = delegate
      let deadline = DispatchWorkItem { [weak self, weak delegate] in
        guard let self, let delegate, self.request === delegate else { return }
        delegate.reject("capture_timeout")
        _ = self.release(requested)
      }
      delegate.deadline = deadline
      queue.asyncAfter(deadline: .now() + 15, execute: deadline)
      let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
      settings.flashMode = .off
      output.capturePhoto(with: settings, delegate: delegate)
  }

  func permissionStatus(_ value: [String: Any]) -> [String: String] {
    guard activationEnabled else { return ["status": "unavailable", "reason": "native_capture_unqualified"] }
    guard (try? PhotoScope(value)) != nil else { return ["status": "unknown"] }
    guard lifecycleSnapshot() != nil else { return ["status": "unavailable", "reason": "native_capture_unavailable"] }
    guard cameraDescriptionPresent() else { return ["status": "unavailable", "reason": "configuration_missing"] }
    return ["status": authorizationState()]
  }

  func requestPermission(_ value: [String: Any], id: String, promise: Promise) {
    guard let scope = try? PhotoScope(value), !id.isEmpty, id.utf16.count <= 128 else {
      promise.reject("permission_unavailable", "Original permission identity is required."); return
    }
    guard activationEnabled else {
      permissionRetirements.record(id, scope: scope, status: "not_requested")
      promise.resolve(["requestId": id, "status": "unavailable", "reason": "native_capture_unqualified"]); return
    }
    do {
      guard !id.isEmpty, id.utf16.count <= 128, lease == nil, request == nil, permissionRequest == nil,
        let stamp = lifecycleSnapshot() else { throw failure("permission_unavailable") }
      var status = permissionStatus(value); status["requestId"] = id
      guard status["status"] == "not_determined" else {
        permissionRetirements.record(id, scope: scope, status: "not_requested"); promise.resolve(status); return
      }
      permissionRetirements.record(id, scope: scope, status: "unknown")
      permissionRequest = PhotoPermissionRequest(scope: scope, id: id, stamp: stamp, promise: promise)
      // Explicit request only. Acquisition never invokes this OS prompt and cannot cancel an already-presented prompt.
      AVCaptureDevice.requestAccess(for: .video) { [weak self] _ in
        guard let self else { return }
        self.queue.async {
          guard let pending = self.permissionRequest, pending.id == id, pending.scope == scope else { return }
          self.permissionRequest = nil
          self.permissionRetirements.record(id, scope: scope, status: "retired")
          guard self.lifecycleSnapshot() == pending.stamp else {
            pending.reject(); return
          }
          pending.resolve(["requestId": id, "status": self.authorizationState()])
        }
      }
    } catch { promise.reject("permission_unavailable", "Explicit permission request did not start.") }
  }

  func permissionRetirement(_ operation: [String: Any]) -> [String: Any] {
    guard Set(operation.keys) == Set(["requestId", "scope"]), let id = operation["requestId"] as? String,
      let value = operation["scope"] as? [String: Any], let scope = try? PhotoScope(value) else {
      return ["operation": operation, "status": "unknown"]
    }
    return ["operation": operation, "status": permissionRetirements.read(id, scope: scope)]
  }

  func preview(_ value: [String: Any], frame frameValue: [String: Any], scope scopeValue: [String: Any]) throws -> [String: String] {
    guard activationEnabled else { throw failure("native_capture_unqualified") }
    let requested = try PhotoLease(value), scope = try PhotoScope(scopeValue), frame = try PhotoFrameReference(frameValue)
    guard current(requested), leaseScope == scope, scope.matches(requested), frame.leaseID == requested.id,
      frames[frame.frameID]?.view == frame.view,
      let ticket = previews.ticket(frame, lease: requested, scope: scope) else { throw failure("preview_unavailable") }
    return ticket.payload
  }

  // This synchronous bridge path never waits for startRunning/stopRunning or the capture queue.
  func invalidatePreviews(_ value: [String: Any], frame frameValue: [String: Any]?, scope scopeValue: [String: Any]) -> [String: String] {
    let id = value["leaseId"] as? String ?? ""
    guard activationEnabled, let requested = try? PhotoLease(value), let scope = try? PhotoScope(scopeValue) else {
      return ["leaseId": id, "status": "unknown"]
    }
    let frame: PhotoFrameReference?
    if let frameValue { guard let parsed = try? PhotoFrameReference(frameValue) else {
      return ["leaseId": id, "status": "unknown"]
    }; frame = parsed } else { frame = nil }
    return ["leaseId": id, "status": previews.invalidate(requested, frame: frame, scope: scope) ? "invalidated" : "unknown"]
  }

  func retake(_ value: [String: Any], frame frameValue: [String: Any], scope scopeValue: [String: Any], promise: Promise) {
    do {
      guard activationEnabled else { throw failure("native_capture_unqualified") }
      let requested = try PhotoLease(value), scope = try PhotoScope(scopeValue), frame = try PhotoFrameReference(frameValue)
      guard current(requested), leaseScope == scope, scope.matches(requested), frame.leaseID == requested.id,
        request == nil, let output, session?.isRunning == true, frames[frame.frameID]?.view == frame.view else {
        throw failure("retake_unavailable")
      }
      _ = previews.invalidate(requested, frame: frame, scope: scope)
      frames.removeValue(forKey: frame.frameID); views.remove(frame.view)
      beginCapture(requested, view: frame.view, replacedFrame: frame.frameID, output: output, promise: promise)
    } catch { promise.reject("retake_unavailable", "Native replacement did not start.") }
  }

  func showPreview(_ value: [String: Any], scope scopeValue: [String: Any], in view: FormPhotoPreviewView, promise: Promise) {
    guard activationEnabled else { promise.reject("native_capture_unqualified", "Native preview is unavailable."); return }
    let renderStamp = view.beginPreview()
    queue.async { [weak self, weak view] in
      guard let self, let view else { promise.reject("preview_unavailable", "Preview consumer is unavailable."); return }
      do {
        guard Set(value.keys) == Set(["leaseId", "frameId", "view", "previewId"]),
          let id = value["previewId"] as? String else { throw self.failure("invalid_preview") }
        var reference = value; reference.removeValue(forKey: "previewId")
        let frame = try PhotoFrameReference(reference), scope = try PhotoScope(scopeValue)
        guard let requested = self.lease, self.current(requested), self.leaseScope == scope, scope.matches(requested),
          frame.leaseID == requested.id, let stored = self.frames[frame.frameID], stored.view == frame.view,
          let stamp = self.leaseLifecycle,
          let ticket = self.previews.existing(id, frame: frame, lease: requested, scope: scope) else {
          throw self.failure("preview_unavailable")
        }
        guard let image = self.boundedPreviewImage(stored.data) else { throw self.failure("preview_unavailable") }
        DispatchQueue.main.async { [weak self, weak view] in
          guard let self, let view, view.accepts(renderStamp),
            self.withLifecycle(stamp, { ticket.attach(image, to: view) }) else { promise.reject("stale_preview", "Preview is no longer current."); return }
          promise.resolve(["previewId": id, "status": "attached"])
        }
      } catch { promise.reject("preview_unavailable", "Exact native preview did not attach.") }
    }
  }

  // Resource bound only: output thumbnail dimensions never exceed 1024 x 1024; decoder/cache/RSS behavior remains unqualified.
  private func boundedPreviewImage(_ data: Data) -> UIImage? {
    guard activationEnabled else { return nil }
    return autoreleasepool {
      let sourceOptions = [kCGImageSourceShouldCache as String: false] as CFDictionary
      guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
      let options: [String: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways as String: true,
        kCGImageSourceCreateThumbnailWithTransform as String: true,
        kCGImageSourceThumbnailMaxPixelSize as String: 1024,
        kCGImageSourceShouldAllowFloat as String: false,
        kCGImageSourceShouldCache as String: false
      ]
      guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
        image.width > 0, image.height > 0, image.width <= 1024, image.height <= 1024 else { return nil }
      return UIImage(cgImage: image)
    }
  }

  private func cameraDescriptionPresent() -> Bool {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String else { return false }
    return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  private func authorizationState() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .notDetermined: return "not_determined"
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "unknown"
    }
  }

  func cancel(_ value: [String: Any], scope scopeValue: [String: Any]?) -> [String: String] {
    let id = value["leaseId"] as? String ?? ""
    guard activationEnabled, let requested = try? PhotoLease(value), let scopeValue,
      let scope = try? PhotoScope(scopeValue), scope.matches(requested) else { return ["leaseId": id, "status": "unknown"] }
    if let releasedLease, requested.sameCreator(releasedLease), scope == releasedScope,
      requested.operationID == nil || requested.operationID == releasedLease.operationID {
      return ["leaseId": id, "status": "released"]
    }
    guard let lease, requested.sameCreator(lease), scope == leaseScope,
      requested.operationID == nil || requested.operationID == lease.operationID else { return ["leaseId": id, "status": "unknown"] }
    return ["leaseId": id, "status": release(lease)]
  }

  func invalidate(destroyed: Bool) {
    // Fence callbacks immediately, even while startRunning blocks the serial queue.
    lifecycleLock.lock()
    lifecycleGeneration &+= 1; isForeground = false; self.destroyed = self.destroyed || destroyed
    lifecycleLock.unlock()
    previews.invalidateAll()
    queue.async {
      if let pending = self.permissionRequest { pending.reject() }
      guard let lease = self.lease else { return }
      _ = self.release(lease)
    }
  }

  func foreground() {
    lifecycleLock.lock()
    if !destroyed { isForeground = true }
    lifecycleLock.unlock()
  }

  fileprivate func processed(_ photo: AVCapturePhoto, error: Error?, request: PhotoRequest) {
    queue.async { [weak self, weak request] in
      guard let self, let request, self.request === request, self.current(request.lease), !request.settled else { return }
      guard error == nil, let data = photo.fileDataRepresentation(), data.count <= 24 * 1024 * 1024 else {
        request.data = nil
        if request.replacedFrame == nil { request.reject("photo_processing_failed"); _ = self.release(request.lease) }
        return
      }
      // Native Data remains opaque. No URL, disk write, Photos-library save, log or upload is added here.
      request.data = data
    }
  }

  fileprivate func finished(_ request: PhotoRequest, error: Error?) {
    queue.async { [weak self] in
      guard let self, self.request === request else { return }
      request.deadline?.cancel(); request.deadline = nil
      if self.current(request.lease), !request.settled, error == nil, let data = request.data {
        let frame = UUID().uuidString
        self.frames[frame] = PhotoStoredFrame(view: request.view, data: data); self.views.insert(request.view)
        if let scope = self.leaseScope, let reference = try? PhotoFrameReference([
          "leaseId": request.lease.id, "frameId": frame, "view": request.view]) {
          self.previews.register(reference, lease: request.lease, scope: scope)
        }
        var value = ["leaseId": request.lease.id, "frameId": frame, "view": request.view]
        if let replaced = request.replacedFrame { value["status"] = "captured"; value["replacedFrameId"] = replaced }
        request.resolve(value)
      } else if self.current(request.lease), !request.settled, let replaced = request.replacedFrame {
        // Only the terminal failed replacement preserves the other native frame; uncertainty closes the lease.
        request.resolve(["leaseId": request.lease.id, "view": request.view, "status": "failed",
          "replacedFrameId": replaced, "reason": "capture_failed"])
      } else { request.reject("capture_cancelled") }
      request.data = nil
      self.request = nil
      // didFinishCapture is the terminal delegate event. Earlier cancellation alone cannot prove retirement.
      if self.leaseLifecycle == nil { _ = self.release(request.lease) }
    }
  }

  private func release(_ requested: PhotoLease) -> String {
    guard lease == requested else { return requested == releasedLease ? "released" : "unknown" }
    leaseLifecycle = nil
    previews.invalidateAll()
    leaseDeadline?.cancel(); leaseDeadline = nil
    frames.removeAll(); views.removeAll()
    request?.data = nil; request?.reject("capture_cancelled")
    request?.deadline?.cancel(); request?.deadline = nil
    session?.stopRunning()
    if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer) }
    if let observer = runtimeErrorObserver { NotificationCenter.default.removeObserver(observer) }
    interruptionObserver = nil; runtimeErrorObserver = nil
    guard session?.isRunning != true, request == nil else { return "unknown" }
    if let session {
      session.beginConfiguration()
      for input in session.inputs { session.removeInput(input) }
      for output in session.outputs { session.removeOutput(output) }
      session.commitConfiguration()
    }
    releasedScope = leaseScope
    session = nil; output = nil; lease = nil; leaseScope = nil; releasedLease = requested
    return "released"
  }

  private func installObservers(_ session: AVCaptureSession) {
    interruptionObserver = NotificationCenter.default.addObserver(forName: .AVCaptureSessionWasInterrupted,
      object: session, queue: nil) { [weak self] _ in self?.invalidate(destroyed: false) }
    runtimeErrorObserver = NotificationCenter.default.addObserver(forName: .AVCaptureSessionRuntimeError,
      object: session, queue: nil) { [weak self] _ in self?.invalidate(destroyed: false) }
  }
  private func lifecycleSnapshot() -> UInt64? {
    lifecycleLock.lock(); defer { lifecycleLock.unlock() }
    return !destroyed && isForeground ? lifecycleGeneration : nil
  }
  private func withLifecycle(_ stamp: UInt64, _ operation: () -> Bool) -> Bool {
    lifecycleLock.lock(); defer { lifecycleLock.unlock() }
    guard !destroyed, isForeground, lifecycleGeneration == stamp else { return false }
    return operation()
  }
  private func current(_ requested: PhotoLease) -> Bool {
    guard lease == requested, let stamp = leaseLifecycle else { return false }
    return lifecycleSnapshot() == stamp
  }
  private func denied(_ reason: String) -> [String: Any] { ["ready": false, "reason": reason] }
  private func failure(_ code: String) -> Exception {
    Exception(name: code, description: "Native photo operation is unavailable.", code: code)
  }
}

fileprivate final class PhotoRequest: NSObject, AVCapturePhotoCaptureDelegate {
  let lease: PhotoLease
  let view: String
  let replacedFrame: String?
  private let promise: Promise
  private weak var engine: FormPhotoLeaseEngine?
  var data: Data?
  var deadline: DispatchWorkItem?
  private(set) var settled = false

  init(lease: PhotoLease, view: String, replacedFrame: String?, promise: Promise, engine: FormPhotoLeaseEngine) {
    self.lease = lease; self.view = view; self.replacedFrame = replacedFrame; self.promise = promise; self.engine = engine
    super.init()
  }
  func resolve(_ value: [String: String]) { guard !settled else { return }; settled = true; promise.resolve(value) }
  func reject(_ code: String) { guard !settled else { return }; settled = true; promise.reject(code, "Native capture did not complete.") }
  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    engine?.processed(photo, error: error, request: self)
  }
  func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
    engine?.finished(self, error: error)
  }
}
