# Stripe web subscriptions

This module is unmounted and disabled by default. `createStripeWebPurchases`
returns null without explicit configuration. No default server registration,
SDK, credential loading, Stripe account, website UI or live transport is supplied.

The USD catalog maps weekly $7, monthly $20 and yearly $150 to `form.plus.week`,
`form.plus.month` and `form.plus.year`, using the existing Apple product-ID style
and `form_plus` entitlement. Money is integer minor units in `usd`. A subscription
grants only while its single item is an exact configured Price (amount, currency,
interval, quantity). If the portal switches it to any other Price, the stored state
records `productId: null` and the grant ends. There is no trial grant.

## Composition

The registering server owns authenticated AccountContext creation, durable SQLite,
schema application and backup, lifecycle registration and the injected ports:
an HTTP client, a secret resolver for runtime environment references, and Platform's
`activeOtherChannel` guard. It must not log secret values. POST builders return
form parameters and stable account-scoped idempotency keys. Request builders
perform no HTTP effects.
Portal customer IDs come from the authenticated owner's stored binding. Configure
the referenced Billing Portal configuration for cancellation at period end; this
source does not create or change that external configuration.

`stripeWebMigration` is a named schema (`stripe-web-subscriptions-v1`), not a
numbered migration, and joins no shared migration list. Apply it only through an
explicitly selected composition. Every table is keyed by a namespace of provider,
environment and Stripe account (`stripe:test:acct_…`), so test and live, or two
Stripe accounts, never mix in one store. Every table is partitioned by `account_id`.
The configured `stripeAccount` must be the account owning the API key; Stripe
objects do not carry it, so the server must verify it out of band.

## Account binding

Binding uses a completed subscription Checkout Session whose `client_reference_id`
names an existing account. The registering server must reserve this binding field
for its authenticated Checkout creation path on the configured Stripe account.
Payment Link sessions are refused. The binding is immutable. Subscription
metadata, email and customer details never bind. Events for
an unbound subscription return `pending` and apply after Checkout binding or an
account-bound `reconcile`, which reads the same Session evidence. Reuse of a bound
customer or subscription by another account is a held `binding` conflict and is
never rebound; the attempted account is not stored in the owner's partition.

## Webhooks

The event and client contract is pinned to `2025-02-24.acacia`. Other API versions
and Connect-account events are rejected. Raw bytes must reach `ingest` unchanged.
HMAC verification precedes parsing and supports up to three secret references,
multiple `v1` signatures (at most ten) and a 300-second past/future tolerance. A
reference that resolves to nothing is skipped during rotation; ingestion fails
closed as `unavailable` only when none resolves.

Events are deduplicated by event ID. Envelope fields can differ on redelivery, so a
redelivered processed event is acknowledged as processed. A fact digest covers the
event's type, time, mode, version and data; a different digest under the same ID is
a held `event_variant` conflict. Unattributed, pending and unknown outcomes store no
receipt, so retry is always possible. State, receipt, binding and conflicts commit
atomically. A future HTTP caller returns success only for `processed`.

Stripe events do not establish total ordering. Each state event re-fetches the
current subscription; a per-subscription revision fences concurrent fetches.
Event `created` is kept as a high-water diagnostic, never an ordering authority.

Outcomes are `processed`, `pending` (binding or refresh not yet possible),
`rejected` with a code (permanent: invalid or missing `client_reference_id`, null
Checkout subscription, Payment Link, binding/linkage/variant conflicts, unsupported
currency), `unavailable` (no signing secret) and `unknown` (transport, storage or a
lost post-commit response; replay confirms committed work).

## Refunds, disputes and cancellation

Policy (owner may override):

- **Full refund** of a subscription charge: permanent revocation and cancellation.
- **Partial refund**: no revocation.
- **`charge.dispute.created`**: reversible suspension; no cancellation.
- **`charge.dispute.closed`**: `won` or `warning_closed` can release the suspension
  after a current subscription read. `lost` revokes permanently and queues
  cancellation. Unrecognized dispute state yields `unknown`.

