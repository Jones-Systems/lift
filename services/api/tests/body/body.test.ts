import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../../src/errors.js';
import { bodyCapabilities, bodyConsentVersion, bodyDomain, bodyOperations,
  bodyPurposeChoicesSchema, manualExternalLengthSchema, retainedManualMeasurementRequestSchema,
  reportedExternalRatioInputSchema, rejectBodyOperation, type BodyOperation } from '../../src/body/index.js';

const context = Object.freeze({ accountId: 'synthetic-account-a' });
const choices = {
  consentVersion: bodyConsentVersion, retention: 'measurements_only', retainImages: false,
  retainMeasurements: true, externalProviderProcessing: false, sharedSystemImprovement: false,
};
const measurement = {
  construct: 'external_upper_arm', value: 30, unit: 'cm', side: 'left',
  protocol: { id: 'synthetic-external-protocol', version: 'v1', startEndpoint: 'synthetic-start',
    endEndpoint: 'synthetic-end', pose: 'synthetic-standing', instrument: 'synthetic-tape' },
  provenance: { kind: 'manual_reported', operator: 'self_reported', methodVersion: 'manual-v1',
    measuredAt: '2026-10-09T12:00:00Z' },
};
const request = () => ({ expectedRevision: 0, choices: { ...choices }, measurements: [structuredClone(measurement)] });
const error = (code: string, status: number) => (caught: unknown) => {
  assert.ok(caught instanceof DomainError);
  assert.equal(caught.code, code);
  assert.equal(caught.status, status);
  assert.equal(caught.details, undefined);
  assert.equal(caught.message, code);
  return true;
};

test('future manual contracts preserve reported units and provenance without accepting anatomy', () => {
  const parsed = retainedManualMeasurementRequestSchema.parse(request());
  assert.equal(parsed.measurements[0]?.value, 30);
  assert.equal(parsed.measurements[0]?.unit, 'cm');
  assert.equal(parsed.measurements[0]?.provenance.kind, 'manual_reported');
  for (const value of [NaN, Infinity, -Infinity, 0, -1]) {
    assert.equal(manualExternalLengthSchema.safeParse({ ...measurement, value }).success, false);
  }
  for (const unit of ['px', 'm', 'degrees', '%', '', null]) {
    assert.equal(manualExternalLengthSchema.safeParse({ ...measurement, unit }).success, false);
  }
  for (const construct of ['femurLength', 'pelvicTilt', 'hipBalance', 'postureDiagnosis']) {
    assert.equal(manualExternalLengthSchema.safeParse({ ...measurement, construct }).success, false);
  }
  assert.equal(manualExternalLengthSchema.safeParse({ ...measurement, side: 'not_applicable' }).success, false);
  assert.equal(manualExternalLengthSchema.safeParse({ ...measurement, protocol: {
    ...measurement.protocol, endEndpoint: measurement.protocol.startEndpoint,
  } }).success, false);
  for (const field of ['confidence', 'accuracy', 'landmarks', 'image', 'accountId']) {
    assert.equal(manualExternalLengthSchema.safeParse({ ...measurement, [field]: [0.95] }).success, false);
  }
});

test('ratio inputs reject denominator and protocol incompatibility without anatomical labels', () => {
  const ratio = { construct: 'reported_external_length_ratio', numerator: measurement,
    denominator: { ...measurement, construct: 'external_forearm', value: 25 } };
  assert.equal(reportedExternalRatioInputSchema.safeParse(ratio).success, true);
  for (const value of [0, -1, NaN, Infinity, Number.MIN_VALUE]) {
    assert.equal(reportedExternalRatioInputSchema.safeParse({ ...ratio,
      denominator: { ...ratio.denominator, value } }).success, false);
  }
  assert.equal(reportedExternalRatioInputSchema.safeParse({ ...ratio,
    denominator: { ...ratio.denominator, unit: 'mm' } }).success, false);
  assert.equal(reportedExternalRatioInputSchema.safeParse({ ...ratio,
    denominator: { ...ratio.denominator, protocol: { ...measurement.protocol, version: 'v2' } } }).success, false);
  assert.equal(reportedExternalRatioInputSchema.safeParse({ ...ratio,
    denominator: { ...ratio.denominator, provenance: { ...measurement.provenance, methodVersion: 'model-v1' } } }).success, false);
  assert.equal(reportedExternalRatioInputSchema.safeParse({ ...ratio,
    numerator: { ...measurement, value: Number.MIN_VALUE },
    denominator: { ...ratio.denominator, value: Number.MAX_VALUE } }).success, false);
  assert.equal(reportedExternalRatioInputSchema.safeParse({ ...ratio,
    denominator: { ...ratio.denominator, provenance: { ...measurement.provenance, measuredAt: '2026-10-10T12:00:00Z' } } }).success, false);
  assert.equal(reportedExternalRatioInputSchema.safeParse({ ...ratio, construct: 'long_femur_ratio' }).success, false);
});

