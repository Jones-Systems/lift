# Stripe web subscriptions

This module is unmounted and disabled by default. `createStripeWebPurchases`
returns null without explicit configuration. No default server registration,
SDK, credential loading, Stripe account, website UI or live transport is supplied.

The USD catalog maps weekly $7, monthly $20 and yearly $150 to `form.plus.week`,
`form.plus.month` and `form.plus.year`, using the existing Apple product-ID style
and `form_plus` entitlement. Explicit Price IDs must match amount, currency,
interval and quantity on every fetched subscription. There is no trial grant.

The registering server owns authenticated AccountContext creation, durable
SQLite migration/backup, lifecycle adapter registration, and an injected HTTP
client. It must resolve API key and rotated webhook secret environment references
at runtime without logging their values. Builders return form parameters and
stable account-scoped idempotency keys; they perform no HTTP effects. Portal
customer IDs must come from the authenticated owner's stored linkage. Configure
the referenced Stripe Billing Portal configuration for cancellation at period
end; this source does not create or change that external configuration.

Apply `stripePurchaseMigrationSql` only through an explicitly selected migration
composition. Like the optional Apple reconciliation SQL it is additive and
unnumbered; it does not alter default16 or selected27 history. The factory requires
durable SQLite. The class constructor is also exposed for synthetic composition.
It binds the store to mode, catalog and API version; a mode/catalog change requires
an explicit migration decision. Secret rotation does not change this binding.

The snapshot event and injected client contract is pinned to
`2025-02-24.acacia`. Other API versions and Connect-account events are rejected.
Raw bytes must reach `ingest` unchanged. HMAC verification precedes parsing and
supports up to three runtime signing secrets, multiple v1 signatures and a
300-second past/future tolerance. Return success to a future HTTP caller only
for `processed`; unknown/pending outcomes require receipt replay/reconciliation.

Stripe events do not establish total ordering. Each accepted event ID/digest is
persisted before fetching current subscription state. State and its processed
receipt commit atomically. Event `created` is retained as a high-water diagnostic;
a store revision prevents concurrent fetches from overwriting committed state.
Replaying a pending event retries a read, never a payment operation. A fresh
account-bound `reconcile` can recover a missing event. A lost post-commit response
remains unknown until receipt replay confirms the committed result.

Refunds (including partial refunds) and disputes permanently revoke the affected
subscription. Known linkage is revoked before any subscription re-fetch; unknown
charge linkage requires an invoice/charge read and cannot be guessed. A new
subscription may grant independently. Refund reversal is not implemented.
Cancellation at period end retains access until the period expires. `past_due`
grants no additional grace: Apple's grace is a signed provider-specific deadline,
not a reusable fixed duration, and Stripe supplies no equivalent signed deadline.
This conservative policy is an explicit deviation from reusing Apple grace.

`createStripeEntitlementSource` exposes the Stripe-owned `StripeEntitlementSource`
interface. The existing Apple projection has no general provider-source seam;
Platform owns future projection registration. `mergePurchaseEntitlements` is a
pure, tested merge rule: either active channel supplies `form_plus`. It is not
registered in the existing projection. These individual grants never create
commercial-family eligibility.

Platform must register `stripeLifecycleContributor(service)` with account
lifecycle/export alongside the other adapters. It exports only subscription/customer/product references and status.
Suppression records durable `pending_external` cancellation intents and fences
access; purge reports pending external work and retains purchase evidence. No
Stripe cancellation is issued and no retention/destruction deadline is claimed.

Synthetic tests live in `tests/purchases/stripe-web.test.ts`, API purchase discovery
and public `api-breadth`. Passing tests do not qualify a real provider, transport,
portal policy, operational restore, external cancellation or activation.

Protocol references:
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/billing/subscriptions/webhooks