Revocation is sticky at the schema level; suspension is reversible. A refund or
dispute whose customer does not match the bound subscription is a held `linkage`
conflict and cancels nothing. A dispute stays bound to its original charge.
Conflicting outcomes for one dispute are held;
replaying the earlier variant does not release the hold. Held conflicts reject
update and delete; resolution requires a separate owner-approved route.

Permanent revocation and account suppression record a `pending_external` row in
`stripe_web_cancellations` with a built immediate-cancellation request. The
explicit `sendCancellation` call reads the bound provider subscription before
dispatch. It records `unknown` before sending and settles when Stripe confirms
the subscription is canceled, through response, later readback or refresh.
A hold on the cancellation's subscription or owner blocks dispatch based on
revocation alone. Account suppression supplies an independent basis.

`reconcile(actor, subscriptionId)` re-reads the subscription, pages through its
invoices and checks the linked charges and their disputes. It verifies that each
charge points back to the invoice. Unreadable or incomplete evidence returns
`unknown`, including an unfinished list after ten pages or a missing latest
invoice. The webhook path also handles events for older subscription charges.

## Second purchase and channel precedence

Owner decision (Nov 17): a member with an active subscription on one channel
cannot buy on the other, and access is granted if either channel is active.
`checkout` refuses while the account has a Stripe subscription with nonterminal
billing status, including when access was revoked before cancellation settles
(`already_subscribed_stripe`, manage in the billing portal), asks Platform's
`activeOtherChannel` guard otherwise, refuses `apple` with
`already_subscribed_other_channel` and the manage-in-App-Store hint, and returns an
explicit `unknown` for `unknown`, a thrown guard or any other value. For already
completed payments, ingestion and reconciliation persist Stripe facts even when
Apple status is unavailable. They consult the guard with `{ accountId }` when
the resulting Stripe subscription is active and record a `dual_channel_conflict`
when Apple also reports active. Platform owns current dual-channel status.
The Stripe hold itself leaves access readable and triggers no cancellations.

`proposePurchaseAccessMerge` is an unregistered, non-selecting proposal of that rule:
`form_plus` is active when either channel is active; it reports dual-channel activity
and orders grants by code point, independent of input order.

## Platform seam

`createStripeEntitlementSource(service).observe(ctx)` is a pure, non-granting read.
It returns `observed`, `pending` (open dispute), `rejected` (invalid context or a
fail-closed held conflict), `unavailable` (suppressed or inactive account) or
`unknown`, with `{ productId, active, effectiveExpiresAtMs }` only when observed and
evidence `{ provider: 'Stripe', environment, subscriptionRef, eventHighWater,
observedAtMs }`. `eventHighWater` is the highest applied Stripe event `created`
(seconds), or null when only reconciliation wrote state. `observedAtMs` is the
time of the local read. `heldConflicts(ctx)` lists retained holds. Platform's
projection is Apple-only; this source never decides access.

## Lifecycle

`stripeLifecycleContributor(service)` is the `stripe-billing` adapter. Inventory
reports `retained` billing records. Export appends references only: IDs, product,
Stripe status, access state, period dates and amounts in minor units, plus
cancellation and dispute status. It never includes card data, raw payloads,
metadata or secrets. Suppression marks subscriptions, records `pending_external`
cancellations and makes `observe` return `unavailable`. Ingestion for a suppressed
account records state but never publishes. Purge retains local billing records and
reports `pending`/`pending_external` while a Stripe Customer remains, because this
module never deletes it. `stripeLifecycleTableCoverage` declares every table
without a cohort for Platform to register.

Synthetic tests live in `tests/purchases/stripe-web.test.ts`, API purchase discovery
and public `api-breadth`. Passing tests do not qualify a real provider, transport,
portal policy, operational restore, external cancellation or activation.

Protocol references:
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/billing/subscriptions/webhooks
- https://docs.stripe.com/api/idempotent_requests
- https://docs.stripe.com/api/invoices/list?api-version=2025-02-24.acacia
- https://docs.stripe.com/api/disputes/object?api-version=2025-02-24.acacia
