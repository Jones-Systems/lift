import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Domain } from '../../domain.js';
import { DomainError } from '../../errors.js';
import { canonical, command } from '../../storage.js';
import { expectedRevision, profileFields, preferenceFields } from '../../schemas.js';
import type { AccountContext } from '../../lifecycle/types.js';
import type { CanonicalAccountWriter } from '../account-modules/canonical-writer.js';
import { freeze, normalizeContext } from '../../planning/first-plan/normalization.js';
import { constraintCaptureSchema, inspectConstraintCapture,
  type CapturePin, type ConfirmedCaptureRecord, type ConstraintCapture } from '../../planning/constraints/confirmed-capture.js';

export const confirmedCaptureKind = 'confirmed-source-capture';
export const confirmedCaptureOperation = 'confirmed-source-capture:confirm';
const id = z.string().min(1).max(256).refine(value => value.trim().length > 0);
const source = z.object({ id, revision: id, locator: id,
  currentness: z.enum(['current', 'unknown', 'superseded', 'withdrawn']) }).strict();
export const captureInventorySchema = z.object({ id, revision: id,
  source: source.extend({ qualification: z.enum(['qualified', 'accepted_instruction', 'unreviewed', 'hypothesis', 'creator_assertion']) }).strict(),
  questions: z.array(z.object({ id, revision: id, prompt: z.string().min(1).max(4000),
    kind: z.enum(['yes_no', 'text']), required: z.boolean() }).strict()).min(1).max(256),
  consent: z.object({ id, revision: id, text: z.string().min(1).max(4000) }).strict(),
}).strict();
export const captureConsentPermissionSchema = z.object({ id, revision: id,
  inventoryId: id, inventoryRevision: id, statementId: id, statementRevision: id,
  decision: z.literal('granted'), retention: z.literal('retain_confirmed_capture_and_history'),
}).strict();
const configurationSchema = z.object({ inventory: captureInventorySchema, permission: captureConsentPermissionSchema }).strict();
export type CaptureContent = z.infer<typeof configurationSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const captureContentBindingSchema = z.object({ schema: z.literal('form.r1-capture-binding/v1'),
  contentDigest: digest, inventoryDigest: digest, captureDigest: digest, bindingDigest: digest }).strict();
export type CaptureContentBinding = z.infer<typeof captureContentBindingSchema>;
export type DraftCaptureContent = Readonly<{ content: CaptureContent; contentBinding: CaptureContentBinding;
  assertCurrent(capture: ConstraintCapture): void }>;
// This port supplies accepted content and retention permission; no production default is installed here.
export type CaptureContentPort =
  | Readonly<{ readWithinWrite(actor: AccountContext): CaptureContent | null; readForCaptureWithinWrite?: never }>
  | Readonly<{ readWithinWrite?: never;
      readForCaptureWithinWrite(actor: AccountContext, capture: ConstraintCapture): DraftCaptureContent | null }>;
const draftContentSchema = z.object({ content: configurationSchema, contentBinding: captureContentBindingSchema,
  assertCurrent: z.custom<DraftCaptureContent['assertCurrent']>(value => typeof value === 'function') }).strict();
const actorSchema = z.object({ accountId: id, authUserId: id, sessionId: id, epoch: expectedRevision }).strict();
const profile = profileFields.extend({ revision: expectedRevision }).strict();
const preferences = preferenceFields.extend({ revision: expectedRevision }).strict();
const publicPin = z.object({ id, revision: id, digest: z.string().regex(/^[a-f0-9]{64}$/),
  accountId: id, contextKey: id, profileRevision: expectedRevision, preferencesRevision: expectedRevision }).strict();
export const publicConfirmedCaptureSchema = z.object({ schema: z.literal('form.confirmed-source-capture/v1'),
  pin: publicPin, payload: constraintCaptureSchema, inventory: captureInventorySchema,
  consentPermission: captureConsentPermissionSchema, source,
  contentBinding: captureContentBindingSchema.optional(),
  confirmation: z.object({ id, captureRevision: id, captureDigest: z.string().regex(/^[a-f0-9]{64}$/),
    confirmedAt: z.string().datetime() }).strict(),
}).strict();
export const storedConfirmedCaptureSchema = publicConfirmedCaptureSchema.extend({
  privateContext: z.object({ actor: actorSchema, profile, preferences }).strict(),
}).strict();
export type StoredConfirmedCapture = z.infer<typeof storedConfirmedCaptureSchema>;
export const confirmedCaptureReceiptSchema = z.object({ schema: z.literal('form.confirmed-source-capture-receipt/v1'),
  revision: expectedRevision, capture: publicConfirmedCaptureSchema }).strict().refine(receipt =>
    receipt.capture.pin.revision === String(receipt.revision) && validPublicCapture(receipt.capture));
