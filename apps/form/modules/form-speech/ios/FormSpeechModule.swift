import AVFoundation
import ExpoModulesCore
import Speech

public final class FormSpeechModule: Module, @unchecked Sendable {
  // All mutable session state is confined to the main queue, including callbacks.
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var engine: AVAudioEngine?
  private var tapInstalled = false
  private var sessionID: String?
  private var stopping = false
  private var destroyed = false
  private var audioSessionActive = false
  private var cleanupSessionID: String?
  private var interruptionObserver: NSObjectProtocol?
  private var mediaResetObserver: NSObjectProtocol?
  private var captureDeadline: DispatchWorkItem?
  private var finalDeadline: DispatchWorkItem?
  private var previousAudioSettings: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?

  public func definition() -> ModuleDefinition {
    Name("FormSpeech")
    Events("onResult", "onState", "onError")

    AsyncFunction("availability") { (locale: String) -> [String: Any] in
      self.availability(locale)
    }.runOnQueue(.main)

    AsyncFunction("requestPermissions") { (promise: Promise) in
      guard self.hasUsageDescriptions else {
        promise.reject("configuration_missing", "Microphone and speech usage descriptions are required.")
        return
      }
      SFSpeechRecognizer.requestAuthorization { [weak self] _ in
        DispatchQueue.main.async {
          guard let self, !self.destroyed else {
            promise.reject("module_destroyed", "Speech module was destroyed.")
            return
          }
          guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            promise.resolve(self.permissions())
            return
          }
          let response: @Sendable (Bool) -> Void = { [weak self] _ in
            DispatchQueue.main.async {
              guard let self, !self.destroyed else {
                promise.reject("module_destroyed", "Speech module was destroyed.")
                return
              }
              promise.resolve(self.permissions())
            }
          }
          if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: response)
          } else {
            AVAudioSession.sharedInstance().requestRecordPermission(response)
          }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("start") { (locale: String, id: String) -> [String: String] in
      try self.start(locale: locale, id: id)
      return ["sessionId": id]
    }.runOnQueue(.main)

    AsyncFunction("stop") { (id: String) in
      guard self.sessionID == id else { throw self.failure("stale_session", "Speech session is no longer active.") }
      self.stopCapture()
    }.runOnQueue(.main)

    AsyncFunction("cancel") { (id: String) in
      guard self.sessionID == nil || self.sessionID == id,
        self.cleanupSessionID == nil || self.cleanupSessionID == id else {
        throw self.failure("stale_session", "A different speech session owns audio cleanup.")
      }
      try self.endSession(reason: "cancelled")
    }.runOnQueue(.main)

    OnAppEntersBackground {
      DispatchQueue.main.async { self.finishSession(reason: "backgrounded") }
    }
    OnDestroy {
      DispatchQueue.main.async {
        self.destroyed = true
        self.finishSession(reason: "destroyed", emit: false)
      }
    }
  }

  private var hasUsageDescriptions: Bool {
    ["NSSpeechRecognitionUsageDescription", "NSMicrophoneUsageDescription"].allSatisfy {
      guard let value = Bundle.main.object(forInfoDictionaryKey: $0) as? String else { return false }
      return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }

  private func permissions() -> [String: String] {
    let speech: String
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: speech = "granted"
    case .denied: speech = "denied"
    case .restricted: speech = "restricted"
    case .notDetermined: speech = "undetermined"
    @unknown default: speech = "unknown"
    }
    return ["speech": speech, "microphone": microphonePermission()]
  }

