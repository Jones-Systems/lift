import Foundation
import UIKit
import ExpoModulesCore

struct PhotoScope: Equatable {
  let account: String
  let generation: Double
  let shell: String
  let photos: Purpose
  let derived: Purpose
  enum Purpose: Equatable { case sessionOnly; case retain(String) }

  init(_ value: [String: Any]) throws {
    guard Set(value.keys) == Set(["accountId", "generation", "shellSessionGeneration", "choices"]),
      let account = value["accountId"], let generation = value["generation"],
      let shell = value["shellSessionGeneration"] as? String, !shell.isEmpty,
      let choices = value["choices"] as? [String: Any], Set(choices.keys) == Set(["photos", "derived"]),
      let photos = Self.purpose(choices["photos"]), let derived = Self.purpose(choices["derived"]) else {
      throw Exception(name: "invalid_scope", description: "Original session and explicit choices are required.", code: "invalid_scope")
    }
    let fence = try PhotoLease(["leaseId": "scope-validation", "requestId": "scope-validation", "accountId": account, "generation": generation])
    self.account = fence.account; self.generation = fence.generation; self.shell = shell
    self.photos = photos; self.derived = derived
  }
  func matches(_ lease: PhotoLease) -> Bool { account == lease.account && generation == lease.generation }
  private static func purpose(_ value: Any?) -> Purpose? {
    guard let value = value as? [String: Any], Set(value.keys) == Set(["choice", "consentVersion"]),
      let choice = value["choice"] as? String else { return nil }
    if choice == "session_only", value["consentVersion"] is NSNull { return .sessionOnly }
    if choice == "retain", let version = value["consentVersion"] as? String,
      !version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, version.utf16.count <= 128 { return .retain(version) }
    return nil
  }
}

struct PhotoFrameReference: Equatable {
  let leaseID: String
  let frameID: String
  let view: String
  init(_ value: [String: Any]) throws {
    guard Set(value.keys) == Set(["leaseId", "frameId", "view"]),
      let leaseID = value["leaseId"] as? String, let frameID = value["frameId"] as? String,
      let view = value["view"] as? String, ["front", "side"].contains(view),
      !leaseID.isEmpty, leaseID.utf16.count <= 128, !frameID.isEmpty, frameID.utf16.count <= 128 else {
      throw Exception(name: "invalid_frame", description: "An exact opaque frame is required.", code: "invalid_frame")
    }
    self.leaseID = leaseID; self.frameID = frameID; self.view = view
  }
}
struct PhotoStoredFrame { let view: String; let data: Data }

// Token validity is independent of the serial camera queue. Main-queue image clearing may still be pending.
final class PhotoPreviewTicket {
  let id = UUID().uuidString
  let frame: PhotoFrameReference
  private let lock = NSLock()
  private var valid = true
  private weak var consumer: FormPhotoPreviewView?
  init(frame: PhotoFrameReference) { self.frame = frame }
  func attach(_ image: UIImage, to view: FormPhotoPreviewView) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard valid else { return false }
    if let previous = consumer, previous !== view { previous.clear(if: self) }
    consumer = view
    view.install(image, ticket: self)
    return true
  }
  func invalidate() {
    lock.lock(); valid = false; let previous = consumer; consumer = nil; lock.unlock()
    if let previous { DispatchQueue.main.async { [weak previous, weak self] in
      guard let self else { return }; previous?.clear(if: self)
    } }
  }
  var payload: [String: String] {
    ["leaseId": frame.leaseID, "frameId": frame.frameID, "view": frame.view, "previewId": id]
  }
}

