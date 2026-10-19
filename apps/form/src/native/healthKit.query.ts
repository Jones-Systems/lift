import { FormHealthAdapter } from './healthKit';
import { FormNativeError } from './runtime';
import type {
  FormHealthNative, FormHealthQueryNative, HealthKitBindMode, HealthKitCheckpoint, HealthKitJournalReceipt,
  HealthKitPurgeReceipt, HealthKitQueryContext, HealthKitSourceBinding, NativePage,
} from './healthKit.types';

const contextKeys = ['accountId', 'sessionGeneration', 'connectionId', 'generation', 'deviceGeneration',
  'type', 'from', 'to', 'timeZone', 'normalizationVersion'];
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const recordId = new RegExp('^hk1:[0-9a-f]{64}:' + uuid + '$');
const metrics = {
  workouts: { workout_duration: ['s', 'workout'], workout_energy: ['kcal', 'workout'], workout_distance: ['m', 'workout'] },
  steps: { steps: ['count', 'sum'] },
  activeEnergy: { active_energy: ['kcal', 'sum'] },
  restingHeartRate: { resting_hr: ['bpm', 'mean'] },
  hrvSdnn: { hrv_sdnn: ['ms', 'mean'] },
  sleep: { sleep_asleep: ['s', 'interval_union'], sleep_in_bed: ['s', 'interval_union'] },
  bodyMass: { body_mass: ['kg', 'latest'] },
} as const;

