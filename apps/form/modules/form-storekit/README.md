# Form StoreKit bridge

Original Form-owned local Expo iOS module. Assumptions inspected October 8, 2026: Expo 57.0.26, ExpoModulesCore 57.0.20, React Native 0.86.3, iOS deployment target 16.4 or newer. Local module metadata/podspec and scoped Git ignore overrides are included. Default SDK 57 `./modules` autolinking discovers this module; no application package, config, backend, Git index or Mac output was changed here.

## Caller contract

`FormStoreKit` exposes availability/configure/product lookup/purchase, explicit restore, current entitlements, unfinished transactions, update observation and explicit server-delivery acknowledgment. Complete TS interfaces live in `../../src/native/storeKit.types.ts`. Product identifiers default to **unconfigured**, not invented products or prices. Parent supplies 1–32 unique allowed identifiers; only those can be looked up, purchased or finished. Display/decimal prices come from Apple product metadata.

Purchase requires a stable server-issued `appAccountToken` UUID for the authenticated Form account. Results preserve `pending`, `cancelled`, `unavailable`, transaction and unknown effects separately. A StoreKit purchase error after entering the flow is conservatively `unknown`; no automatic purchase retry occurs. Transaction IDs/original IDs remain decimal strings, including UInt64 values beyond JS safe integers. Dates use explicitly named epoch-millisecond fields. JWS environment is verified by the server, never selected by an untrusted device flag.

Every verified/unverified transaction result carries **that VerificationResult's** exact `jwsRepresentation`. Local verification is device evidence only; it never grants a paid/entitled flag. Reads, restore, purchase success and update delivery never call `finish()`. Unknown/disallowed/unverified states are retained for caller/server disposition. Reads are capped at 256 with explicit `truncated`; the in-memory proof-handle cache is capped at 256. Evicted handles remain in Apple's unfinished transactions until explicitly acknowledged. If a handle expires, re-read/reconcile the transaction rather than treating a failed acknowledgment as successful. Dispose stops the update task; unfinished Apple transactions survive JS/native reloads.

`FormStoreKitAdapter` is intended as one shared instance per authenticated session and allowlist. Configure it, attach the transaction observer, then explicitly read/reconcile unfinished/current entitlements to cover events arriving before JS subscribes. Removing a JS observer leaves the update stream alive until dispose; a future subscriber must reconcile the sequences. Restore is an explicit user action because `AppStore.sync()` may prompt for Apple authentication. Payments-disabled availability prevents purchases; reads/restore still have their own native error results.

## Authenticated server seam and finish ordering

Parent supplies `AuthenticatedStoreKitDelivery.currentAccount()` and `verifyAndDeliver(request, account)`; these callbacks own Form session authentication and backend transport. The account argument is a client binding for the authenticated transport, never permission to trust a caller-selected account_id. Use the actual Form account UUID returned by a verified server contract; no native/JS credentials are embedded in this lane.

`StoreKitDeliveryCoordinator.deliver(proof)` is explicit. It forwards the exact JWS, checks the allowed product and account-token binding, coalesces same-proof concurrent sends, preserves ambiguous effects, validates the returned account/product/transaction/delivery receipt, rechecks the active account and only then invokes `acknowledgeServerDelivery`. An unverified local proof can reach the server for adjudication, but remains unfinished even if the server returns delivery. Account changes, malformed acknowledgment or a failed finish remain distinguishable from known successful delivery.

The callback must verify Apple's chain/signature, expected bundle/environment and product/account ownership, handle expiration/revocation/current server entitlement state and durable transaction deduplication, and durably deliver before returning `status: delivered`. The callback's `idempotencyKey` is a transaction-based delivery identity; parent must use a distinct reconciliation operation or proof-bound identity when updated signed facts for that transaction must change server state. Parent also owns server notifications, authoritative entitlement reads and retry/reconciliation policy. Never grant entitlements based on device metadata or decode-only JWS.

