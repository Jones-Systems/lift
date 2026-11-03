# Form API client contract `form-api-client-contract/v1`

Bound source: Lift `build/lift` at `7b10e578d599a6ceeb726da794ecb62c03aa670d`. Paths are relative to `services/api/src/` unless they start with
`apps/`. Markers: **CURRENT** is true at the bound SHA (file:line given); **TARGET** is a planned additive change with its owner lane; **LIB** is
behaviour of the pinned `better-auth` 1.7.7 library rather than Form source; **REC** is a client recommendation, not server behaviour. Unmarked rows
in the tables are CURRENT. This note does not describe wire bodies owned by modules (Standard coaching turn, nutrition conversations, community/board
payloads); it fixes how every route authenticates, fails and is retried.

## 1. Scope and consumers

- Native app (`apps/form/src/api/*`, `account-lifecycle/api.ts`, `wearables/api.ts`, `activity/resources.ts`, `body/manualMeasurements.ts`): signed
  bearer tokens, `credentials:'omit'`, `redirect:'error'`, 15 s timeout (`apps/form/src/api/transport.ts:570-588`). CURRENT.
- Website (`apps/form-website/public/resource-client.mjs`): cookies (`credentials:'include'`) from an allowed browser Origin
  (`resource-client.mjs:128`). CURRENT.
- Default deployment stays disabled: the app embeds `http://127.0.0.1:9` (`apps/form/src/api/client.ts:5`). CURRENT.

## 2. Transport and authentication (CURRENT)

| Rule | Source |
| --- | --- |
| Sign in via `/api/auth/*`; read the signed token from the `set-auth-token` response header (exposed by CORS); send `Authorization: Bearer <token>`. A raw body `token` is rejected (`bearer({requireSignature:true})`). | `auth.ts:27`, `server.ts:242-247` |
| Every `/v1/*` route except `GET /v1/capabilities` and `POST /v1/account-deletion/status` needs a live session; `/health` is public. | `server.ts:257-311` |
| Cookie clients: every non-GET `/v1` request needs an allowed `Origin`; an untrusted Origin is `403 origin_not_allowed`, no Authorization and no Origin is `403 origin_required`. Bearer clients need no Origin. | `server.ts:288-292` |
| Allowed origins: the API base origin, `formprivacy://`, and configured HTTPS browser origins. CORS allows `GET, POST, PATCH, OPTIONS` and headers `Content-Type, Authorization, Idempotency-Key`. | `server.ts:128, 242-247` |
| JSON bodies need `Content-Type: application/json` (parameters allowed) else `415 json_required`; unparsable JSON is `400 invalid_json`. | `server.ts:85-88` |
| Body limit 64 KiB (`413 body_too_large`). Exceptions: `POST /v1/transcriptions` 2 MiB WAV (`transcription.ts:9`); `/v1/body/*` 4 KiB (`body/routes.ts:13,34`); `/v1/grounded-answers` own 64 KiB check (`server.ts:328`); `/v1/training-feedback*`, `POST /v1/coaching/standard/turn`, `/v1/nutrition/conversations/*` and `/v1/bug-reports*` (when mounted) apply module limits. | `server.ts:248-249` |
| Every response carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. | `server.ts:239` |
| Sessions last 7 days (`expiresInSeconds: 604800` in capabilities). | `auth.ts:25`, `server.ts:266` |
| After sign-in call `GET /v1/me` first: it creates the Form account mapping. Module routes (`/v1/body/`, `/v1/community/`, `/v1/activity/`, `/v1/nutrition/conversations/`, `/v1/coaching/standard/`, training feedback, bug reports) answer `403 account_not_initialized` until it exists. | `server.ts:297-307` |
| `GET /v1/capabilities` reports which providers/features are configured; use it to hide 501 features. | `server.ts:258-272` |

## 3. Success shapes (CURRENT)

Resources are returned directly (no wrapper). Collections are `{items}` (`server.ts:467,469`); history is `{items,nextBefore}` where `nextBefore` is
an opaque cursor passed back unchanged as `before`, `limit` 1-50 (`server.ts:517-521`). Creates return 201, other successes 200. Mutations on
revisioned resources return the new resource with its `revision`; set commands return `{set,sessionRevision}`. Units are kilograms and centimetres
(`server.ts:271`). Exceptions: `POST /v1/coaching/standard/turn` returns its own wire text; nutrition conversations return the module wire JSON,
including in-band `status:"unavailable"` results (`integration/nutrition-conversation/host.ts:89-102`); account export is a JSON attachment
(`server.ts:443-446`).

