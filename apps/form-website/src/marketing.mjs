import { page, escapeHtml as e } from './shell.mjs';

const clearance = '<p class="safety-note">Returning after <strong>injury or illness</strong>? Get clinician clearance before exercising and follow their restrictions. Form is not rehabilitation, diagnosis, or a substitute for medical care.</p>';

function illustration() {
  return `<div class="movement-art"><div class="art-label"><span>THE MOVEMENT STUDY</span><span>01 / FORM</span></div><svg viewBox="0 0 520 500" role="img" aria-label="Original abstract illustration of a person reaching, with arcs suggesting movement"><defs><pattern id="study-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="currentColor" stroke-opacity=".08"/></pattern></defs><rect width="520" height="500" fill="url(#study-grid)"/><circle cx="280" cy="248" r="171" fill="none" stroke="currentColor" stroke-opacity=".2"/><path d="M79 279A204 204 0 0 1 379 81" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="5 9"/><path d="M258 226L195 336L108 383M262 225L309 342L414 368" fill="none" stroke="#202b24" stroke-width="43" stroke-linecap="round" stroke-linejoin="round"/><path d="M256 223L291 135L375 93M272 160L196 133L155 68" fill="none" stroke="#202b24" stroke-width="29" stroke-linecap="round" stroke-linejoin="round"/><circle cx="302" cy="94" r="27" fill="#202b24"/><circle cx="375" cy="93" r="9" fill="#f3f1e8"/><path d="M78 419H448" stroke="currentColor" stroke-width="1"/><path d="M427 190v48m-24-24h48" stroke="currentColor" stroke-width="1"/><text x="78" y="450" font-family="monospace" font-size="12" fill="currentColor">CONTEXT → MOVEMENT → REFLECTION</text></svg><span class="art-caption">An illustration of possibility. Not exercise instruction.</span><div class="art-tag">Built around<br><em>your starting point.</em></div></div>`;
}

function demo(goal = 'strength') {
  const initial = {strength:['Make space for strength.','A future planning conversation could explore your experience, equipment and preferences before suggesting a routine.','No workout has been generated. Personalized planning is in development.'],routine:['Give your routine a place to begin.','A future planning conversation could ask what you enjoy, what gets in the way and which days feel realistic.','This is a planning illustration. It does not predict weight change or other outcomes.'],return:['Keep your current context in view.','A future planning conversation could help you record clinician-set restrictions and questions about returning to movement.','After injury or illness, clinician clearance comes first. This preview cannot assess readiness or prescribe rehabilitation.']}[goal];
  return `<section class="demo-section container" id="preview"><div class="demo-heading"><p class="eyebrow">02 / Try the idea</p><h2>A plan begins<br>with your life.</h2><p>Change a goal and the time you have. See how a planning conversation could be framed.</p><span class="badge">Interactive preview · no personalized advice</span></div><div class="demo-panel" data-plan-preview><form class="preview-controls"><fieldset><legend>What brings you here?</legend><div class="goal-options">${[['strength','Build strength'],['routine','Find a routine'],['return','Return to movement']].map(([value,label]) => `<label><input type="radio" name="goal" value="${value}"${goal === value ? ' checked' : ''}><span>${label}</span></label>`).join('')}</div></fieldset><label class="range-label" for="preview-time">Time available <output data-time-output for="preview-time">20 minutes</output></label><input id="preview-time" type="range" min="10" max="45" step="5" value="20" name="minutes"><p class="small">This demo runs in this page. It does not save your choices or create an account.</p></form><div class="plan-sheet" aria-live="polite" aria-atomic="true"><div class="sheet-top"><span>YOUR EXAMPLE BRIEF</span><span class="badge">Preview</span></div><h3 data-plan-title>${e(initial[0])}</h3><p data-plan-copy>${e(initial[1])}</p><div class="plan-line"><span>01</span><div><strong>Start with context</strong><p>Goals, preferences and boundaries</p></div></div><div class="plan-line"><span>02</span><div><strong data-plan-time>A 20-minute window</strong><p>Time to discuss, not an exercise prescription</p></div></div><div class="plan-line"><span>03</span><div><strong>Review together</strong><p>Understand changes before accepting them</p></div></div><p class="small" data-plan-caution>${e(initial[2])}</p></div>${clearance}<a class="button" href="/account/">Check account availability <span aria-hidden="true">↗︎</span></a><p class="small">Accounts, app downloads and subscriptions are unavailable in this preview.</p><nav class="readiness-links" aria-label="Product readiness"><a href="/account/">Account: unavailable</a><a href="/account/">Download: unavailable</a><a href="/account/">Subscription: unavailable</a></nav></div><noscript><p>The interactive demo requires JavaScript. The example above is a static planning brief, not a workout.</p></noscript></section>`;
}


