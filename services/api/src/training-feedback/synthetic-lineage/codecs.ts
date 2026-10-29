import type { EmbeddedSchema } from '../../planning/synthetic-lineage/types.js';
import type { EmbeddedPayloadsV1 } from '../../planning/synthetic-lineage/subcodec-types.js';
import { detach, parseBytes, result, requireThat, canonical } from './strict-json.js';
import { embeddedChecks, row, unique, type Row } from './schema.js';

function localReferences(schema: EmbeddedSchema, value: import('./strict-json.js').Json): void {
  if (schema === 'synthetic.accepted-input-dispositions/v1') {
    const rows = row(value).rows as Row[]; unique(rows.map(r => r.inputId));
    unique(rows.map(r => canonical(r.dependencyKey!))); return;
  }
  if (schema !== 'synthetic.registration-manifest/v1') return;
  const manifest = row(value), nodes = manifest.nodes as Row[];
  unique(nodes.map(n => n.id)); const visiting = new Set<string>(), visited = new Set<string>(); let edges = 0;
  const byId = new Map(nodes.map(n => [n.id as string, n]));
  function visit(id: string) {
    requireThat(!visiting.has(id), 'cycle'); if (visited.has(id)) return;
    const node = byId.get(id); requireThat(node, 'unresolved_reference');
    const parents = node.parentIds as string[], sources = node.sourceRecordIds as string[];
    unique(parents); unique(sources); requireThat(parents.length + sources.length > 0, 'unresolved_reference');
    edges += parents.length; requireThat(edges <= 256, 'bounds_exceeded'); visiting.add(id);
    parents.forEach(visit); visiting.delete(id); visited.add(id);
  }
  const root = byId.get(manifest.rootDerivationId as string); requireThat(root && root.kind === 'recommendation', 'unresolved_reference');
  visit(manifest.rootDerivationId as string); requireThat(visited.size === nodes.length, 'unresolved_reference');
}
// Each assertion follows a full recursive closed schema check on detached JSON.
export function decodeEmbedded<S extends EmbeddedSchema>(schema: S, bytes: Uint8Array) {
  return result(() => {
    const value = detach(parseBytes(bytes)); embeddedChecks[schema](value); localReferences(schema, value);
    return value as EmbeddedPayloadsV1[S];
  });
}
export function validateEmbedded<S extends EmbeddedSchema>(schema: S, input: unknown) {
  return result(() => {
    const value = detach(input); embeddedChecks[schema](value); localReferences(schema, value);
    return value as EmbeddedPayloadsV1[S];
  });
}
