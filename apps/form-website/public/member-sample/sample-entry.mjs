import { createSampleTransport } from './sample-transport.mjs';
import { mountMemberSample } from './member-shell.mjs';

export function mountSamplePage({ documentTarget = globalThis.document, pageTarget = globalThis.window, ...ports } = {}) {
  const root = documentTarget?.querySelector('[data-member-sample]');
  if (!root) return null;
  return mountMemberSample({ ...ports, root, transport: ports.transport ?? createSampleTransport(),
    pageTarget, visibilityTarget: documentTarget, readVisibility: () => documentTarget.visibilityState });
}

if (typeof document !== 'undefined') mountSamplePage();
