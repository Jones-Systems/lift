export type StandardUsageOperation = 'transcribe' | 'complete' | 'synthesize';
export type StandardUsageTokenField = 'promptTokens' | 'completionTokens' | 'cachedPromptTokens' | 'totalTokens';
export type StandardUsageInvalidField = 'usage' | StandardUsageTokenField;
export type StandardUsageTelemetry = Readonly<{
  status: 'unavailable' | 'partial' | 'complete';
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  totalTokens?: number;
  invalidFields: readonly StandardUsageInvalidField[];
}>;
export type StandardUsageMetadataInput = Readonly<{
  schemaVersion: 1;
  providerId: 'groq';
  operation: StandardUsageOperation;
  requestedModelId: string;
  reportedModelId?: string;
  requestId?: string;
  responseId?: string;
  telemetry: StandardUsageTelemetry;
}>;
export type StandardUsageContext = Readonly<{
  operation: StandardUsageOperation;
  sourceId: string;
  asOf: string;
  identityKind: 'request' | 'response';
  modelBinding: Readonly<{ requestedModelId: string; reportedModelId: string }>;
}>;
export type StandardUsageReport = Readonly<{
  schemaVersion?: 1;
  providerId?: 'groq';
  operation?: StandardUsageOperation;
  requestedModelId?: string;
  reportedModelId?: string;
  requestId?: string;
  responseId?: string;
  telemetry?: Readonly<Partial<Omit<StandardUsageTelemetry, 'invalidFields'>> & {
    invalidFields: readonly StandardUsageInvalidField[];
  }>;
}>;
export type StandardUsageIssueCode =
  | 'missing_metadata' | 'invalid_metadata' | 'missing_context' | 'invalid_context'
  | 'missing_provenance' | 'missing_model_binding' | 'missing_identity_kind'
  | 'missing_provider_identity' | 'missing_reported_model' | 'model_binding_mismatch' | 'stage_mismatch'
  | 'telemetry_unavailable' | 'telemetry_partial' | 'telemetry_status_mismatch'
  | 'provider_invalid_fields' | 'invalid_token_count' | 'missing_token_counts'
  | 'cached_exceeds_prompt' | 'token_total_mismatch' | 'token_total_overflow' | 'unsupported_operation';
export type StandardUsageIssue = Readonly<{ code: StandardUsageIssueCode; field: string }>;
export type StandardUsageTokenUnit = Readonly<{
  unitId: 'input_uncached_tokens' | 'input_cached_tokens' | 'output_tokens';
  quantity: number;
}>;
type EvidenceBase = Readonly<{
  schemaVersion: 1;
  pricingState: 'unconfigured';
  actualBilledCost: false;
  issues: readonly StandardUsageIssue[];
}>;
export type StandardUsageEvidence =
  | Readonly<EvidenceBase & {
    kind: 'qualified';
    qualification: 'normalized_provider_reported_token_units';
    reported: StandardUsageReport;
    context: StandardUsageContext;
    providerIdentity: Readonly<{ providerId: 'groq'; kind: 'request' | 'response'; id: string }>;
    units: readonly StandardUsageTokenUnit[];
  }>
  | Readonly<EvidenceBase & {
    kind: 'unknown' | 'invalid';
    reported?: StandardUsageReport;
    context?: StandardUsageContext;
  }>;

const tokenFields: readonly StandardUsageTokenField[] = ['promptTokens', 'completionTokens', 'cachedPromptTokens', 'totalTokens'];
const invalidFields: readonly StandardUsageInvalidField[] = ['usage', ...tokenFields];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const operation = (value: unknown): value is StandardUsageOperation =>
  value === 'transcribe' || value === 'complete' || value === 'synthesize';
const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 200 && !/[\r\n]/.test(value)
  && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) return false;
  const canonical = new Date(value).toISOString();
  return canonical === value || canonical.replace('.000Z', 'Z') === value;
};