Native `acknowledgeServerDelivery(transactionId, exactJws, serverDeliveryId)` requires a retained matching locally verified allowed-product proof and an explicit bounded receipt. That receipt is supplied by trusted JS composition; it is **not** native cryptographic proof of a Form server response. Raw native methods are internal capability boundaries, not public server endpoints. Native code calls `finish()` only inside this acknowledgment method. Finish failures preserve known delivery as `delivered_unfinished/finish_unknown`; no automatic replay is implemented.

## Parent integration/configuration

1. Local module under `apps/form/modules/form-storekit`, Expo Modules/CocoaPods autolinking and a rebuilt iOS binary. Adapters use exports from `expo`; no new JS package is required for this module.
2. For the native app target, select/verify Xcode's **In-App Purchase** capability and its actual bundle/signing/App Store Connect product identity. This bridge adds no custom Info.plist keys, config plugin or entitlement plist entry. Capability/account agreements and product provisioning are separate parent prerequisites; source presence proves none of them. Speech permission changes are described in the sibling module's README.
3. Supply the real allowlist from parent-owned configuration. App Store Connect, Apple sandbox/TestFlight and local Xcode StoreKit testing are distinct environments. The bridge contains no fake sandbox, no local promo entitlement, no environment override and no product/signing/provider credentials. Only the server can accept the explicitly configured verification environment; local Xcode proof must never masquerade as Apple sandbox proof.
4. Parent wires authenticated server callbacks, explicit delivery, update/restore/current-entitlement reconciliation and feature UI. Authenticated API facade availability does not prove a purchased-verification endpoint or stable account-token contract exists. No actual lookup, purchase, restore, credential/provider call or charge was performed.

## Qualification still required

See the sibling speech README for the exact Node/typecheck/autolinking commands. Source tests in `../../src/native/__tests__/storeKitDelivery.test.cjs` use synthetic proofs and callback/native seams only; they create no files and perform no external request. Node 24.19.0 is the observed VPS runtime and supports the direct `.ts` require/type stripping used by this pure coordinator test. They have **not run** pending the parent's serial turn.

No TS typecheck, autolinking resolution, Ruby/podspec compilation or Swift/native build was run in this lane. Native qualification must cover product misses, pending/cancel, verified/unverified results, interrupted/lost purchase response, restart with unfinished transactions, restore, renew/revoke updates, wrong-account/server rejection and proof-bound finish. Local StoreKit tests cannot prove sandbox/server-verification activation. Parent owns one reconciled Mac source/output tree, the disk/CocoaPods prerequisite, build logs and device evidence.

## Source-backed basis

Accepted Form native research/spec and applicable pinned Core/App-Development sources were read; the sibling speech README records exact revisions and loading limitations. App-Development September research remains proposal/reference evidence. Primary sources checked October 8, 2026:

- [Expo Modules API](https://docs.expo.dev/modules/module-api/) and [autolinking](https://docs.expo.dev/modules/autolinking/): maintained promise/event/lifecycle APIs and local discovery; installed ExpoModulesCore factories were inspected too.
- [Apple purchase](https://developer.apple.com/documentation/storekit/product/purchase(options:)) and [transaction](https://developer.apple.com/documentation/storekit/transaction): purchase results and Apple transaction ownership.
- [VerificationResult JWS](https://developer.apple.com/documentation/storekit/verificationresult/jwsrepresentation-21vgo): signed transaction proof belongs to the result, including its device verification context.
- [Transaction finish](https://developer.apple.com/documentation/storekit/transaction/finish()) and [unfinished](https://developer.apple.com/documentation/storekit/transaction/unfinished): acknowledge after delivery; recover unfinished transactions independently of the JS cache.
- [Transaction updates](https://developer.apple.com/documentation/storekit/transaction/updates) and [sandbox prerequisites](https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox): updates and actual test environment/account setup are separate qualification.

Selected Apple Markdown endpoints were read by bounded HTTPS when the web reader exposed a JS-only shell. Sources were summarized; no unlicensed/example implementation was copied into this module.