function fail(code = 'health_native_contract'): never { throw new FormNativeError(code, 'HealthKit source contract or checkpoint does not match.'); }
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function text(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value);
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  const result = JSON.stringify(value);
  if (result === undefined) fail();
  return result;
}
function instant(value: unknown): number {
  if (!text(value, 40) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail();
  const result = Date.parse(value);
  if (!Number.isFinite(result)) fail();
  return result;
}
function localDate(value: string, timeZone: string): { day: string; midnight: boolean } {
  const fields = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const get = (type: string) => fields.find(field => field.type === type)?.value;
  return { day: [get('year'), get('month'), get('day')].join('-'),
    midnight: get('hour') === '00' && get('minute') === '00' && get('second') === '00' && instant(value) % 1000 === 0 };
}
function context(value: unknown): HealthKitQueryContext {
  closed(value, contextKeys);
  for (const key of ['accountId', 'sessionGeneration', 'connectionId', 'deviceGeneration']) if (!text(value[key])) fail();
  if (!integer(value.generation) || value.normalizationVersion !== 1 || typeof value.type !== 'string'
    || !Object.hasOwn(metrics, value.type) || !text(value.timeZone, 100)) fail();
  const from = instant(value.from), to = instant(value.to);
  try {
    const start = localDate(value.from as string, value.timeZone), end = localDate(value.to as string, value.timeZone);
    const days = (Date.parse(end.day) - Date.parse(start.day)) / 86400000;
    if (from >= to || !start.midnight || !end.midnight || days < 1 || days > 31) fail('health_invalid_window');
  } catch { fail('health_invalid_window'); }
  return { ...value } as HealthKitQueryContext;
}
function stream(value: HealthKitQueryContext): string { return JSON.stringify(['healthkit-v1', value.type, value.from, value.to]); }
function cursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && new RegExp('^hk1:' + uuid + ':' + uuid + '$').test(value));
}
function checkpoint(value: unknown, ctx: HealthKitQueryContext): HealthKitCheckpoint {
  closed(value, ['stream', 'cursor']);
  if (value.stream !== stream(ctx) || !cursor(value.cursor)) fail('health_checkpoint_mismatch');
  return { stream: value.stream, cursor: value.cursor };
}
function receipt(value: unknown, ctx: HealthKitQueryContext, cp: HealthKitCheckpoint, previous?: HealthKitJournalReceipt): HealthKitJournalReceipt {
  closed(value, ['version', 'context', 'contextId', 'journalId', 'journalSerial', 'revisionOrder', 'stream', 'cursor']);
  if (value.version !== 1 || canonical(context(value.context)) !== canonical(ctx)
    || typeof value.contextId !== 'string' || !/^[0-9a-f]{64}$/.test(value.contextId)
    || typeof value.journalId !== 'string' || !new RegExp('^' + uuid + '$').test(value.journalId)
    || !integer(value.journalSerial) || !integer(value.revisionOrder) || value.stream !== cp.stream || value.cursor !== cp.cursor) fail();
  if (previous && (value.contextId !== previous.contextId || value.journalId !== previous.journalId
    || value.journalSerial < previous.journalSerial || value.revisionOrder < previous.revisionOrder)) fail('health_journal_changed');
  if (cp.cursor !== null && !cp.cursor.startsWith('hk1:' + value.journalId + ':')) fail('health_checkpoint_mismatch');
  return { ...value, context: { ...ctx } } as HealthKitJournalReceipt;
}
function revision(value: unknown, journal: HealthKitJournalReceipt): void {
  closed(value, ['token', 'order']);
  if (!integer(value.order, 1) || value.order > journal.revisionOrder
    || value.token !== 'hk1:' + journal.journalId + ':' + value.order) fail('health_revision_invalid');
}
function page(value: unknown, ctx: HealthKitQueryContext, journal: HealthKitJournalReceipt,
              input: Parameters<FormHealthNative['query']>[0]): NativePage {
  closed(value, ['records', 'tombstones', 'anchor', 'more', 'logicalBucketsComplete']);
  if (!Array.isArray(value.records) || value.records.length > input.limit || !Array.isArray(value.tombstones)
    || value.tombstones.length > 500 || typeof value.more !== 'boolean' || value.logicalBucketsComplete !== true
    || !cursor(value.anchor) || value.anchor === null || value.anchor === input.anchor
    || !value.anchor.startsWith('hk1:' + journal.journalId + ':')) fail();
  const allowed = metrics[ctx.type] as Record<string, readonly string[]>;
  const ids = new Set<string>();
  const recordIds = new Set<string>();
  let count = value.tombstones.length;
  for (const candidate of value.records) {
    closed(candidate, ['id', 'kind', 'type', 'day', 'zone', 'start', 'end', 'sourceBundleId', 'sourceName',
      'deviceModel', 'algorithm', 'originalId', 'revision', 'quality', 'values']);
    if (typeof candidate.id !== 'string' || !recordId.test(candidate.id) || candidate.type !== ctx.type
      || candidate.kind !== (ctx.type === 'workouts' ? 'workout' : 'daily') || candidate.zone !== ctx.timeZone
      || candidate.quality !== 'unknown' || !text(candidate.sourceBundleId, 300) || !text(candidate.sourceName, 300)
      || !(candidate.deviceModel === null || text(candidate.deviceModel, 300)) || candidate.algorithm !== null
      || !Array.isArray(candidate.values) || candidate.values.length < 1 || candidate.values.length > 3) fail();
    if (recordIds.has(candidate.id)) fail();
    recordIds.add(candidate.id);
    const start = instant(candidate.start), end = instant(candidate.end);
    if (start > end || start < instant(ctx.from) || start >= instant(ctx.to)) fail();
    const localStart = localDate(candidate.start as string, ctx.timeZone), localEnd = localDate(candidate.end as string, ctx.timeZone);
    if (candidate.day !== localStart.day) fail();
    if (ctx.type === 'workouts') {
      if (typeof candidate.originalId !== 'string' || !new RegExp('^' + uuid + '$').test(candidate.originalId)) fail();
    } else if (candidate.originalId !== null || !localStart.midnight || !localEnd.midnight
      || end > instant(ctx.to) || Date.parse(localEnd.day) - Date.parse(localStart.day) !== 86400000) fail();
    revision(candidate.revision, journal);
    const seen = new Set<string>();
    for (const item of candidate.values) {
      closed(item, ['metric', 'value', 'unit', 'aggregation']);
      if (typeof item.metric !== 'string' || !Object.hasOwn(allowed, item.metric) || seen.has(item.metric)
        || typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0
        || item.unit !== allowed[item.metric][0] || item.aggregation !== allowed[item.metric][1]) fail();
      const normalizedId = candidate.id + ':' + item.metric;
      if (ids.has(normalizedId)) fail();
      ids.add(normalizedId); seen.add(item.metric); count += 1;
    }
    if (ctx.type === 'workouts' && !seen.has('workout_duration')) fail();
  }
  for (const item of value.tombstones) {
    closed(item, ['id', 'revision']);
    if (typeof item.id !== 'string') fail();
    const position = item.id.lastIndexOf(':');
    if (!recordId.test(item.id.slice(0, position)) || !Object.hasOwn(allowed, item.id.slice(position + 1)) || ids.has(item.id)) fail();
    ids.add(item.id);
    revision(item.revision, journal);
  }
  if (count > 500) fail();
  // A detached copy prevents a native/mock object from mutating an accepted replay.
  return JSON.parse(JSON.stringify(value)) as NativePage;
}

