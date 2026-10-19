import ExpoModulesCore
import StoreKit

public final class FormStoreKitModule: Module, @unchecked Sendable {
  // Accessed only by the main-actor tasks below; one native transaction owner.
  private var bridge: FormStoreKitSession?
  private var destroyed = false

  public func definition() -> ModuleDefinition {
    Name("FormStoreKit")
    Events("onTransaction", "onError")

    AsyncFunction("availability") { (promise: Promise) in
      self.perform(promise) { session in
        ["available": AppStore.canMakePayments, "reason": AppStore.canMakePayments ? "available" : "payments_disabled",
         "configured": session.isConfigured]
      }
    }
    AsyncFunction("configure") { (ids: [String], promise: Promise) in
      self.perform(promise) { session in
        try session.configure(ids)
        return ["configured": true]
      }
    }
    AsyncFunction("products") { (ids: [String], promise: Promise) in
      self.perform(promise) { session in try await session.products(ids) }
    }
    AsyncFunction("purchase") { (id: String, token: String, promise: Promise) in
      self.perform(promise) { session in try await session.purchase(id, token: token) }
    }
    AsyncFunction("currentEntitlements") { (promise: Promise) in
      self.perform(promise) { session in try await session.transactions(unfinished: false) }
    }
    AsyncFunction("unfinishedTransactions") { (promise: Promise) in
      self.perform(promise) { session in try await session.transactions(unfinished: true) }
    }
    AsyncFunction("restore") { (promise: Promise) in
      self.perform(promise) { session in
        try session.requireConfigured()
        try await AppStore.sync() // Explicit user action; may present Apple authentication.
        return try await session.transactions(unfinished: false)
      }
    }
    AsyncFunction("startObserving") { (promise: Promise) in
      self.perform(promise) { session in
        try session.startObserving()
        return ["observing": true]
      }
    }
    AsyncFunction("stopObserving") { (promise: Promise) in
      self.perform(promise) { session in
        session.stopObserving()
        return ["observing": false]
      }
    }
    AsyncFunction("acknowledgeServerDelivery") { (id: String, jws: String, receipt: String, promise: Promise) in
      self.perform(promise) { session in try await session.acknowledge(id, jws: jws, receipt: receipt) }
    }
    OnDestroy {
      Task { @MainActor in self.destroyed = true; self.bridge?.destroy() }
    }
  }

  private func perform(_ promise: Promise, operation: @escaping @MainActor (FormStoreKitSession) async throws -> [String: Any]) {
    Task { @MainActor in
      guard !self.destroyed else {
        promise.reject("module_destroyed", "StoreKit module was destroyed.")
        return
      }
      if self.bridge == nil {
        self.bridge = FormStoreKitSession { [weak self] event, body in self?.sendEvent(event, body) }
      }
      guard let bridge = self.bridge else { return }
      do { promise.resolve(try await operation(bridge)) }
      catch { promise.reject(error) }
    }
  }
}

@MainActor
private final class FormStoreKitSession {
  private var allowedIDs: Set<String> = []
  private var proofs: [String: VerificationResult<StoreKit.Transaction>] = [:]
  private var proofOrder: [String] = []
  private var updatesTask: Task<Void, Never>?
  private var purchaseActive = false
  private var finishing: Set<String> = []
  private var destroyed = false
  private let emit: (String, [String: Any?]) -> Void
  var isConfigured: Bool { !allowedIDs.isEmpty }

  init(emit: @escaping (String, [String: Any?]) -> Void) { self.emit = emit }

  func configure(_ ids: [String]) throws {
    guard !destroyed else { throw failure("module_destroyed", "StoreKit bridge was destroyed.") }
    guard !purchaseActive, finishing.isEmpty else { throw failure("busy", "A purchase or acknowledgment is in progress.") }
    guard !ids.isEmpty, ids.count <= 32, Set(ids).count == ids.count,
      ids.allSatisfy({ !$0.isEmpty && $0.count <= 200 && $0.rangeOfCharacter(from: .whitespacesAndNewlines) == nil }) else {
      throw failure("invalid_products", "Configure 1–32 unique product identifiers.")
    }
    allowedIDs = Set(ids)
  }

  func requireConfigured() throws {
    guard !destroyed else { throw failure("module_destroyed", "StoreKit bridge was destroyed.") }
    guard isConfigured else { throw failure("products_unconfigured", "No allowed products have been configured.") }
  }

  private func checkIDs(_ ids: [String]) throws {
    try requireConfigured()
    guard !ids.isEmpty, ids.count <= 32, ids.allSatisfy({ allowedIDs.contains($0) }) else {
      throw failure("product_not_allowed", "Requested product is not in the configured allowlist.")
    }
  }

  func products(_ ids: [String]) async throws -> [String: Any] {
    try checkIDs(ids)
    let products = try await Product.products(for: Set(ids))
    return ["products": products.map {
      ["id": $0.id, "displayName": $0.displayName, "description": $0.description,
       "displayPrice": $0.displayPrice, "price": NSDecimalNumber(decimal: $0.price).stringValue,
       "currencyCode": $0.priceFormatStyle.currencyCode, "type": $0.type.rawValue]
    }, "missingProductIds": ids.filter { id in !products.contains(where: { $0.id == id }) }]
  }

