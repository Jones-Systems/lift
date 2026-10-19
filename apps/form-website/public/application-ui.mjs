import { createApplicationController } from './application-controller.mjs';
import { createApplicationLifecycle } from './application-lifecycle.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const views = { plans: 'Plans', workout: 'Workout', history: 'History', preferences: 'Settings' };
const button = (action, label, disabled = false, attrs = '') => `<button type="button" data-action="${action}"${disabled ? ' disabled' : ''}${attrs}>${label}</button>`;
const resource = (snapshot, slot) => snapshot.application.resources[slot];
const unknown = snapshot => Object.values(snapshot.application.resources).some(state => state.status === 'unknown');
const writable = state => state?.status === 'ready' && state.data;
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, typeof item === 'object' && item !== null ? JSON.parse(canonical(item)) : item])) : value);
const retryMatches = (snapshot, retry) => retry && retry.generation === snapshot.generation && snapshot.status === 'ready' &&
  resource(snapshot, retry.slot)?.status === 'unknown' && canonical(resource(snapshot, retry.slot).pending) === canonical(retry.intent);
const errorMessage = error => ({ session_not_ready: 'Check your connected session first.',
  unknown_intent_pending: 'A write outcome is still unknown. Resolve it before making another change.',
  readback_required: 'Reload current details before making a change.', operation_in_progress: 'An operation is still in progress.',
  session_completed: 'This completed workout is read-only.', archived_plan: 'This archived plan is read-only and cannot start a new workout.',
  lifecycle_suspended: 'Resume the workspace before continuing.', page_not_visible: 'Return to this page before resuming.',
  write_key_factory_required: 'Saving changes is unavailable in this connection.', fresh_write_key_required: 'This connection cannot safely submit another change.',
  plan_editor_required: 'Open a plan editor first.', plan_draft_stale: 'This plan has changed. Reload it and replace your draft before saving.',
  invalid_plan_fields: 'Check the plan name, duration and movement targets.', invalid_plan_item_id: 'A new movement could not be identified safely. No plan was submitted.',
  exercise_unavailable: 'Choose an available movement from the loaded exercise list.', archive_confirmation_required: 'Confirm that you want to archive this saved plan.',
  preferences_draft_stale: 'These settings have changed. Replace your draft with current settings before saving.',
  profile_draft_stale: 'This profile has changed. Replace your draft with the current profile before saving.',
  invalid_profile: 'Check the profile text, ranges and goal entries.',
  invalid_preferences: 'Check the selected preferences, numeric ranges and equipment entries.', invalid_fields: 'Check the entered values.',
})[error.code ?? error.message] ?? (['Enter a performed value.', 'Check the performed values.', 'Confirm completion first.'].includes(error.message) ? error.message : 'The operation could not be confirmed. Review the current details before continuing.');
const messages = {
  unavailable: 'Account service is unavailable. No connection is active on this website.',
  empty: 'Check your existing session to load account access.', checking: 'Checking account access…',
  ready: 'Account details confirmed.', anonymous: 'No signed-in session was confirmed. Sign-in is unavailable here.',
  'signing-out': 'Signing out. Previous account details have been removed.',
  unknown: 'The sign-out result is unknown. Check the session before taking another account action.',
};

export function createUnavailableApplicationSession() {
  const application = createApplicationController();
  const snapshot = () => ({ status: 'unavailable', generation: application.snapshot().generation,
    account: { status: 'unavailable', account: null, entitlements: null }, application: application.snapshot() });
  return Object.freeze({ snapshot, selectView: view => { application.selectView(view); return snapshot(); },
    refresh: snapshot, signout: snapshot });
}

function stateNote(state, empty = 'Nothing has been loaded yet.') {
  if (!state) return `<p class="app-muted">${empty}</p>`;
  const text = { loading: 'Loading…', stale: 'Previously confirmed details. Read back before making changes.',
    conflict: 'The server reported a conflict. Reload current details before editing.',
    unknown: 'The write outcome is unknown. Further writes are held; reading data alone does not confirm this write.',
    error: 'The request failed. No success was confirmed.', empty: 'No records in this result.',
    unavailable: 'This service is unavailable.', ready: 'Confirmed details.' }[state.status] ?? 'Details have not been confirmed.';
  return `<p class="app-state" data-resource-status="${esc(state.status)}">${esc(text)}${state.pending ? ' <span>An operation is pending.</span>' : ''}</p>`;
}

const numberField = (name, label, value, min, max, step = 1) => `<label>${label}<input data-focus="${name}" name="${name}" type="number" min="${min}" max="${max}" step="${step}" required value="${esc(value)}"></label>`;
const selectField = (name, label, value, options) => `<label>${label}<select data-focus="${name}" name="${name}">${options.map(([key, text, disabled]) => `<option value="${esc(key)}"${key === value ? ' selected' : ''}${disabled ? ' disabled' : ''}>${esc(text)}</option>`).join('')}</select></label>`;

const preferenceChoices = {
  appMode: ['basic', 'advanced'], mascot: ['scholarly', 'baby', 'buff', 'none'], animationStyle: ['short', 'long'],
  loadUnit: ['kg', 'lb'], heightUnit: ['cm', 'ft-in'], coachVoice: ['calm', 'direct', 'encouraging'], communication: ['concise', 'detailed'],
};
const preferenceDraft = saved => ({ baseRevision: saved.revision,
  ...Object.fromEntries(Object.keys(preferenceChoices).map(name => [name, saved[name]])),
  trainingDaysPerWeek: String(saved.trainingDaysPerWeek), sessionMinutes: String(saved.sessionMinutes),
  remindersEnabled: String(saved.remindersEnabled), equipment: [...saved.equipment] });

const profileNames = ['name', 'age', 'heightCm', 'weightKg', 'trainingBackground', 'trainingContext', 'injuryHistory', 'goals'];
const profileInputs = saved => ({ name: saved.name, age: String(saved.age ?? ''), heightCm: String(saved.heightCm ?? ''),
  weightKg: String(saved.weightKg ?? ''), trainingBackground: saved.trainingBackground ?? '',
  trainingContext: saved.trainingContext ?? '', injuryHistory: saved.injuryHistory, goals: [...saved.goals] });
