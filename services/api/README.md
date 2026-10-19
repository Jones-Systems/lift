# Form private API

One Node 24+ Hono process with Better Auth 1.7.7 and better-sqlite3 13.0.3. This module owns source and deterministic synthetic verification. Service activation, provider provisioning, live migration and native delivery belong to the parent continuity owner.

## Build and checks

Run from `services/api`, under the parent’s exclusive serial check window and fresh same-host admission:

```sh
node scripts/install.mjs
npm run build
npm test
node scripts/audit.mjs
```

Installation runs `npm install --no-fund --no-audit` with a unique cache and `TMPDIR` below `.scratch`, removed on success, failure and handled cancellation. `node_modules` and `dist` are intentional task outputs, reused across checkpoints. Tests allocate unique `.scratch/http-*` and `.scratch/migration-*` roots, close database/listener handles and remove their exact root in `finally` and on SIGINT/SIGTERM. Unconditional host/process termination cannot run cleanup. Production audit evidence is retained in `evidence/npm-audit-production.json`; the script never applies updates. No `/tmp` scratch is required.

`createServer(config)` is exported by `src/server.ts` / `dist/src/server.js`. It returns `app`, `auth`, `domain`, `db`, `handleRequest(request, directPeerAddress)`, `migrationBackups` and `close()`. `handleRequest` replaces untrusted forwarded-IP headers with the direct peer address. Use it for an actual HTTP listener; `app.fetch` is the framework seam. The CLI handles SIGINT/SIGTERM and closes the listener before the database.

## Runtime configuration

The CLI requires these environment values; it neither searches for credentials nor installs a service:

| Variable | Contract |
| --- | --- |
| `FORM_DATABASE_PATH` | Absolute durable SQLite file outside API source and the Form application checkout, e.g. `/path/to/Form`. Existing path symlinks are resolved; an unrelated ancestor dotfiles repository does not define the application boundary. |
| `FORM_BASE_URL` | Exact origin: `http://localhost:8766` for the parent’s private route |
| `BETTER_AUTH_SECRET` | Explicitly supplied high-entropy secret of at least 32 characters; keep stable across restarts |
| `FORM_HOST` | Explicit listener address; parent’s private route is `127.0.0.1`; default `127.0.0.1` |
| `FORM_PORT` | Integer TCP port; default `8766` |
| `FORM_REGISTRATION` | Strict JSON `{"mode":"closed"}` (default), or `{"mode":"allowlist","emails":["approved@example.invalid"]}` |
| `FORM_PROMOS` | Strict JSON array of `{code,entitlement:"form_plus",days,maxRedemptions,expiresAt}`; default empty |
| `FORM_SOCIAL_PROVIDERS` | Strict JSON with optional `google:{clientId,clientSecret,disableSignUp?}` and `apple:{clientId,clientSecret,appBundleIdentifier?,disableSignUp?}`; default `{}` |
| `FORM_BROWSER_ORIGINS` | Strict JSON array of up to20 unique exact canonical HTTPS browser origins; default `[]`; no credentials/path/query/fragment/wildcard. HTTPS browser/API transport and actual cookie behavior must be qualified before web credentials are enabled |
| `FORM_PHONE` | Optional strict server-only managed Verify configuration; see [phone contract](phone.md). Absent means no SMS/check effects |
| `FORM_APPLE_PURCHASES` | Optional strict `{bundleId,products,environment?:"Sandbox"}` configuration; see [purchase contract](purchases.md). Absent means no purchase grants |
| `FORM_GROK_STT_ENABLED` | Default disabled; only literal `true` enables the supplied Grok adapter. Enabling is a separately authorized provider-usage effect |
| `FORM_GROK_STT_KEY` | Explicitly supplied xAI key, only needed when Grok is enabled; never sent to the app |

No promo is invented or enabled by default. Promo terms are immutable once configured, code comparison is case-insensitive, and capacity and grant insertion commit together. A matching replay returns the original grant; a new key cannot redeem the same promo twice for one account. Removing a promo from configuration does not revoke previously retained terms or grants; operational revocation needs an explicit future contract. No payment is charged.

The base origin and `formprivacy://` are trusted exactly. Additional `trustedOrigins` are strict canonical HTTPS browser origins, configured by `FORM_BROWSER_ORIGINS` or the server factory; malformed/non-HTTPS origins and wildcards are rejected before opening storage. The current API base and approved native scheme remain built-in. CORS exposes `set-auth-token` only to an allowed origin. Better Auth’s origin/CSRF checks remain enabled and cookie caching is disabled. Cookie-authenticated domain mutations require an allowed Origin; native signed bearer requests work without a browser Origin. Cookies retain Better Auth’s HttpOnly/SameSite=Lax defaults and Secure behavior derived from an HTTPS API base. Credentialed CORS is not a cross-site cookie override or TLS provisioning: use a qualified same-site HTTPS browser/API topology, or separately decide and test a different cookie topology before enabling browser credentials. The loopback tests send cookies explicitly and do not prove an actual browser cookie store or HTTPS deployment. Tailscale protects the parent’s private transport; this source does not provision Tailscale, certificates, DNS or public routes.