  func purchase(_ id: String, token: String) async throws -> [String: Any] {
    try checkIDs([id])
    guard let accountToken = UUID(uuidString: token) else { throw failure("invalid_account_token", "An authenticated account's stable UUID is required.") }
    guard AppStore.canMakePayments else { throw failure("payments_disabled", "Apple payments are disabled.") }
    guard !purchaseActive else { throw failure("busy", "Another purchase is in progress.") }
    purchaseActive = true
    defer { purchaseActive = false }
    // No retry: errors/cancellation after entering Apple's purchase flow have unknown effects.
    do {
      guard let product = try await Product.products(for: [id]).first else {
        return ["status": "unavailable", "productId": id]
      }
      guard !destroyed else { return ["status": "unknown", "productId": id] }
      switch try await product.purchase(options: [.appAccountToken(accountToken)]) {
      case .success(let result): return ["status": "transaction", "transaction": remember(result, source: "purchase")]
      case .pending: return ["status": "pending", "productId": id]
      case .userCancelled: return ["status": "cancelled", "productId": id]
      @unknown default: return ["status": "unknown", "productId": id]
      }
    } catch {
      return ["status": "unknown", "productId": id, "code": "purchase_effect_unknown"]
    }
  }

  func transactions(unfinished: Bool) async throws -> [String: Any] {
    try requireConfigured()
    var values: [[String: Any]] = []
    var truncated = false
    if unfinished {
      for await result in StoreKit.Transaction.unfinished {
        if destroyed { throw failure("module_destroyed", "StoreKit bridge was destroyed.") }
        if values.count == 256 { truncated = true; break }
        values.append(remember(result, source: "unfinished"))
      }
    } else {
      for await result in StoreKit.Transaction.currentEntitlements {
        if destroyed { throw failure("module_destroyed", "StoreKit bridge was destroyed.") }
        if values.count == 256 { truncated = true; break }
        values.append(remember(result, source: "entitlements"))
      }
    }
    return ["transactions": values, "truncated": truncated]
  }

  func startObserving() throws {
    try requireConfigured()
    guard updatesTask == nil else { return }
    updatesTask = Task { @MainActor [weak self] in
      for await result in StoreKit.Transaction.updates {
        guard !Task.isCancelled, let self, !self.destroyed else { break }
        self.emit("onTransaction", self.remember(result, source: "update"))
      }
    }
  }

  func stopObserving() { updatesTask?.cancel(); updatesTask = nil }
  func destroy() { destroyed = true; stopObserving(); proofs.removeAll(); proofOrder.removeAll() }

  private func remember(_ result: VerificationResult<StoreKit.Transaction>, source: String) -> [String: Any] {
    let transaction: StoreKit.Transaction
    let verification: String
    switch result {
    case .verified(let value): transaction = value; verification = "verified"
    case .unverified(let value, _): transaction = value; verification = "unverified"
    }
    let id = String(transaction.id) // UInt64 identifiers must never pass through JS Number.
    if proofs[id] == nil { proofOrder.append(id) }
    proofs[id] = result
    // A dropped in-memory handle remains recoverable through Apple's unfinished sequence.
    // Recovery never implies automatic delivery or finishing.
    if proofOrder.count > 256 { proofs.removeValue(forKey: proofOrder.removeFirst()) }
    return ["transactionId": id, "originalTransactionId": String(transaction.originalID),
            "productId": transaction.productID, "productType": transaction.productType.rawValue,
            "appAccountToken": transaction.appAccountToken?.uuidString.lowercased() as Any? ?? NSNull(),
            "purchaseDateMs": transaction.purchaseDate.timeIntervalSince1970 * 1000,
            "expirationDateMs": transaction.expirationDate.map { $0.timeIntervalSince1970 * 1000 } as Any? ?? NSNull(),
            "revocationDateMs": transaction.revocationDate.map { $0.timeIntervalSince1970 * 1000 } as Any? ?? NSNull(),
            "localVerification": verification, "productAllowed": allowedIDs.contains(transaction.productID),
            // The proof belongs to VerificationResult, including the unverified case.
            "jwsRepresentation": result.jwsRepresentation, "source": source]
  }

  func acknowledge(_ id: String, jws: String, receipt: String) async throws -> [String: Any] {
    try requireConfigured()
    guard !receipt.isEmpty, receipt.count <= 512, !jws.isEmpty,
      let result = proofs[id], result.jwsRepresentation == jws else {
      throw failure("delivery_ack_mismatch", "Acknowledgment must match a retained proof and server delivery receipt.")
    }
    guard case .verified(let transaction) = result else {
      throw failure("transaction_unverified", "An unverified transaction must remain unfinished.")
    }
    guard allowedIDs.contains(transaction.productID) else { throw failure("product_not_allowed", "Transaction product is not allowed.") }
    guard !finishing.contains(id) else { throw failure("busy", "This transaction is already being finished.") }
    finishing.insert(id)
    defer { finishing.remove(id) }
    // JS composition must bind this receipt to authenticated server verification AND delivery.
    // Neither reading a proof nor receiving a StoreKit success reaches this method implicitly.
    await transaction.finish()
    if proofs[id]?.jwsRepresentation == jws {
      proofs.removeValue(forKey: id)
      proofOrder.removeAll { $0 == id }
    }
    return ["finished": true, "transactionId": id, "serverDeliveryId": receipt]
  }

  private func failure(_ code: String, _ message: String) -> Exception {
    Exception(name: code, description: message, code: code)
  }
}
