import type { EmbeddedSchema } from '../../planning/synthetic-lineage/types.js';
import type { EmbeddedSubcodecV1, SyntheticSubcodecBindingsV1 } from '../../planning/synthetic-lineage/subcodec-types.js';
import { identities, implementationPins } from './source-pins.js';
import { decodeEmbedded, validateEmbedded } from './codecs.js';
import { validateClosure } from './guard.js';

function codec<S extends EmbeddedSchema>(schema: S): EmbeddedSubcodecV1<S> {
  return Object.freeze({ identity: identities[schema], decodeStrict: (bytes: Uint8Array) => decodeEmbedded(schema, bytes),
    validateForEncoding: (value: unknown) => validateEmbedded(schema, value) });
}
/** Fixed source binding only. Request payloads cannot replace the table or select implementations. */
export const syntheticTrainingBindings: SyntheticSubcodecBindingsV1 = Object.freeze({
  schema: 'form.synthetic-subcodec-bindings/v1',
  codecs: Object.freeze({
    'synthetic.training-feedback-analysis.pinned-v1': codec('synthetic.training-feedback-analysis.pinned-v1'),
    'synthetic.feedback-comparison-lineage.pinned-v1': codec('synthetic.feedback-comparison-lineage.pinned-v1'),
    'synthetic.comparison-witness.pinned-v2': codec('synthetic.comparison-witness.pinned-v2'),
    'synthetic.registration-manifest/v1': codec('synthetic.registration-manifest/v1'),
    'synthetic.accepted-input-dispositions/v1': codec('synthetic.accepted-input-dispositions/v1'),
  }),
  producer: Object.freeze({ implementation: implementationPins.guard, validateClosure }),
});