final class PhotoPreviewRegistry {
  private let lock = NSLock()
  private var lease: PhotoLease?
  private var scope: PhotoScope?
  private var tickets: [String: PhotoPreviewTicket] = [:]
  private var frames: [String: PhotoFrameReference] = [:]
  func bind(_ lease: PhotoLease, scope: PhotoScope) {
    invalidateAll()
    lock.lock(); self.lease = lease; self.scope = scope; lock.unlock()
  }
  func register(_ frame: PhotoFrameReference, lease: PhotoLease, scope: PhotoScope) {
    lock.lock(); defer { lock.unlock() }
    guard self.lease == lease, self.scope == scope, frame.leaseID == lease.id else { return }
    frames[frame.view] = frame
  }
  func ticket(_ frame: PhotoFrameReference, lease: PhotoLease, scope: PhotoScope) -> PhotoPreviewTicket? {
    lock.lock(); defer { lock.unlock() }
    guard self.lease == lease, self.scope == scope, frame.leaseID == lease.id, frames[frame.view] == frame else { return nil }
    if let existing = tickets[frame.frameID] { return existing.frame == frame ? existing : nil }
    guard tickets.count < 2 else { return nil }
    let ticket = PhotoPreviewTicket(frame: frame); tickets[frame.frameID] = ticket; return ticket
  }
  func existing(_ id: String, frame: PhotoFrameReference, lease: PhotoLease, scope: PhotoScope) -> PhotoPreviewTicket? {
    lock.lock(); defer { lock.unlock() }
    guard self.lease == lease, self.scope == scope, let ticket = tickets[frame.frameID],
      ticket.id == id, ticket.frame == frame else { return nil }
    return ticket
  }
  func invalidate(_ lease: PhotoLease, frame: PhotoFrameReference?, scope: PhotoScope) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard self.lease == lease, self.scope == scope, frame == nil || frame?.leaseID == lease.id else { return false }
    if let frame {
      guard frames[frame.view] == frame else { return false }
      frames.removeValue(forKey: frame.view)
      guard let ticket = tickets[frame.frameID] else { return true }
      guard ticket.frame == frame else { return false }
      ticket.invalidate(); tickets.removeValue(forKey: frame.frameID)
    } else {
      for ticket in tickets.values { ticket.invalidate() }; tickets.removeAll(); frames.removeAll()
      self.lease = nil; self.scope = nil
    }
    return true
  }
  func invalidateAll() {
    lock.lock(); defer { lock.unlock() }
    for ticket in tickets.values { ticket.invalidate() }; tickets.removeAll(); frames.removeAll(); lease = nil; scope = nil
  }
}

// Bare native image producer. The READY consumer owns mounting, bounds, controls and screen layout.
final class FormPhotoPreviewView: UIImageView {
  private var ticket: PhotoPreviewTicket?
  private var renderGeneration: UInt64 = 0
  override init(frame: CGRect) { super.init(frame: frame); contentMode = .scaleAspectFit }
  required init?(coder: NSCoder) { super.init(coder: coder); contentMode = .scaleAspectFit }
  func install(_ image: UIImage, ticket: PhotoPreviewTicket) { self.ticket = ticket; self.image = image }
  func clear(if expected: PhotoPreviewTicket) { if ticket === expected { clear() } }
  func clear() { renderGeneration &+= 1; image = nil; ticket = nil }
  func beginPreview() -> UInt64 { clear(); return renderGeneration }
  func accepts(_ stamp: UInt64) -> Bool { renderGeneration == stamp }
  override func didMoveToWindow() { super.didMoveToWindow(); if window == nil { clear() } }
}

// An OS prompt may outlive Form's scope. Settle this exact promise once and retain its identity until the OS callback retires.
final class PhotoPermissionRequest {
  let scope: PhotoScope
  let id: String
  let stamp: UInt64
  private let promise: Promise
  private var settled = false
  init(scope: PhotoScope, id: String, stamp: UInt64, promise: Promise) {
    self.scope = scope; self.id = id; self.stamp = stamp; self.promise = promise
  }
  func resolve(_ value: [String: String]) { guard !settled else { return }; settled = true; promise.resolve(value) }
  func reject() { guard !settled else { return }; settled = true; promise.reject("stale_session", "Permission result is no longer current.") }
}

// This bounded witness is independent of promise settlement and the serial camera queue.
final class PhotoPermissionRetirementRegistry {
  private let lock = NSLock()
  private var id: String?
  private var scope: PhotoScope?
  private var status = "unknown"
  func record(_ id: String, scope: PhotoScope, status: String) {
    lock.lock(); defer { lock.unlock() }
    self.id = id; self.scope = scope; self.status = status
  }
  func read(_ id: String, scope: PhotoScope) -> String {
    lock.lock(); defer { lock.unlock() }
    return self.id == id && self.scope == scope ? status : "unknown"
  }
}