const profileDraft = saved => ({ baseRevision: saved.revision, baseline: profileInputs(saved), ...profileInputs(saved) });
function renderProfile(state, draft, busy, held) {
  let html = `<section class="app-detail" aria-label="Profile"><h3>Profile</h3><p>Enter your own manual details. Height uses cm and weight uses kg.</p>${button('profile', 'Load profile', busy)}${stateNote(state, 'Profile details have not been loaded.')}${state?.status === 'unknown' ? button('reconcile-profile', 'Check profile save outcome', busy) : ''}`;
  if (draft) {
    const stale = state?.data?.revision !== draft.baseRevision;
    const disabled = busy || held || !writable(state) || stale;
    html += `${stale ? '<p class="app-hold">This profile has changed. Replace your draft with the current profile before saving.</p>' : ''}${button('replace-profile-draft', 'Replace draft with current profile', busy || held || !writable(state))}<form data-form="profile" data-action="save-profile"><fieldset${disabled ? ' disabled' : ''}><legend>Your profile draft</legend><label>Name<input name="name" data-focus="name" maxlength="100" required value="${esc(draft.name)}"></label><div class="app-fields">${[['age', 'Age', 13, 120, 1], ['heightCm', 'Height (cm)', 50, 260, 'any'], ['weightKg', 'Weight (kg)', 15, 500, 'any']].map(([name, label, min, max, step]) => numberField(name, label, draft[name], min, max, step).replace(' required', '')).join('')}${selectField('trainingBackground', 'Training background', draft.trainingBackground, [['', 'Not supplied'], ['new', 'New'], ['returning', 'Returning'], ['regular', 'Regular']])}</div>${[['trainingContext', 'Training context'], ['injuryHistory', 'Injury history']].map(([name, label]) => `<label>${label}<textarea name="${name}" data-focus="${name}" maxlength="4000" rows="3">${esc(draft[name])}</textarea></label>`).join('')}<fieldset><legend>Goals</legend><ol>${(Array.isArray(draft.goals) ? draft.goals : []).map((entry, index) => `<li><label>Goal ${index + 1}<textarea name="goal-${index}" data-focus="goal-${index}" maxlength="200" required rows="2">${esc(entry)}</textarea></label>${button('goal-remove', `Remove goal ${index + 1}`, false, ` data-id="${index}"`)}</li>`).join('')}</ol>${button('goal-add', 'Add goal', draft.goals?.length >= 30)}</fieldset><p>These inputs are an unsaved draft until a save is confirmed. Each goal is one literal entry; an empty list records no goals.</p><button type="submit">Save profile</button></fieldset></form>`;
  }
  return html + '</section>';
}

function renderRecordedTotals(state, exercise) {
  const totals = state?.data;
  return `<section class="app-detail" aria-label="Recorded totals"><h3>Recorded totals</h3>${stateNote(state, 'Recorded totals have not been loaded.')}<p>Totals cover current account records, independently of the session page above. They include confirmed sets in active workouts and exclude draft and voided sets. They do not describe a week or guarantee complete historical coverage.</p>${totals ? `<dl class="app-totals"><div><dt>Completed sessions</dt><dd>${totals.completedSessions}</dd></div><div><dt>Confirmed sets</dt><dd>${totals.confirmedSets}</dd></div><div><dt>Repetitions</dt><dd>${totals.repetitions}</dd></div><div><dt>Load × repetitions</dt><dd>${totals.volumeKg} kg-repetitions</dd></div></dl><h4>By exercise</h4>${totals.byExercise.length ? `<ul class="app-rows">${totals.byExercise.map(row => `<li><strong>${esc(exercise(row.exerciseId)?.name ?? 'Exercise name unavailable')}</strong><span>${row.confirmedSets} confirmed sets · ${row.repetitions} repetitions · ${row.volumeKg} kg-repetitions</span><span>Highest recorded load: ${row.maxWeightKg} kg</span></li>`).join('')}</ul>` : '<p>No confirmed sets are included in these totals.</p>'}<p class="app-muted">Recorded loads use kg, regardless of your preferred display unit. Highest recorded load is not a strength estimate or a personal-record claim.</p>` : ''}</section>`;
}

function renderPlanEditor(editor, catalog, selected, blocked) {
  const stale = editor.mode === 'edit' && selected?.data?.revision !== editor.baseRevision;
  const disabled = blocked || catalog?.status !== 'ready' || (editor.mode === 'edit' && (!writable(selected) || selected.data.archived || stale));
  const available = (catalog?.data?.items ?? []).filter(exercise => !exercise.retired);
  return `<section class="app-plan-editor" aria-label="Manual plan editor"><h3>${editor.mode === 'create' ? 'Create your plan' : 'Edit your plan'}</h3><p>Choose your movements and enter your own targets. Nothing is generated or saved until you submit.</p>${stateNote(catalog, 'Load the exercise list to choose movements.')}${stale ? '<p class="app-hold">This plan has changed. Reload the selected plan, then replace this draft before saving.</p>' : ''}<form data-form="plan-editor" data-action="save-plan"><fieldset${disabled ? ' disabled' : ''}><legend>Plan details</legend><div class="app-fields"><label>Plan name<input name="name" data-focus="name" type="text" maxlength="100" required value="${esc(editor.name)}"></label>${numberField('minutes', 'Duration (minutes)', editor.minutes, 5, 180)}</div><ol class="app-plan-items">${editor.rows.map((row, index) => {
    const options = [['', 'Choose a movement'], ...available.map(exercise => [exercise.id, exercise.name])];
    if (row.exerciseId && !available.some(exercise => exercise.id === row.exerciseId)) options.push([row.exerciseId, 'Unavailable movement — replace or remove', true]);
    return `<li><fieldset><legend>Movement ${index + 1}</legend>${selectField(`exerciseId-${row.key}`, 'Movement', row.exerciseId, options)}<div class="app-fields">${numberField(`setTarget-${row.key}`, 'Target sets', row.setTarget, 1, 20)}${numberField(`repMin-${row.key}`, 'Minimum reps', row.repMin, 1, 100)}${numberField(`repMax-${row.key}`, 'Maximum reps', row.repMax, 1, 100)}${numberField(`targetKg-${row.key}`, 'Target load (kg)', row.targetKg, 0, 500, 'any')}</div><div class="app-toolbar">${button('plan-row-up', `Move movement ${index + 1} up`, index === 0, ` data-id="${esc(row.key)}"`)}${button('plan-row-down', `Move movement ${index + 1} down`, index === editor.rows.length - 1, ` data-id="${esc(row.key)}"`)}${button('plan-remove-row', `Remove movement ${index + 1}`, editor.rows.length === 1, ` data-id="${esc(row.key)}"`)}</div></fieldset></li>`;
  }).join('')}</ol><div class="app-toolbar">${button('plan-add-row', 'Add movement', editor.rows.length >= 50)}<button type="submit">${editor.mode === 'create' ? 'Create plan' : 'Save plan changes'}</button></div></fieldset></form>${button('cancel-plan-editor', 'Discard this draft', blocked)}</section>`;
}