## 4. Error envelope

Canonical shape: `{"error":{"code":string,"message"?:string,"details"?:unknown}}`.

- `code` is the only stable machine key (snake_case). Map codes, then status class, to user copy. CURRENT.
- `message` is diagnostic English. It defaults to the code itself (`errors.ts:3`) and is **absent** in these CURRENT variants: community, extension
  and board routers (`community/routes.ts:44-46`, `community/extension-routes.ts:20`, `community/board/routes.ts:52-56`), bug reports
  (`bug-intake/routes.ts:39-41`), training feedback (`training-feedback/routes.ts:51-52`), body byte limits (`body/routes.ts:13,34`), community
  fallthrough `not_found` (`server.ts:354,365`) and `password_recovery_unavailable` (`credentials/proxy.ts:41`). Never show `message` verbatim to
  users.
- `details` is present only when the thrower supplied it (`server.ts:251`); community/board forward it only for `stale_revision`. Shape is
  code-specific (section 8).
- Unhandled errors are `500 internal_error` with no internals (`server.ts:252-254`); a `ZodError` outside request-body parsing is `422
  invalid_request` without details (`server.ts:252`). In the community, board, bug and training-feedback routers, unexpected errors become `503
  <module>_unavailable` instead.
- While the server is closing, `handleRequest` returns a bare `503` with no body (`server.ts:552`); inside the app it is `503 server_closed`
  (`server.ts:234`).
- `/api/auth/*` may use a different shape (section 9). Parse defensively: `code = body?.error?.code ?? body?.code ?? "http_" + status`. REC.

## 5. Status classes and client action

| Status | Meaning | Client action | Retry unchanged? |
| --- | --- | --- | --- |
| 400 | Malformed request (`invalid_json`, `idempotency_key_required`) | Client defect: generic toast, log code | No |
| 401 | No or invalid session | Clear session, re-authenticate; then the user repeats the action | No (not before sign-in) |
| 403 | Forbidden: origin, account state or module policy | Toast or account-state screen; `account_not_initialized`: `GET /v1/me` then retry once | No |
| 404 | Unknown route, missing **or other account's** resource, unmounted feature | Drop stale local reference, refresh the list | No |
| 409 | Conflict with current state | `stale_revision`: refresh and reapply; unknown-outcome codes: recover (section 7); others: toast | No |
| 413 | Body too large | Inline "too long" on the input; shrink | No |
| 415 | Wrong content type | Client defect | No |
| 422 | Validation or domain rule | Inline field errors when `details` paths exist, else form-level message | No |
| 429 | Rate or quota limit | Back off (section 8); never auto-retry SMS or reports | After backoff |
| 500 | Unexpected failure | Reads: retry with backoff. Writes: outcome unknown, resend same key and body | Yes (same key) |
| 501 | Feature not configured on this server | Hide/disable feature; check `/v1/capabilities` | No |
| 503 | Unavailable, closing, or integrity guard | Reads: backoff retry (max 3). Writes: same key and body, else "unavailable" | Limited |
| none | Timeout or network loss | Reads: retry. Writes: outcome unknown, resend same key and body | Yes (same key) |

Unknown codes fall back to their status class. REC: at most 3 automatic attempts, exponential backoff with jitter (1 s, 2 s, 4 s), and only while the
originating screen/session is current.

## 6. Validation details

CURRENT (`server.ts:85-92`): the shared body parser returns `422 invalid_request`, message `"Check the submitted fields."`, `details:
[{path:(string|number)[], message:string}]`. `path` mirrors the request JSON (`["items",0,"repMin"]`; `[]` for unknown keys or whole-body issues).
`message` is library English and unstable. Only this parser emits field details; every other 422 (path ids, `/v1/history` query,
`/v1/purchases/apple/verify`, `/api/auth/*`, module codes such as `community_invalid_input`) is form-level.

Client rule: highlight the field addressed by `path`, show your own copy for that field, and fall back to form-level copy when `path` is empty or
unknown.