/** The caller supplies provenance and model/identity bindings; normalization grants no billing or settlement authority. */
export function normalizeStandardUsageMetadata(
  metadata: StandardUsageMetadataInput | undefined, context: StandardUsageContext | undefined,
): StandardUsageEvidence {
  const issues: StandardUsageIssue[] = [];
  let invalid = false;
  const issue = (code: StandardUsageIssueCode, field: string, malformed = false): void => {
    issues.push(Object.freeze({ code, field })); invalid ||= malformed;
  };
  const keys = (value: Record<string, unknown>, allowed: readonly string[], path: string, code: StandardUsageIssueCode): void => {
    if (Object.keys(value).some(key => !allowed.includes(key))) issue(code, path, true);
  };
  const readId = (value: unknown, path: string, code: StandardUsageIssueCode): string | undefined => {
    if (value === undefined) return undefined;
    if (identifier(value)) return value;
    issue(code, path, true); return undefined;
  };

  const suppliedContext: unknown = context;
  let boundContext: StandardUsageContext | undefined;
  if (suppliedContext === undefined) issue('missing_context', 'context');
  else if (!record(suppliedContext)) issue('invalid_context', 'context', true);
  else {
    keys(suppliedContext, ['operation', 'sourceId', 'asOf', 'identityKind', 'modelBinding'], 'context', 'invalid_context');
    const sourceId = suppliedContext.sourceId, asOf = suppliedContext.asOf;
    const sourceValid = typeof sourceId === 'string' && sourceId.length <= 200 && !/[\r\n]/.test(sourceId)
      && /^[A-Za-z0-9_.:/@+-]{1,200}$/.test(sourceId);
    if (sourceId === undefined) issue('missing_provenance', 'context.sourceId');
    else if (!sourceValid) issue('invalid_context', 'context.sourceId', true);
    if (asOf === undefined) issue('missing_provenance', 'context.asOf');
    else if (!timestamp(asOf)) issue('invalid_context', 'context.asOf', true);
    const stage = suppliedContext.operation, identityKind = suppliedContext.identityKind;
    if (!operation(stage)) issue('invalid_context', 'context.operation', true);
    if (identityKind === undefined) issue('missing_identity_kind', 'context.identityKind');
    else if (identityKind !== 'request' && identityKind !== 'response') issue('invalid_context', 'context.identityKind', true);
    let requestedModelId: string | undefined, reportedModelId: string | undefined;
    if (suppliedContext.modelBinding === undefined) issue('missing_model_binding', 'context.modelBinding');
    else if (!record(suppliedContext.modelBinding)) issue('invalid_context', 'context.modelBinding', true);
    else {
      keys(suppliedContext.modelBinding, ['requestedModelId', 'reportedModelId'], 'context.modelBinding', 'invalid_context');
      requestedModelId = readId(suppliedContext.modelBinding.requestedModelId, 'context.modelBinding.requestedModelId', 'invalid_context');
      reportedModelId = readId(suppliedContext.modelBinding.reportedModelId, 'context.modelBinding.reportedModelId', 'invalid_context');
      if (suppliedContext.modelBinding.requestedModelId === undefined) issue('missing_model_binding', 'context.modelBinding.requestedModelId');
      if (suppliedContext.modelBinding.reportedModelId === undefined) issue('missing_model_binding', 'context.modelBinding.reportedModelId');
    }
    if (operation(stage) && sourceValid && timestamp(asOf) && (identityKind === 'request' || identityKind === 'response')
      && requestedModelId !== undefined && reportedModelId !== undefined) {
      boundContext = Object.freeze({ operation: stage, sourceId, asOf, identityKind,
        modelBinding: Object.freeze({ requestedModelId, reportedModelId }) });
    }
  }

  const suppliedMetadata: unknown = metadata;
  let reported: StandardUsageReport | undefined;
  if (suppliedMetadata === undefined) issue('missing_metadata', 'metadata');
  else if (!record(suppliedMetadata)) issue('invalid_metadata', 'metadata', true);
  else {
    keys(suppliedMetadata, ['schemaVersion', 'providerId', 'operation', 'requestedModelId', 'reportedModelId',
      'requestId', 'responseId', 'telemetry'], 'metadata', 'invalid_metadata');
    const schemaVersion = suppliedMetadata.schemaVersion, providerId = suppliedMetadata.providerId, stage = suppliedMetadata.operation;
    if (schemaVersion !== 1) issue('invalid_metadata', 'metadata.schemaVersion', true);
    if (providerId !== 'groq') issue('invalid_metadata', 'metadata.providerId', true);
    if (!operation(stage)) issue('invalid_metadata', 'metadata.operation', true);
    const requestedModelId = readId(suppliedMetadata.requestedModelId, 'metadata.requestedModelId', 'invalid_metadata');
    const reportedModelId = readId(suppliedMetadata.reportedModelId, 'metadata.reportedModelId', 'invalid_metadata');
    const requestId = readId(suppliedMetadata.requestId, 'metadata.requestId', 'invalid_metadata');
    const responseId = readId(suppliedMetadata.responseId, 'metadata.responseId', 'invalid_metadata');
    if (suppliedMetadata.requestedModelId === undefined) issue('invalid_metadata', 'metadata.requestedModelId', true);
    let telemetry: StandardUsageReport['telemetry'];
    if (!record(suppliedMetadata.telemetry)) issue('invalid_metadata', 'metadata.telemetry', true);
    else {
      const raw = suppliedMetadata.telemetry;
      keys(raw, ['status', 'invalidFields', ...tokenFields], 'metadata.telemetry', 'invalid_metadata');
      const status = raw.status;
      const statusValid = status === 'unavailable' || status === 'partial' || status === 'complete';
      if (!statusValid) issue('invalid_metadata', 'metadata.telemetry.status', true);
      const markedInvalid: StandardUsageInvalidField[] = [];
      if (!Array.isArray(raw.invalidFields) || raw.invalidFields.length > invalidFields.length)
        issue('invalid_metadata', 'metadata.telemetry.invalidFields', true);
      else for (const field of raw.invalidFields) {
        if (!invalidFields.includes(field) || markedInvalid.includes(field)) issue('invalid_metadata', 'metadata.telemetry.invalidFields', true);
        else markedInvalid.push(field);
      }
      if (markedInvalid.length) issue('provider_invalid_fields', 'metadata.telemetry.invalidFields', true);
      const counts: Partial<Record<StandardUsageTokenField, number>> = {};
      let invalidCount = false;
      for (const field of tokenFields) {
        const value = raw[field];
        if (value === undefined) continue;
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) counts[field] = value;
        else { issue('invalid_token_count', `metadata.telemetry.${field}`, true); invalidCount = true; }
      }
      const count = Object.keys(counts).length;
      const expectedStatus = count === 4 && markedInvalid.length === 0 && !invalidCount ? 'complete'
        : count > 0 || markedInvalid.length > 0 || invalidCount ? 'partial' : 'unavailable';
      if (statusValid && status !== expectedStatus) issue('telemetry_status_mismatch', 'metadata.telemetry.status', true);
      if (status === 'unavailable') issue('telemetry_unavailable', 'metadata.telemetry');
      if (status === 'partial') issue('telemetry_partial', 'metadata.telemetry');
      if (count !== 4) issue('missing_token_counts', 'metadata.telemetry');
      telemetry = Object.freeze({ ...(statusValid ? { status } : {}), ...counts, invalidFields: Object.freeze(markedInvalid) });
    }
    reported = Object.freeze({ ...(schemaVersion === 1 ? { schemaVersion } : {}), ...(providerId === 'groq' ? { providerId } : {}),
      ...(operation(stage) ? { operation: stage } : {}), ...(requestedModelId !== undefined ? { requestedModelId } : {}),
      ...(reportedModelId !== undefined ? { reportedModelId } : {}), ...(requestId !== undefined ? { requestId } : {}),
      ...(responseId !== undefined ? { responseId } : {}), ...(telemetry !== undefined ? { telemetry } : {}) });
  }

  let selectedIdentity: string | undefined;
  if (reported !== undefined) {
    if (reported.operation !== undefined && reported.operation !== 'complete') issue('unsupported_operation', 'metadata.operation');
    if (boundContext !== undefined) {
      if (reported.operation !== undefined && reported.operation !== boundContext.operation) issue('stage_mismatch', 'metadata.operation', true);
      selectedIdentity = boundContext.identityKind === 'request' ? reported.requestId : reported.responseId;
      if (selectedIdentity === undefined) issue('missing_provider_identity', `metadata.${boundContext.identityKind}Id`);
      if (reported.reportedModelId === undefined) issue('missing_reported_model', 'metadata.reportedModelId');
      if ((reported.requestedModelId !== undefined && reported.requestedModelId !== boundContext.modelBinding.requestedModelId)
        || (reported.reportedModelId !== undefined && reported.reportedModelId !== boundContext.modelBinding.reportedModelId))
        issue('model_binding_mismatch', 'context.modelBinding');
    }
  }
  const counts = reported?.telemetry;
  const prompt = counts?.promptTokens, completion = counts?.completionTokens, cached = counts?.cachedPromptTokens, total = counts?.totalTokens;
  if (prompt !== undefined && cached !== undefined && cached > prompt) issue('cached_exceeds_prompt', 'metadata.telemetry.cachedPromptTokens', true);
  if (prompt !== undefined && completion !== undefined) {
    const sum = BigInt(prompt) + BigInt(completion);
    if (sum > BigInt(Number.MAX_SAFE_INTEGER)) issue('token_total_overflow', 'metadata.telemetry.totalTokens', true);
    else if (total !== undefined && sum !== BigInt(total)) issue('token_total_mismatch', 'metadata.telemetry.totalTokens', true);
  }
  const base = { schemaVersion: 1 as const, pricingState: 'unconfigured' as const, actualBilledCost: false as const,
    issues: Object.freeze(issues) };
  if (issues.length || reported === undefined || boundContext === undefined || selectedIdentity === undefined
    || prompt === undefined || completion === undefined || cached === undefined || total === undefined) {
    return Object.freeze({ ...base, kind: invalid ? 'invalid' : 'unknown',
      ...(reported !== undefined ? { reported } : {}), ...(boundContext !== undefined ? { context: boundContext } : {}) });
  }
  // These disjoint units qualify reported token arithmetic only, not invoice cost or authority to settle usage.
  return Object.freeze({ ...base, kind: 'qualified', qualification: 'normalized_provider_reported_token_units', reported, context: boundContext,
    providerIdentity: Object.freeze({ providerId: 'groq', kind: boundContext.identityKind, id: selectedIdentity }),
    units: Object.freeze([
      Object.freeze({ unitId: 'input_uncached_tokens', quantity: prompt - cached }),
      Object.freeze({ unitId: 'input_cached_tokens', quantity: cached }),
      Object.freeze({ unitId: 'output_tokens', quantity: completion }),
    ] as const) });
}
