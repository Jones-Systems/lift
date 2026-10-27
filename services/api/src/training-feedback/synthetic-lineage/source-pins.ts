import type { Digest, EmbeddedSchema } from '../../planning/synthetic-lineage/types.js';
import type { EmbeddedCodecIdentityV1, EmbeddedSourcePinsV1, SyntheticImplementationPinV1 } from '../../planning/synthetic-lineage/subcodec-types.js';
import { detach, type Json } from './strict-json.js';
import { digest, implementation } from './schema.js';

// Metadata checkpoint: these implementation files are byte-identical to the first published source commit below.
// The set digest hashes actual source bytes with length framing in the listed order; this metadata and test/fixture builders are excluded.
export const implementationSourceRevision = 'c73e102af0a1bbcebd102ed1ef5f4b56ec491686';
export const sourceFiles = [
  {
    "path": "attempt-shape.ts",
    "sha256": "cf3d36fd23b937d647dd7d39ecb9110d4a0c9891502ebb9f32e3e248d6269353"
  },
  {
    "path": "bindings.ts",
    "sha256": "f7051bc7f964f1a2b2da62a3082ecb4ece567355e4f6693713cd933e4f88ebbb"
  },
  {
    "path": "codecs.ts",
    "sha256": "a242065132f92dc6c098035bf1e121a116a816c3c6b3206d5dd21c1b4244a9bb"
  },
  {
    "path": "fixture-recipe.ts",
    "sha256": "1720025b479c6db120efc738650e7ffb2ac3f7ecfa3dab5e03c5f9235f99d341"
  },
  {
    "path": "guard.ts",
    "sha256": "f85e16d79ed75328d5b0a9a28bcc4df24d45c0dacac0b3828a00fccb32146fc2"
  },
  {
    "path": "meaning.ts",
    "sha256": "9f5c497f8b336b55be4215312be22455c0b4073007499e4dfeaf46f691fc261d"
  },
  {
    "path": "schema.ts",
    "sha256": "f49861a3ae1a002c9da57026f6a074a765d84f2d789d5f566d1872333f413dfb"
  },
  {
    "path": "strict-json.ts",
    "sha256": "8e3b404f1c7ecd198e087c4661be9e05f64ed3adb8f5e6bc06f30c98c223c743"
  }
] as const;
function checkedDigest(value: string): Digest { digest(value); return value as Digest; }
export const implementationManifestDigest = checkedDigest('f01854df69e18f54fa4d9e774850cd42adf6419e6511b95343c34102c1f68a4d');
function pin(path: typeof sourceFiles[number]['path']): SyntheticImplementationPinV1 {
  const file = sourceFiles.find(file => file.path === path)!;
  const value = detach({ repository: 'Jones-Systems/lift', revision: implementationSourceRevision,
    path: `services/api/src/training-feedback/synthetic-lineage/${path}`, sha256: file.sha256 });
  implementation(value); return value as Json & SyntheticImplementationPinV1;
}
export const implementationPins = Object.freeze({ codecs: pin('codecs.ts'), guard: pin('guard.ts'), recipe: pin('fixture-recipe.ts') });
function checkpoint<P extends string, B extends string>(path: P, gitBlob: B) {
  return Object.freeze({ repository: 'Jones-Systems/lift' as const, revision: 'c203aadd49592011a39c1344b0016ca191a3f007' as const, path, gitBlob });
}
const sources: EmbeddedSourcePinsV1 = Object.freeze({
  clientDecoder: checkpoint('apps/form/src/api/training-feedback.ts', '82d76013a16face4f8ea8d9b4ec672edce8038b1'),
  analysis: checkpoint('services/api/src/integration/account-modules/index.ts', '94cad393f631eaedb06f5b4c2155e0432faf6781'),
  feedback: checkpoint('services/api/src/training-feedback/index.ts', '34595d826c39c0f742022f861cfb988fd4c67892'),
  ledger: checkpoint('services/api/src/training-feedback/ledger-types.ts', '087e0ebd27f38f525fa965cf4d0f1854c18edcba'),
  comparisonInputs: checkpoint('services/api/src/training-feedback/comparison-inputs.ts', '3e03c9ad4a3879de14613c23a4888dc21482993f'),
  witness: checkpoint('services/api/src/progress-comparison/persistence-types.ts', '7ccb97b83b2d407e64c9602e4a46fa67dd747d02'),
  comparison: checkpoint('services/api/src/progress-comparison/index.ts', '608aa113379c6beb4caed9f945d9ff375a08d2ff'),
});
function identity<S extends EmbeddedSchema>(schema: S): EmbeddedCodecIdentityV1<S> {
  return Object.freeze({ schema, implementation: implementationPins.codecs, subcodecDigest: implementationManifestDigest, sources });
}
export const identities = Object.freeze({
  'synthetic.training-feedback-analysis.pinned-v1': identity('synthetic.training-feedback-analysis.pinned-v1'),
  'synthetic.feedback-comparison-lineage.pinned-v1': identity('synthetic.feedback-comparison-lineage.pinned-v1'),
  'synthetic.comparison-witness.pinned-v2': identity('synthetic.comparison-witness.pinned-v2'),
  'synthetic.registration-manifest/v1': identity('synthetic.registration-manifest/v1'),
  'synthetic.accepted-input-dispositions/v1': identity('synthetic.accepted-input-dispositions/v1'),
});