const reviewSchema = configurationSchema.extend({ actor: actorSchema, profile, preferences,
  contentBinding: captureContentBindingSchema.optional(), expectedCaptureRevision: expectedRevision.nullable() }).strict();
export type CaptureReview = z.infer<typeof reviewSchema>;
const confirmationInput = z.object({ review: reviewSchema, payload: constraintCaptureSchema }).strict();
const unavailable = () => ({ status: 'unavailable' as const });
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function permitted(content: CaptureContent): boolean {
  const { inventory, permission } = content;
  return inventory.source.currentness === 'current' && inventory.source.qualification === 'qualified' &&
    permission.inventoryId === inventory.id && permission.inventoryRevision === inventory.revision &&
    permission.statementId === inventory.consent.id && permission.statementRevision === inventory.consent.revision;
}
function contextKey(accountId: string, p: z.infer<typeof profile>, prefs: z.infer<typeof preferences>): string {
  const normalized = normalizeContext({ accountId, profile: { revision: p.revision, goals: p.goals,
    trainingBackground: p.trainingBackground, injuryHistory: p.injuryHistory,
    ...(p.trainingContext === undefined ? {} : { trainingContext: p.trainingContext }) },
  preferences: { revision: prefs.revision, equipment: prefs.equipment, sessionMinutes: prefs.sessionMinutes,
    trainingDaysPerWeek: prefs.trainingDaysPerWeek } },
  { accountId, profileRevision: p.revision, preferencesRevision: prefs.revision });
  if (normalized.status !== 'valid') throw new DomainError(409, 'capture_context_invalid');
  return normalized.contextKey;
}
function validPublicCapture(record: z.infer<typeof publicConfirmedCaptureSchema>): boolean {
  const { pin, confirmation } = record;
  const inspected = inspectConstraintCapture(record.payload, record.inventory);
  return inspected.status === 'captured' && inspected.digest === pin.digest &&
    (record.contentBinding === undefined || record.contentBinding.captureDigest === inspected.digest) &&
    permitted({ inventory: record.inventory, permission: record.consentPermission }) &&
    record.payload.consent.decision === 'granted' && record.payload.consent.statementId === record.inventory.consent.id &&
    record.payload.consent.statementRevision === record.inventory.consent.revision &&
    confirmation.captureRevision === pin.revision && confirmation.captureDigest === pin.digest &&
    record.source.id === pin.id && record.source.revision === pin.revision && record.source.currentness === 'current' &&
    record.source.locator === `documents/${confirmedCaptureKind}/${pin.id}/${pin.revision}`;
}
export function validateStoredConfirmedCapture(value: unknown): StoredConfirmedCapture {
  const parsed = storedConfirmedCaptureSchema.safeParse(value);
  if (!parsed.success || !equal(parsed.data, value)) throw new DomainError(503, 'confirmed_capture_invalid_data');
  const record = parsed.data, { pin, privateContext } = record;
  if (!validPublicCapture(record) || privateContext.actor.accountId !== pin.accountId ||
    privateContext.profile.revision !== pin.profileRevision || privateContext.preferences.revision !== pin.preferencesRevision ||
    contextKey(pin.accountId, privateContext.profile, privateContext.preferences) !== pin.contextKey)
    throw new DomainError(503, 'confirmed_capture_invalid_data');
  return freeze(record);
}
export function exportConfirmedCapture(value: unknown) {
  const { privateContext: _private, ...publicRecord } = validateStoredConfirmedCapture(value);
  return freeze(publicRecord);
}