export function renderApplication(snapshot, { planId = null, workoutId = null, cursor = '', busy = false, notice = '', drafts = {}, canWrite = false, canRetry = false, planEditor = null } = {}) {
  const app = snapshot.application, ready = snapshot.status === 'ready', held = unknown(snapshot);
  const blocked = !ready || busy || held || !canWrite;
  const view = app.selectedView;
  const grants = ready ? snapshot.account.entitlements : null;
  const account = ready ? snapshot.account.account : null;
  const exerciseState = resource(snapshot, 'exercises');
  const exercise = id => exerciseState?.data?.items?.find(item => item.id === id);
  const exerciseName = id => exercise(id)?.name ?? 'Movement';
  let content = '';
  if (!ready) content = `<div class="app-empty"><h3>A place to continue.</h3><p>${esc(messages[snapshot.status] ?? 'Account access has not been confirmed.')}</p><p>Browse Plans, Workout, History, and Settings here. Your personal details appear only after a connected session is confirmed.</p><a href="/variations/session/">Try the separate sample preview →</a></div>`;
  else if (view === 'plans') {
    const list = resource(snapshot, 'plans'), selected = planId ? resource(snapshot, `plan:${planId}`) : null;
    content = `<div class="app-toolbar">${button('plans', 'Load plans', busy)}${button('new-plan', 'Create a plan', blocked)}</div>${stateNote(list)}<ul class="app-cards">${(list?.data?.items ?? []).map(plan => `<li><h3>${esc(plan.name)}</h3><p>${esc(plan.minutes)} min · ${plan.items.length} movements${plan.archived ? ' · Archived' : ''}</p>${button('plan', 'Open plan', busy, ` data-id="${esc(plan.id)}"`)}</li>`).join('')}</ul>${list?.status === 'empty' ? '<p>No saved plans were returned. Create a plan with your own movements and targets.</p>' : ''}${resource(snapshot, 'plans:create') ? stateNote(resource(snapshot, 'plans:create')) : ''}`;
    if (planId) {
      content += `<section class="app-detail" aria-label="Selected plan">${stateNote(selected)}${button('plan', 'Reload selected plan', busy, ` data-id="${esc(planId)}"`)}`;
      if (selected?.data) content += `<h3>${esc(selected.data.name)}</h3><p>Plan targets. These are targets, not performed work.</p><ul class="app-rows">${selected.data.items.map(item => `<li><strong>${esc(exerciseName(item.exerciseId))}</strong><span>${item.setTarget} sets · ${item.repMin}–${item.repMax} reps · ${item.targetKg} kg target</span></li>`).join('')}</ul>${button('start', 'Start this workout', blocked || !writable(selected) || selected.data.archived)}`;
      if (selected?.data?.archived) content += '<p>This archived plan is read-only. Existing workout records are unchanged.</p>';
      else if (selected?.data) content += `<div class="app-toolbar">${button('edit-plan', planEditor ? 'Replace draft with current plan' : 'Edit this plan', blocked || !writable(selected))}</div><form data-form="archive-plan" data-action="archive-plan"><fieldset${blocked || !writable(selected) ? ' disabled' : ''}><legend>Archive this saved plan</legend><label class="app-check"><input type="checkbox" name="confirmed" required> Archive the saved plan. Unsaved edits will not be saved, and this plan will no longer be editable or start new workouts.</label><button type="submit">Archive plan</button></fieldset></form>`;
      if (selected?.status === 'unknown' && selected.pending?.key === null && selected.pending?.method === 'PATCH') content += button('reconcile-plan', 'Check plan edit outcome', busy);
      content += '</section>';
      if (resource(snapshot, 'workout:start')) content += stateNote(resource(snapshot, 'workout:start'));
    }
    if (planEditor) content += renderPlanEditor(planEditor, exerciseState, planEditor.id ? resource(snapshot, `plan:${planEditor.id}`) : null, blocked);
  } else if (view === 'workout') {
    const state = workoutId ? resource(snapshot, `workout:${workoutId}`) : null, session = state?.data;
    const receipt = workoutId ? resource(snapshot, `sets:${workoutId}`) : null;
    content = `${workoutId ? button('workout', 'Read back workout', busy) : '<p>Open a plan to start, or open a session from History.</p>'}${stateNote(state)}${receipt ? `<div class="app-receipt"><h3>Latest set update</h3>${stateNote(receipt)}<p>Reloaded workout details below show the performed work.</p></div>` : ''}`;
    if (session) {
      const editable = !blocked && writable(state) && session.status === 'active';
      const summary = app.workoutSummaries[`workout:${workoutId}`];
      content += `<h3>${esc(session.planSnapshot.name)}</h3><p>${esc(session.status)} workout</p>${session.status === 'completed' ? '<p>This completed workout is read-only.</p>' : ''}${summary ? `<p>${summary.data.performed.confirmedSets} confirmed sets · ${summary.data.performed.repetitions} performed reps · ${summary.data.performed.volumeKg} kg-repetitions</p>` : ''}`;
      content += session.occurrences.map(occurrence => {
        const sets = session.sets.filter(set => set.occurrenceId === occurrence.id);
        const details = exercise(occurrence.exerciseId), target = occurrence.target;
        const form = `add-${occurrence.id}`, draft = drafts[form] ?? {};
        return `<section class="app-movement"><h3>${esc(exerciseName(occurrence.exerciseId))}</h3><p class="app-target">Plan target: ${target.setTarget} sets · ${target.repMin}–${target.repMax} reps · ${target.targetKg} kg</p>${details ? `<ul>${[...details.requiredConstraints, ...details.cues].map(cue => `<li>${esc(cue.text)}</li>`).join('')}</ul>` : '<p class="app-muted">Exercise guidance has not been loaded.</p>'}<h4>Performed sets</h4>${sets.length ? sets.map(set => {
          const editForm = `edit-${set.id}`, edit = drafts[editForm] ?? {};
          return `<div class="app-set"><p>Set ${set.setNumber} · ${esc(set.status)} · ${set.reps} reps at ${set.weightKg} kg</p>${editable && set.status !== 'voided' ? `<form data-form="${editForm}" data-action="edit-set" data-id="${esc(set.id)}"><fieldset><legend>Edit performed set ${set.setNumber}</legend><div class="app-fields">${numberField('reps', 'Performed reps', edit.reps ?? set.reps, 1, 100)}${numberField('weightKg', 'Performed load (kg)', edit.weightKg ?? set.weightKg, 0, 500, 'any')}</div><button type="submit">Save set correction</button>${button('void-set', 'Void set', false, ` data-id="${esc(set.id)}"`)}</fieldset></form>` : ''}</div>`;
        }).join('') : '<p>No performed sets recorded.</p>'}${session.status === 'active' ? `<form data-form="${form}" data-action="add-set" data-id="${esc(occurrence.id)}"><fieldset${editable ? '' : ' disabled'}><legend>Log performed work</legend><div class="app-fields">${numberField('setNumber', 'Set number', draft.setNumber ?? Math.max(0, ...sets.map(set => set.setNumber)) + 1, 1, 100)}${numberField('reps', 'Performed reps', draft.reps ?? '', 1, 100)}${numberField('weightKg', 'Performed load (kg)', draft.weightKg ?? '', 0, 500, 'any')}</div><button type="submit">Add performed set</button></fieldset></form>` : ''}</section>`;
      }).join('');
      if (session.status === 'active') content += `<form data-action="complete" data-form="complete"><fieldset${editable ? '' : ' disabled'}><legend>Finish this workout</legend><label class="app-check"><input type="checkbox" name="confirmed" required> I’m ready to mark this workout complete. Further set edits will be unavailable here.</label><button type="submit">Complete workout</button></fieldset></form>`;
    }
  } else if (view === 'history') {
    const state = resource(snapshot, `history:${cursor}:20`), window = app.historyWindows[`history:${cursor}:20`];
    content = `<div class="app-toolbar">${button('history', 'Load latest sessions', busy)}${cursor ? button('history-page', 'Reload this page', busy, ` data-id="${esc(cursor)}"`) : ''}</div>${stateNote(state)}<p>Showing only this loaded page. This is not a complete week or all-time history.</p>${window?.data ? `<p>${window.data.loadedCount} sessions in this window · ${window.data.completedCount} completed</p>` : ''}<ul class="app-cards">${(state?.data?.items ?? []).map(session => `<li><h3>${esc(session.planSnapshot.name)}</h3><p>${esc(session.status)} · <time datetime="${esc(session.startedAt)}">${esc(session.startedAt)}</time></p>${button('open-workout', 'Open session', busy, ` data-id="${esc(session.id)}"`)}</li>`).join('')}</ul>${state?.data?.nextBefore ? button('history-page', 'Load older sessions', busy, ` data-id="${esc(state.data.nextBefore)}"`) : ''}`;
    content += `${button('stats', 'Load recorded totals', busy)}${renderRecordedTotals(resource(snapshot, 'stats'), id => exerciseState?.status === 'ready' ? exercise(id) : null)}`;
  } else if (view === 'preferences') {
    const state = resource(snapshot, 'preferences'), saved = state?.data, draft = drafts.preferences ?? {};
    content = `${button('preferences', 'Load settings', busy)}${stateNote(state)}${state?.status === 'unknown' ? button('reconcile-preferences', 'Check settings write outcome', busy) : ''}`;
    if (saved) {
      const value = name => draft[name] ?? saved[name];
      const stale = draft.baseRevision !== undefined && draft.baseRevision !== saved.revision;
      if (stale) content += '<p class="app-hold">These settings have changed. Replace your draft with current settings before saving.</p>';
      content += button('replace-preferences-draft', 'Replace draft with current settings', busy || held || !writable(state));
      content += `<form data-action="save-preferences" data-form="preferences"><fieldset${blocked || !writable(state) || stale ? ' disabled' : ''}><legend>Your preference draft</legend><div class="app-fields">${selectField('appMode', 'Workspace mode', value('appMode'), [['basic', 'Basic'], ['advanced', 'Advanced']])}${selectField('mascot', 'Saved companion preference', value('mascot'), [['scholarly', 'Scholarly'], ['baby', 'Baby'], ['buff', 'Buff'], ['none', 'None']])}${selectField('animationStyle', 'Saved animation preference', value('animationStyle'), [['short', 'Short'], ['long', 'Long']])}${selectField('loadUnit', 'Preferred load unit', value('loadUnit'), [['kg', 'Kilograms'], ['lb', 'Pounds']])}${selectField('heightUnit', 'Preferred height unit', value('heightUnit'), [['cm', 'Centimeters'], ['ft-in', 'Feet / inches']])}${selectField('coachVoice', 'Saved coaching tone', value('coachVoice'), [['calm', 'Calm'], ['direct', 'Direct'], ['encouraging', 'Encouraging']])}${selectField('communication', 'Communication detail', value('communication'), [['concise', 'Concise'], ['detailed', 'Detailed']])}${numberField('trainingDaysPerWeek', 'Training days per week', value('trainingDaysPerWeek'), 1, 7)}${numberField('sessionMinutes', 'Session duration (minutes)', value('sessionMinutes'), 5, 180)}${selectField('remindersEnabled', 'Saved reminder preference', String(value('remindersEnabled')), [['false', 'Off'], ['true', 'On']])}</div><fieldset><legend>Equipment entries</legend><p>Keep each piece or description in its own entry. An empty list records no equipment.</p><ol class="app-equipment">${(Array.isArray(value('equipment')) ? value('equipment') : []).map((entry, index) => `<li><label>Equipment entry ${index + 1}<textarea name="equipment-${index}" data-focus="equipment-${index}" maxlength="200" required rows="2">${esc(entry)}</textarea></label>${button('equipment-remove', `Remove equipment entry ${index + 1}`, false, ` data-id="${index}"`)}</li>`).join('')}</ol>${button('equipment-add', 'Add equipment entry', value('equipment')?.length >= 30)}</fieldset><p>These inputs are an unsaved draft until the server confirms a save. Workout logging uses kg. Companion artwork is unavailable; saved choices do not start animation. Coaching tone and reminders are saved preferences only; saving does not start audio, request permission or deliver notifications.</p><button type="submit">Save preferences</button></fieldset></form>`;
    }
    content += renderProfile(resource(snapshot, 'profile'), drafts.profile ?? (writable(resource(snapshot, 'profile')) ? profileDraft(resource(snapshot, 'profile').data) : null), busy, held);
    content += `<section class="app-detail"><h3>Membership</h3><p>${grants ? (grants.active.includes('form_plus') ? 'Form Plus access is confirmed by the server.' : 'No active Form Plus entitlement was returned.') : 'Membership has not been confirmed.'}</p><p>Purchases and checkout are unavailable. This page does not offer an upgrade.</p></section>`;
  }
  return `<div class="session-workspace-top"><span class="session-workspace-name">${account ? `${esc(account.name)}’s workspace` : 'Your space to move'}</span><span class="session-preview-label">${ready ? 'Account confirmed' : 'Account not connected'}</span></div><div class="app-account"><p role="status" aria-live="polite">${esc(messages[snapshot.status] ?? snapshot.status)}${snapshot.error ? ' Review the current account state before continuing.' : ''}</p><div class="app-toolbar">${button('refresh', snapshot.status === 'unknown' ? 'Check sign-out outcome' : 'Check existing session', busy || held)}${button('signout', 'Sign out', !ready)}</div></div><div class="session-workspace-layout"><aside class="session-rail"><nav aria-label="Workspace">${Object.entries(views).map(([key, label], index) => button('navigate', `<span aria-hidden="true">0${index + 1}</span> ${label}`, false, ` data-id="${key}"${key === view ? ' aria-current="page"' : ''}`)).join('')}</nav><p class="session-rail-foot">Strength &amp; movement,<br>with room for real life.</p></aside><div class="session-canvas"><div class="session-canvas-heading"><h2 tabindex="-1" data-focus="view-heading" data-view-heading>${views[view] ?? 'Workspace'}</h2><span class="session-canvas-tag">${busy ? 'Working…' : 'Your next step'}</span></div><p class="app-notice" role="status" aria-live="polite" aria-atomic="true">${esc(notice)}</p>${canRetry ? `${button('retry-write', 'Retry the same submitted change', busy)}<p class="app-muted">This repeats the preserved request, so a confirmed earlier result can be returned without adding the change again.</p>` : ''}${held ? '<p class="app-hold" role="alert">A write outcome is unknown. New writes and account refresh are held to preserve its intent. Reading current details may not resolve that operation. Signing out hides these details and does not undo a submitted change.</p>' : ''}<div class="app-content" aria-busy="${busy}">${content}</div></div></div>`;
}

