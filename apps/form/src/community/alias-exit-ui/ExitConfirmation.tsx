import { Gutter, Nav, Notice, PlainAction, PrimaryAction, Screen, Subtitle, Title } from '../../features/shared/ui';
import type { AliasExitContext } from './contracts';
import { AliasExitStatus, useAliasExitPresentation } from './AliasScreen';

export function ExitConfirmation({ context, mode }: { context: AliasExitContext; mode: 'leave' | 'close' }) {
  const presentation = useAliasExitPresentation(context, mode);
  if (!presentation) return <Screen><Gutter><Notice kind="info" text="Opening Community…" /></Gutter></Screen>;
  const { model, view } = presentation;
  const label = mode === 'leave' ? 'Leave group' : 'Close group';
  return <Screen testID={`screen-community-${mode}`} nav={view.canClose ? <Nav back="Group" onBack={model.close} /> : <Nav />}>
    <Gutter>
      <Title text={`${label}?`} />
      {!view.ended ? <>
        <Subtitle text={view.groupName ?? 'Group details unavailable'} />
        {!view.receipt ? <Notice kind="warning" announce text={mode === 'leave'
          ? 'Confirm that you want to leave this group.' : 'Confirm that you want to close this group as its owner.'} /> : null}
        <PrimaryAction label={label} captureId={`community-${mode}-confirm`} loading={view.pending} disabled={!view.canSubmit}
          onPress={() => void model.submit()} />
        <PlainAction label={view.receipt ? 'Done' : 'Cancel'} chevron={null} disabled={!view.canClose} onPress={model.close} />
      </> : null}
      <AliasExitStatus model={model} view={view} />
    </Gutter>
  </Screen>;
}