TARGET (BE-E6, additive): each issue gains `code` (`invalid_type`, `too_small`, `too_big`, `invalid_format`, `invalid_value`, `unrecognized_keys`,
`custom`), optional `minimum`, `maximum`, `keys`, and `pointer` (RFC 6901); non-body Zod failures gain `details` with `in:"path"|"query"`. Existing
fields keep their meaning; clients ignore unknown fields.

## 7. Idempotency, revisions and retry

CURRENT receipt engine `command()` (`storage.ts:327-345`), used via `receipt()` (`server.ts:410-413`):

- Key: `Idempotency-Key` matching `^[A-Za-z0-9_.:-]{1,128}$` (a UUID works); missing or malformed is `400 idempotency_key_required`.
- Scope `(account, operation, key)`; operation includes path ids (`set.edit:<session>:<set>`). The intent is the canonical JSON of the validated body.
- Same key and intent replays the original status and body, even if the resource changed later. Same key with a different intent is `409
  idempotency_mismatch`.
- Account state and authorization run before replay, so a replay against a now-missing resource is 404.
- Only successes are stored. A failed attempt rolls back and does not consume the key.

Receipted routes (key required): `POST /v1/me/onboarding/complete`, `POST /v1/plans`, `POST /v1/plans/:id/archive`, `POST /v1/workout-sessions`, `POST
.../sets`, `PATCH .../sets/:setId`, `POST .../sets/:setId/void`, `POST .../complete`, `POST /v1/promo-redemptions`; `PATCH /v1/me/preferences` only
when a key is sent (`server.ts:456`). Own key handling: `POST /v1/plans/first`, `POST /v1/transcriptions` (records failed and unknown attempts too),
`POST /v1/purchases/apple/verify` (body `idempotencyKey` required; a header must equal it, else `409 idempotency_mismatch`, `server.ts:539-540`),
deletion requests, and module writes (activity, body, community, board, bug reports). Not receipted, revision-guarded only: `PATCH /v1/me/profile`,
`PATCH /v1/plans/:id`, `PATCH /v1/me/onboarding`, `PATCH /v1/exercises/:id/cue-preferences`.

Client rules (REC unless marked):

1. Send `Idempotency-Key` on every POST and PATCH. One key per user intent; keep key and body unchanged across retries after a timeout, network loss,
   500 or 503.
2. Never mint a new key to "retry" the same intent; mint a new key only when the payload changes.
3. `409 stale_revision` (CURRENT `errors.ts:9-11`): `details.revision` is the current server revision. GET the resource, reapply the user's change,
   resubmit with the new `expectedRevision` and a new key. Do not resubmit unchanged.
4. Revision-guarded PATCH with an unknown outcome: GET first. If the revision advanced and the fields equal the intended values, treat it as success;
   otherwise reapply as in rule 3.
5. `409 idempotency_mismatch`: client defect. Do not retry; log.
6. Unknown outcomes. Never treat these as success or failure:
   - `409 transcription_outcome_unknown`, `details:{attemptId}` (CURRENT `transcription.ts:58-59,98`): do not upload again (the key is permanently
     bound); read `GET /v1/transcriptions/:attemptId`; the user may record again under a new key. `transcription_failed` (503 first,
     `transcription.ts:79`; 409 on replay) is final for that key.
   - Purchase decision `200 {status:"unknown",code}` (CURRENT `purchases.md`, "Decision"): keep the StoreKit transaction unfinished and resend later
     with the same `idempotencyKey`; finish only after `delivered`.
   - `phone_outcome_unknown` (409, auth-shaped `{code,message}`, `phone/challenges.ts:67,168`) carries no `challengeId` or `resendAfter`. On
     challenge or resend an SMS may have been sent; on verify the code may have been consumed. The challenge is no longer usable (`:165`): resend or
     verify with a new key returns `409 phone_challenge_unavailable` (`:107,137`), and a new challenge returns `429 phone_challenge_cooldown` until
     10 minutes after the last send (`:7,85-86`). Never auto-resend; tell the user a code may still arrive and to try again later.
   - `deletion_effect_unknown`, `deletion_status_unknown` (503): re-read status; staged lifecycle only.
