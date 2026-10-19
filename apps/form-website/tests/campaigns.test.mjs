import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { marketingPages } from '../src/marketing.mjs';
import { escapeHtml } from '../src/shell.mjs';

const configUrl = new URL('../content/campaigns.json', import.meta.url);
const scriptUrl = new URL('../public/site.mjs', import.meta.url);
const expectedDefaults = [
  ['weight-loss', 'strength', 'subscribe'],
  ['after-illness', 'return', 'download'],
  ['clinician-cleared-injury', 'return', 'subscribe']
];

async function retainedPages() {
  const bytes = await readFile(configUrl, 'utf8');
  const campaigns = JSON.parse(bytes);
  const before = JSON.stringify(campaigns);
  const pages = marketingPages(campaigns);
  assert.equal(JSON.stringify(campaigns), before, 'rendering must not change the supplied config');
  assert.equal(await readFile(configUrl, 'utf8'), bytes, 'retained config bytes must remain unchanged');
  return campaigns.map(campaign => {
    const matches = pages.filter(page => page.path === `campaigns/${campaign.id}/index.html`);
    assert.equal(matches.length, 1, campaign.id);
    return { campaign, html: matches[0].html };
  });
}

function radios(html, name) {
  const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]);
  const values = inputs.filter(tag => tag.includes(`name="${name}"`)).map(tag => ({
    value: /value="([^"]+)"/.exec(tag)?.[1], checked: /\schecked(?:\s|>)/.test(tag)
  }));
  assert.equal(values.filter(input => input.checked).length, 1, `${name} has one selected input`);
  return values;
}

function text(html, attribute) {
  const matches = [...html.matchAll(new RegExp(`<[^>]+\\s${attribute}(?:\\s[^>]*)?>([^<]*)<`, 'g'))];
  assert.equal(matches.length, 1, attribute);
  return matches[0][1].replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[entity]));
}

test('retained campaign source qualifies all three audience pages, defaults and unavailable conversion routes', async () => {
  const records = await retainedPages();
  assert.deepEqual(records.map(({campaign:c}) => [c.id, c.goal, c.conversionGoal]), expectedDefaults);
  assert.equal(new Set(records.map(({campaign:c}) => c.title)).size, 3);
  assert.equal(new Set(records.map(({campaign:c}) => c.description)).size, 3);
  for (const { campaign:c, html } of records) {
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    for (const [tag, value] of [['h1',c.title],['h2',c.focus]]) assert.ok(html.includes(`<${tag}>${escapeHtml(value)}</${tag}>`), c.id);
    assert.ok(html.includes(`<title>${escapeHtml(c.title)} · Form</title>`));
    for (const [className, value] of [['eyebrow',c.eyebrow],['hero-deck',c.description],['context-principle',c.principle]]) assert.ok(html.includes(`<p class="${className}">${escapeHtml(value)}</p>`), c.id);
    assert.ok(html.includes(`<meta name="description" content="${escapeHtml(c.description)}">`));
    assert.ok(html.includes(`<ol class="context-list">${c.details.map(detail => `<li>${escapeHtml(detail)}</li>`).join('')}</ol>`));
    assert.deepEqual(radios(html,'goal').filter(input => input.checked).map(input => input.value), [c.goal]);
    assert.deepEqual(radios(html,'conversion').filter(input => input.checked).map(input => input.value), [c.conversionGoal]);
    assert.equal(text(html,'data-conversion-status'), `${c.conversionGoal === 'download' ? 'App download' : 'Website membership'} is unavailable. No verified provider route is configured.`);
    for (const boundary of ['A starting point, not an outcome','Interactive preview · no personalized advice','Get clinician clearance before exercising and follow their restrictions.','Form is not rehabilitation, diagnosis, or a substitute for medical care.','In development · no account, download or subscription is available here.','This choice stays on this page. It does not create an account, start checkout or reserve a subscription.']) assert.ok(html.includes(boundary), `${c.id}: ${boundary}`);
    assert.match(html,/href="\/account\/">View account readiness/);
    assert.match(html,/href="\/account\/">Check account availability/);
    assert.doesNotMatch(html,/<a\b[^>]*\bdownload(?:\s|=|>)|<form\b[^>]*\baction=|href="(?:https?:|\/checkout)/);
  }
  assert.match(records[0].campaign.principle,/does not prescribe a program or promise a physical outcome/);
  assert.match(records[1].campaign.description,/once your clinician has cleared you to exercise/);
  assert.match(records[2].campaign.description,/not rehabilitation or a substitute for your care team/);
});

// This strict synthetic DOM exercises shipped listeners; it does not prove browser rendering or accessibility.
function strictNode(properties, writable = []) {
  return new Proxy(properties, {
    get(target, key) {
      assert.ok(Object.hasOwn(target, key), `Unexpected DOM access: ${String(key)}`);
      return target[key];
    },
    set(target, key, value) {
      assert.ok(writable.includes(key), `Unexpected DOM mutation: ${String(key)}`);
      target[key] = value;
      return true;
    }
  });
}

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      assert.equal(typeof callback, 'function');
      assert.ok(!listeners.has(type), `Duplicate ${type} listener`);
      listeners.set(type, callback);
    },
    dispatch(type) {
      assert.ok(listeners.has(type), `Missing ${type} listener`);
      let prevented = 0;
      listeners.get(type)(strictNode({preventDefault() { prevented++; }}));
      return prevented;
    },
    types() { return [...listeners.keys()].sort(); }
  };
}