export function mountApplication({ root, session = createUnavailableApplicationSession(), pageTarget, visibilityTarget, readVisibility, keyFactory } = {}) {
  if (!root || typeof root.addEventListener !== 'function' || typeof root.removeEventListener !== 'function') throw new TypeError('application_root_required');
  let planId = null, workoutId = null, cursor = '', notice = '', drafts = {}, pending = 0, epoch = 0, seenGeneration;
  let disposed = false, lifecycle, retry = null, planEditor = null, rowSequence = 0;
  const keys = new Set(), itemIds = new Set();
  const fresh = () => session.snapshot();
  const paint = snapshot => {
    if (snapshot.generation !== seenGeneration || snapshot.status !== 'ready') {
      planId = workoutId = null; cursor = ''; drafts = {}; retry = null; planEditor = null; seenGeneration = snapshot.generation;
    }
    if (snapshot.status === 'ready' && snapshot.application.selectedView === 'preferences' && writable(resource(snapshot, 'preferences')) && !drafts.preferences) drafts.preferences = preferenceDraft(resource(snapshot, 'preferences').data);
    if (snapshot.status === 'ready' && snapshot.application.selectedView === 'preferences' && writable(resource(snapshot, 'profile')) && !drafts.profile) drafts.profile = profileDraft(resource(snapshot, 'profile').data);
    const focused = root.querySelector?.(':focus');
    const focus = focused?.getAttribute('data-focus'), form = focused?.closest('form')?.getAttribute('data-form');
    const selection = focused && [focused.selectionStart, focused.selectionEnd];
    root.innerHTML = renderApplication(snapshot, { planId, workoutId, cursor, busy: pending > 0, notice, drafts, canWrite: typeof keyFactory === 'function', canRetry: retryMatches(snapshot, retry), planEditor });
    if (focus) {
      const next = [...(root.querySelectorAll?.('[data-focus]') ?? [])].find(node => node.getAttribute('data-focus') === focus && node.closest('form')?.getAttribute('data-form') === form);
      next?.focus();
      if (selection?.[0] != null && typeof next?.setSelectionRange === 'function') next.setSelectionRange(...selection);
    } else if (focused) root.querySelector?.('[data-view-heading]')?.focus();
  };
  lifecycle = createApplicationLifecycle({ session, pageTarget, visibilityTarget, readVisibility, onSnapshot: paint,
    onSuspend: state => { epoch++; drafts = {}; planEditor = null; notice = ''; root.innerHTML = state.state === 'disposed' ? '' : '<div class="app-fallback"><h2>Workspace paused</h2><p>Account details are hidden. Pending operations may still finish; their outcomes are kept in this session.</p><button type="button" data-action="resume">Resume workspace</button></div>'; } });
  const current = ticket => !disposed && epoch === ticket && lifecycle.status().state === 'active';
  const run = (name, ...args) => lifecycle.execute(name, ...args);
  const get = slot => resource(fresh(), slot);
  async function write(name, ...args) {
    const [subject, value, changes] = args;
    const base = `/v1/workout-sessions/${subject.id}`;
    const intent = name === 'createPlan' ? { path: '/v1/plans', method: 'POST', body: subject, key: value }
      : name === 'archivePlan' ? { path: `/v1/plans/${subject.id}/archive`, method: 'POST', body: { expectedRevision: subject.revision }, key: value }
      : name === 'startWorkout' ? { path: '/v1/workout-sessions', method: 'POST', body: { planId: subject.id, expectedPlanRevision: subject.revision }, key: value }
      : name === 'addSet' ? { path: `${base}/sets`, method: 'POST', body: { ...value, expectedRevision: subject.revision }, key: changes }
      : name === 'editSet' ? { path: `${base}/sets/${value.id}`, method: 'PATCH', body: { ...changes, expectedRevision: value.revision }, key: args[3] }
      : name === 'voidSet' ? { path: `${base}/sets/${value.id}/void`, method: 'POST', body: { expectedRevision: value.revision }, key: changes }
      : { path: `${base}/complete`, method: 'POST', body: { expectedRevision: subject.revision }, key: value };
    // Keep one exact command for deliberate replay, never a second resource projection.
    const command = { name, args, generation: fresh().generation, intent,
      slot: name === 'createPlan' ? 'plans:create' : name === 'archivePlan' ? `plan:${subject.id}`
        : name === 'startWorkout' ? 'workout:start' : name === 'completeWorkout' ? `workout:${subject.id}` : `sets:${subject.id}` };
    retry = command;
    try { await run(name, ...args); }
    finally { if (retry === command && !retryMatches(fresh(), command)) retry = null; }
  }
  const key = () => {
    if (typeof keyFactory !== 'function') throw new Error('write_key_factory_required');
    const value = keyFactory();
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value) || keys.has(value)) throw new Error('fresh_write_key_required');
    keys.add(value); return value;
  };
  const requireReady = () => { if (fresh().status !== 'ready') throw new Error('session_not_ready'); };
  const requirePlanAdmission = () => {
    requireReady();
    if (unknown(fresh())) throw new Error('unknown_intent_pending');
    if (typeof keyFactory !== 'function') throw new Error('write_key_factory_required');
  };
  const requireWrite = slot => {
    requireReady();
    if (unknown(fresh())) throw new Error('unknown_intent_pending');
    const state = get(slot);
    if (!writable(state)) throw new Error('readback_required');
    return state.data;
  };
  const numeric = (value, min, max, integer = true) => {
    if (typeof value !== 'string' || value.trim() === '') throw new Error('Enter a performed value.');
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) throw new Error('Check the performed values.');
    return number;
  };
  function capturePreferenceDraft(values) {
    const draft = drafts.preferences ??= preferenceDraft(requireWrite('preferences'));
    for (const name of [...Object.keys(preferenceChoices), 'trainingDaysPerWeek', 'sessionMinutes', 'remindersEnabled']) {
      if (values[name] !== undefined) draft[name] = values[name];
    }
    if (values.equipment !== undefined) draft.equipment = Array.isArray(values.equipment) ? [...values.equipment] : values.equipment;
    else if (Array.isArray(draft.equipment)) draft.equipment = draft.equipment.map((entry, index) => values[`equipment-${index}`] ?? entry);
    return draft;
  }
  function preferenceFields(draft) {
    const invalid = () => { throw new Error('invalid_preferences'); };
    for (const [name, choices] of Object.entries(preferenceChoices)) if (!choices.includes(draft[name])) invalid();
    let trainingDaysPerWeek, sessionMinutes;
    try { trainingDaysPerWeek = numeric(draft.trainingDaysPerWeek, 1, 7); sessionMinutes = numeric(draft.sessionMinutes, 5, 180); }
    catch { invalid(); }
    if (![true, false, 'true', 'false'].includes(draft.remindersEnabled)) invalid();
    if (!Array.isArray(draft.equipment) || draft.equipment.length > 30 || draft.equipment.some(entry => typeof entry !== 'string' || !entry.trim() || entry.trim().length > 200)) invalid();
    return { ...Object.fromEntries(Object.keys(preferenceChoices).map(name => [name, draft[name]])), trainingDaysPerWeek, sessionMinutes,
      remindersEnabled: draft.remindersEnabled === true || draft.remindersEnabled === 'true', equipment: draft.equipment.map(entry => entry.trim()) };
  }
  function captureProfileDraft(values) {
    const draft = drafts.profile ??= profileDraft(requireWrite('profile'));
    for (const name of profileNames.filter(name => name !== 'goals')) if (values[name] !== undefined) draft[name] = values[name];
    if (values.goals !== undefined) draft.goals = Array.isArray(values.goals) ? [...values.goals] : values.goals;
    else if (Array.isArray(draft.goals)) draft.goals = draft.goals.map((entry, index) => values[`goal-${index}`] ?? entry);
    return draft;
  }
  function profileChanges(draft, saved) {
    const invalid = () => { throw new Error('invalid_profile'); };
    const changes = {};
    for (const name of profileNames) {
      if (canonical(draft[name]) === canonical(draft.baseline[name])) continue;
      let value = draft[name];
      if (['name', 'injuryHistory', 'trainingContext'].includes(name)) {
        if (typeof value !== 'string') invalid();
        value = value.trim();
        if (value.length > (name === 'name' ? 100 : 4000) || (name === 'name' && !value)) invalid();
      } else if (['age', 'heightCm', 'weightKg'].includes(name)) {
        if (typeof value !== 'string') invalid();
        if (!value.trim()) value = null;
        else {
          const [min, max] = { age: [13, 120], heightCm: [50, 260], weightKg: [15, 500] }[name];
          try { value = numeric(value, min, max, name === 'age'); } catch { invalid(); }
        }
      } else if (name === 'trainingBackground') {
        if (!['', 'new', 'returning', 'regular'].includes(value)) invalid();
        value = value || null;
      } else {
        if (!Array.isArray(value) || value.length > 30 || value.some(entry => typeof entry !== 'string' || !entry.trim() || entry.trim().length > 200)) invalid();
        value = value.map(entry => entry.trim());
      }
      if (canonical(value) !== canonical(saved[name])) changes[name] = value;
    }
    return changes;
  }
  const blankRow = () => ({ key: `row${++rowSequence}`, itemId: null, identityExercise: null,
    exerciseId: '', setTarget: '', repMin: '', repMax: '', targetKg: '' });
  function capturePlanDraft(values) {
    if (!planEditor) throw new Error('plan_editor_required');
    for (const name of ['name', 'minutes']) if (typeof values[name] === 'string') planEditor[name] = values[name];
    for (const row of planEditor.rows) for (const field of ['exerciseId', 'setTarget', 'repMin', 'repMax', 'targetKg']) {
      const value = values[`${field}-${row.key}`];
      if (typeof value === 'string') row[field] = value;
    }
  }
  function planFields() {
    const editor = planEditor, catalog = get('exercises');
    if (!editor) throw new Error('plan_editor_required');
    if (catalog?.status !== 'ready') throw new Error('exercise_unavailable');
    const name = editor.name.trim();
    if (!name || name.length > 100 || editor.rows.length < 1 || editor.rows.length > 50) throw new Error('invalid_plan_fields');
    const planNumber = (value, min, max, integer = true) => {
      try { return numeric(value, min, max, integer); } catch { throw new Error('invalid_plan_fields'); }
    };
    const minutes = planNumber(editor.minutes, 5, 180);
    const items = editor.rows.map(row => {
      if (!catalog.data.items.some(exercise => exercise.id === row.exerciseId && !exercise.retired)) throw new Error('exercise_unavailable');
      const repMin = planNumber(row.repMin, 1, 100);
      return { exerciseId: row.exerciseId, setTarget: planNumber(row.setTarget, 1, 20), repMin,
        repMax: planNumber(row.repMax, repMin, 100), targetKg: planNumber(row.targetKg, 0, 500, false) };
    });
    // IDs bind to an exercise for the life of a plan, even after that row is removed.
    const used = new Set();
    return { name, minutes, items: items.map((fields, index) => {
      const row = editor.rows[index];
      if (!row.itemId || row.identityExercise !== fields.exerciseId) {
        const next = key();
        if (next.length > 80 || itemIds.has(next)) throw new Error('invalid_plan_item_id');
        itemIds.add(next); row.itemId = next; row.identityExercise = fields.exerciseId;
      }
      if (used.has(row.itemId)) throw new Error('invalid_plan_item_id');
      used.add(row.itemId);
      return { id: row.itemId, ...fields };
    }) };
  }
  async function readPlanAfterWrite(id, ticket) {
    if (!current(ticket)) return;
    planId = id; planEditor = null; lifecycle.selectView('plans');
    await run('plan', id);
    if (current(ticket)) await run('plans');
  }

  async function perform(action, values = {}) {
    if (disposed) throw new Error('application_disposed');
    if (action === 'resume') { lifecycle.resume(); return; }
    if (lifecycle.status().state !== 'active') throw new Error('lifecycle_suspended');
    if (action === 'navigate') {
      epoch++; notice = ''; lifecycle.selectView(values.id);
      action = { plans: 'plans', history: 'history-page', preferences: 'preferences', workout: workoutId ? 'workout' : null }[values.id];
      if (fresh().status !== 'ready' || !action) return;
      values = { id: cursor };
    } else if (pending && action !== 'signout') throw new Error('operation_in_progress');
    if (action === 'refresh' || action === 'signout') epoch++;
    const ticket = epoch;
    pending++; notice = '';
    try {
      lifecycle.resume();
      if (action === 'refresh' || action === 'signout') {
        if (action === 'refresh' && unknown(fresh())) throw new Error('unknown_intent_pending');
        await run(action);
        return;
      }
      requireReady();
      if (action === 'new-plan' || action === 'edit-plan') {
        requirePlanAdmission();
        if (action === 'edit-plan' && requireWrite(`plan:${planId}`).archived) throw new Error('archived_plan');
        await run('exercises');
        if (current(ticket)) {
          if (action === 'new-plan') planEditor = { mode: 'create', id: null, baseRevision: null, name: '', minutes: '', rows: [blankRow()] };
          else {
            const plan = requireWrite(`plan:${planId}`);
            if (plan.archived) throw new Error('archived_plan');
            planEditor = { mode: 'edit', id: plan.id, baseRevision: plan.revision, name: plan.name, minutes: String(plan.minutes),
              rows: plan.items.map(item => {
                itemIds.add(item.id);
                return { ...blankRow(), itemId: item.id, identityExercise: item.exerciseId, exerciseId: item.exerciseId,
                  ...Object.fromEntries(['setTarget', 'repMin', 'repMax', 'targetKg'].map(field => [field, String(item[field])])) };
              }) };
          }
          lifecycle.selectView('plans');
        }
      } else if (action === 'cancel-plan-editor') {
        planEditor = null;
      } else if (['plan-add-row', 'plan-remove-row', 'plan-row-up', 'plan-row-down'].includes(action)) {
        requirePlanAdmission();
        if (!planEditor) throw new Error('plan_editor_required');
        capturePlanDraft(values);
        const rows = planEditor.rows, index = rows.findIndex(row => row.key === values.id);
        if (action === 'plan-add-row') {
          if (rows.length >= 50) throw new Error('invalid_plan_fields');
          rows.push(blankRow());
        } else {
          if (index < 0) throw new Error('invalid_plan_fields');
          if (action === 'plan-remove-row') {
            if (rows.length <= 1) throw new Error('invalid_plan_fields');
            rows.splice(index, 1);
          } else {
            const next = index + (action === 'plan-row-up' ? -1 : 1);
            if (next < 0 || next >= rows.length) throw new Error('invalid_plan_fields');
            [rows[index], rows[next]] = [rows[next], rows[index]];
          }
        }
      } else if (action === 'save-plan') {
        requirePlanAdmission(); capturePlanDraft(values);
        const editor = planEditor;
        const saved = editor.mode === 'edit' ? requireWrite(`plan:${editor.id}`) : null;
        if (saved?.archived) throw new Error('archived_plan');
        if (saved && saved.revision !== editor.baseRevision) throw new Error('plan_draft_stale');
        const fields = planFields();
        if (saved) {
          const changes = Object.fromEntries(Object.entries(fields).filter(([field, value]) => canonical(value) !== canonical(saved[field])));
          if (!Object.keys(changes).length) notice = 'No plan changes to save.';
          else {
            await run('editPlan', saved, changes);
            if (current(ticket) && get(`plan:${saved.id}`)?.status === 'ready') await readPlanAfterWrite(saved.id, ticket);
          }
        } else {
          await write('createPlan', fields, key());
          if (current(ticket) && get('plans:create')?.status === 'ready') await readPlanAfterWrite(get('plans:create').data.id, ticket);
        }
      } else if (action === 'archive-plan') {
        requirePlanAdmission();
        const saved = requireWrite(`plan:${planId}`);
        if (saved.archived) throw new Error('archived_plan');
        if (values.confirmed !== 'on') throw new Error('archive_confirmation_required');
        await write('archivePlan', saved, key());
        if (current(ticket) && get(`plan:${saved.id}`)?.status === 'ready') await readPlanAfterWrite(saved.id, ticket);
      } else if (action === 'reconcile-plan') {
        const state = get(`plan:${planId}`);
        if (state?.status !== 'unknown' || state.pending?.key !== null || state.pending?.method !== 'PATCH') throw new Error('readback_required');
        await run('reconcilePlan', planId);
        if (current(ticket) && get(`plan:${planId}`)?.status === 'ready') await readPlanAfterWrite(planId, ticket);
      } else if (action === 'retry-write') {
        const command = retry;
        if (!retryMatches(fresh(), command)) throw new Error('exact_retry_unavailable');
        await run(command.name, ...command.args);
        if (current(ticket) && get(command.slot)?.status === 'ready') {
          retry = null; drafts = {};
          if (command.name === 'createPlan' || command.name === 'archivePlan') await readPlanAfterWrite(get(command.slot).data.id, ticket);
          else {
            workoutId = command.name === 'startWorkout' ? get(command.slot).data.id : command.args[0].id;
            lifecycle.selectView('workout'); await run('workout', workoutId);
          }
        }
      } else if (action === 'plans') await run('plans');
      else if (action === 'plan') {
        if (planId !== values.id) planEditor = null;
        planId = values.id; await run('plan', planId);
        if (current(ticket)) await run('exercises');
      } else if (action === 'start') {
        const plan = requireWrite(`plan:${planId}`);
        if (plan.archived) throw new Error('archived_plan');
        await write('startWorkout', plan, key());
        if (current(ticket) && get('workout:start')?.status === 'ready') {
          workoutId = get('workout:start').data.id;
          lifecycle.selectView('workout'); await run('workout', workoutId);
        }
      } else if (action === 'workout' || action === 'open-workout') {
        if (action === 'open-workout') { workoutId = values.id; lifecycle.selectView('workout'); }
        if (!workoutId) throw new Error('select_workout');
        await run('workout', workoutId);
        if (current(ticket)) await run('exercises');
      } else if (['add-set', 'edit-set', 'void-set', 'complete'].includes(action)) {
        const workout = requireWrite(`workout:${workoutId}`);
        if (workout.status !== 'active') throw new Error('session_completed');
        let slot = `sets:${workout.id}`;
        if (action === 'complete') {
          if (values.confirmed !== 'on') throw new Error('Confirm completion first.');
          slot = `workout:${workout.id}`; await write('completeWorkout', workout, key());
        } else if (action === 'add-set') {
          if (!workout.occurrences.some(item => item.id === values.id)) throw new Error('unknown_occurrence');
          const fields = { occurrenceId: values.id, setNumber: numeric(values.setNumber, 1, 100), reps: numeric(values.reps, 1, 100), weightKg: numeric(values.weightKg, 0, 500, false), status: 'confirmed' };
          await write('addSet', workout, fields, key());
        } else {
          const set = workout.sets.find(item => item.id === values.id);
          if (!set || set.status === 'voided') throw new Error('set_not_editable');
          if (action === 'void-set') await write('voidSet', workout, set, key());
          else await write('editSet', workout, set, { reps: numeric(values.reps, 1, 100), weightKg: numeric(values.weightKg, 0, 500, false), status: 'confirmed' }, key());
        }
        if (current(ticket) && get(slot)?.status === 'ready') { drafts = {}; await run('workout', workout.id); }
      } else if (action === 'history' || action === 'history-page') {
        cursor = action === 'history' ? '' : values.id ?? '';
        await run('history', { ...(cursor ? { before: cursor } : {}), limit: 20 });
      } else if (action === 'stats') await run('stats');
      else if (action === 'profile') await run('profile');
      else if (action === 'replace-profile-draft') drafts.profile = profileDraft(requireWrite('profile'));
      else if (action === 'goal-add' || action === 'goal-remove') {
        const saved = requireWrite('profile'), draft = captureProfileDraft(values);
        if (draft.baseRevision !== saved.revision) throw new Error('profile_draft_stale');
        if (!Array.isArray(draft.goals)) throw new Error('invalid_profile');
        if (action === 'goal-add') {
          if (draft.goals.length >= 30) throw new Error('invalid_profile');
          draft.goals.push('');
        } else {
          if (typeof values.id !== 'string' || !/^\d+$/.test(values.id) || Number(values.id) >= draft.goals.length) throw new Error('invalid_profile');
          draft.goals.splice(Number(values.id), 1);
        }
      } else if (action === 'reconcile-profile') {
        await run('reconcileProfile');
        if (current(ticket) && get('profile')?.status === 'ready') delete drafts.profile;
      } else if (action === 'save-profile') {
        const saved = requireWrite('profile'), draft = captureProfileDraft(values);
        if (draft.baseRevision !== saved.revision) throw new Error('profile_draft_stale');
        const changes = profileChanges(draft, saved);
        if (!Object.keys(changes).length) notice = 'No profile changes to save.';
        else { await run('saveProfile', saved, changes); if (current(ticket) && get('profile')?.status === 'ready') delete drafts.profile; }
      } else if (action === 'preferences') await run('preferences');
      else if (action === 'replace-preferences-draft') drafts.preferences = preferenceDraft(requireWrite('preferences'));
      else if (action === 'equipment-add' || action === 'equipment-remove') {
        const saved = requireWrite('preferences'), draft = capturePreferenceDraft(values);
        if (draft.baseRevision !== saved.revision) throw new Error('preferences_draft_stale');
        if (!Array.isArray(draft.equipment)) throw new Error('invalid_preferences');
        if (action === 'equipment-add') {
          if (draft.equipment.length >= 30) throw new Error('invalid_preferences');
          draft.equipment.push('');
        } else {
          if (typeof values.id !== 'string' || !/^\d+$/.test(values.id) || Number(values.id) >= draft.equipment.length) throw new Error('invalid_preferences');
          draft.equipment.splice(Number(values.id), 1);
        }
      } else if (action === 'reconcile-preferences') {
        await run('reconcilePreferences');
        if (current(ticket) && get('preferences')?.status === 'ready') delete drafts.preferences;
      } else if (action === 'save-preferences') {
        const saved = requireWrite('preferences'), draft = capturePreferenceDraft(values);
        // A readback never silently rebases unsaved inputs onto a newer revision.
        if (draft.baseRevision !== saved.revision) throw new Error('preferences_draft_stale');
        const fields = preferenceFields(draft);
        const changes = Object.fromEntries(Object.entries(fields).filter(([name, value]) => canonical(value) !== canonical(saved[name])));
        if (!Object.keys(changes).length) notice = 'No preference changes to save.';
        else { await run('savePreferences', saved, changes); if (current(ticket) && get('preferences')?.status === 'ready') delete drafts.preferences; }
      } else throw new Error('unknown_application_action');
    } catch (error) {
      if (current(ticket)) notice = errorMessage(error);
      throw error;
    } finally {
      pending--;
      // A retired action never repaints a new view or a suspended renderer.
      if (current(ticket)) lifecycle.resume();
    }
  }

  const report = error => { if (!disposed && lifecycle.status().state === 'active') { notice = errorMessage(error); lifecycle.resume(); } };
  const click = event => {
    const target = event.target.closest?.('button[data-action]');
    if (!target || !root.contains(target) || target.disabled) return;
    event.preventDefault();
    const action = target.getAttribute('data-action');
    const ticket = epoch;
    return perform(action, { id: target.getAttribute('data-id') }).catch(error => { if (epoch === ticket) report(error); });
  };
  const formValues = form => Object.fromEntries([...form.elements].filter(input => input.name && !input.disabled && (input.type !== 'checkbox' || input.checked)).map(input => [input.name, input.value]));
  const input = event => {
    const form = event.target.closest?.('form[data-form]');
    if (form && root.contains(form)) {
      if (form.getAttribute('data-form') === 'plan-editor' && planEditor) capturePlanDraft(formValues(form));
      else if (form.getAttribute('data-form') === 'profile') captureProfileDraft(formValues(form));
      else if (form.getAttribute('data-form') === 'preferences') capturePreferenceDraft(formValues(form));
      else drafts[form.getAttribute('data-form')] = formValues(form);
    }
  };
  const submit = event => {
    const form = event.target.closest?.('form[data-action]');
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    const ticket = epoch;
    return perform(form.getAttribute('data-action'), { ...formValues(form), id: form.getAttribute('data-id') }).catch(error => { if (epoch === ticket) report(error); });
  };
  const listeners = [['click', click], ['submit', submit], ['input', input], ['change', input]];
  try {
    for (const [name, handler] of listeners) root.addEventListener(name, handler);
    if (lifecycle.status().state === 'active') lifecycle.resume();
  } catch (error) {
    for (const [name, handler] of listeners) root.removeEventListener(name, handler);
    lifecycle.dispose(); throw error;
  }
  return Object.freeze({ perform, dispose() {
    if (disposed) return;
    disposed = true; epoch++; retry = null;
    for (const [name, handler] of listeners) root.removeEventListener(name, handler);
    lifecycle.dispose();
  } });
}