  private func microphonePermission() -> String {
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

  private func selectedRecognizer(_ identifier: String) -> SFSpeechRecognizer? {
    let normalized = identifier.replacingOccurrences(of: "_", with: "-").lowercased()
    guard !normalized.isEmpty, normalized.count <= 80,
      let locale = SFSpeechRecognizer.supportedLocales().first(where: {
        $0.identifier.replacingOccurrences(of: "_", with: "-").lowercased() == normalized
      }) else { return nil }
    return SFSpeechRecognizer(locale: locale)
  }

  private func availability(_ locale: String) -> [String: Any] {
    let permissions = permissions()
    let selected = hasUsageDescriptions ? selectedRecognizer(locale) : nil
    let reason: String
    if destroyed { reason = "module_destroyed" }
    else if !hasUsageDescriptions { reason = "configuration_missing" }
    else if selected == nil { reason = "locale_unsupported" }
    else if selected?.supportsOnDeviceRecognition != true { reason = "on_device_unsupported" }
    else if selected?.isAvailable != true { reason = "recognizer_unavailable" }
    else if permissions.values.contains("denied") || permissions.values.contains("restricted") { reason = "permission_denied" }
    else if permissions.values.contains("unknown") { reason = "permission_unknown" }
    else if permissions.values.contains("undetermined") { reason = "permission_required" }
    else { reason = "available" }
    return ["reason": reason, "available": reason == "available", "locale": locale,
            "permissions": permissions, "onDeviceSupported": selected?.supportsOnDeviceRecognition ?? false]
  }

  private func start(locale: String, id: String) throws {
    guard !destroyed else { throw failure("module_destroyed", "Speech module was destroyed.") }
    guard sessionID == nil else { throw failure("busy", "Another speech session is active.") }
    guard !audioSessionActive, previousAudioSettings == nil, cleanupSessionID == nil else {
      throw failure("audio_cleanup_failed", "Previous audio session cleanup is unresolved.")
    }
    guard !id.isEmpty, id.count <= 128 else { throw failure("invalid_session", "A bounded session identifier is required.") }
    let status = availability(locale)
    guard status["available"] as? Bool == true, let selected = selectedRecognizer(locale) else {
      throw failure(status["reason"] as? String ?? "recognizer_unavailable", "On-device speech is not available for this locale and permission state.")
    }
    // Recheck this exact recognizer; never fall back to Apple's network service.
    guard selected.isAvailable, selected.supportsOnDeviceRecognition else {
      throw failure("recognizer_unavailable", "Requested on-device recognizer is unavailable.")
    }
    sessionID = id
    recognizer = selected
    let audioRequest = SFSpeechAudioBufferRecognitionRequest()
    audioRequest.requiresOnDeviceRecognition = true
    audioRequest.shouldReportPartialResults = true
    audioRequest.taskHint = .dictation
    request = audioRequest
    let audio = AVAudioSession.sharedInstance()
    cleanupSessionID = id
    previousAudioSettings = (audio.category, audio.mode, audio.categoryOptions)
    do {
      try audio.setCategory(.record, mode: .measurement, options: [])
      // An activation error may still change audio state; require deactivation on that path too.
      audioSessionActive = true
      try audio.setActive(true)
      let audioEngine = AVAudioEngine()
      engine = audioEngine
      let input = audioEngine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else {
        throw failure("audio_unavailable", "No usable microphone input format.")
      }
      // Buffers stay in Apple's in-memory request; no file, URL or upload is created.
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        audioRequest.append(buffer)
      }
      tapInstalled = true
      recognitionTask = selected.recognitionTask(with: audioRequest) { [weak self] result, error in
        DispatchQueue.main.async {
          guard let self, self.sessionID == id else { return }
          if let result {
            self.sendEvent("onResult", ["sessionId": id, "text": result.bestTranscription.formattedString,
                                        "isFinal": result.isFinal, "locale": locale])
            if result.isFinal { self.finishSession(reason: "final"); return }
          }
          if let error {
            self.sendEvent("onError", ["sessionId": id, "code": "recognition_failed", "message": "On-device recognition failed.",
                                       "nativeCode": (error as NSError).code])
            self.finishSession(reason: "error")
          }
        }
      }
      interruptionObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: audio, queue: .main
      ) { [weak self] notification in
        guard let value = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          value == AVAudioSession.InterruptionType.began.rawValue else { return }
        self?.finishSession(reason: "interrupted")
      }
      mediaResetObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification, object: audio, queue: .main
      ) { [weak self] _ in self?.finishSession(reason: "interrupted") }
      audioEngine.prepare()
      try audioEngine.start()
      sendEvent("onState", ["sessionId": id, "state": "recording"])
      let deadline = DispatchWorkItem { [weak self] in self?.stopCapture() }
      captureDeadline = deadline
      DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: deadline)
    } catch {
      try endSession(reason: "error")
      throw error
    }
  }

  private func stopCapture() {
    guard let id = sessionID, !stopping else { return }
    stopping = true
    captureDeadline?.cancel()
    // Stop input and request a final result; only endSession/cancel proves audio release.
    stopAudioEngine()
    request?.endAudio()
    sendEvent("onState", ["sessionId": id, "state": "stopping"])
    // Apple's final callback is not guaranteed after interruption or service failure.
    let deadline = DispatchWorkItem { [weak self] in
      guard let self, self.sessionID == id else { return }
      self.sendEvent("onError", ["sessionId": id, "code": "final_timeout", "message": "No final speech result was received."])
      self.finishSession(reason: "error")
    }
    finalDeadline = deadline
    DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: deadline)
  }

  private func finishSession(reason: String, emit: Bool = true) {
    do { try endSession(reason: reason, emit: emit) }
    catch { /* Failed cleanup retains its exact owner; releaseAudio reports it when emit is true. */ }
  }

  private func endSession(reason: String, emit: Bool = true) throws {
    let id = sessionID ?? cleanupSessionID
    sessionID = nil // Ignore all late callbacks before cancelling the Apple task.
    captureDeadline?.cancel()
    finalDeadline?.cancel()
    captureDeadline = nil
    finalDeadline = nil
    var cleanupError: Error?
    do { try releaseAudio(emit: emit, id: id) }
    catch { cleanupError = error }
    request?.endAudio()
    recognitionTask?.cancel()
    recognitionTask = nil
    request = nil
    recognizer = nil
    stopping = false
    if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer) }
    if let observer = mediaResetObserver { NotificationCenter.default.removeObserver(observer) }
    interruptionObserver = nil
    mediaResetObserver = nil
    if emit, let id { sendEvent("onState", ["sessionId": id, "state": "ended", "reason": cleanupError == nil ? reason : "error"]) }
    if let cleanupError { throw cleanupError }
  }

  private func stopAudioEngine() {
    engine?.stop()
    if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
    engine?.reset()
    engine = nil
  }

  private func releaseAudio(emit: Bool = true, id: String? = nil) throws {
    stopAudioEngine()
    let audio = AVAudioSession.sharedInstance()
    do {
      if audioSessionActive {
        try audio.setActive(false, options: .notifyOthersOnDeactivation)
        audioSessionActive = false
      }
      if let previous = previousAudioSettings {
        try audio.setCategory(previous.0, mode: previous.1, options: previous.2)
        previousAudioSettings = nil
      }
      cleanupSessionID = nil
    } catch {
      if emit {
        sendEvent("onError", ["sessionId": id ?? sessionID ?? "", "code": "audio_cleanup_failed",
                               "message": "Audio session cleanup could not be confirmed."])
      }
      throw failure("audio_cleanup_failed", "Audio session cleanup could not be confirmed.")
    }
  }

  private func failure(_ code: String, _ message: String) -> Exception {
    Exception(name: code, description: message, code: code)
  }
}
