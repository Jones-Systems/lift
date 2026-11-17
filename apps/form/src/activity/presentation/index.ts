import { createElement } from 'react';
import type { ActivityRuntimeContext } from '../../FormRuntime';
import { ActivitySlot } from './ActivitySlot';

/** Mount through FormRuntime's Activity seam; the root keeps authentication, transport and speech ownership. */
export function createActivityRenderer() {
  return (context: ActivityRuntimeContext) => createElement(ActivitySlot, { context });
}