7. The native transport already flags network loss and non-GET 5xx as `effectUnknown` (`apps/form/src/api/transport.ts:592-595,610`) but not
   `transcription_outcome_unknown` (409). It drops `details` (`transport.ts:605-610`), so `details.revision` and `details.attemptId` are unavailable
   to callers today. The website maps every failure to `unauthenticated`/`conflict`/`request_failed` without reading `code`
   (`resource-client.mjs:133`). Client-side follow-ups belong to the client owners.

## 8. Specific statuses

- 401/403 (CURRENT): `unauthenticated` (`server.ts:287`), `account_session_invalid` (`server.ts:294`, `lifecycle/guards.ts:41`) and the 403 codes are
  listed in section 10. The native transport clears its session on any authenticated 401 (`transport.ts:602-604`).
- 404 `not_found` (CURRENT `errors.ts:8`, `server.ts:256`): identical for missing and cross-account resources; also unknown routes and unmounted
  features. Use `/v1/capabilities` to tell "feature off" from "gone". Malformed path ids are `422 invalid_request` (`server.ts:392`). Unauthenticated
  requests to unknown `/v1` paths get 401 because authentication runs first.
- 429 (CURRENT): Form source sets no `Retry-After` on `/v1`. REC: back off at least 60 s; for quotas (`community_*_quota`, `bug_intake_*_limit`) do
  not retry automatically. LIB: Better Auth's own `/api/auth` limiter (`auth.ts:32-34`) answers 429 and may send `X-Retry-After` seconds; honour it
  when present.
- 503 (CURRENT): no `Retry-After`. Codes ending `_unavailable`, `_required`, `_held`, `_unproved` or `_invalid` describe missing composition or
  integrity guards: show "temporarily unavailable" and stop.
- TARGET (BE-E6, additive): `Retry-After` (seconds) on every 429 and transient 503, mirrored as `details.retryAfterSeconds`; a `retryable` boolean in
  `details` for 503 guards; a `message` on every router variant; `X-Request-Id` on all responses for support reports.

## 9. `/api/auth/*` (Better Auth) differences

All auth routes go through `credentials/proxy.ts`, which allows only listed routes (`proxy.ts:26-32`).

| Case | Body | Source |
| --- | --- | --- |
| Unsupported auth route | `404 {error:{code:"not_found",message}}` | `proxy.ts:36` |
| Password recovery unconfigured | `501 {error:{code:"password_recovery_unavailable"}}` | `proxy.ts:40-41` |
| Proxy validation and gates | Form envelope: `415 json_required`, `400 invalid_json`, `422 invalid_request` (no details), `403 registration_unavailable`, `403 account_disabled` | `proxy.ts:44-54`, `server.ts:250-251` |
| Proxy-synthesized Better Auth style | top-level `{code,message?}`: `400 INVALID_OTP`, `401 UNAUTHORIZED`, `400 CREDENTIAL_ACCOUNT_NOT_FOUND`, `429 TOO_MANY_REQUESTS`, `400 INVALID_PASSWORD` | `proxy.ts:56,62,63,73,75` |
| Phone endpoints | top-level `{code,message}` carrying Form codes (`phone_*`, `invalid_phone*`) with mapped status | `phone/index.ts:21-29` |
| Library responses (LIB) | top-level `{code?,message}`, UPPER_SNAKE codes; not Form-stable | better-auth 1.7.7 |
| Reset request | always `{success:true}` unless 429, with a 700 ms floor; show neutral copy | `proxy.ts:81-87` |

Client handling (REC): read `error.code` or top-level `code`; on `sign-in/email` map 401 to "email or password is incorrect" without saying which; 403
to "sign-in unavailable for this account"; 429 to "too many attempts"; anything else to the status class. The native transport already parses both
shapes (`transport.ts:605-607`).

## 10. Code catalog

Detailed rows for platform and default-CLI routes; `R` = retry unchanged is safe (`same-key` = only with the identical key and body). All CURRENT.

