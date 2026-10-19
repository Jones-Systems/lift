export function createConsentPreview() {
  let state;
  const clear = () => { state = Object.freeze({ noSave: true, progressImages: false, derivedMeasurements: false, improvement: false, image: null, derived: null }); return state; };
  clear();
  return Object.freeze({ snapshot: () => state, clear,
    choose({ noSave = state.noSave, progressImages = state.progressImages, derivedMeasurements = state.derivedMeasurements, improvement = state.improvement } = {}) {
      if ([noSave, progressImages, derivedMeasurements, improvement].some(x => typeof x !== 'boolean')) throw new TypeError('Boolean choices required');
      state = Object.freeze({ noSave, progressImages: noSave ? false : progressImages, derivedMeasurements: noSave ? false : derivedMeasurements, improvement: noSave ? false : improvement, image: null, derived: null });
      return state;
    } });
}

const events = new Set(['navigation_open', 'journal_open', 'preview_open']);
// Only a bounded name can leave this seam; there is no collector or external SDK.
export function anonymousEvent(config, name, details) {
  if (config?.trackingEnabled !== true || !events.has(name) || details !== undefined) return null;
  return Object.freeze({ event: name });
}

export function mountPrivacy(root) {
  const preview = createConsentPreview();
  const noSave = root.querySelector('[name=noSave]'), progressImages = root.querySelector('[name=progressImages]'), derivedMeasurements = root.querySelector('[name=derivedMeasurements]'), improvement = root.querySelector('[name=improvement]');
  const status = root.querySelector('[data-consent-status]');
  function render() {
    const state = preview.snapshot();
    noSave.checked = state.noSave; progressImages.checked = state.progressImages; derivedMeasurements.checked = state.derivedMeasurements; improvement.checked = state.improvement;
    progressImages.disabled = derivedMeasurements.disabled = improvement.disabled = state.noSave;
    status.textContent = state.noSave ? 'No save: photo and derived values would be discarded together. This preview holds neither.' :
      `Proposed choices: progress images ${state.progressImages ? 'on' : 'off'}; derived measurements ${state.derivedMeasurements ? 'on' : 'off'}; model improvement ${state.improvement ? 'on' : 'off'}. No consent has been submitted or saved.`;
  }
  for (const control of [noSave, progressImages, derivedMeasurements, improvement]) control.addEventListener('change', () => {
    preview.choose({ noSave: noSave.checked, progressImages: progressImages.checked, derivedMeasurements: derivedMeasurements.checked, improvement: improvement.checked }); render();
  });
  root.querySelector('[data-consent-clear]').addEventListener('click', () => { preview.clear(); render(); });
  globalThis.addEventListener?.('pagehide', () => { preview.clear(); render(); });
  globalThis.addEventListener?.('pageshow', () => { preview.clear(); render(); });
  render(); return preview;
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('[data-consent-preview]');
  if (root) mountPrivacy(root);
}
