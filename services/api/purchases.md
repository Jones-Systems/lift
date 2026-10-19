# Form Apple Sandbox purchase delivery

<!-- codex-section:begin id="interface.form-apple-sandbox-delivery#ctx.artifact-header.001" -->
Artifact Type: `interface-contract`

Artifact ID: `interface.form-apple-sandbox-delivery`

Purpose: Define cryptographically verified, durable Apple Sandbox delivery for Form's StoreKit coordinator.

Governing artifact: `spec.form-accounts-onboarding`

Specification owner: bounded PURCHASE implementation lane

Integration owner: ROOT MalcolmCodex, sole Git owner

Consumers: private Form API, entitlement authorization and `StoreKitDeliveryCoordinator`

Authority effect: none
<!-- codex-section:end id="interface.form-apple-sandbox-delivery#ctx.artifact-header.001" -->

<!-- codex-section:begin id="interface.form-apple-sandbox-delivery#iface.composition.001" -->
## Parent composition and dependency request

Use `src/purchases/index.ts` as the runtime composition root. Exact requested dependency: **`@apple/app-store-server-library: "3.1.0"`**, Apple-maintained, MIT. The parent owns the package, lock, installation and audit. No dependency installation was performed by this lane. Npm's version metadata returned integrity `sha512-d26SICRz8BwCV2qPR0BSXBMxmw0NEvJLwsdREcBmCrus8NmyHw2XgOOP0fiFjcctPn/JXtmSDuGVnaHe+dqO+A==`. The official `v3.1.0` tag resolves to `23dd5d868ab40740bf911908e2b86a5c02cccdb4`. [Apple library](https://github.com/apple/app-store-server-library-node/tree/23dd5d868ab40740bf911908e2b86a5c02cccdb4), [published package metadata](https://registry.npmjs.org/@apple%2fapp-store-server-library/3.1.0). Verified October 8, 2026; recheck on version, security or root-certificate changes.

Exports:

```ts
applePurchaseMigrationSql: string;
validateAppleConfiguration(value: unknown): Readonly<Required<AppleSandboxConfiguration>>;
parseAppleDeliveryRequest(value: unknown): AppleDeliveryRequest | null;
createAppleSandboxPurchases(db, configuration?) => {
  deliver(authenticatedAccountId, request): Promise<AppleDeliveryDecision>;
  entitlements(authenticatedAccountId): { grants: AppleEntitlementGrant[]; active: string[] };
  accountBinding(authenticatedAccountId): { accountId: string; appAccountToken: string } | null;
  capabilities(): { status: 'unconfigured' | 'configured_unverified'; environment: 'Sandbox';
    chargesEnabled: false; verification: 'apple_jws_offline'; onlineCertificateRevocation: false };
};
```

Configuration is absent/disabled by default. Enable only with an explicitly supplied actual bundle ID and actual product allowlist:

```ts
type AppleSandboxConfiguration = {
  bundleId: string;
  environment?: 'Sandbox'; // Omitted means Sandbox; every other environment is rejected at runtime.
  products: readonly {
    productId: string;
    type: 'Auto-Renewable Subscription' | 'Non-Consumable' | 'Non-Renewing Subscription';
    entitlement: 'form_plus';
  }[];
};
```

No bundle/product is invented or enabled by this module. Consumables and family sharing are unsupported. Subscription proofs must contain a verified expiration; non-renewing subscriptions without one are rejected. Non-consumables may have a null expiry. Configuration rejects unknown options, empty/duplicate products and every Production/XCODE/LOCAL_TESTING variant. Runtime requires a durable database, foreign keys ON and synchronous FULL. It expects the parent's WAL/busy-timeout configuration.

The source appends `{version: 6, sql: applePurchaseMigrationSql}` in `storage.ts`, preserving historical checksums and its backup/isolated-restore/integrity workflow. `migration.ts` owns additive purchase SQL only; it neither migrates a database on import nor edits storage. It adds private owners, transactions, observations, grants, commands and deliveries, preserving the existing promo-only `entitlement_grants` constraint. Do not silently apply ad hoc SQL to a live database.