| Code | Status | Route family | Details | R | Client action |
| --- | --- | --- | --- | --- | --- |
| `invalid_json` | 400 | any JSON body | - | no | defect toast |
| `idempotency_key_required` | 400 | receipted commands, transcription, body | - | no | defect: add key |
| `unauthenticated` / `account_session_invalid` | 401 | all `/v1` | - | no | re-authenticate |
| `origin_not_allowed` / `origin_required` | 403 | cookie mutations | - | no | config defect |
| `account_not_initialized` | 403 | module routes | - | once | `GET /v1/me`, retry once |
| `account_disabled` / `account_epoch_changed` | 403 | all authenticated | - | no | account-state screen |
| `not_found` | 404 | all | - | no | refresh, drop reference |
| `stale_revision` | 409 | plans, sets, sessions, documents, onboarding, modules | `{revision:number}` | no | refresh and reapply |
| `idempotency_mismatch` | 409 | receipted commands, transcription, purchases | - | no | defect |
| `plan_archived` | 409/422 | plans, sessions | - | no | refresh plan, toast |
| `session_completed` / `set_voided` / `set_number_exists` / `set_format_mismatch` | 409 | workout sessions | - | no | refresh session, toast |
| `onboarding_completed` | 409 | onboarding | - | no | refresh, continue |
| `exercise_retired` | 409/422 | plans, activity | - | no | ask for another exercise |
| `item_identity_conflict` | 409 | plans, activity | - | no | defect: unique item ids |
| `promo_already_redeemed` | 409 | promo | - | no | inline "already used" |
| `transcription_outcome_unknown` | 409 | transcriptions | `{attemptId}` | no | unknown outcome (s.7) |
| `transcription_failed` | 503/409 | transcriptions | `{attemptId}` | no | re-record (new key) |
| `body_too_large` | 413 | all | - | no | shrink input |
| `json_required` / `wav_required` | 415 | JSON / audio | - | no | defect |
| `invalid_request` | 422 | body parser, ids, queries, purchases, auth | issues array (body parser only) | no | inline or form error |
| `invalid_cursor` | 422 | history | - | no | restart from first page |
| `invalid_cue_preferences` / `onboarding_incomplete` / `promo_unavailable` / `invalid_wav` | 422 | cues, onboarding, promo, audio | - | no | inline message |
| `internal_error` | 500 | all | - | same-key | unknown outcome on writes |
| `*_unavailable`, `*_unconfigured` (e.g. `staged_account_lifecycle_unavailable`, `transcription_unconfigured`, `purchase_verification_unconfigured`, `grounded_answer_unavailable`, `first_plan_unavailable`, `body_retention_unavailable`) | 501 | feature routes | - | no | hide feature |
| `server_closed` | 503 | all | - | yes | backoff retry |

Module families (status: codes). Unless noted: no details, not retryable unchanged; 409 means refresh then decide, 422 inline/form error, 429 back
off, 503 feature unavailable.

- Phone (auth-shaped): 400 `invalid_phone_code`, `phone_send_rejected`; 403 `phone_login_unavailable`; 404 `phone_challenge_not_found`; 409
  `phone_challenge_consumed|expired|unavailable`, `phone_subject_mismatch`, `phone_outcome_unknown` (unknown outcome); 422 `invalid_phone`,
  `invalid_phone_binding`, `invalid_phone_code`; 429 `phone_attempt_limit`, `phone_challenge_cooldown`, `phone_resend_limit`, `phone_send_limit`; 501
  `phone_verification_unconfigured`.
- First plan: 409 `first_plan_confirmation_stale`, `first_plan_sources_changed` (refresh preview, reconfirm); 501 `first_plan_unavailable`; 503
  `first_plan_*`.
- Activity: 409 `activity_calendar_fixed|required`, `activity_entry_voided`, `draft_identity_conflict`, `set_identity_conflict`,
  `workout_in_progress`; 422 `invalid_activity_*`, `activity_*`, `date_review_required`, `future_activity_date`, `future_day_correction`,
  `nonexistent_activity_date`, `duplicate_adherence_day`, `schedule_must_be_prospective`, `calendar_boundary_unavailable`, `invalid_calendar_offset`,
  `run_duration_and_load_required`, `invalid_plan_limit`, `invalid_plan_revision`; 403 `activity_owner_channel_required`; 503 `activity_*`
  (`activity_persistability_unavailable` when unmounted).