type BoundSource = { owner: HealthKitSourceBinding; context: HealthKitQueryContext; receipt: HealthKitJournalReceipt };

/** Source qualification seam only. Public query capability stays false until the
 * original upload pageId/key has a separately qualified durable consumer. */
export class FormHealthQuerySource extends FormHealthAdapter {
  private source: BoundSource | null = null;
  private bindingBusy = false;
  private queryToken: symbol | null = null;
  private readonly replay = new Map<string, string>();
  private readonly retired = new Set<string>();
  private observedOrder = 0;
  private replayBytes = 0;
  private purgeAttempt: { source: BoundSource; proof: HealthKitPurgeReceipt } | null = null;

  async bindContext(owner: HealthKitSourceBinding, mode: HealthKitBindMode): Promise<HealthKitJournalReceipt> {
    if (this.bindingBusy || this.purgeAttempt) fail('health_reconciliation_required');
    const ctx = context(owner.context);
    if (!['create_connection', 'create_stream', 'resume'].includes(mode)) fail();
    this.bindingBusy = true;
    try {
      await this.cancelAll();
      const generation = this.epoch;
      return await this.track(async () => {
        this.checkOwner(owner, generation);
        const cp = checkpoint(await owner.checkpoint.read(), ctx);
        this.checkOwner(owner, generation);
        if (mode !== 'resume' && cp.cursor !== null) fail('health_checkpoint_mismatch');
        const result = receipt(await this.nativeQuery().bindQueryContext({ ...ctx }, cp, mode), ctx, cp);
        this.checkOwner(owner, generation);
        const after = checkpoint(await owner.checkpoint.read(), ctx);
        this.checkOwner(owner, generation);
        if (canonical(after) !== canonical(cp)) fail('health_checkpoint_changed');
        this.source = { owner, context: ctx, receipt: result };
        return { ...result, context: { ...result.context } };
      });
    } finally { this.bindingBusy = false; }
  }

  override async query(input: Parameters<FormHealthNative['query']>[0]): Promise<NativePage> {
    this.assertActive();
    const source = this.source;
    if (!source || this.purgeAttempt) fail('health_context_unbound');
    closed(input, ['type', 'from', 'to', 'anchor', 'limit']);
    if (input.type !== source.context.type || input.from !== source.context.from || input.to !== source.context.to
      || !cursor(input.anchor) || !integer(input.limit, 1) || input.limit > 100) fail('health_query_mismatch');
    if (this.queryToken) fail('health_busy');
    const selected = { ...input };
    const generation = this.epoch, token = Symbol();
    this.queryToken = token;
    try {
      return await this.track(async () => {
        this.checkOwner(source.owner, generation);
        const cp = checkpoint(await source.owner.checkpoint.read(), source.context);
        this.checkOwner(source.owner, generation);
        if (cp.cursor !== selected.anchor) fail('health_checkpoint_mismatch');
        const native = this.nativeQuery();
        source.receipt = receipt(await native.reconcileQueryCheckpoint(source.receipt.contextId, cp), source.context, cp, source.receipt);
        this.checkOwner(source.owner, generation);
        const output = await native.query(selected);
        this.checkOwner(source.owner, generation);
        const after = checkpoint(await source.owner.checkpoint.read(), source.context);
        this.checkOwner(source.owner, generation);
        if (canonical(cp) !== canonical(after)) fail('health_checkpoint_changed');
        source.receipt = receipt(await native.reconcileQueryCheckpoint(source.receipt.contextId, after), source.context, after, source.receipt);
        this.checkOwner(source.owner, generation);
        const result = page(output, source.context, source.receipt, selected);
        const key = canonical(selected), signature = canonical(result), previous = this.replay.get(key);
        if (previous !== undefined && previous !== signature) fail('health_replay_changed');
        if (previous === undefined) {
          if (this.replay.size >= 100 || this.replayBytes + signature.length * 4 > 16 * 1024 * 1024) fail('health_page_capacity');
          const orders = [...result.records.map(record => record.revision.order!),
            ...result.tombstones.map(item => item.revision.order!)];
          if (orders.some(order => order <= this.observedOrder)) fail('health_revision_invalid');
          for (const record of result.records) {
            for (const value of record.values) if (this.retired.has(record.id + ':' + value.metric)) fail('health_incarnation_reused');
          }
          for (const item of result.tombstones) this.retired.add(item.id);
          this.observedOrder = Math.max(this.observedOrder, ...orders);
          this.replayBytes += signature.length * 4;
        }
        this.replay.set(key, signature);
        return result;
      });
    } finally { if (this.queryToken === token) this.queryToken = null; }
  }

