import type { ProviderOutcome } from '../contracts.js';

export type StandardOperation = 'transcribe' | 'complete' | 'synthesize';
export type StandardUsageField = 'usage' | 'promptTokens' | 'completionTokens' | 'cachedPromptTokens' | 'totalTokens';
export type StandardTelemetry = Readonly<{
  status: 'unavailable' | 'partial' | 'complete';
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  totalTokens?: number;
  invalidFields: readonly StandardUsageField[];
}>;
export type StandardProviderMetadata = Readonly<{
  schemaVersion: 1;
  providerId: 'groq';
  operation: StandardOperation;
  requestedModelId: string;
  reportedModelId?: string;
  requestId?: string;
  responseId?: string;
  telemetry: StandardTelemetry;
}>;
export type StandardOutcome<T> = ProviderOutcome<T> & { readonly metadata?: StandardProviderMetadata };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && !/[\r\n]/.test(value)
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
const unavailable = (): StandardTelemetry => Object.freeze({ status: 'unavailable', invalidFields: Object.freeze([]) });

function telemetry(payload: Record<string, unknown>): StandardTelemetry {
  if (!Object.hasOwn(payload, 'usage')) return unavailable();
  const usage = payload.usage;
  if (!record(usage)) return Object.freeze({ status: 'partial', invalidFields: Object.freeze(['usage'] as const) });
  const invalidFields: StandardUsageField[] = [];
  const counts: Partial<Record<Exclude<StandardUsageField, 'usage'>, number>> = {};
  const read = (source: Record<string, unknown>, field: string, target: Exclude<StandardUsageField, 'usage'>): void => {
    if (!Object.hasOwn(source, field)) return;
    const value = source[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) counts[target] = value;
    else invalidFields.push(target);
  };
  read(usage, 'prompt_tokens', 'promptTokens');
  read(usage, 'completion_tokens', 'completionTokens');
  if (Object.hasOwn(usage, 'prompt_tokens_details')) {
    if (record(usage.prompt_tokens_details)) read(usage.prompt_tokens_details, 'cached_tokens', 'cachedPromptTokens');
    else invalidFields.push('cachedPromptTokens');
  }
  read(usage, 'total_tokens', 'totalTokens');
  const count = Object.keys(counts).length;
  return Object.freeze({
    status: count === 4 && invalidFields.length === 0 ? 'complete'
      : count > 0 || invalidFields.length > 0 ? 'partial' : 'unavailable',
    ...counts,
    invalidFields: Object.freeze(invalidFields),
  });
}

export function projectStandardMetadata(operation: StandardOperation, requestedModelId: string, payload?: unknown): StandardProviderMetadata {
  const source = record(payload) ? payload : {};
  const groq = record(source.x_groq) ? source.x_groq : {};
  const identity = operation === 'synthesize' ? {} : {
    ...(identifier(groq.id) ? { requestId: groq.id } : {}),
    ...(operation === 'complete' && identifier(source.id) ? { responseId: source.id } : {}),
    ...(operation === 'complete' && identifier(source.model) ? { reportedModelId: source.model } : {}),
  };
  return Object.freeze({
    schemaVersion: 1,
    providerId: 'groq',
    operation,
    requestedModelId,
    ...identity,
    telemetry: operation === 'complete' ? telemetry(source) : unavailable(),
  });
}