- Body: 403 `body_manual_retention_*`, `body_no_save_server_request_forbidden`; 404 `body_measurement_not_found`; 409
  `body_manual_retention_decision_exists`, `body_measurement_capacity`, `idempotency_conflict`; 422 `body_invalid_input`,
  `body_manual_retention_invalid_input`, `body_operation_invalid`, `body_owner_identity_forbidden`; 501 `body_*_unavailable`; 503 `body_*`.
- Community, extension and board (`message` absent): 403 `community_*`, `board_adult_eligibility_unavailable`; 404 `community_not_found`,
  `community_invitation_unavailable`, `board_not_found`; 409 `community_*`, `board_*`, `idempotency_conflict`, `stale_revision` (details forwarded);
  413 `community_*_capacity|too_large`, `board_*_too_large`; 415 `*_json_required`; 422 `community_invalid_input`, `community_text_rejected`,
  `community_sharing_dependency`, `board_invalid_input`, `board_text_rejected`, `board_correction_unchanged`; 429
  `community_*_quota|capacity|rate_limited`, `board_rate_limited`; 503 `community_*`, `board_*`.
- Bug reports (`message` absent): 400 `invalid_bug_report_page`, `invalid_idempotency_key`; 404 `bug_report_not_found`; 409
  `idempotency_key_conflict`, `bug_*`; 413 `bug_report_too_large`; 422 `invalid_bug_report`; 429 `bug_intake_key_limit`, `bug_intake_report_limit`;
  503 `bug_*`.
- Training feedback (`message` absent): 401 `authentication_required`; 403 `feedback_account_mismatch`; 409 `feedback_*`, `progress_*`,
  `current_analysis_changed`, `plan_changed_since_apply`; 422 `feedback_*`, `training_feedback_invalid_request`, `invalid_progress_request`,
  `confirmed_progress_work_required`; 501 `feedback_deletion_policy_unavailable`; 503 `training_feedback_*`, `feedback_*`, `progress_*`.
- Standard coaching: 413/422 `invalid_standard_wire`; 503 `standard_coaching_*` (`_interrupted` is retryable as a new turn).
- Account lifecycle (staged, default 501): 401 `status_receipt_invalid`; 403 `action_grant_invalid`, `action_reauthentication_*`; 409
  `deletion_request_*`, `deletion_confirmation_unavailable`; 413 `account_export_packaging_required`; 422 `invalid_account_export_limit`; 429
  `action_reauthentication_rate_limited`; 503 `deletion_effect_unknown`, `deletion_status_unknown` (unknown outcome), `account_export_*`,
  `lifecycle_*`.
- Family, usage, purge, capture, canonical, suppression, source-migration and subscription-status codes (`family_*`, `invalid_family_*`, `usage_*`,
  `purge_*`, `capture_*`, `canonical_*`, `*suppression*`, `source_*`, `subscription_status_*`, `stored_training_data_invalid`,
  `owner_writer_required`) are internal or factory-only guards. A client that receives one handles it by status class.

## 11. Endpoint inventory

Server status: **CLI** = works in the default CLI server (`cli.ts:47`); **CLI-config** = mounted, 501 until its environment configuration is supplied;
**Factory** = mounted but 501/503 (or 404) unless `createServer` source options or `FORM_RUNTIME_MODULES` runtime composition provide it
(`cli.ts:42-47`, `server.ts:112-119`); **Missing** = no server route (404). All CURRENT.

