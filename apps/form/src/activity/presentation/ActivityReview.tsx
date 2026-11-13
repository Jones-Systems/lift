import { View } from 'react-native';
import { Notice, Subtitle, Txt } from '../../features/shared/ui';
import { t } from '../../features/shared/tokens';
import { resolveIssue, reviewProblems } from './draftEditing';
import { ActivityAction, ActivityValues } from './ActivityScreens';
import type { ActivityActions, ActivitySnapshot } from './presentation';

export function ActivityReview({ snapshot, actions }: { snapshot: ActivitySnapshot; actions: ActivityActions }) {
  const result = snapshot.consumer!.draft.result;
  if (!result) return <Notice kind="warning" text="The structured review is unavailable." />;
  const problems = reviewProblems(result);
  return <>
    <ActivityValues value={result.candidate} />
    {result.reviewedText ? <><Subtitle text="Reviewed speech input" /><Txt role="body">{result.reviewedText}</Txt></> : null}
    {result.unsupportedFragments.map((fragment, index) => <Notice key={index} kind="warning" text={`Unresolved or excluded fragment: ${fragment}`} />)}
    <Subtitle text="Issues and explicit resolutions" />
    {result.issues.length === 0 ? <Txt role="body">No parser issues were reported. Validation and your explicit confirmation are still required.</Txt> : null}
    {result.issues.map(issue => {
      const discardable = ['unsupportedPhrase', 'unsupportedLocale', 'negatedActivity', 'futureIntent', 'correctionAmbiguous'].includes(issue.code);
      return <View key={issue.id} style={{ gap: t.space.s8 }}>
        <Notice kind={issue.blocking && !issue.resolution ? 'warning' : 'info'} text={`${issue.fieldPath}: ${issue.message} (${issue.code}); ${issue.resolution ? `resolution: ${issue.resolution.kind}` : 'unresolved'}`} />
        {issue.fragment ? <Txt role="body">{`Fragment: ${issue.fragment}`}</Txt> : null}
        {issue.candidates?.map(candidate => <Txt role="body" key={candidate.id}>{`${candidate.id}: ${candidate.label}`}</Txt>)}
        {!issue.resolution ? <>
          {discardable ? <ActivityAction secondary label={`Exclude fragment: ${issue.code}`} onPress={() => { void actions.edit(current => resolveIssue(current, issue.id, { kind: 'discardedFragment' })); }} />
            : <ActivityAction secondary label={`I corrected ${issue.fieldPath || issue.code}`} onPress={() => { void actions.edit(current => resolveIssue(current, issue.id, { kind: 'edited' })); }} />}
          {issue.code === 'metricConflict' || issue.code === 'possibleDuplicate' ? <ActivityAction secondary
            label={issue.code === 'metricConflict' ? 'Accept approximate metrics' : 'Acknowledge possible duplicate'}
            onPress={() => { void actions.edit(current => resolveIssue(current, issue.id, { kind: 'acknowledged', code: issue.code === 'metricConflict' ? 'approximateMetrics' : 'possibleDuplicate' })); }} /> : null}
        </> : null}
      </View>;
    })}
    {problems.map((problem, index) => <Notice key={index} kind="warning" text={`Needs correction: ${problem.fieldPath || 'review'} — ${problem.code}`} />)}
    <Notice kind="info" text="Save activity explicitly confirms that this activity was performed and that the displayed civil date, zone, every observation, load disposition and issue resolution are correct. Back preserves the draft and removes this confirmation." />
    <ActivityAction label="Save activity" id="activity-save" reason={problems.length ? 'Correct the listed fields and review again before saving.' : null}
      onPress={() => { void actions.save(); }} />
  </>;
}