Parent-owned service template (review and recheck paths/address before activation):

```ini
[Unit]
Description=Form private API
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/Form
EnvironmentFile=/path/to/Form
ExecStart=/absolute/verified/node dist/src/cli.js
UMask=0077
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

The parent owns `/path/to/Form`, the state directory, restricted environment-file creation and unprivileged user-service lifecycle. The builder performs none of these operations. Node executable must be resolved by the operator rather than copied from an unverified example. Idle serving, request work and client rendering are separate workloads; no CPU usage promise is made.

## Native API contract

`POST /api/auth/sign-up/email` accepts `{name,email,password,callbackURL?,rememberMe?}` and `sign-in/email` accepts `{email,password,callbackURL?,rememberMe?}`. Passwords are 12–128 characters. Registration is independently gated in the route and auth user-creation hook. Read the signed `set-auth-token` response header and keep it in native SecureStore. Supply `Authorization: Bearer <signed-token>` on domain requests. The JSON body’s raw `token` is deliberately rejected by `bearer({requireSignature:true})`. `POST /api/auth/sign-out` revokes that session. Neither an email claim nor a client account ID creates a Form identity; the verified auth user maps to one immutable Form account.

Domain JSON resources are returned directly. Lists use `{items}`. Failures use `{error:{code,message,details?}}`. Missing/cross-account private resources return the same `404 not_found`. Strict schemas reject ownership, privilege, verification, payment and unknown fields. JSON requests are at most 64 KiB. Numeric canonical units are centimetres and kilograms; display-unit preferences never reinterpret stored kilograms.

| Routes | Request/response contract |
| --- | --- |
| `GET /v1/capabilities` | Public readiness report; source configuration alone never reports a provider as verified |
| `GET /v1/me` | `{accountId,appAccountToken,profile,preferences,onboarding}` |
| `GET /v1/me/settings` | Sanitized own identity/methods and supported Form-session actions; deletion unavailable, reminders preference-only, body privacy awaiting separate contract |
| `GET/PATCH /v1/me/profile` | `{revision,name,age,heightCm,weightKg,trainingBackground,injuryHistory,goals}`; PATCH sparse fields plus `expectedRevision` |
| `GET/PATCH /v1/me/preferences` | `{revision,appMode:"basic"|"advanced",loadUnit,heightUnit,coachVoice,communication,trainingDaysPerWeek,sessionMinutes,equipment,remindersEnabled}`; PATCH sparse fields plus `expectedRevision` |
| `GET/PATCH /v1/me/onboarding` | `{revision,step,answers,preferences,status,completedAt}`; PATCH `{expectedRevision,step,answers?,preferences?}` merges drafts |
| `POST /v1/me/onboarding/complete` | `{expectedRevision}`; atomic merge of draft profile/preferences and explicit completion |
| `GET /v1/exercises[/:exerciseId]` | Shared immutable catalog with provenance, required constraints and replaceable general-fitness cues |
| `GET/POST /v1/plans`, `GET/PATCH /v1/plans/:planId` | `{id,revision,name,minutes,items,archived,createdAt,updatedAt}`. Creation `{name,minutes,items:[{id,exerciseId,setTarget,repMin,repMax,targetKg}]}`; patch sparse fields plus revision |
| `POST /v1/plans/:planId/archive` | `{expectedRevision}`; creates a retained archived revision |
| `POST /v1/workout-sessions` | `{planId,expectedPlanRevision}`; snapshot plan and ordered exercise occurrences |
| `GET /v1/workout-sessions/:sessionId` | `{id,revision,planId,planRevision,status,planSnapshot,occurrences,sets,startedAt,completedAt}` |
| `POST /v1/workout-sessions/:sessionId/sets` | `{expectedRevision:sessionRevision,occurrenceId,setNumber,reps,weightKg,status:"draft"|"confirmed"}` returns `{set,sessionRevision}` |
| `PATCH /v1/workout-sessions/:sessionId/sets/:setId` | `{expectedRevision:setRevision,reps,weightKg,status}` returns `{set,sessionRevision}` |
| `POST /v1/workout-sessions/:sessionId/sets/:setId/void` | `{expectedRevision:setRevision}` returns `{set,sessionRevision}`; retains the original and corrected revisions |
| `POST /v1/workout-sessions/:sessionId/complete` | `{expectedRevision:sessionRevision}` returns session; never implicitly confirms drafts |
| `GET /v1/history?limit=20&before=...` | `{items,nextBefore}`; `nextBefore` is an opaque compound cursor, passed unchanged as `before`; limit 1–50 |
| `GET /v1/stats` | Confirmed-set totals and per-exercise volume; only `confirmed` counts, including active sessions. Volume is kg-repetitions; completed-session count is separate |
| `GET/PATCH /v1/exercises/:exerciseId/cue-preferences` | Personal `{revision,kept,rejected,order,replacementRequested}` plus immutable `requiredConstraints` and `availableCues`; request cannot rewrite/reject required constraints |
| `GET /v1/entitlements`, `POST /v1/promo-redemptions` | Redemption `{code}` returns `{grant,charged:false}`; entitlement response `{accountId,appAccountToken,grants,active,purchases}`; active grants are server-authoritative and Apple non-consumable expiry is nullable |

`Idempotency-Key` is required for every domain POST command and every set PATCH; Better Auth owns its separate `/api/auth` contract. Keep the caller’s key and payload unchanged after an uncertain response. Receipts retain `(account,operation,key,intent hash,result)` indefinitely in this first version. Authentication and parent/child authorization happen before receipt replay. Changed intent returns `409 idempotency_mismatch`. Stale mutation returns `409 stale_revision`; refresh before composing a new edit. Plan item IDs must be unique within a plan and cannot later identify a different exercise. Session occurrence IDs distinguish repeated exercises. A voided set remains retained and cannot be restored by ordinary PATCH; corrections preserve audit revisions.

Catalog names come only from Open Mat `apps/form/src/variants/a/generatedfixtures.ts` at imported source commit `9d3523697a0d1348c7a68e2178f4d1ec0d7813f0`. Provenance includes the source fixture item ID. API IDs are new stable canonical IDs, never reused. Retirement is a one-way database flag through a reviewed operator migration, not an account-level API. Retired exercises remain in historical snapshots/catalog and cannot be newly assigned to a plan. No demo account, performance, plan, workout history, or clinical/research instruction is seeded. General cues authored here do not promote retained scientific claims or prove movement-engine integration.

## External seams and remaining qualification

Google and Apple are wired to Better Auth through bounded configuration, including its provider-token lifecycle. Configuration reports `configured_unverified`; actual native OAuth/client audience, Apple bundle/nonce checks, callback provisioning and on-device flows require separate activation tests. Automatic email account linking is disabled. Private allowlist provisioning remains applicable. The managed [phone login module](phone.md) is composed into the actual auth handler, including durable bound challenges and the strict approved-subject creation guard. Its default is `unconfigured`; strict explicit provider configuration reports only `configured_unverified`. There is no fake OTP endpoint, real SMS qualification or automatic identity linking. Email recovery delivery is also unconfigured.

`POST /v1/transcriptions` accepts an authenticated `audio/wav` body and an idempotency key. The dormant adapter validates RIFF/WAVE, mono signed 16-bit PCM at a permitted sample rate, 2 MiB maximum and 60 seconds maximum, then claims a durable attempt before upload. It sends one multipart request to `https://api.x.ai/v1/stt` with `model=grok-voice-transcribe-2.0`, `language=en`, `file`, bounded response and a 30-second deadline. It stores text/outcome, never audio or provider keys. Success returns `{id,status:"succeeded",text,errorCode:null}`. `GET /v1/transcriptions/:attemptId` is private. Ambiguous send/response produces `409 transcription_outcome_unknown` with `attemptId`; restart or replay cannot upload the same attempt again. Tests use an injected synthetic fetch only. Key, usage authorization, budget and a real bounded transcription are absent; activation is unproved.