Published source wiring in `server.ts` configures the factory, derives the account from the verified Form session, enforces request guards, exposes readiness and the stable account token, and unions Apple/promo grants in `/v1/entitlements`. `/v1/purchases/apple/verify` returns 501 while Apple configuration is absent; a configured source instance dispatches to the delivery module. `active` still reflects expiry/revocation rather than receipt existence. The full package test command includes `dist/tests/purchases/*.test.js`. Live signed transaction verification, real restore and charges remain unproved; this publication does not enable them.

`ApplePurchaseService` in `service.ts` is an explicitly trusted dependency-injection seam for synthetic tests. Runtime composition always creates the actual Apple verifier and offers no request/config verifier override. Synthetic success must never be reported as Apple cryptographic verification.
<!-- codex-section:end id="interface.form-apple-sandbox-delivery#iface.composition.001" -->

<!-- codex-section:begin id="interface.form-apple-sandbox-delivery#iface.delivery.001" -->
## Account, receipt and native-finish contract

`services/api/src/domain.ts` creates Form IDs with `randomUUID()`. The authoritative `form_accounts` mapping is immutable in storage. This supports **`appAccountToken = accountId`**, a canonical lowercase UUID v4. The server's authenticated mapping supplies `authenticatedAccountId` separately to `deliver`; body fields such as `accountId`, `appAccountToken`, `paid`, `verified` and any unknown fields are rejected. Native purchases must pass that stable UUID to StoreKit's `.appAccountToken` option. A signed proof missing the token is rejected, including historical transactions; this implementation grants no legacy account-binding exception.

Accepted body is exactly:

```ts
type AppleDeliveryRequest = {
  transactionId: string;
  productId: string;
  jwsRepresentation: string; // Exact StoreKit verification-result JWS, never reconstructed/decoded client JSON.
  idempotencyKey: string;    // Coordinator uses `storekit-delivery:${transactionId}`.
};
type AppleDeliveryDecision =
  | { status: 'delivered'; accountId: string; transactionId: string; productId: string; serverDeliveryId: string }
  | { status: 'rejected'; code: string }
  | { status: 'unknown'; code: string };
```

JWS is at most 60,000 ASCII characters within the parent's 64 KiB request limit. Numeric transaction IDs are bounded to 64 digits; the existing native coordinator imposes its tighter 20-digit limit. Product and idempotency-key bounds are 200 and 128 characters. If the parent also accepts an `Idempotency-Key` header, it must agree with the required body key.

The official verifier checks the Apple chain, signature, bundle and Sandbox environment; Form additionally requires ES256 and a three-certificate header, mandatory claims, matching request transaction/product, immutable account token, allowed product/type, PURCHASED ownership, quantity 1, bounded dates, expiration, revocation and upgrade state. Local device verification does not authorize a server grant.

Certificate verification precedes all ledger writes. Under one SQLite immediate transaction, the service rechecks account existence, locks original-transaction ownership, enforces immutable transaction identity, retains the exact verified proof, applies monotonic state, inserts a single grant and commits an exact-proof delivery receipt. Only after this commit can `delivered` be returned. Its four identity fields match the existing `StoreKitServerDecision`; native must validate the account/transaction/product/receipt, recheck the current account and local verification, then call `acknowledgeServerDelivery(transactionId, exactJws, serverDeliveryId)`. The native coordinator remains responsible for finish status. A server delivery is not evidence that native finish succeeded.

Commands bind `(account,key)` permanently to transaction/product intent. A key cannot be reassigned. Each cryptographically verified JWS hash gets a receipt bound to account, transaction, product and retained exact JWS. A refreshed signed proof for the same transaction may therefore use the coordinator's stable key while receiving a different proof-specific delivery ID; it does not create another grant. Exact replays, including a different key, reuse the original receipt while current state remains valid. Changed intent is rejected with `idempotency_mismatch`.

Received valid revocation/upgrade observations are sticky, including an older signed revocation proof. Earlier valid proofs cannot restore access. Observations and receipts remain private and retained. Newer signed transaction state advances; an unseen older proof cannot create a receipt/grant; equal signed dates with conflicting expiry fail closed. Expired/revoked/upgraded proofs may retain verified observations but never create a grant or delivery receipt. Previously issued grants become inactive immediately on known revocation/upgrade or clock expiry; replay then returns rejected rather than a stale success. The separate reconciliation source contract below adds verified notification observations and bounded history pages. Renewal information is evidence only; no billing-grace extension, refund reversal or upgrade restoration is implemented.

