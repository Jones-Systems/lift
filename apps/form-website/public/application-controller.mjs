import { createResourceClient, createSyntheticResourceClient, createConfiguredResourceClient } from './resource-client.mjs';
import { derivePresentation, deriveWorkoutSummary, deriveHistoryWindow } from './presentation-model.mjs';

const views = new Set(['plans', 'workout', 'history', 'preferences']);
const project = (state, derive) => state
  ? Object.freeze({ ...state, data: state.data === null ? null : derive(state.data) })
  : null;

function controller(client) {
  let selectedView = 'plans';
  const { snapshot: resourceSnapshot, clear: clearResources, bindIdentity: bindResources, ...operations } = client;

  function snapshot({ reduceMotion = false, assetReady = false } = {}) {
    if (typeof reduceMotion !== 'boolean' || typeof assetReady !== 'boolean') {
      throw new TypeError('reduceMotion and assetReady must be booleans');
    }
    // Derive from this generation only; never cache an async operation's returned data.
    const resources = resourceSnapshot();
    const entries = Object.entries(resources.resources);
    return Object.freeze({
      ...resources,
      selectedView,
      presentation: project(resources.resources.preferences,
        value => derivePresentation(value, { reduceMotion, assetReady })),
      workoutSummaries: Object.freeze(Object.fromEntries(entries
        .filter(([slot]) => slot.startsWith('workout:'))
        .map(([slot, state]) => [slot, project(state, deriveWorkoutSummary)]))),
      historyWindows: Object.freeze(Object.fromEntries(entries
        .filter(([slot]) => slot.startsWith('history:'))
        .map(([slot, state]) => [slot, project(state, deriveHistoryWindow)]))),
    });
  }

  function selectView(view) {
    if (!views.has(view)) throw new TypeError('Unknown application view');
    selectedView = view;
    return snapshot();
  }

  function clear() {
    clearResources();
    selectedView = 'plans';
    return snapshot();
  }

  function bindIdentity() {
    selectedView = 'plans';
    return bindResources();
  }

  return Object.freeze({ ...operations, snapshot, selectView, clear, invalidate: clear, bindIdentity });
}

export function createApplicationController(options) {
  return controller(createResourceClient(options));
}

export function createConfiguredApplicationController(options) {
  return controller(createConfiguredResourceClient(options));
}

export function createSyntheticApplicationController(options) {
  return controller(createSyntheticResourceClient(options));
}
