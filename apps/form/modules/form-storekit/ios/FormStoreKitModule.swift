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
  private var productConfiguration: UInt64 = 0
  private var productLookup: UInt64 = 0
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
    productConfiguration &+= 1
    productLookup &+= 1
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
    guard Set(ids).count == ids.count else { throw failure("invalid_products", "Requested products must be unique.") }
    productLookup &+= 1
    let lookup = productLookup, configuration = productConfiguration
    let products = try await Product.products(for: Set(ids))
    try requireProductLookup(lookup, configuration: configuration)
    var values: [[String: Any]] = []
    for product in products {
      let metadata = await subscriptionMetadata(product)
      try requireProductLookup(lookup, configuration: configuration)
      values.append(["id": product.id, "displayName": product.displayName, "description": product.description,
        "displayPrice": product.displayPrice, "price": NSDecimalNumber(decimal: product.price).stringValue,
        "currencyCode": product.priceFormatStyle.currencyCode, "type": product.type.rawValue,
        "subscriptionMetadata": metadata])
    }
    return ["products": values, "missingProductIds": ids.filter { id in !products.contains(where: { $0.id == id }) }]
  }

  private func requireProductLookup(_ lookup: UInt64, configuration: UInt64) throws {
    try requireConfigured()
    guard lookup == productLookup, configuration == productConfiguration else {
      throw failure("products_stale", "Product lookup was superseded or reconfigured.")
    }
  }

  private func unavailableMetadata(_ reason: String) -> [String: Any] {
    ["version": 1, "status": "unavailable", "reason": reason]
  }

  private func subscriptionMetadata(_ product: Product) async -> [String: Any] {
    switch product.type {
    case .consumable: return ["version": 1, "status": "not_applicable", "productKind": "consumable"]
    case .nonConsumable: return ["version": 1, "status": "not_applicable", "productKind": "non_consumable"]
    case .nonRenewable: return ["version": 1, "status": "not_applicable", "productKind": "non_renewing_subscription"]
    case .autoRenewable: break
    default: return unavailableMetadata("unsupported_product_type")
    }
    guard let subscription = product.subscription else { return unavailableMetadata("subscription_missing") }
    guard let period = serializedPeriod(subscription.subscriptionPeriod) else { return unavailableMetadata("unsupported_period") }
    guard !subscription.subscriptionGroupID.isEmpty else { return unavailableMetadata("invalid_metadata") }
    var introductoryOffer: [String: Any] = ["status": "none"]
    var eligibility = "unknown"
    if let offer = subscription.introductoryOffer {
      introductoryOffer = serializedOffer(offer)
      if !Task.isCancelled {
        let eligible = await subscription.isEligibleForIntroOffer
        if !Task.isCancelled { eligibility = eligible ? "eligible" : "ineligible" }
      }
    }
    return ["version": 1, "status": "available", "subscriptionGroupId": subscription.subscriptionGroupID,
      "period": period, "introductoryOffer": introductoryOffer, "introductoryOfferEligibility": eligibility]
  }

  private func serializedPeriod(_ period: Product.SubscriptionPeriod) -> [String: Any]? {
    guard period.value > 0, period.value <= 9_007_199_254_740_991 else { return nil }
    let unit: String
    switch period.unit {
    case .day: unit = "day"
    case .week: unit = "week"
    case .month: unit = "month"
    case .year: unit = "year"
    @unknown default: return nil
    }
    return ["unit": unit, "value": period.value]
  }

  private func serializedOffer(_ offer: Product.SubscriptionOffer) -> [String: Any] {
    guard offer.type == .introductory else { return ["status": "unavailable", "reason": "unsupported_offer_type"] }
    let mode: String
    switch offer.paymentMode {
    case .freeTrial: mode = "free_trial"
    case .payAsYouGo: mode = "pay_as_you_go"
    case .payUpFront: mode = "pay_up_front"
    default: return ["status": "unavailable", "reason": "unsupported_payment_mode"]
    }
    guard let period = serializedPeriod(offer.period) else { return ["status": "unavailable", "reason": "unsupported_period"] }
    guard offer.periodCount > 0, offer.periodCount <= 9_007_199_254_740_991,
      (mode == "pay_as_you_go" || offer.periodCount == 1), offer.price >= 0,
      (mode != "free_trial" || offer.price == 0), !offer.displayPrice.isEmpty else {
      return ["status": "unavailable", "reason": "invalid_metadata"]
    }
    return ["status": "available", "paymentMode": mode, "displayPrice": offer.displayPrice,
      "price": NSDecimalNumber(decimal: offer.price).stringValue, "period": period, "periodCount": offer.periodCount]
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