export function createConfirmedCaptureHost(domain: Domain, writer: CanonicalAccountWriter, content?: CaptureContentPort) {
  if (content && (typeof content.readWithinWrite === 'function') === (typeof content.readForCaptureWithinWrite === 'function'))
    throw new DomainError(503, 'capture_content_port_invalid');
  function assertWithin(actor: AccountContext): void {
    writer.lifecycleStoreOptions.assertRootWriter(domain.db);
    writer.assertWithinWrite(actor);
  }
  function configuration(actor: AccountContext, capture?: ConstraintCapture) {
    assertWithin(actor);
    if (content?.readForCaptureWithinWrite) {
      if (!capture || capture.consent.decision !== 'granted') return null;
      const raw = content.readForCaptureWithinWrite(actor, capture);
      assertWithin(actor);
      const parsed = draftContentSchema.safeParse(raw);
      if (!parsed.success || !permitted(parsed.data.content)) return null;
      const configured = freeze({ ...parsed.data.content, contentBinding: parsed.data.contentBinding });
      const assertion = parsed.data.assertCurrent;
      const assertCurrent = (): void => {
        assertWithin(actor);
        if (!raw || raw.assertCurrent !== assertion || !equal(raw.content, parsed.data.content) ||
          !equal(raw.contentBinding, configured.contentBinding)) throw new DomainError(409, 'capture_confirmation_stale');
        const result: unknown = assertion.call(raw, capture);
        if (result !== undefined) throw new DomainError(503, 'capture_synchronous_content_required');
        assertWithin(actor);
        if (raw.assertCurrent !== assertion || !equal(raw.content, parsed.data.content) ||
          !equal(raw.contentBinding, configured.contentBinding)) throw new DomainError(409, 'capture_confirmation_stale');
      };
      assertCurrent();
      const inspected = inspectConstraintCapture(capture, configured.inventory);
      if (inspected.status !== 'captured' || inspected.digest !== configured.contentBinding.captureDigest) return null;
      return { configured, assertCurrent };
    }
    const raw = content?.readWithinWrite?.(actor);
    assertWithin(actor);
    if (raw == null) return null;
    const parsed = configurationSchema.safeParse(raw);
    return parsed.success && permitted(parsed.data) ? { configured: freeze(parsed.data), assertCurrent: () => assertWithin(actor) } : null;
  }
  function contextWithin(actor: AccountContext) {
    assertWithin(actor);
    const rawProfile = domain.document(actor.accountId, 'profile'), rawPreferences = domain.document(actor.accountId, 'preferences');
    const p = profile.parse(rawProfile), prefs = preferences.parse(rawPreferences);
    if (!equal(p, rawProfile) || !equal(prefs, rawPreferences)) throw new DomainError(503, 'capture_context_invalid');
    return freeze({ profile: p, preferences: prefs,
      expectedCaptureRevision: domain.confirmedCapture(actor.accountId)?.revision ?? null });
  }
  function contextMatches(actor: AccountContext, review: CaptureReview): boolean {
    return equal(contextWithin(actor), { profile: review.profile, preferences: review.preferences,
      expectedCaptureRevision: review.expectedCaptureRevision });
  }
  function reviewWithin(actor: AccountContext, capture?: ConstraintCapture) {
    const lease = configuration(actor, capture);
    if (!lease) return null;
    const review: CaptureReview = freeze({ ...lease.configured, actor, ...contextWithin(actor) });
    return { review, assertCurrent: lease.assertCurrent };
  }
  return Object.freeze({
    review(actorInput: AccountContext, draft?: unknown) {
      const actor = freeze(actorSchema.parse(actorInput));
      const parsed = draft === undefined ? undefined : constraintCaptureSchema.safeParse(draft);
      if (parsed && (!parsed.success || !equal(parsed.data, draft))) throw new DomainError(400, 'capture_confirmation_invalid');
      const capture = parsed?.success ? freeze(parsed.data) : undefined;
      return writer.lifecycle.withActiveWrite(actor, () => {
        const lease = reviewWithin(actor, capture);
        return lease ? { status: 'ready' as const, review: lease.review } : unavailable();
      });
    },
    confirm(actorInput: AccountContext, key: string | undefined, input: unknown) {
      const actor = freeze(actorSchema.parse(actorInput));
      const parsed = confirmationInput.safeParse(input);
      if (!parsed.success || !equal(parsed.data, input)) throw new DomainError(400, 'capture_confirmation_invalid');
      const intent = freeze(parsed.data);
      return writer.lifecycle.withActiveWrite(actor, () => {
        assertWithin(actor);
        // Replay proves the original write only; current content is checked by readCurrentWithinWrite.
        const result = command(domain.db, actor.accountId, confirmedCaptureOperation, key, { actor, ...intent },
          () => assertWithin(actor), () => {
            const original = reviewWithin(actor, intent.payload);
            if (!original || intent.payload.consent.decision !== 'granted') throw new DomainError(503, 'capture_unavailable');
            const current = original.review;
            if (!equal(current, intent.review)) throw new DomainError(409, 'capture_confirmation_stale');
            const inspected = inspectConstraintCapture(intent.payload, current.inventory);
            if (inspected.status !== 'captured') throw new DomainError(400, 'capture_confirmation_invalid');
            if (inspected.gaps.some(gap => gap.code === 'capture_consent_unavailable')) throw new DomainError(503, 'capture_unavailable');
            const revision = (current.expectedCaptureRevision ?? -1) + 1;
            const captureId = domain.confirmedCapture(actor.accountId)?.record.pin.id ?? randomUUID();
            const captureRevision = String(revision);
            const record: StoredConfirmedCapture = { schema: 'form.confirmed-source-capture/v1',
              pin: { id: captureId, revision: captureRevision, digest: inspected.digest, accountId: actor.accountId,
                contextKey: contextKey(actor.accountId, current.profile, current.preferences),
                profileRevision: current.profile.revision, preferencesRevision: current.preferences.revision },
              payload: inspected.capture, inventory: current.inventory, consentPermission: current.permission,
              ...(current.contentBinding === undefined ? {} : { contentBinding: current.contentBinding }),
              source: { id: captureId, revision: captureRevision, locator: `documents/${confirmedCaptureKind}/${captureId}/${revision}`, currentness: 'current' },
              confirmation: { id: randomUUID(), captureRevision, captureDigest: inspected.digest, confirmedAt: new Date().toISOString() },
              privateContext: { actor, profile: current.profile, preferences: current.preferences } };
            const before = reviewWithin(actor, intent.payload);
            if (!before || !equal(before.review, current)) throw new DomainError(409, 'capture_confirmation_stale');
            original.assertCurrent(); before.assertCurrent();
            domain.replaceConfirmedCapture(actor.accountId, current.expectedCaptureRevision, record);
            const refreshed = reviewWithin(actor, intent.payload);
            if (!refreshed || !equal(refreshed.review, { ...current, expectedCaptureRevision: revision }))
              throw new DomainError(409, 'capture_confirmation_stale');
            original.assertCurrent(); before.assertCurrent(); refreshed.assertCurrent();
            if (!contextMatches(actor, refreshed.review) || !equal(domain.confirmedCapture(actor.accountId)?.record, record))
              throw new DomainError(409, 'capture_confirmation_stale');
            return { status: 201, body: { schema: 'form.confirmed-source-capture-receipt/v1', revision,
              capture: exportConfirmedCapture(record) } };
          });
        return freeze(confirmedCaptureReceiptSchema.parse(result.body));
      });
    },
    readCurrentWithinWrite(actorInput: AccountContext, pin: CapturePin) {
      const actor = freeze(actorSchema.parse(actorInput));
      assertWithin(actor);
      const stored = domain.confirmedCapture(actor.accountId);
      if (!stored) return unavailable();
      const record = stored.record;
      const actualPin = { ...record.pin, sessionId: record.privateContext.actor.sessionId };
      if (!equal(pin, actualPin) || !equal(actor, record.privateContext.actor)) return unavailable();
      const lease = reviewWithin(actor, record.payload);
      if (!lease) return unavailable();
      const current = lease.review;
      if (current.expectedCaptureRevision !== stored.revision ||
        !equal(current.profile, record.privateContext.profile) || !equal(current.preferences, record.privateContext.preferences) ||
        !equal(current.contentBinding, record.contentBinding) ||
        !equal(current.inventory, record.inventory) || !equal(current.permission, record.consentPermission)) return unavailable();
      const capture: ConfirmedCaptureRecord = { pin: actualPin, payload: record.payload,
        source: record.source, confirmation: record.confirmation };
      lease.assertCurrent();
      if (!contextMatches(actor, current) || !equal(domain.confirmedCapture(actor.accountId)?.record, record)) return unavailable();
      return freeze({ status: 'current' as const, capture, questions: record.inventory });
    },
  });
}
