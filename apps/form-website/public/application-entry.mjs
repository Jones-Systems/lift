import { mountApplication } from './application-ui.mjs';

const root = document.querySelector('[data-application]');
if (root) mountApplication({ root, pageTarget: window, visibilityTarget: document,
  readVisibility: () => document.visibilityState });