test('consent is affirmative, versioned and purpose specific; absent choices never imply retention', () => {
  for (const field of Object.keys(choices)) {
    const missing: Record<string, unknown> = { ...choices }; delete missing[field];
    assert.equal(bodyPurposeChoicesSchema.safeParse(missing).success, false);
  }
  assert.equal(bodyPurposeChoicesSchema.safeParse({ ...choices, consentVersion: 'old' }).success, false);
  assert.equal(bodyPurposeChoicesSchema.safeParse({ ...choices, retainImages: true }).success, false);
  assert.equal(bodyPurposeChoicesSchema.safeParse({ ...choices, retention: 'photos_only' }).success, false);
  assert.equal(retainedManualMeasurementRequestSchema.safeParse({ ...request(), choices: undefined }).success, false);
  for (const field of ['externalProviderProcessing', 'sharedSystemImprovement']) {
    assert.equal(retainedManualMeasurementRequestSchema.safeParse({ ...request(),
      choices: { ...choices, [field]: true } }).success, false);
  }
  const noSave = { ...choices, retention: 'no_save', retainMeasurements: false };
  assert.equal(bodyPurposeChoicesSchema.safeParse(noSave).success, true);
  assert.equal(retainedManualMeasurementRequestSchema.safeParse({ ...request(), choices: noSave }).success, false);
  assert.equal(bodyPurposeChoicesSchema.safeParse({ ...noSave, sharedSystemImprovement: true }).success, false);
  assert.equal(bodyPurposeChoicesSchema.safeParse({ ...noSave, externalProviderProcessing: true }).success, false);
});

test('request ownership is exclusively trusted context; clients cannot override it', () => {
  for (const field of ['accountId', 'account_id', 'ownerId', 'owner_id', 'userId', 'user_id', 'email']) {
    const input = { ...request(), [field]: 'synthetic-account-b' };
    assert.equal(retainedManualMeasurementRequestSchema.safeParse(input).success, false);
    assert.throws(() => rejectBodyOperation(context, 'save_manual_measurement', input), error('body_owner_identity_forbidden', 422));
  }
  assert.equal(retainedManualMeasurementRequestSchema.safeParse({ ...request(), measurements: [
    { ...measurement, accountId: 'synthetic-account-b' },
  ] }).success, false);
  for (const missing of [undefined, null, { accountId: '' }, { accountId: ' ' }]) {
    assert.throws(() => rejectBodyOperation(missing, 'save_manual_measurement', request()), error('body_authentication_required', 401));
  }
  for (const accountId of ['synthetic-account-a', 'synthetic-account-b']) {
    assert.throws(() => bodyDomain.reject({ accountId }, 'save_manual_measurement', request()), error('body_retention_unavailable', 501));
  }
  assert.deepEqual(context, { accountId: 'synthetic-account-a' });
});

test('no-save defeats inconsistent retention/improvement settings before any command seam', () => {
  for (const operation of bodyOperations) {
    for (const input of [
      { retention: 'no_save', measurements: [measurement], image: 'synthetic-bytes' },
      { ...request(), choices: { ...choices, retention: 'no_save', sharedSystemImprovement: true } },
    ]) {
      let commandCalls = 0;
      const routeBoundary = () => {
        rejectBodyOperation(context, operation, input);
        commandCalls++;
      };
      assert.throws(routeBoundary, error('body_no_save_server_request_forbidden', 403));
      assert.equal(commandCalls, 0);
    }
  }
});

test('every server path remains unavailable even for syntactically valid retained input', () => {
  const capabilities = bodyCapabilities();
  assert.equal(capabilities.strictNoSave.serverRequestsAllowed, false);
  assert.equal(capabilities.strictNoSave.nativeZeroPersistenceVerified, false);
  assert.equal(capabilities.strictNoSave.manualProcessingLocation, 'client_ephemeral_only');
  for (const capability of [capabilities.photoUpload, capabilities.inference, capabilities.retainedMeasurements,
    capabilities.progress, capabilities.bodyDeletion, capabilities.bodyExport, capabilities.accountDeletion,
    capabilities.externalProvider, capabilities.sharedSystemImprovement, ...Object.values(capabilities.constructs)]) {
    assert.equal(capability.status, 'unavailable');
  }
  for (const operation of bodyOperations) {
    let receiptReads = 0, retainedWrites = 0;
    const routeBoundary = () => {
      bodyDomain.reject(context, operation, request());
      receiptReads++; retainedWrites++;
    };
    const code = operation === 'upload_photo' ? 'body_photo_upload_unavailable' :
      operation === 'infer_assessment' ? 'body_inference_unavailable' :
        ['contribute_improvement', 'revoke_improvement_consent'].includes(operation) ? 'body_improvement_unavailable' : 'body_retention_unavailable';
    assert.throws(routeBoundary, error(code, 501));
    assert.equal(receiptReads, 0); assert.equal(retainedWrites, 0);
  }
  assert.throws(() => rejectBodyOperation(context, 'synthetic-unknown' as BodyOperation), error('body_operation_invalid', 422));
});
