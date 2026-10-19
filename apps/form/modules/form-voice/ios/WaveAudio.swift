import AVFoundation
import CoreFoundation
import Foundation

enum VoiceAudioFailure: Error, Equatable {
  case invalidLimits, conversionFailed, captureLimit, emptyCapture, cancelled
}

struct VoiceCaptureLimits {
  static let hardBytes = 25_000_000
  let maxBytes: Int
  let maxDurationMs: Int
  let sampleRate: Int
  let maxFrames: Int

  init(_ input: [String: Any]) throws {
    func integer(_ key: String) throws -> Int {
      guard let number = input[key] as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID() else { throw VoiceAudioFailure.invalidLimits }
      let value = number.doubleValue
      guard value.isFinite, value > 0, value <= 9_007_199_254_740_991,
        value.rounded(.towardZero) == value else { throw VoiceAudioFailure.invalidLimits }
      return Int(value)
    }
    let bytes = try integer("maxCaptureBytes")
    let duration = try integer("maxCaptureDurationMs")
    let rate = try integer("sampleRate")
    let playback = try integer("maxPlaybackBytes")
    guard bytes >= 46, bytes <= Self.hardBytes, (bytes - 44) % 2 == 0,
      playback <= Self.hardBytes, rate == 16_000 || rate == 24_000 else { throw VoiceAudioFailure.invalidLimits }
    let bytesPerSecond = rate * 2
    guard duration <= (bytes - 44) * 1000 / bytesPerSecond,
      (duration * bytesPerSecond + 999) / 1000 + 44 <= bytes else { throw VoiceAudioFailure.invalidLimits }
    maxBytes = bytes
    maxDurationMs = duration
    sampleRate = rate
    maxFrames = duration * rate / 1000
  }
}

enum WaveAudio {
  static func encode(_ pcm: Data, sampleRate: Int) throws -> Data {
    guard !pcm.isEmpty, pcm.count % 2 == 0, pcm.count <= VoiceCaptureLimits.hardBytes - 44 else {
      throw VoiceAudioFailure.emptyCapture
    }
    var wave = Data(capacity: pcm.count + 44)
    func u16(_ value: UInt16) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { wave.append(contentsOf: $0) }
    }
    func u32(_ value: UInt32) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { wave.append(contentsOf: $0) }
    }
    wave.append(contentsOf: "RIFF".utf8)
    u32(UInt32(pcm.count + 36))
    wave.append(contentsOf: "WAVEfmt ".utf8)
    u32(16); u16(1); u16(1)
    u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
    wave.append(contentsOf: "data".utf8)
    u32(UInt32(pcm.count))
    wave.append(pcm)
    return wave
  }

  static func hasSignature(_ data: Data) -> Bool {
    guard data.count >= 12 else { return false }
    return data.prefix(4).elementsEqual("RIFF".utf8)
      && data.dropFirst(8).prefix(4).elementsEqual("WAVE".utf8)
  }
}

// The tap processes synchronously; no unbounded queue of borrowed AVAudioEngine buffers exists.
final class VoiceCaptureBuffer: @unchecked Sendable {
  private let lock = NSLock()
  private let limits: VoiceCaptureLimits
  private let converter: AVAudioConverter
  private let outputFormat: AVAudioFormat
  private var pcm = Data()
  private var closed = false
  private var failed: VoiceAudioFailure?

  init(inputFormat: AVAudioFormat, limits: VoiceCaptureLimits) throws {
    guard inputFormat.sampleRate.isFinite, inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
      let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(limits.sampleRate),
                                channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: inputFormat, to: output) else {
      throw VoiceAudioFailure.conversionFailed
    }
    self.limits = limits
    self.converter = converter
    self.outputFormat = output
    converter.primeMethod = .none
    pcm.reserveCapacity(limits.maxBytes - 44)
  }

  func append(_ input: AVAudioPCMBuffer) -> VoiceAudioFailure? {
    lock.lock(); defer { lock.unlock() }
    guard !closed, failed == nil else { return nil }
    let capacity = ceil(Double(input.frameLength) * outputFormat.sampleRate / input.format.sampleRate) + 64
    guard capacity.isFinite, capacity > 0, capacity <= Double(limits.maxFrames + 64),
      let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(capacity)) else {
      return fail(.conversionFailed)
    }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
      if supplied { inputStatus.pointee = .noDataNow; return nil }
      supplied = true
      inputStatus.pointee = .haveData
      return input
    }
    guard status != .error, error == nil else { return fail(.conversionFailed) }
    return store(output)
  }

  func finish() throws -> Data {
    lock.lock(); defer { lock.unlock() }
    if let failure = failed { throw failure }
    guard !closed else { throw VoiceAudioFailure.cancelled }
    closed = true
    // Drain resampler tail samples before constructing the complete WAV, never a partial frame stream.
    var drained = false
    for _ in 0..<8 {
      guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 1024) else {
        throw VoiceAudioFailure.conversionFailed
      }
      var error: NSError?
      let status = converter.convert(to: output, error: &error) { _, inputStatus in
        inputStatus.pointee = .endOfStream
        return nil
      }
      guard status != .error, error == nil else { throw VoiceAudioFailure.conversionFailed }
      if let failure = store(output) { throw failure }
      if status == .endOfStream { drained = true; break }
    }
    guard drained else { throw VoiceAudioFailure.conversionFailed }
    defer { pcm.removeAll(keepingCapacity: false) }
    return try WaveAudio.encode(pcm, sampleRate: limits.sampleRate)
  }

  func discard() {
    lock.lock(); defer { lock.unlock() }
    closed = true
    pcm.removeAll(keepingCapacity: false)
    converter.reset()
  }

  private func store(_ buffer: AVAudioPCMBuffer) -> VoiceAudioFailure? {
    let count = Int(buffer.frameLength)
    guard count > 0 else { return nil }
    guard count <= limits.maxFrames - pcm.count / 2,
      count * 2 <= limits.maxBytes - 44 - pcm.count else { return fail(.captureLimit) }
    guard let samples = buffer.int16ChannelData?[0] else { return fail(.conversionFailed) }
    pcm.append(UnsafeRawPointer(samples).assumingMemoryBound(to: UInt8.self), count: count * 2)
    if pcm.count / 2 >= limits.maxFrames || pcm.count + 44 >= limits.maxBytes { return fail(.captureLimit) }
    return nil
  }

  private func fail(_ failure: VoiceAudioFailure) -> VoiceAudioFailure {
    failed = failure
    closed = true
    pcm.removeAll(keepingCapacity: false)
    return failure
  }
}