Storage failure returns `unknown/purchase_storage_effect_unknown`, never `delivered`. A lost HTTP response after commit remains unknown to the caller; explicit matching redelivery re-verifies and reads durable state after restart. No module code schedules or automatically retries an ambiguous effect. Transient/unknown verifier failure also returns unknown without a grant. Rejection exposes no raw Apple exception, JWS, account email or receipt content. Parent logs must not retain signed transaction bodies.
<!-- codex-section:end id="interface.form-apple-sandbox-delivery#iface.delivery.001" -->

<!-- codex-section:begin id="interface.form-apple-sandbox-delivery#ctx.primary-evidence.001" -->
## Primary evidence and trust anchors

Apple's pinned implementation checks certificate paths/extensions and cryptographic signatures in `SignedDataVerifier.verifyAndDecodeTransaction`; its local-testing environments explicitly skip signature verification. This module hardcodes the library's Sandbox constructor and rejects local/production configuration before construction. `enableOnlineChecks=false` performs offline verification at the signed date. The verifier performs **no OCSP calls, purchase calls or authenticated Server API calls**. The separately injected history adapter below can call an already configured SDK client; no such runtime client is constructed or activated here. Offline verification cannot establish current certificate revocation or unobserved transaction refunds; this limitation is explicit in capabilities. Observed transaction revocation is enforced. [Apple verifier at v3.1.0](https://github.com/apple/app-store-server-library-node/blob/23dd5d868ab40740bf911908e2b86a5c02cccdb4/jws_verification.ts).

Public DER roots are embedded in `apple-roots.ts` with retrieval URL, byte length and SHA-256. They were fetched directly over HTTPS from the three root links on [Apple PKI](https://www.apple.com/certificateauthority/) on October 8, 2026. Constructor readback checks byte identity, CA status and self-signature. No private key, account store, auth store or protected capture was read.

| Public Apple root | Bytes | SHA-256 | Direct primary source |
| --- | ---: | --- | --- |
| Apple Inc. Root | 1,215 | `b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024` | [Apple DER](https://www.apple.com/appleca/AppleIncRootCertificate.cer) |
| Apple Root CA G2 | 1,430 | `c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050` | [Apple G2 DER](https://www.apple.com/certificateauthority/AppleRootCA-G2.cer) |
| Apple Root CA G3 | 583 | `63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179` | [Apple G3 DER](https://www.apple.com/certificateauthority/AppleRootCA-G3.cer) |

The supplied App-Development path is absent. Its required immutable object was read instead from `/path/to/Form` at `948e6f60fec18f09ef713a135ee0752ed6e31983`: applicable root `AGENTS.md`, `README.md`, `docs/README.md`, Apple delivery README and `docs/delivery/apple-app-store/sources.md` S20/S21/S22/S34/S36. No nested delivery AGENTS exists in that tree. Those September research/provisioning proposals and incomplete evidence examples do not prove Form runtime delivery. S22 requires verified renewal state for grace periods; this module gives none. S34 motivates verified transaction reconciliation but supplies no hardcoded retry promise. S36's signing-key authority is unnecessary for this offline seam.

Core's required immutable `4db43e53c9855ad54a89032e0d274ee3727fc5ea` was available in `/path/to/Form` with the canonical origin; the older supplied checkout path is absent. Form's exact pinned Core instructions were read there. Graphify supplied older navigation pointers with qualified freshness/coverage; immutable current source established the facts.

Architecture-screen facts for parent incorporation in its existing Engineering Spec: direct consumers are the private session-authenticated endpoint, server entitlement authorization, SQLite migrations and native StoreKit coordinator. Native owns purchase observation/finish; Apple owns signed claims; API owns verification and immutable account mapping; this module owns atomic private ledger/receipt state; ROOT owns schema/runtime/transport composition. Persisted receipts cross process/restart and native/server boundaries. Hidden consumers include existing promo-only entitlement aggregation and its nullable-expiry handling, capabilities, nested test discovery and request limits. The initial delivery slice did not include notifications/history; the separate reconciliation increment below supplies source without mounting a producer or history client. No other-app or production consumer is activated. Parent integration and native end-to-end checks remain required. The lane launched no children under its explicit no-orchestration scope.
<!-- codex-section:end id="interface.form-apple-sandbox-delivery#ctx.primary-evidence.001" -->

<!-- codex-section:begin id="interface.form-apple-sandbox-delivery#verify.evidence.001" -->
## Verification and external activation gates

Affected inner-loop scope is `tests/purchases/purchases.test.ts`, compiled by the parent API build, then run serially from `services/api`:

```sh
npm run build
node --test --test-concurrency=1 dist/tests/purchases/*.test.js
```

**Historical initial-delivery implementation result: not run.** At that initial checkpoint the root had not granted a CPU/build/test window, and the new Apple dependency was not installed by that lane. The later focused qualification below supersedes the unrun compiler/test status for the affected purchase union. During implementation the parent had observed terminal failed runs and supplied no CPU window; a later accepted parent message is not a test grant. No compilation, test pass, audit pass, database migration or runtime success is claimed. Parent must install the exact dependency, grant the window, take fresh same-host admission and execute the affected checks before accepting this module. Its final affected union must include backend HTTP/database migration/backup and native coordinator integration tests. Source inspection is separate from those checks.

The authored tests cover strict configuration, root-byte checks, absent authentication/client ownership, malformed/unsigned/invalid signatures, bundle/environment/product/account/date/ownership policy, subscription expiry, non-consumables, receipt identity/exact JWS, deduplication, key mismatch, refreshed/stale proofs, monotonic revocation/upgrade, clock expiry, close/restart, overlapping requests on independent SQLite connections, lost-ack replay, atomic rollback on receipt failure, verifier unknown state and account disappearance during verification. Negative crypto tests use the actual library with forged certificate-bearing ES256 data; successful policy/state tests use a clearly labeled injected **synthetic** verifier. They do not claim Apple-valid fixtures. A positive real Apple-signed Sandbox test is explicitly skipped because no licensed, provisioned Form proof is supplied. Independent-connection overlapping requests prove the asynchronous application seam and database uniqueness; simultaneous separate-process contention is unverified.

Disk fixtures stay in unique `tests/purchases/.scratch/purchase-*` roots, opened only by the executing test, and close their captured handles/remove their exact root in teardown and handled SIGINT/SIGTERM. No `/tmp` is used. Unconditional process/host termination cannot run cleanup. The source/test directory remains the lifetime owner; empty scratch parents may remain. No per-lane Mac source or build/output tree was created.

Actual Sandbox activation still requires owner-supplied product/bundle configuration, active Developer Program/commercial prerequisites, App Store Connect products, an appropriate Sandbox Apple Account, an authorized development-signed device or TestFlight build and successful product lookup/purchase. Sandbox produces no actual charges; this lane made no external purchase or account/API call. [Apple Sandbox testing](https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox), [TestFlight purchase testing](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testing-subscriptions-and-in-app-purchases-in-testflight).

Provisioning sequence for ROOT: (1) install/pin/audit the requested library and run the serial source checks; (2) integrate the additive migration and verify populated upgrade/backup/restore; (3) bind exact authorized bundle/products and session-derived token; (4) wire delivery and authoritative entitlement aggregation with HTTP ownership tests; (5) reuse the single Mac source/output binding already owned by ROOT; (6) exercise product lookup, Sandbox purchase, exact signed-JWS verification and committed receipt readback; (7) verify native finish follows matching server receipt; (8) verify restoration/renewal/revocation and restart with supplied real evidence. No successful signed proof, product provisioning, native build, finish, Sandbox activation or production readiness is claimed here.

Original Form task and additive B1 remain authoritative in `docs/workstreams/form-accounts-onboarding/request.json` and `clarification-b1.json`; the Malcolm-only routing correction remains in `provider-routing-correction.json`. This bounded seam does not reduce the original fully working native/backend objective. External gates are unfinished work for ROOT, not a claim of completion. The implementation lane edits only `services/api/src/purchases/**`, `services/api/tests/purchases/**` and this file; it performs no Git/index operation, sudo, deployment, shared cleanup, installation, native build or charge.
<!-- codex-section:end id="interface.form-apple-sandbox-delivery#verify.evidence.001" -->

<!-- codex-section:begin id="interface.form-apple-sandbox-delivery#iface.reconciliation.001" -->
## Verified notification and owner reconciliation source

This increment is bound to the accepted FORM membership purchase-reconciliation contract. It reuses SDK 3.1.0, existing configured products, immutable original ownership and the original purchase ledger. It introduces no product IDs, prices, native activation, framework replacement or entitlement-restoration policy. WS11 owns `src/purchases/**`, `tests/purchases/**` and this guide; WS01 owns shared composition, producer routes, lifecycle authority and migration registration.

Additional runtime exports from `src/purchases/index.ts`:

```ts
applePurchaseReconciliationMigrationSql: string;
createAppleHistoryReader(client: Pick<AppStoreServerAPIClient, 'getTransactionHistory'>): AppleHistoryReader;
createAppleSandboxReconciliation(db, configuration: AppleSandboxConfiguration | undefined, ports: AppleReconciliationPorts): {
  forOwner(actor: AccountContext): OwnerReconciliation;
  ingestNotification(signedPayload: string): Promise<NotificationOutcome>;
};
type PurchaseOwner = Readonly<{
  accountId: string; appAccountToken: string; originalTransactionId: string;
  bundleId: string; environment: 'Sandbox';
}>;
type ReconciliationCheckpoint = Readonly<{ handle: string; expectedPage: number }>;
type OwnerReconciliation = Readonly<{
  reconcileOwner(owner: PurchaseOwner, checkpoint: ReconciliationCheckpoint): Promise<ReconciliationOutcome>;
  readReconciliation(handle: string): ReconciliationOutcome | null;
}>;
type ReconciliationOutcome = Readonly<{
  status: 'complete' | 'pending' | 'rejected' | 'unavailable' | 'unknown';
  handle: string; committedPage: number | null; transactions: number; reason: string | null;
}>;
type NotificationOutcome = Readonly<{
  status: 'observed' | 'rejected' | 'unavailable' | 'unknown';
  notificationId: string | null; reason: string | null;
}>;
```

`PurchaseOwner` fields are assertions against an **existing installed** owner/transaction binding, never authority supplied by a request body. The original account/token, original transaction, bundle and Sandbox environment must all agree. The module cannot establish a new owner through a notification or history response. `forOwner` synchronously copies all four authenticated coordinates (`accountId`, `authUserId`, `sessionId`, `epoch`). The run persists that original binding. Every read checks currentness before lookup and before returning; a foreign account sees no run, and a replacement session cannot inherit a run. The caller retains a stable UUID handle and zero-based expected page. Returned objects are copies and contain no raw proofs, session coordinates or provider cursor.

`AppleReconciliationPorts` requires `ownerWriter`, and optionally accepts `history` and `backgroundWriter`. `ownerWriter` structurally consumes the existing canonical writer's `lifecycle.assertActive`, `lifecycle.withActiveWrite`, `assertWithinWrite` and `lifecycleStoreOptions.assertRootWriter(candidateDb)`. All owner commits are synchronous effects admitted by that original actor on the exact database; neither a bare transaction nor `assertAccountActive` substitutes for admission. Network and cryptographic awaits occur before that write frame; currentness and installed ownership are checked again inside it.

`backgroundWriter` has a deliberately distinct contract:

```ts
type PurchaseBackgroundWriter = Readonly<{
  capture(owner: PurchaseOwner): Readonly<{
    assertCurrent(): void;
    withWrite<T>(effect: () => T): T;
    assertWithinWrite(candidate: Sqlite): void;
  }>;
}>;
```

Only trusted shared composition may provide it. Capture must bind the installed owner and its current lifecycle generation; admission must prove the same database, synchronous transaction and continued lifecycle authority before and after effects. A provider notification is not a session, so no actor is fabricated. **The canonical writer currently supplies no such provider frame.** Without this port, `ingestNotification` returns `unavailable/purchase_background_writer_required` before verification and writes nothing. Accepting this interface does not implement or qualify the missing shared authority. Suppression/purge registration remains WS01 work; no purge executor or deletion of retained purchase evidence is introduced.

The runtime factory constructs the official offline Sandbox verifier and requires durable SQLite when configured. Unconfigured factories stay unavailable. Trusted tests inject synthetic verifier/history ports through `ApplePurchaseReconciliation`; those types establish no runtime cryptographic proof. `createAppleHistoryReader` accepts an already configured SDK client, constructs no credentials/client, and calls `getTransactionHistory(originalTransactionId, revision, {}, GetTransactionHistoryVersion.V2)` explicitly on each page. The empty parameter set stays fixed across cursors and does not filter out revocations. SDK 3.1.0 defaults to V1 if that argument is omitted. [Pinned official client](https://github.com/apple/app-store-server-library-node/blob/23dd5d868ab40740bf911908e2b86a5c02cccdb4/index.ts#L383-L422).

One call fetches at most one SDK history page (20 transactions). Each signed transaction must independently match the original token **and lineage**, even though Apple's endpoint returns customer-wide history. Mixed-lineage pages reject as a whole; this is a conservative source limitation, not a claim that Apple filters by lineage. Envelope bundle/environment are also checked. Transaction/renewal JWS limits remain 60,000 characters; the notification envelope limit is 240,000 to accommodate two nested bounded proofs and encoding overhead. Cursor length is capped at 4,096 characters as a source transport bound. Empty pages claiming more data, nonadvancing continuation cursors and oversize pages reject. These are bounded-work constraints, not commercial rules.

The whole page is verified before ledger application. One canonical transaction applies ledger state, the next cursor, immutable page fingerprint and durable outcome. A policy-rejected item rolls back the entire page savepoint and records only the rejected page outcome. Repeating a committed checkpoint reads its original outcome without fetching/reapplying. Overlapping fetches returning different signed page bytes cannot replace the first committed page. Handles cannot be rebound to a different owner or actor. Transport/verifier uncertainty returns `unknown` without automatic retries; if no page committed, readback returns null or the previous committed outcome. A caller must reconcile the retained handle/page before choosing an explicit retry; `unknown` is never success. Counts are per committed page, bounded to 20; rejected pages apply zero transactions.

Notification ingestion independently invokes Apple's `verifyAndDecodeNotification`, `verifyAndDecodeTransaction` and, when supplied, `verifyAndDecodeRenewalInfo`. It correlates the verified nested token/lineage/environment and rejects malformed or unsupported envelopes. The canonicalized notification UUID and SHA-256 of the exact signed payload detect duplicates and collisions. Matching duplicates return the stored outcome; a UUID with changed bytes rejects. Only existing immutable ownership can admit the atomic observation/outcome write. Renewal-only evidence is retained without changing grants or expiry. `REFUND_REVERSED` is recorded as policy-unavailable without restoration. The existing `permanent_apple_purchase_revocation` trigger, sticky upgrade policy and clock expiry remain unchanged. No grace extension or upgrade restoration is inferred.

`ApplePurchaseService.observeVerified` is an internal trusted seam shared with delivery policy. It requires an admitted transaction and existing ownership, validates the same configured transaction claims, and applies the same monotonic state. Eligible verified transaction observations can contribute the existing `form_plus` grant; revoked, upgraded, expired and stale observations cannot newly grant. Reconciliation never creates native delivery receipts or client delivery commands, never signals native finish, and never treats renewal settings as paid access.

The unnumbered additive SQL export creates only `apple_purchase_reconciliations`, `apple_purchase_reconciliation_pages` and `apple_purchase_notifications`, with account/lineage foreign keys and immutable binding/page/notification updates. Import performs no DDL. **Do not edit or renumber the existing purchase migration.** WS01 must assign a new migration, preserve historical checksums, apply its backup/restore/integrity workflow, and register lifecycle/export/suppression handling before mounting these private retained records. Owner/session bindings, exact signed payloads and provider cursors are private data, excluded from public outcomes. Runtime charges remain disabled and positive Apple/native proof remains unverified.
<!-- codex-section:end id="interface.form-apple-sandbox-delivery#iface.reconciliation.001" -->

<!-- codex-section:begin id="interface.form-apple-sandbox-delivery#verify.reconciliation.001" -->
## Reconciliation affected checks and evidence limits

The bounded group `form-api-purchase-reconciliation` is `tests/purchases/reconciliation.test.ts`; its affected union `form-api-purchases` also includes the unchanged `tests/purchases/purchases.test.ts`. The new module contains 21 authored cases; the union contains 36 declared cases, including the original single explicitly skipped real-Apple positive-proof gate. Coverage includes official-adapter negative proofs, V2 dispatch, missing authority, nested owner fences, notification replay/collision, immutable unknown ownership, renewal-only/no-grace behavior, permanent revocation/upgrade, bounded pagination, lost-ack readback, customer-history isolation, policy rollback, verifier uncertainty, original-session fencing, storage rollback, overlapping page conflict, cursor bounds and exact-database admission.

No new test creates filesystem scratch: each fixture immediately registers teardown for its in-memory SQLite handle. The unchanged delivery suite still owns its documented disk scratch. Shared schema, routes, installed dependencies and operational migration are outside this increment. The implementation lane ran no checks or live Apple requests. The coordinator subsequently ran the exact focused checks below under a named WS07 serial grant; no dependency installation or live Apple request occurred. New behavior uses an in-memory synthetic authority and synthetic verifier/client; it does not qualify the shared provider writer, real signed positive proofs, disk/restart migration, or live notifications/history.

The coordinator executed these focused compiler and runner commands from `services/api`:

```sh
node node_modules/typescript/bin/tsc --ignoreConfig --target ES2023 --module NodeNext --moduleResolution NodeNext --lib ES2023,DOM,DOM.Iterable --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --esModuleInterop --skipLibCheck --rootDir . --outDir dist tests/purchases/purchases.test.ts tests/purchases/reconciliation.test.ts
node --test --test-concurrency=1 --test-isolation=none dist/tests/purchases/purchases.test.js dist/tests/purchases/reconciliation.test.js
```

These commands require the bound TypeScript 7.0.2 CLI, Node 24+, better-sqlite3 13.0.3, Apple SDK 3.1.0 and their declared types. They do not use the `form-test-typescript` alias or source-hook/discovery runner. The compiler follows the two test roots and their source/type imports (including `storage.ts` type dependencies); WS07 admitted the serial commands, while WS11 owns the exact dependency-link cleanup and retained output lifetime. No blanket full-installation or missing-alias compatibility claim follows.

Qualification is bound to source commit `24b0ae14ee355765956a17ef252772af1f065b0d`: compiler exit 0; 36 actual tests, 35 passed, 0 failed, 0 cancelled, 1 explicitly skipped Apple-positive gate, 0 todo. Native session `62588` starts `9d7df8`, terminal `35741c` exit 0, and direct cleanup readback `ca6b65` establish both child exits and link absence. Fresh admissions before the two commands were CPU 2.49% / available RAM 39.55 GiB and CPU 0.63% / RAM 39.54 GiB; one full effective core represented 6.25%, serial ceiling 1. This evidence does not prove successful Apple cryptographic verification or native activation.

The approved read-only API donor was `/path/to/Form`. Installed versions were TypeScript 7.0.2, better-sqlite3 13.0.3, Apple SDK 3.1.0, Node types 24.19.1 and SQLite types 9.6.0. Source package SHA-256 `826620b4dd3495365922728adfef8305c04156bb56d5eb51f9dd0513c8a87087` and lock `eebbbca2644b14cc6b93aae2ce34674a48282726db95cdb9d545028e3e208040` matched donor declarations after excluding scripts and only the source's unused `form-test-typescript` alias and its one lock package. No alias was installed or consumed. Compiler CLI SHA-256: `2219f428a7e55aaf1f7ad85b9b0f0cf5078aeb76ccc9a7c6036c92d48f492ffd`.

Root authorized retained emissions only in the new task tree's `services/api/dist`, verified absent before compilation: 19 files, 121933 bytes; inventory SHA-256 `cb3367ef4c06b609d7a0a20727dd7f9f5ac7da7916e70cbc9e89b5b5bf45f554`. All emission mtimes lie in `1791725772392814174`–`1791725772396814187` nanoseconds since Unix epoch; full inventory is in terminal `35741c`. WS11 retains artifact custody; no recursive removal or `/tmp` use is authorized. The identity-checked temporary donor symlink was removed in `finally` after child exit, and existing disk fixtures removed their exact scratch children, retaining the empty parent. The old membership/design worktree was unchanged. Later guide-only evidence edits require no unchanged-source test rerun; canonical integration must compare the qualified source, tests and consumed dependency declarations before carrying this evidence forward.

Touched comments retain their local trust, synthetic-fixture, migration-owner and atomicity context (`keep near code`). The existing verifier-header comment moved intact to the shared decoder; no protected explanation was removed on an unproved structural-replacement claim. Existing guide statements about absent reconciliation were corrected while retaining the original operational and policy gates.
<!-- codex-section:end id="interface.form-apple-sandbox-delivery#verify.reconciliation.001" -->