function controls({ campaign, html }) {
  const goals = radios(html, 'goal');
  const conversions = radios(html, 'conversion');
  const timeTag = [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes('name="minutes"'));
  assert.ok(timeTag);
  const minutes = {value:/value="([^"]+)"/.exec(timeTag)[1]};
  const leaves = Object.fromEntries(['data-time-output','data-plan-title','data-plan-copy','data-plan-time','data-plan-caution'].map(attribute => [attribute, {textContent:text(html, attribute)}]));
  const status = {textContent:text(html,'data-conversion-status')};
  const planEvents = events();
  const conversionEvents = events();
  const form = strictNode({
    addEventListener:planEvents.addEventListener,
    querySelector(selector) {
      if (selector === 'input[name="goal"]:checked') return strictNode(goals.find(input => input.checked));
      assert.equal(selector, 'input[name="minutes"]');
      return strictNode(minutes);
    }
  });
  const plan = strictNode({querySelector(selector) {
    if (selector === 'form') return form;
    const key = /^\[([^\]]+)\]$/.exec(selector)?.[1];
    assert.ok(Object.hasOwn(leaves,key), `Unexpected plan selector: ${selector}`);
    return strictNode(leaves[key], ['textContent']);
  }});
  const conversion = strictNode({
    addEventListener:conversionEvents.addEventListener,
    querySelector(selector) {
      if (selector === 'input[name="conversion"]:checked') return strictNode(conversions.find(input => input.checked));
      assert.equal(selector, '[data-conversion-status]');
      return strictNode(status, ['textContent']);
    }
  });
  const select = (inputs, value) => {
    assert.ok(inputs.some(input => input.value === value));
    for (const input of inputs) input.checked = input.value === value;
  };
  return {campaign, plan, conversion, planEvents, conversionEvents,
    setGoal(value) { select(goals,value); }, setMinutes(value) { minutes.value = value; },
    setConversion(value) { select(conversions,value); },
    state() { return {plan:Object.fromEntries(Object.entries(leaves).map(([key,value]) => [key,value.textContent])), conversion:status.textContent}; }
  };
}

async function runtime() {
  const records = await retainedPages();
  const sections = records.map(controls);
  const document = strictNode({querySelectorAll(selector) {
    assert.ok(['[data-plan-preview]','[data-conversion-preview]'].includes(selector), selector);
    return Object.freeze(sections.map(section => selector === '[data-plan-preview]' ? section.plan : section.conversion));
  }});
  const globals = {document};
  const forbidden = [];
  for (const key of ['fetch','localStorage','sessionStorage','indexedDB','caches','navigator','location','window','open','XMLHttpRequest','WebSocket','EventSource','Worker','setTimeout','setInterval']) {
    Object.defineProperty(globals,key,{get() { forbidden.push(key); assert.fail(`Unexpected network/storage/navigation/provider access: ${key}`); },set() { forbidden.push(key); assert.fail(`Unexpected global mutation: ${key}`); }});
  }
  const initial = sections.map(section => section.state());
  const source = await readFile(scriptUrl,'utf8');
  const context = createContext(globals,{codeGeneration:{strings:false,wasm:false}});
  new Script(source,{filename:scriptUrl.pathname}).runInContext(context,{timeout:1000});
  assert.deepEqual(sections.map(section => section.state()),initial,'shipped script must retain the actual rendered defaults');
  for (const section of sections) {
    assert.deepEqual(section.planEvents.types(),['change','input','submit']);
    assert.deepEqual(section.conversionEvents.types(),['change']);
  }
  return {sections, forbidden};
}

test('shipped site script in synthetic DOM handles actual campaign goal/time/submit controls independently', async () => {
  const {sections,forbidden} = await runtime();
  for (const section of sections) {
    const others = sections.filter(other => other !== section);
    const before = others.map(other => other.state());
    const conversionBefore = section.state().conversion;
    section.setGoal('routine'); section.planEvents.dispatch('change');
    assert.equal(section.state().plan['data-plan-title'],'Give your routine a place to begin.');
    assert.equal(section.state().plan['data-plan-copy'],'A future planning conversation could ask what you enjoy, what gets in the way and which days feel realistic.');
    assert.equal(section.state().plan['data-plan-caution'],'This is a planning illustration. It does not predict weight change or other outcomes.');
    for (const [input,expected] of [['32',30],['999',45],['-3',10],['invalid',20]]) {
      section.setMinutes(input); section.planEvents.dispatch('input');
      assert.equal(section.state().plan['data-time-output'],`${expected} minutes`);
      assert.equal(section.state().plan['data-plan-time'],`A ${expected}-minute window`);
    }
    section.setGoal('return'); section.planEvents.dispatch('input');
    assert.equal(section.state().plan['data-plan-title'],'Keep your current context in view.');
    assert.match(section.state().plan['data-plan-caution'],/clinician clearance comes first.*cannot assess readiness or prescribe rehabilitation/);
    const preSubmit = section.state();
    assert.equal(section.planEvents.dispatch('submit'),1,'submit must prevent default navigation');
    assert.deepEqual(section.state(),preSubmit);
    assert.equal(section.state().conversion,conversionBefore);
    assert.deepEqual(others.map(other => other.state()),before);
  }
  assert.deepEqual(forbidden,[]);
});

test('shipped conversion listeners in synthetic DOM keep subscribe/download unavailable without side effects', async () => {
  const {sections,forbidden} = await runtime();
  for (const section of sections) {
    const others = sections.filter(other => other !== section);
    const before = others.map(other => other.state());
    const planBefore = section.state().plan;
    for (const [goal,label] of [['download','App download'],['subscribe','Website membership']]) {
      section.setConversion(goal); section.conversionEvents.dispatch('change');
      assert.equal(section.state().conversion,`${label} is unavailable. No verified provider route is configured.`);
      assert.deepEqual(section.state().plan,planBefore);
      assert.deepEqual(others.map(other => other.state()),before);
    }
  }
  assert.deepEqual(forbidden,[]);
});
