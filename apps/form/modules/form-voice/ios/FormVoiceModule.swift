import AVFoundation
import ExpoModulesCore
import UIKit

private final class VoicePlaybackDelegate: NSObject, AVAudioPlayerDelegate {
  let complete: (AVAudioPlayer, Bool) -> Void
  init(_ complete: @escaping (AVAudioPlayer, Bool) -> Void) { self.complete = complete }
  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { complete(player, flag) }
  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) { complete(player, false) }
}

public final class FormVoiceModule: Module, @unchecked Sendable {
  // Module state belongs to the main queue; the audio tap owns only its locked capture buffer.
  private var leaseID: String?
  private var lastReleasedID: String?
  private var invalidated = false
  private var destroyed = false
  private var engine: AVAudioEngine?
  private var capture: VoiceCaptureBuffer?
  private var captureGeneration: UInt64 = 0
  private var deadline: DispatchWorkItem?
  private var player: AVAudioPlayer?
  private var playbackDelegate: VoicePlaybackDelegate?
  private var playbackPromise: Promise?
  private var audioActive = false
  private var previousSettings: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("FormVoice")
    Events("onInvalidated")
    AsyncFunction("availability") { self.availability() }.runOnQueue(.main)
    AsyncFunction("requestPermission") { (promise: Promise) in
      guard !self.destroyed, self.hasUsageDescription else {
        promise.reject("configuration_missing", "Microphone permission is unavailable."); return
      }
      guard UIApplication.shared.applicationState == .active else {
        promise.reject("background", "Microphone permission requires the foreground."); return
      }
      let complete: @Sendable (Bool) -> Void = { [weak self] _ in
        DispatchQueue.main.async {
          guard let self, !self.destroyed else {
            promise.reject("module_destroyed", "Voice module was destroyed."); return
          }
          promise.resolve(self.permission())
        }
      }
      if #available(iOS 17.0, *) { AVAudioApplication.requestRecordPermission(completionHandler: complete) }
      else { AVAudioSession.sharedInstance().requestRecordPermission(complete) }
    }.runOnQueue(.main)
    AsyncFunction("openLease") { (id: String, fence: [String: Any]) in
      try self.openLease(id, fence: fence)
    }.runOnQueue(.main)
    AsyncFunction("startCapture") { (id: String, limits: [String: Any]) in
      try self.startCapture(id, limits: VoiceCaptureLimits(limits))
    }.runOnQueue(.main)
    AsyncFunction("finishCapture") { (id: String) -> Data in
      try self.finishCapture(id)
    }.runOnQueue(.main)
    AsyncFunction("playWav") { (id: String, bytes: Data, promise: Promise) in
      do { try self.play(id, bytes: bytes, promise: promise) }
      catch { promise.reject("playback_failed", "WAV playback could not start.") }
    }.runOnQueue(.main)
    AsyncFunction("stopCapture") { (id: String) in
      guard try self.cleanupLease(id) else { return }
      self.stopCapture(discard: true)
    }.runOnQueue(.main)
    AsyncFunction("stopPlayback") { (id: String) in
      guard try self.cleanupLease(id) else { return }
      self.stopPlayback()
    }.runOnQueue(.main)
    AsyncFunction("deactivateAudio") { (id: String) in
      guard try self.cleanupLease(id) else { return }
      try self.deactivateAudio()
    }.runOnQueue(.main)
    AsyncFunction("release") { (id: String) in
      guard try self.cleanupLease(id) else { return }
      self.invalidated = true
      self.stopCapture(discard: true)
      self.stopPlayback()
      try self.deactivateAudio()
      self.removeObservers()
      self.leaseID = nil
      self.lastReleasedID = id
    }.runOnQueue(.main)
    OnAppEntersBackground { DispatchQueue.main.async { self.invalidate("background") } }
    OnDestroy {
      DispatchQueue.main.async {
        self.destroyed = true
        self.invalidate("destroyed", emit: false)
        self.removeObservers()
      }
    }
  }

  private var hasUsageDescription: Bool {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") as? String else { return false }
    return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func permission() -> String {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return "granted"
      case .denied: return "denied"
      case .undetermined: return "undetermined"
      @unknown default: return "unknown"
      }
    } else {
      switch AVAudioSession.sharedInstance().recordPermission {
      case .granted: return "granted"
      case .denied: return "denied"
      case .undetermined: return "undetermined"
      @unknown default: return "unknown"
      }
    }
  }

  private func availability() -> [String: Any] {
    let permission = permission()
    let reason: String
    if destroyed { reason = "module_destroyed" }
    else if !hasUsageDescription { reason = "configuration_missing" }
    else if UIApplication.shared.applicationState != .active { reason = "background" }
    else if leaseID != nil || previousSettings != nil || audioActive { reason = "busy" }
    else if permission == "denied" { reason = "permission_denied" }
    else if permission == "undetermined" { reason = "permission_required" }
    else if permission != "granted" { reason = "permission_unknown" }
    else { reason = "available" }
    return ["available": reason == "available", "reason": reason, "permission": permission]
  }

  private func openLease(_ id: String, fence: [String: Any]) throws {
    guard !id.isEmpty, id.count <= 128, id != lastReleasedID,
      let account = fence["accountId"] as? String, !account.isEmpty,
      let session = fence["authSessionId"] as? String, !session.isEmpty,
      let epoch = fence["accountEpoch"] as? NSNumber, epoch.doubleValue >= 0,
      let generation = fence["generation"] as? NSNumber, generation.doubleValue > 0 else {
      throw failure("invalid_lease")
    }
    guard availability()["available"] as? Bool == true else { throw failure("voice_unavailable") }
    leaseID = id
    invalidated = false
    installObservers()
  }

  private func requireLease(_ id: String) throws {
    guard !destroyed, !invalidated, leaseID == id,
      UIApplication.shared.applicationState == .active, permission() == "granted" else { throw failure("stale_lease") }
  }

  private func cleanupLease(_ id: String) throws -> Bool {
    if leaseID == nil, lastReleasedID == id { return false }
    guard leaseID == id else { throw failure("stale_lease") }
    return true
  }

  private func activateAudio() throws {
    let audio = AVAudioSession.sharedInstance()
    if previousSettings == nil { previousSettings = (audio.category, audio.mode, audio.categoryOptions) }
    try audio.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
    // Activation may have taken effect even when it throws; cleanup must attempt deactivation.
    audioActive = true
    try audio.setActive(true)
  }

  private func startCapture(_ id: String, limits: VoiceCaptureLimits) throws {
    try requireLease(id)
    guard engine == nil, capture == nil, player == nil else { throw failure("voice_busy") }
    do {
      try activateAudio()
      let engine = AVAudioEngine()
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      let capture = try VoiceCaptureBuffer(inputFormat: format, limits: limits)
      captureGeneration &+= 1
      let generation = captureGeneration
      self.engine = engine
      self.capture = capture
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        if let failure = capture.append(buffer) {
          DispatchQueue.main.async {
            guard let self, self.leaseID == id, self.captureGeneration == generation else { return }
            self.invalidate(failure == .captureLimit ? "capture_limit" : "audio_error")
          }
        }
      }
      engine.prepare()
      try engine.start()
      let deadline = DispatchWorkItem { [weak self] in
        guard let self, self.leaseID == id, self.captureGeneration == generation else { return }
        self.invalidate("capture_limit")
      }
      self.deadline = deadline
      DispatchQueue.main.asyncAfter(deadline: .now() + Double(limits.maxDurationMs) / 1000, execute: deadline)
    } catch {
      invalidate("audio_error")
      throw failure("capture_failed")
    }
  }

  private func finishCapture(_ id: String) throws -> Data {
    try requireLease(id)
    guard let capture else { throw failure("capture_not_started") }
    stopCapture(discard: false)
    defer { self.capture = nil; capture.discard() }
    do {
      let bytes = try capture.finish()
      try requireLease(id)
      try deactivateAudio()
      return bytes
    } catch {
      invalidate("audio_error")
      throw failure("capture_failed")
    }
  }

  private func stopCapture(discard: Bool) {
    captureGeneration &+= 1
    deadline?.cancel(); deadline = nil
    if let engine {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
      engine.reset()
    }
    engine = nil
    if discard { capture?.discard(); capture = nil }
  }

  private func play(_ id: String, bytes: Data, promise: Promise) throws {
    try requireLease(id)
    guard bytes.count <= VoiceCaptureLimits.hardBytes, WaveAudio.hasSignature(bytes),
      player == nil, capture == nil, engine == nil else { throw failure("invalid_playback") }
    do {
      let player = try AVAudioPlayer(data: bytes, fileTypeHint: "wav")
      try activateAudio()
      let delegate = VoicePlaybackDelegate { [weak self] player, success in
        DispatchQueue.main.async {
          guard let self, self.leaseID == id, self.player === player else { return }
          let result = self.playbackPromise
          self.player = nil; self.playbackPromise = nil; self.playbackDelegate = nil
          do {
            try self.requireLease(id)
            try self.deactivateAudio()
            if success { result?.resolve(nil) }
            else { result?.reject("playback_failed", "WAV decoding failed."); self.invalidate("audio_error") }
          } catch {
            result?.reject("playback_failed", "Playback cleanup could not be confirmed.")
            self.invalidate("cleanup_failed")
          }
        }
      }
      player.delegate = delegate
      self.player = player
      playbackDelegate = delegate
      playbackPromise = promise
      guard player.prepareToPlay(), player.play() else { throw failure("playback_failed") }
    } catch {
      // The AsyncFunction caller owns rejection when startup throws.
      playbackPromise = nil
      invalidate("audio_error")
      throw failure("playback_failed")
    }
  }

  private func stopPlayback() {
    let pending = playbackPromise
    playbackPromise = nil
    player?.stop(); player?.delegate = nil
    player = nil; playbackDelegate = nil
    pending?.reject("playback_cancelled", "Playback was cancelled.")
  }

  private func deactivateAudio() throws {
    guard engine == nil, player == nil else { throw failure("audio_busy") }
    let audio = AVAudioSession.sharedInstance()
    if audioActive { try audio.setActive(false, options: .notifyOthersOnDeactivation); audioActive = false }
    if let settings = previousSettings {
      try audio.setCategory(settings.0, mode: settings.1, options: settings.2)
      previousSettings = nil
    }
  }

  private func invalidate(_ reason: String, emit: Bool = true) {
    guard let id = leaseID else { return }
    invalidated = true
    stopCapture(discard: true)
    stopPlayback()
    var finalReason = reason
    do { try deactivateAudio() } catch { finalReason = "cleanup_failed" }
    if emit { sendEvent("onInvalidated", ["leaseId": id, "reason": finalReason]) }
  }

  private func installObservers() {
    let audio = AVAudioSession.sharedInstance()
    observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification,
      object: audio, queue: .main) { [weak self] notification in
        guard let value = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          value == AVAudioSession.InterruptionType.began.rawValue else { return }
        self?.invalidate("interruption")
      })
    observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification,
      object: audio, queue: .main) { [weak self] notification in
        guard let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw), reason != .categoryChange else { return }
        self?.invalidate("route_changed")
      })
    observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
      object: audio, queue: .main) { [weak self] _ in self?.invalidate("media_reset") })
  }

  private func removeObservers() {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers.removeAll()
  }

  private func failure(_ code: String) -> Exception {
    Exception(name: code, description: "Native voice operation could not be completed.", code: code)
  }
}