function conversionPreview(c) {
  const goal = c.conversionGoal ?? 'subscribe';
  return `<section class="container conversion-preview" data-conversion-preview><p class="eyebrow">Your next step · availability preview</p><h2>Choose what you would like to explore.</h2><fieldset><legend>Campaign goal</legend><label><input type="radio" name="conversion" value="subscribe"${goal==='subscribe'?' checked':''}> Membership on the website</label><label><input type="radio" name="conversion" value="download"${goal==='download'?' checked':''}> Download the app</label></fieldset><p data-conversion-status role="status">${goal==='subscribe'?'Website membership':'App download'} is unavailable. No verified provider route is configured.</p><a class="button button-outline" href="/account/">View account readiness ↗︎</a><p class="small">This choice stays on this page. It does not create an account, start checkout or reserve a subscription.</p></section>`;
}

function campaignLinks(campaigns) {
  return `<div class="use-case-list">${campaigns.map((c,index) => `<a class="use-case-row" href="/campaigns/${e(c.id)}/"><span class="row-number">0${index + 1}</span><div><p class="eyebrow">${e(c.eyebrow)}</p><h3>${e(c.focus)}</h3><p>${e(c.description)}</p></div><span class="row-arrow" aria-hidden="true">↗︎</span></a>`).join('')}</div>`;
}

function approach() {
  return `<section class="approach container"><p class="eyebrow">01 / The intention</p><div class="approach-title"><h2>Less one-size-fits-all.<br><em>More room for you.</em></h2><p>Form is developing a conversational strength and movement experience. The intention is simple: keep your context visible, help you understand a plan, and leave room to change it.</p></div><div class="principles"><article><span>01</span><h3>Context comes first.</h3><p>Your goals, time, equipment and preferences are intended inputs, not afterthoughts.</p></article><article><span>02</span><h3>A reason behind a change.</h3><p>Explanations, corrections and undo are intended parts of the experience.</p></article><article><span>03</span><h3>A longer conversation.</h3><p>Guided execution, logging and comparable progress are in development.</p></article></div><div class="research-statement"><p class="eyebrow">An evidence-led ambition</p><h3>Expertise, with the evidence in view.</h3><p>Form's research direction brings together published physical therapy resources, elite training knowledge and scientific literature. The goal is to explain how evidence relates to your context—not to promise a perfect plan.</p><p class="small">Keeping a source, reading it, appraising its methods and synthesizing its findings are different steps. Evidence appraisal is ongoing. Published resources are not consultations or endorsements.</p><a class="text-link" href="/body-preview/">Explore a careful capture walkthrough ↗︎</a></div><p class="small">These are product intentions. This website does not demonstrate a working movement engine, clinical assessment or persistent progress tracking.</p></section>`;
}

function validateCampaigns(campaigns) {
  if (!Array.isArray(campaigns) || campaigns.length !== 3) throw new TypeError('Exactly three campaign configurations are required');
  const required = new Set(['weight-loss','after-illness','clinician-cleared-injury']);
  for (const c of campaigns) {
    if (!c || !required.delete(c.id)) throw new TypeError('Invalid or duplicate campaign ID');
    for (const key of ['eyebrow','title','description','focus','principle']) if (typeof c[key] !== 'string' || !c[key].trim() || c[key].length > 1200) throw new TypeError(`Invalid campaign ${key}`);
    if (!Array.isArray(c.details) || c.details.length !== 3 || c.details.some(v => typeof v !== 'string' || !v.trim() || v.length > 400)) throw new TypeError('Invalid campaign details');
    if (c.conversionGoal !== undefined && !['subscribe','download'].includes(c.conversionGoal)) throw new TypeError('Invalid conversion goal');
    if (!['strength','routine','return'].includes(c.goal) || !['lime','clay','blue'].includes(c.accent)) throw new TypeError('Invalid campaign presentation');
  }
}