`POST /v1/purchases/apple/verify` accepts exactly `{transactionId,productId,jwsRepresentation,idempotencyKey}`. A supplied `Idempotency-Key` header must match. Malformed requests fail with `422`; valid requests fail closed with `501 purchase_verification_unconfigured` when configuration is absent. Explicit Sandbox composition uses Apple's pinned library 3.1.0 to verify the certificate chain/signature, bundle/environment, product allowlist and immutable account token before the module's atomic private ledger/receipt grant. Decisions are `delivered`, `rejected` or `unknown`; native finish follows only a matching committed receipt. No runtime synthetic verifier is accepted. Offline verification does not discover unreceived refunds or current certificate revocation. Production purchases, server notifications/history, grace periods and a real signed positive Sandbox proof remain unqualified. See the exact [purchase contract and limits](purchases.md).

`appAccountToken = accountId` is the server-created immutable UUID shared across native and website consumers. Automatic email-equality linking stays disabled. `/v1/entitlements` unions currently active zero-charge promo and cryptographically verified Sandbox grants with source provenance; a historical receipt never overrides expiry/revocation. Website billing ingestion is not implemented here. Basic/Advanced is one account-wide presentation preference, defaults to Basic, uses optimistic revisions and does not change entitlement authority or discard stored workout data. `remindersEnabled` is a saved preference; device permission, scheduling and delivery are separate. Account deletion and sensitive body retention require their own supported lifecycle contracts; ordinary document history is not a no-save store.