  async reconcileCheckpoint(): Promise<HealthKitJournalReceipt> {
    const source = this.source;
    if (!source || this.queryToken || this.purgeAttempt) fail('health_context_unbound');
    const generation = this.epoch, token = Symbol();
    this.queryToken = token;
    try {
      return await this.track(async () => {
        this.checkOwner(source.owner, generation);
        const cp = checkpoint(await source.owner.checkpoint.read(), source.context);
        this.checkOwner(source.owner, generation);
        const result = receipt(await this.nativeQuery().reconcileQueryCheckpoint(source.receipt.contextId, cp),
          source.context, cp, source.receipt);
        this.checkOwner(source.owner, generation);
        const after = checkpoint(await source.owner.checkpoint.read(), source.context);
        this.checkOwner(source.owner, generation);
        if (canonical(cp) !== canonical(after)) fail('health_checkpoint_changed');
        source.receipt = result;
        return { ...result, context: { ...result.context } };
      });
    } finally { if (this.queryToken === token) this.queryToken = null; }
  }

  async forgetAfterConfirmedPurge(proof: HealthKitPurgeReceipt): Promise<void> {
    if (this.queryToken || this.bindingBusy) fail('health_busy');
    closed(proof, ['accountId', 'connectionId', 'generation', 'deviceGeneration', 'receiptId']);
    const source = this.purgeAttempt?.source ?? this.source;
    if (!source || !text(proof.receiptId) || proof.accountId !== source.context.accountId
      || proof.connectionId !== source.context.connectionId || proof.generation !== source.context.generation
      || proof.deviceGeneration !== source.context.deviceGeneration
      || (this.purgeAttempt && canonical(this.purgeAttempt.proof) !== canonical(proof))) fail('health_purge_mismatch');
    const selectedProof = { ...proof };
    this.purgeAttempt = { source, proof: selectedProof };
    await this.cancelAll();
    const generation = this.epoch;
    await this.track(async () => {
      this.checkOwner(source.owner, generation);
      await this.nativeQuery().forgetQueryContext(source.context, source.receipt.journalId, source.receipt.journalSerial, selectedProof.receiptId);
      this.checkOwner(source.owner, generation);
      this.purgeAttempt = null;
    });
  }

  override cancelAll(): Promise<void> {
    this.source = null;
    this.replay.clear();
    this.retired.clear();
    this.observedOrder = 0;
    this.replayBytes = 0;
    return super.cancelAll();
  }

  private nativeQuery(): FormHealthQueryNative {
    const module = this.binding.module as FormHealthQueryNative | null;
    if (!module || ['bindQueryContext', 'reconcileQueryCheckpoint', 'forgetQueryContext']
      .some(key => typeof module[key as keyof FormHealthQueryNative] !== 'function')) fail('health_query_unavailable');
    return module;
  }
  private checkOwner(owner: HealthKitSourceBinding, generation: number): void {
    this.assertActive();
    if (generation !== this.epoch || !owner.isCurrentSession()) fail('health_context_changed');
  }
}
