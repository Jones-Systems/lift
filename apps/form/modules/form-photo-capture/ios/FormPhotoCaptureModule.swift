import ExpoModulesCore

public final class FormPhotoCaptureModule: Module {
  private let engine = FormPhotoLeaseEngine()

  public func definition() -> ModuleDefinition {
    Name("FormPhotoCapture")

    AsyncFunction("availability") { () -> [String: Any] in self.engine.availability() }
      .runOnQueue(engine.queue)

    AsyncFunction("acquire") { (lease: [String: Any], scope: [String: Any]?) -> [String: String] in
      try self.engine.acquire(lease, scope: scope)
    }.runOnQueue(engine.queue)

    AsyncFunction("capture") { (lease: [String: Any], view: String, scope: [String: Any]?, promise: Promise) in
      self.engine.capture(lease, view: view, scope: scope, promise: promise)
    }.runOnQueue(engine.queue)

    AsyncFunction("cancel") { (lease: [String: Any], scope: [String: Any]?) -> [String: String] in
      self.engine.cancel(lease, scope: scope)
    }.runOnQueue(engine.queue)

    AsyncFunction("permissionStatus") { (_scope: [String: Any]) -> [String: String] in
      self.engine.permissionStatus(_scope)
    }.runOnQueue(engine.queue)

    AsyncFunction("requestPermission") { (scope: [String: Any], id: String, promise: Promise) in
      self.engine.requestPermission(scope, id: id, promise: promise)
    }.runOnQueue(engine.queue)

    Function("permissionRetirement") { (operation: [String: Any]) -> [String: Any] in
      self.engine.permissionRetirement(operation)
    }

    AsyncFunction("preview") { (lease: [String: Any], frame: [String: Any], scope: [String: Any]) -> [String: String] in
      try self.engine.preview(lease, frame: frame, scope: scope)
    }.runOnQueue(engine.queue)

    AsyncFunction("retake") { (lease: [String: Any], frame: [String: Any], scope: [String: Any], promise: Promise) in
      self.engine.retake(lease, frame: frame, scope: scope, promise: promise)
    }.runOnQueue(engine.queue)

    Function("invalidatePreviews") { (lease: [String: Any], frame: [String: Any]?, scope: [String: Any]) -> [String: String] in
      self.engine.invalidatePreviews(lease, frame: frame, scope: scope)
    }

    View(FormPhotoPreviewView.self) {
      AsyncFunction("show") { (view: FormPhotoPreviewView, preview: [String: Any], scope: [String: Any], promise: Promise) in
        self.engine.showPreview(preview, scope: scope, in: view, promise: promise)
      }
      AsyncFunction("clear") { (view: FormPhotoPreviewView) in view.clear() }
    }

    OnAppEntersBackground { self.engine.invalidate(destroyed: false) }
    OnAppEntersForeground { self.engine.foreground() }
    OnDestroy { self.engine.invalidate(destroyed: true) }
  }
}