export function marketingPages(campaigns) {
  validateCampaigns(campaigns);
  const home = `<section class="hero container"><div class="hero-copy"><p class="eyebrow">Strength. Movement. Your context.</p><h1>A little<br>more <em>you.</em></h1><p class="hero-deck">A more personal approach to movement is taking shape. Built around the life you have, and the goals you bring.</p><div class="hero-actions"><a class="button" href="#preview">Explore the preview <span aria-hidden="true">↗︎</span></a><a class="text-link" href="/use-cases/">Find your starting point</a></div><p class="small">Form is in development. Explore the concept today.</p></div>${illustration()}</section><div class="statement-strip"><p>YOUR GOALS <span aria-hidden="true">↗︎</span> YOUR TIME <span aria-hidden="true">↗︎</span> YOUR STARTING POINT <span aria-hidden="true">↗︎</span></p></div>${approach()}${demo()}<section class="starting-points container"><div class="section-heading"><div><p class="eyebrow">03 / Different starting points</p><h2>Where are you<br>coming from?</h2></div><p>Explore three intended use cases. Each begins with context, not a promised result.</p></div>${campaignLinks(campaigns)}</section><section class="journal-teaser container"><p class="eyebrow">04 / The Form journal</p><h2>Questions worth<br><em>moving with.</em></h2><p>Read about the ideas behind Form, with sources and clear boundaries around what we know.</p><a class="button button-outline" href="/journal/">Open the journal <span aria-hidden="true">↗︎</span></a></section>`;
  const useCases = `<section class="page-intro container"><p class="eyebrow">Your starting point</p><h1>One idea.<br>Different contexts.</h1><p>Form's intended approach starts with what matters to you. These pages explore possibilities, not available treatment or personalized programs.</p>${clearance}</section><section class="container">${campaignLinks(campaigns)}</section>${demo()}`;
  return [{path:'index.html',html:page('Movement, with room for you',home)}, {path:'use-cases/index.html',html:page('Find your starting point',useCases,{active:'use-cases'})}, ...campaigns.map(c => ({path:`campaigns/${c.id}/index.html`,html:page(c.title, `<section class="campaign-hero container accent-${c.accent}"><div><p class="eyebrow">${e(c.eyebrow)}</p><h1>${e(c.title)}</h1><p class="hero-deck">${e(c.description)}</p>${clearance}<a class="button" href="#preview">Explore this preview <span aria-hidden="true">↗︎</span></a><p class="small">In development · no account, download or subscription is available here.</p></div>${illustration()}</section><section class="campaign-context container"><p class="eyebrow">A starting point, not an outcome</p><h2>${e(c.focus)}</h2><p class="context-principle">${e(c.principle)}</p><ol class="context-list">${c.details.map(detail => `<li>${e(detail)}</li>`).join('')}</ol></section>${conversionPreview(c)}${demo(c.goal)}<section class="container onward"><p class="eyebrow">Keep exploring</p><a class="text-link" href="/use-cases/">All starting points ↗︎</a><a class="text-link" href="/journal/">Read the journal ↗︎</a><a class="text-link" href="/privacy/">Privacy and preview data ↗︎</a></section>`,{description:c.description,active:'use-cases'})}))];
}

export async function registerSourceTests() {
  const { test } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');
  const fixtures = ['weight-loss','after-illness','clinician-cleared-injury'].map(id => ({id,eyebrow:'Synthetic case',title:'Synthetic title',description:'Synthetic description',focus:'Synthetic focus',principle:'Synthetic principle',details:['One','Two','Three'],goal:'strength',accent:'lime'}));
  test('marketing emits complete, unique homepage, use-case and campaign pages', () => {
    const records = marketingPages(fixtures);
    assert.deepEqual(records.map(record => record.path), ['index.html','use-cases/index.html','campaigns/weight-loss/index.html','campaigns/after-illness/index.html','campaigns/clinician-cleared-injury/index.html']);
    for (const {html} of records) {
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('data-plan-preview'));
      assert.ok(html.includes('injury or illness'));
      assert.ok(html.includes('clinician clearance'));
      assert.ok(html.includes('href="/account/"'));
      assert.ok(html.includes('unavailable in this preview'));
      assert.ok(!/type="file"|<script(?![^>]*src=)/.test(html));
    }
  });
  test('marketing escapes campaign content and refuses invalid route configurations', () => {
    const malicious = structuredClone(fixtures);
    malicious[0].title = '<img src=x onerror=alert(1)>';
    malicious[0].details[0] = '<script>bad()</script>';
    const html = marketingPages(malicious)[2].html;
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>bad()'));
    const duplicate = structuredClone(fixtures); duplicate[1].id = duplicate[0].id;
    assert.throws(() => marketingPages(duplicate), TypeError);
    const traversal = structuredClone(fixtures); traversal[0].id = '../account';
    assert.throws(() => marketingPages(traversal), TypeError);
    assert.throws(() => marketingPages(null), TypeError);
    const badGoal = structuredClone(fixtures); badGoal[0].goal = 'diagnosis';
    assert.throws(() => marketingPages(badGoal), TypeError);
  });
}