| Method | Path | Client module | Server | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/sign-up/email`, `/sign-in/email`, `/sign-out`, `/revoke-sessions`, `/revoke-other-sessions`, `/change-password`; GET `/get-session` | `api/transport.ts`, `api/credentials.ts` | CLI | sign-up gated by `FORM_REGISTRATION` |
| POST | `/api/auth/sign-in/social` | `api/transport.ts` | CLI-config | 404 without `FORM_SOCIAL_PROVIDERS` |
| POST | `/api/auth/phone-number/challenge`, `/resend`, `/verify` | `api/transport.ts` | CLI-config | `FORM_PHONE` |
| POST | `/api/auth/email-otp/*` (4 routes) | `api/credentials.ts`, `api/transport.ts` | Factory | 501 `password_recovery_unavailable` (no CLI mail port) |
| GET | `/health`, `/v1/capabilities` | `api/resources.ts` (capabilities) | CLI | public |
| GET | `/v1/me`, `/v1/me/settings` | `api/resources.ts`, `account-lifecycle/api.ts` | CLI | `/v1/me` initializes the account |
| GET, PATCH | `/v1/me/profile`, `/v1/me/preferences`, `/v1/me/onboarding` | `api/resources.ts`, `api/settings.ts` | CLI | revision-guarded |
| POST | `/v1/me/onboarding/complete` | `api/resources.ts` | CLI | receipted |
| GET | `/v1/exercises`, `/v1/exercises/:id` | `api/resources.ts` | CLI | |
| GET, PATCH | `/v1/exercises/:id/cue-preferences` | `api/resources.ts` | CLI | revision-guarded |
| GET, POST | `/v1/plans`; GET, PATCH `/v1/plans/:id`; POST `/v1/plans/:id/archive` | `api/resources.ts`, `api/sourceTrainingResources.ts` | CLI | |
| POST | `/v1/plans/first` | `api/resources.ts` | Factory | 501 `first_plan_unavailable` |
| POST, GET | `/v1/workout-sessions`, `/:id`, `/:id/sets`, `/sets/:setId` (PATCH), `/void`, `/complete` | `api/resources.ts`, `api/sourceTrainingResources.ts` | CLI | receipted |
| GET | `/v1/history`, `/v1/stats` | `api/resources.ts`, `api/sourceTrainingResources.ts` | CLI | |
| GET, POST | `/v1/entitlements`, `/v1/promo-redemptions` | `api/resources.ts` | CLI | promos default empty |
| POST | `/v1/purchases/apple/verify` | `integration/membershipSession.ts` | CLI-config | `FORM_APPLE_PURCHASES`; 422 precedes 501 |
| POST, GET | `/v1/transcriptions`, `/v1/transcriptions/:attemptId` | - | CLI-config | `FORM_GROK_STT_ENABLED`; no native caller found |
| POST | `/v1/coaching/standard/turn` | `api/transport.ts` via `integration/standardCoachingTransport.ts` | Factory | 503 `standard_coaching_unavailable` |
| GET, POST | `/v1/training-feedback`, `/witness`, `/events` | `api/training-feedback.ts` | Factory | 503 `training_feedback_unavailable` |
| POST | `/v1/nutrition/conversations/*` | `api/nutritionConversation.ts` | Factory | in-band `nutrition_unconfigured` |
| POST | `/v1/grounded-answers` | `api/groundedAnswer.ts` | Factory | 501 `grounded_answer_unavailable` |
| GET, POST | `/v1/bug-reports*` | `api/bugIntake.ts` | Factory | 404 when unmounted |
| * | `/v1/community/*`, `/v1/community/board/*` | `api/community.ts`, `api/featureBoard.ts` | Factory | 503 `community_unavailable` / `board_unavailable` |
| * | `/v1/activity/*` | `activity/resources.ts` | Factory | 503 `activity_persistability_unavailable` |
| GET | `/v1/body/capabilities` | `body/manualMeasurements.ts` | CLI | |
| GET, POST | `/v1/body/measurements*`, `/v1/body/manual-retention*` | `body/manualMeasurements.ts` | Factory | 501 `body_retention_unavailable` |
| POST | `/v1/me/account-action-grants`, `/v1/me/deletion-requests[/:id/confirm]`, `/v1/me/account-export`, `/v1/account-deletion/status` | `account-lifecycle/api.ts` | Factory | 501 `staged_account_lifecycle_unavailable` |
| POST | `/v1/health/imports`, `/v1/health/connections/healthkit/disconnect` | `wearables/api.ts` | Missing | handler source in `wearables/router.ts` is not mounted by `server.ts` |

Client-path sources: `apps/form/src/**` string literals at the bound SHA. The website resource client calls only `/v1/me`, entitlements, profile,
preferences, plans, workout sessions, history, stats and exercises (`resource-client.mjs:95-97`).

## 12. Compatibility policy

`v1` changes are additive only: new codes, new optional `details` fields, new headers and new routes. Existing codes keep their status and meaning; a
code is never reused for a different condition. Clients must ignore unknown fields and treat unknown codes by status class (section 5). A breaking
change requires `form-api-client-contract/v2` and a coordinated client release. Each revision of this note names its bound Lift SHA; claims not
re-verified at a newer SHA stay bound to the older one.