## Migrations, backup and recovery

Every SQLite connection uses foreign keys, WAL, `busy_timeout=5000` and `synchronous=FULL`. Migrations are ordered and checksummed; missing/unknown/changed applied migrations stop startup. The pinned auth schema is checked against Better Auth’s own migration inspection and mismatches require a reviewed migration, rather than an automatic unversioned auth change.

Before each pending migration on an existing database, SQLite’s backup API writes a unique `backups/before-<version>-<uuid>.sqlite` beside the live file. Backup is restored to a unique isolated sibling and checked for integrity/foreign keys before migration begins; the temporary restore is removed. Migration SQL, ledger and verification are transactional. Backups remain intentional operator-owned recovery artifacts. Current additive migrations: 1 auth/domain, 2 query indexes/history protection, 3 transcription attempts and immutable histories/snapshots, 4 one-way catalog retirement, 5 phone subjects/challenges, 6 Apple Sandbox ledger/receipts, 7 legacy preferences receive Basic mode with retained history and a new revision. Starting an already-current database creates no new migration backup and does not reset seeded entries or durable account data.

Operator commands after separate scope/target verification:

```sh
node dist/src/storage-cli.js check /path/to/Form
node dist/src/storage-cli.js backup /path/to/Form /path/to/Form
```

`backup` refuses an existing destination and verifies an isolated restore. Do not copy just a live WAL-mode database file as a backup. There is no live restore/reset endpoint or destructive migration helper. On startup/migration failure keep the service stopped, preserve the database and backups, and reconcile state. Recovery requires a parent-selected backup, stopped API, new isolated destination, integrity/foreign-key checks and synthetic auth/profile/history readback with outbound provider work disabled. Switching a service to a restored database or reverting source is a separately bound operational effect; the builder does not replace/delete live state or assume old source can read a newer schema. Keep the auth secret and source revision binding stable for meaningful session recovery.


## Account-scoped module source integration

The server factory supports actual ordered1..13 migrations when explicit canonical lifecycle/suppression authority and module bindings are supplied. The ordinary CLI still selects1..7; it does not provision a suppression ledger or silently activate the newer modules. `moduleMigrations.additions` requires actual Community extension12 and board13 together with `sourceRequestFactories.communityModules: "b2-b4-b5"`. Missing bindings fail closed. One Community lifecycle adapter composes parent groups, accountability extension and feature board; one Activity adapter covers owner-input activity. Purge qualification remains false, and the atomic reserved-friend token bridge is unavailable.

`sourceRequestFactories.activityCommands: "owner-input"` enables the authenticated Activity request lease, released in finally. Real legacy dataset eligibility is unqualified; no legacy reader is injected. Form-controlled no-save body data has no owner-input dispatch/transfer seam. Arbitrary external clients and intentional manual reentry cannot carry verifiable semantic lineage.

The configured feature board mounts at `/v1/community/board` after maintained authentication. Its own request-scoped service does not require a group invitation limiter; group invitations retain their separate required limiter. Pending submissions are visible only to their author. Submission requires explicit policy/audience acknowledgements and an idempotency key. Votes use the current feature revision; withdrawal uses the author's submission revision. Cross-account pending detail/vote/withdrawal is denied, same intent/key replay is stable, and revoked sessions cannot commit after a request body await. Board unknown paths terminate inside the namespace and do not fall through to group handlers.

Browse/detail/submit/vote/withdraw/own-submissions/own-votes and capabilities are mounted. Publication, moderator/steward merge/status actions and release evidence remain internal injected capabilities; no public admin endpoint or staffed moderation is invented. Missing publication/support/safety/retention ports leave the board pending-author-only. Critical feedback is not rejected merely for being negative. Free text has explicit bounded plain-text/link/markup validation; pending status is not permission to publish private health/account information. Account-wide Basic/Advanced, mascot and animation choices retain server revision semantics and do not grant entitlements.

Verification is synthetic maintained-auth handler and SQLite source evidence, not a live private service, real-user moderation, browser TLS/cookie, native UI or deletion/restore/purge proof.
