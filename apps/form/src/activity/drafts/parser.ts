import type { ReviewedSpeechText } from '../../native/speech.types';
import type { ExerciseSnapshot, Split } from '../contracts';
import { addCivilDays, civilDayBoundaries, localDateAt, parseCivilDate } from './dates';
import { metricConflicts } from './metrics';
import { copyExerciseSnapshot, stableDraftId } from './model';
import type { CaptureContext, DraftExercise, DraftIssue, DraftIssueCode, DraftItem, DraftResult } from './model';
const numbers: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const numeric = '(?:-?\\d+(?:\\.\\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';
const number = (text: string) => numbers[text.toLowerCase()] ?? Number(text);
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function scanner(text: string) {
  let rest = text;
  const take = (expression: RegExp, accept: (match: RegExpExecArray) => void) => {
    const matches = [...rest.matchAll(expression)];
    for (const match of matches) { accept(match); const start = match.index!; rest = rest.slice(0, start) + ' '.repeat(match[0].length) + rest.slice(start + match[0].length); }
  };
  const remove = (start: number, length: number) => { rest = rest.slice(0, start) + ' '.repeat(length) + rest.slice(start + length); };
  return { take, remove, remaining: () => rest };
}
export function parseReviewedActivity(text: ReviewedSpeechText, context: CaptureContext, catalog: ExerciseSnapshot[]): DraftResult {
  if (text.reviewed !== true || text.source !== 'apple_on_device' || !text.sessionId || !text.text.trim() || text.text.length > 12000) throw new Error('reviewed_speech_required');
  const source = text.text.trim(), scan = scanner(source), issues: DraftIssue[] = [], unsupportedFragments: string[] = [];
  const issue = (code: DraftIssueCode, fieldPath: string, message: string, fragment?: string, candidates?: DraftIssue['candidates']) => {
    issues.push({ id: stableDraftId(context, 'issue', issues.length), code, fieldPath, blocking: true, message, ...(fragment ? { fragment } : {}), ...(candidates ? { candidates } : {}) });
  };
  const candidate: DraftResult['candidate'] = { date: null, kind: 'workout', items: [], performedConfirmed: false, source: 'nativeSpeech', draftId: context.draftId };
  const result = (): DraftResult => ({ draftId: context.draftId, parserVersion: 'activity-parser-v1', context: Object.freeze({ ...context }), candidate, issues, reviewedText: source, unsupportedFragments });
  if (!/^en(?:-|$)/i.test(text.locale)) { issue('unsupportedLocale', '', 'Structured parsing currently supports English only. Edit the text or enter fields manually.', source); unsupportedFragments.push(source); return result(); }
  const captureDate = localDateAt(context.capturedAt, context.timeZone);
  if (!captureDate || captureDate !== context.referenceLocalDate) issue('clockUncertain', 'date', 'The frozen capture date or confirmed time zone is unavailable or inconsistent.');
  const dates: { value: string; source: 'spokenExplicit' | 'spokenRelative' }[] = [];
  scan.take(/\b\d{4}-\d{2}-\d{2}\b/g, match => dates.push({ value: match[0], source: 'spokenExplicit' }));
  scan.take(new RegExp(`\\b(${months.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'), match => {
    if (!match[3]) issue('dateAmbiguous', 'date', 'Choose a year for this date.', match[0]);
    else dates.push({ value: `${match[3]}-${String(months.indexOf(match[1].toLowerCase()) + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`, source: 'spokenExplicit' });
  });
  scan.take(/\b(today|yesterday)\b/gi, match => {
    if (!parseCivilDate(context.referenceLocalDate)) issue('dateUnavailable', 'date', 'The reference date is unavailable.');
    else dates.push({ value: match[1].toLowerCase() === 'today' ? context.referenceLocalDate : addCivilDays(context.referenceLocalDate, -1), source: 'spokenRelative' });
  });
  scan.take(/\b(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:on|date)\s+\d{1,2}[.-]\d{1,2}(?:[.-]\d{2,4})?|(?:(?:last|next|this)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi, match => issue('dateAmbiguous', 'date', 'Choose an explicit calendar date.', match[0]));
  const distinct = [...new Set(dates.map(date => date.value))];
  if (distinct.length > 1) issue('dateConflict', 'date', 'Multiple spoken dates need explicit selection; this draft will not split itself.', undefined, distinct.map(id => ({ id, label: id })));
  const chosen = context.selectedDate ?? distinct[0] ?? context.referenceLocalDate;
  if (context.selectedDate && distinct.some(date => date !== context.selectedDate)) issue('dateConflict', 'date', 'Selected and spoken dates differ. Choose the date to save.', undefined, [...new Set([context.selectedDate, ...distinct])].map(id => ({ id, label: id })));
  const boundary = civilDayBoundaries(chosen, context.timeZone);
  if (boundary.status === 'unavailable') issue('dateUnavailable', 'date', 'This civil date or zone is unavailable. Use the reviewed date picker.', chosen);
  candidate.date = { localDate: chosen, timeZone: context.timeZone, calendar: 'iso8601', source: context.selectedDate ? 'selected' : dates[0]?.source ?? 'captureDefault', capturedAt: context.capturedAt, referenceLocalDate: context.referenceLocalDate, confirmed: false, selectedDate: context.selectedDate, spokenDates: distinct };
  if (/\b(?:exercise snack|movement snack)\b/i.test(source)) { candidate.kind = 'exerciseSnack'; scan.take(/\b(?:exercise snack|movement snack)\b/gi, () => {}); }
  const unsafe: [RegExp, DraftIssueCode, string][] = [
    [/\b(?:did(?:n['’]t| not)|have(?:n['’]t| not)|never|did not|not (?:run|running|exercise|do))\b/i, 'negatedActivity', 'Negated activity is not recorded as performance. Edit or discard this fragment.'],
    [/\b(?:tomorrow|will|going to|plan to|want to|might|should|next week)\b|\?/i, 'futureIntent', 'Plans and questions need review; this is not completed activity.'],
    [/\b(?:no[, ]+\d|actually|correction|rather|instead)\b|\d\s*[—–]\s*(?:no|\d)/i, 'correctionAmbiguous', 'Review this correction before selecting the reported value.'],
  ];
  for (const [expression, code, message] of unsafe) if (expression.test(source)) { issue(code, '', message, source); unsupportedFragments.push(source); return result(); }
  const remaining = scan.remaining();
  const clauses: string[] = [];
  const splitDuration = new RegExp(`^\\s*${numeric}\\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\\b`, 'i');
  let clauseStart = 0;
  for (const boundary of remaining.matchAll(/;|\n|\bthen\b|\band (?=(?:i\s+)?(?:did\s+)?(?:\d+|one|two|three|four|five)\s+sets?\b)/gi)) {
    const clause = remaining.slice(clauseStart, boundary.index!);
    // Leave explicit segment durations for the split parser; other boundaries still start an item.
    if (/^then$/i.test(boundary[0]) && /\bsplits?\b/i.test(clause) && splitDuration.test(remaining.slice(boundary.index! + boundary[0].length))) continue;
    if (clause.trim()) clauses.push(clause);
    clauseStart = boundary.index! + boundary[0].length;
  }
  if (remaining.slice(clauseStart).trim()) clauses.push(remaining.slice(clauseStart));
  const findMentions = (clause: string) => {
    const matches: { index: number; length: number; snapshots: ExerciseSnapshot[]; mention: string }[] = [];
    const names = [...new Set(catalog.map(value => value.name).filter(Boolean))].sort((a, b) => b.length - a.length);
    for (const name of names) {
      for (const match of clause.matchAll(new RegExp(`\\b${escaped(name)}\\b`, 'giu'))) {
        const start = match.index!, end = start + match[0].length;
        if (matches.some(value => start < value.index + value.length && end > value.index)) continue;
        matches.push({ index: start, length: match[0].length, snapshots: catalog.filter(value => value.name.toLowerCase() === name.toLowerCase()), mention: match[0] });
      }
    }
    if (matches.length === 0) for (const match of clause.matchAll(/\b(?:ran|running|run)\b/gi)) {
      const runs = catalog.filter(value => value.kind === 'run');
      if (runs.length) matches.push({ index: match.index!, length: match[0].length, snapshots: runs, mention: match[0] });
    }
    return matches.sort((a, b) => a.index - b.index);
  };
  for (const clause of clauses) {
    const mentions = findMentions(clause);
    if (mentions.length > 1) {
      // Separate repeated named occurrences. Prefix counts for later names require review.
      for (let index = 0; index < mentions.length; index++) parseItem(clause.slice(index === 0 ? 0 : mentions[index].index, mentions[index + 1]?.index), [mentions[index]]);
      issue('unsupportedPhrase', 'items', 'Review item boundaries when several exercise names share a clause.', clause);
    } else parseItem(clause, mentions);
  }
  if (!candidate.items.length) issue('exerciseMissing', 'items', 'Select at least one performed exercise.');
  return result();

  function parseItem(clause: string, mentions: ReturnType<typeof findMentions>): void {
    const itemIndex = candidate.items.length, path = `items.${itemIndex}`, itemScan = scanner(clause);
    let exercise: DraftExercise;
    const explicit = /\b(global|personal):([A-Za-z0-9:_-]+)(?:@([1-9]\d*))?\b/i.exec(clause);
    if (explicit) {
      const matches = catalog.filter(value => value.ref.source === explicit[1].toLowerCase() && value.ref.id === explicit[2] && (!explicit[3] || (value.ref.source === 'personal' && value.ref.revision === Number(explicit[3]))));
      exercise = select(matches, explicit[0]); itemScan.remove(explicit.index, explicit[0].length);
    } else if (mentions.length) {
      const mention = mentions[0], found = clause.toLowerCase().indexOf(mention.mention.toLowerCase());
      exercise = select(mention.snapshots, mention.mention); itemScan.remove(found, mention.length);
    } else {
      const custom = /\b(?:exercise (?:called|named)|custom exercise|movement (?:called|named))\s+["“]?(.+?)["”]?(?=\s+(?:for|with|at|\d+\s+(?:sets?|reps?))\b|$)/i.exec(clause);
      const inferred = /^\s*(?:i\s+)?(?:did|performed)\s+(.+?)(?=\s+(?:for|with|at|\d+\s+sets?)\b|$)/i.exec(clause);
      const match = custom ?? inferred;
      const mention = match?.[1]?.replace(/["”.,]+$/, '').trim() ?? '';
      exercise = mention ? { state: 'custom', mention, fields: { name: mention, description: '', movement: null, measurementType: 'unspecified', kind: 'resistance', loadApplicability: 'unspecified', loadLabel: null } } : { state: 'missing', mention: clause.trim() };
      if (match) itemScan.remove(match.index, match[0].length);
      issue(mention ? 'customExercise' : 'exerciseMissing', `${path}.exercise`, mention ? 'Review and explicitly create or select this personal exercise before saving the activity.' : 'Select the exercise for this fragment.', mention || clause.trim());
    }
    const item: DraftItem = { id: stableDraftId(context, 'item', itemIndex), exercise, load: { state: 'missing' } };
    const setField = (field: 'reportedSetCount' | 'durationSeconds', value: number) => {
      if (item[field] !== undefined && item[field] !== value) issue('metricConflict', `${path}.${field}`, 'Several values were reported for the same field. Select the intended value.');
      else item[field] = value;
    };
    const loadCandidates: DraftItem['load'][] = [];
    itemScan.take(/\b(?:i (?:don['’]t|do not) remember(?: the)?(?: weight)?|unknown (?:weight|load)|weight unknown)\b/gi, () => loadCandidates.push({ state: 'unknown', confirmed: true }));
    itemScan.take(/\b(?:body\s?weight|no added weight|unloaded)\b/gi, match => loadCandidates.push({ state: 'notApplicable', reason: /body/i.test(match[0]) ? 'bodyweight' : 'unloaded' }));
    itemScan.take(new RegExp(`(${numeric})\\s*(kg|kilograms?|lb|lbs|pounds?)\\b(?:\\s*(total|per implement|per side|assistance))?`, 'gi'), match => loadCandidates.push({ state: 'knownValue', value: number(match[1]), unit: /^(?:lb|pound)/i.test(match[2]) ? 'lb' : 'kg', basis: match[3]?.toLowerCase() === 'total' ? 'total' : match[3]?.toLowerCase() === 'per implement' ? 'perImplement' : match[3]?.toLowerCase() === 'per side' ? 'perSide' : match[3]?.toLowerCase() === 'assistance' ? 'assistance' : 'unspecified' }));
    if (loadCandidates.length === 1) item.load = loadCandidates[0];
    else if (loadCandidates.length > 1) { item.load = loadCandidates[0]; issue('correctionAmbiguous', `${path}.load`, 'Several load dispositions were reported. Choose the intended load.'); }
    itemScan.take(new RegExp(`(${numeric})\\s*sets?\\b`, 'gi'), match => setField('reportedSetCount', number(match[1])));
    const repetitions: number[] = [];
    itemScan.take(new RegExp(`(${numeric})\\s*(?:reps?|repetitions?)\\b`, 'gi'), match => repetitions.push(number(match[1])));
    if (repetitions.length) {
      item.sets = repetitions.map((value, index) => ({ id: stableDraftId(context, `set${itemIndex}`, index), repetitions: value, load: { ...item.load } }));
      if (item.reportedSetCount !== undefined && item.reportedSetCount !== repetitions.length) issue('metricConflict', `${path}.sets`, 'Reported set count differs from explicit repetition observations. Do not repeat a set automatically.');
    }
    const splitMarker = /\b(?:(partial|complete)\s+)?(?:(incremental|cumulative)\s+)?splits?\s*:?/i.exec(itemScan.remaining());
    let metricText = itemScan.remaining(), splitText = '';
    if (splitMarker) {
      splitText = metricText.slice(splitMarker.index + splitMarker[0].length);
      metricText = metricText.slice(0, splitMarker.index);
      if (splitMarker[1]) item.splitCoverage = splitMarker[1].toLowerCase() as 'partial' | 'complete';
      if (splitMarker[2]?.toLowerCase() !== 'incremental') issue('unsupportedPhrase', `${path}.splits`, 'Confirm incremental segment durations; cumulative or unspecified split semantics are not inferred.', splitText);
    }
    const parsed = parseMetrics(metricText, path);
    Object.assign(item, parsed.values);
    preserveRemainder(parsed.rest, path);
    if (splitMarker) {
      item.splits = [];
      for (const [index, fragment] of splitText.split(/\s*(?:,|\band\b|\bthen\b)\s*/i).filter(Boolean).entries()) {
        const split = parseMetrics(fragment, `${path}.splits.${index}`);
        preserveRemainder(split.rest, `${path}.splits.${index}`);
        if (split.values.durationSeconds === undefined) issue('durationMissing', `${path}.splits.${index}`, 'Every incremental split needs an explicit duration.', fragment);
        else item.splits.push({ id: stableDraftId(context, `split${itemIndex}`, index), sequence: index + 1, ...split.values } as Split);
      }
    }
    const kind = exercise.state === 'selected' ? exercise.snapshot.kind : undefined;
    if (kind === 'run') {
      if (loadCandidates.length && !(item.load.state === 'notApplicable' && item.load.reason === 'timedActivity')) issue('invalidValue', `${path}.load`, 'Run load must use the timed-activity disposition.');
      item.load = { state: 'notApplicable', reason: 'timedActivity' };
      if (item.durationSeconds === undefined) issue('durationMissing', `${path}.durationSeconds`, 'Add the reported run duration.');
    } else if (kind === 'timed' && item.load.state === 'missing' && item.durationSeconds !== undefined) item.load = { state: 'notApplicable', reason: 'timedActivity' };
    if (item.load.state === 'missing') issue('loadMissing', `${path}.load`, 'What weight did you use? Enter weight, no added weight, or I don’t remember.');
    for (const conflict of metricConflicts(item)) issue('metricConflict', `${path}${conflict.fieldPath ? `.${conflict.fieldPath}` : ''}`, conflict.message);
    candidate.items.push(item);
  }
  function select(matches: ExerciseSnapshot[], mention: string): DraftExercise {
    if (matches.length === 1) return { state: 'selected', ref: { ...matches[0].ref }, snapshot: copyExerciseSnapshot(matches[0]) };
    if (matches.length > 1) { issue('exerciseAmbiguous', `items.${candidate.items.length}.exercise`, 'Several exercises match this name. Select an identity.', mention, matches.map(value => ({ id: `${value.ref.source}:${value.ref.id}`, label: `${value.name} · ${value.ref.source} · ${value.movement ?? value.ref.id}` }))); return { state: 'ambiguous', mention, candidates: matches.map(copyExerciseSnapshot) }; }
    issue('exerciseMissing', `items.${candidate.items.length}.exercise`, 'This exercise reference is unavailable. Select from the owned catalog.', mention);
    return { state: 'missing', mention };
  }
  function parseMetrics(fragment: string, path: string) {
    const metrics = scanner(fragment), values: Pick<DraftItem, 'durationSeconds' | 'distance' | 'pace' | 'speed'> = {};
    const assign = (field: 'distance' | 'pace' | 'speed', value: unknown) => {
      if (values[field] !== undefined) issue('metricConflict', `${path}.${field}`, 'Several reported metrics need review.');
      else Object.assign(values, { [field]: value });
    };
    metrics.take(/\b(\d+):(\d{2})\s*(?:(?:per|\/)\s*(mile|mi|km|kilomet(?:er|re))|(?:mile|mi|km|kilomet(?:er|re))\s+pace)\b/gi, match => {
      const unitText = match[3] ?? /(?:mile|mi|km|kilomet(?:er|re))/i.exec(match[0])?.[0] ?? '';
      if (Number(match[2]) >= 60) issue('invalidValue', `${path}.pace`, 'Pace seconds must be below sixty.', match[0]);
      assign('pace', { secondsPerUnit: Number(match[1]) * 60 + Number(match[2]), unit: /^(?:mi|mile)/i.test(unitText) ? 'mi' : 'km' });
    });
    metrics.take(new RegExp(`(${numeric})\\s*(minutes?|mins?|seconds?|secs?)\\s*(?:per|/)\\s*(miles?|mi|kilomet(?:er|re)s?|km)\\b`, 'gi'), match => assign('pace', { secondsPerUnit: number(match[1]) * (/^m/i.test(match[2]) ? 60 : 1), unit: /^(?:mi|mile)/i.test(match[3]) ? 'mi' : 'km' }));
    metrics.take(/\b\d+(?:\.\d+)?\s*(?:mile|mi|km|kilomet(?:er|re))\s+pace\b/gi, match => issue('unsupportedPhrase', `${path}.pace`, 'Use explicit minutes/seconds per distance or M:SS pace; this decimal pace is ambiguous.', match[0]));
    metrics.take(new RegExp(`(${numeric})\\s*(mph|kph|km/h|mi/h|m/s|miles? per hour|kilomet(?:er|re)s? per hour|met(?:er|re)s? per second)\\b`, 'gi'), match => assign('speed', { value: number(match[1]), unit: /^(?:mph|mi)/i.test(match[2]) ? 'mi/h' : /^(?:kph|km|kilo)/i.test(match[2]) ? 'km/h' : 'm/s' }));
    metrics.take(new RegExp(`(${numeric})\\s*(miles?|mi|kilomet(?:er|re)s?|km|met(?:er|re)s?|m)\\b`, 'gi'), match => assign('distance', { value: number(match[1]), unit: /^(?:mi|mile)/i.test(match[2]) ? 'mi' : /^(?:km|kilo)/i.test(match[2]) ? 'km' : 'm' }));
    const durations: { value: number; unit: string }[] = [];
    metrics.take(new RegExp(`(${numeric})\\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\\b`, 'gi'), match => durations.push({ value: number(match[1]), unit: match[2].toLowerCase() }));
    if (durations.length) {
      const units = durations.map(value => value.unit[0]);
      if (new Set(units).size !== units.length) issue('metricConflict', `${path}.durationSeconds`, 'Repeated duration units may be separate reports. Review the total.');
      values.durationSeconds = durations.reduce((total, value) => total + value.value * (value.unit[0] === 'h' ? 3600 : value.unit[0] === 'm' ? 60 : 1), 0);
    }
    metrics.take(/\b(?:pace|speed|weight|load)\s+(?:\d+(?::\d{2})?(?:\.\d+)?)(?!\w)/gi, match => issue('unitMissing', path, 'Add the explicit unit for this value.', match[0]));
    metrics.take(/\b\d+:\d{2}\b/g, match => issue('unitMissing', `${path}.pace`, 'Specify the distance unit for pace.', match[0]));
    metrics.take(/-?\b\d+(?:\.\d+)?\b/g, match => issue('unitMissing', path, 'This value needs an explicit quantity and unit.', match[0]));
    return { values, rest: metrics.remaining() };
  }
  function preserveRemainder(fragment: string, path: string) {
    const residual = fragment.replace(/\b(?:i|did|do|performed|went|for|at|with|of|the|a|an|and|was|it|my|workout|record|recorded|please|hey|on|in|total|average)\b/gi, ' ').replace(/[\s,.!"“”]+/g, ' ').trim();
    if (residual) { unsupportedFragments.push(residual); issue('unsupportedPhrase', path, 'Some words are outside the supported grammar. Review or explicitly discard this fragment.', residual); }
  }
}
