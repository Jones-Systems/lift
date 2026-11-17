import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { definitions } from '../../../packages/chatgpt-adapter/src/schemas.mjs';

test('inactive internal inventory exactly preserves accepted MCP read tools and does not assign OAuth scopes to browser routes', () => {
  const inventory = JSON.parse(readFileSync(new URL('../../../docs/website-acquisition/resume-20261018/ecosystem/api/existing-routes.internal.json', import.meta.url), 'utf8'));
  assert.equal(inventory.active, false);
  assert.equal(inventory.publicContract, false);
  assert.equal(inventory.publishToWebsite, false);
  assert.equal(inventory.acceptedMcpWrites, false);
  assert.deepEqual(inventory.acceptedMcpScopes, [...new Set(definitions.map(item => item.scope).filter(Boolean))]);
  assert.deepEqual(inventory.tools.map(({name, requiredScopes, readOnly}) => ({name, requiredScopes, readOnly})),
    definitions.map(({descriptor, scope}) => ({name: descriptor.name, requiredScopes: scope ? [scope] : [], readOnly: descriptor.annotations.readOnlyHint})));
  const server = readFileSync(new URL('../../../services/api/src/server.ts', import.meta.url), 'utf8');
  for (const route of inventory.browserRoutes) {
    assert.equal(route.oauthScopes, null);
    assert.ok(server.includes(route.path), `Inventory route must exist in current source: ${route.path}`);
    assert.ok(['GET', 'PATCH'].includes(route.method));
  }
});
