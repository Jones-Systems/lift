import { useLayoutEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { SourcePlanDetailSlotContext } from '../../contract';
import { t } from '../../shared/tokens';
import {
  AccountRow, Gutter, Nav, Notice, PlainAction, PrimaryAction, RowGroup, Screen, Subtitle, Title,
} from '../../shared/ui';
import { sourcePlanItemHeading, sourcePlanItemRows, sourcePlanSummaryRows } from './rows';

type Binding = SourcePlanDetailSlotContext & { context: SourcePlanDetailSlotContext };
type Attachment = {
  binding: Binding; live: boolean; expired: boolean; busy: boolean; attempted: boolean; closed: boolean;
  outcome: 'idle' | 'selected' | 'unavailable';
};

function current(attachment: Attachment, binding: Binding): boolean {
  if (!attachment.live || attachment.binding !== binding || attachment.expired || attachment.closed) return false;
  const context = binding.context;
  if (context.plan !== binding.plan || context.sessionGeneration !== binding.sessionGeneration ||
    context.account !== binding.account || context.resources !== binding.resources || context.appMode !== binding.appMode ||
    context.isCurrentSession !== binding.isCurrentSession || context.start !== binding.start || context.close !== binding.close ||
    !binding.isCurrentSession()) attachment.expired = true;
  return !attachment.expired;
}

export function SourcePlanDetailScreen({ context }: { context: SourcePlanDetailSlotContext }) {
  const { plan, account, appMode, resources, sessionGeneration, isCurrentSession, start, close } = context;
  const binding = useMemo<Binding>(() => ({ context, plan, account, appMode, resources, sessionGeneration, isCurrentSession, start, close }),
    [context, plan, account, appMode, resources, sessionGeneration, isCurrentSession, start, close]);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [, redraw] = useState(0);

  useLayoutEffect(() => {
    const next: Attachment = { binding, live: true, expired: false, busy: false, attempted: false, closed: false, outcome: 'idle' };
    setAttachment(next);
    return () => { next.live = false; };
  }, [binding]);

  const refresh = () => { if (attachment?.live) redraw(value => value + 1); };
  const leave = () => {
    if (!attachment || !current(attachment, binding) || attachment.busy) { refresh(); return; }
    attachment.closed = true;
    binding.close();
    refresh();
  };
  const select = () => {
    if (!attachment || !current(attachment, binding) || attachment.busy || attachment.attempted ||
      binding.plan.archived || !binding.start) { refresh(); return; }
    attachment.attempted = true;
    attachment.busy = true;
    try {
      attachment.outcome = binding.start() ? 'selected' : 'unavailable';
    } finally {
      attachment.busy = false;
      refresh();
    }
  };

  if (!attachment || attachment.binding !== binding) return null;
  if (!current(attachment, binding)) {
    return <Screen testID="screen-source-plan-unavailable" nav={null}>
      <Gutter><Title text="Plan unavailable" />
        <Notice kind="info" text="This plan is no longer available in this view." captureId="a-source-plan-session" announce />
      </Gutter>
    </Screen>;
  }

  const reason = plan.archived ? 'This plan is archived and cannot be selected.'
    : !binding.start ? 'Plan selection is unavailable in this view.'
      : attachment.outcome === 'unavailable' ? 'This plan could not be selected. Selection is unavailable in this view.'
        : attachment.outcome === 'selected' ? 'Plan selected. A workout has not been started.' : null;
  const disabled = attachment.busy || attachment.attempted || plan.archived || !binding.start;

  return <Screen testID="screen-source-plan-detail" nav={<Nav trailing={
    <PlainAction label="Close" captureId="a-source-plan-close" chevron={null} placement="trailing" onPress={leave} disabled={attachment.busy} />
  } />}>
    <Gutter><Title text={plan.name} testID="a-source-plan-title" />
      <Subtitle text="Saved source plan. Exercise identifiers are shown where display names are not supplied." />
    </Gutter>
    <RowGroup heading="Plan summary">
      {sourcePlanSummaryRows(plan).map((row, index, rows) => <AccountRow key={row.label} {...row} last={index === rows.length - 1} />)}
    </RowGroup>
    {plan.items.map((item, position) => <View key={item.id} testID={`a-source-plan-item-${position + 1}`}>
      <RowGroup heading={sourcePlanItemHeading(item, position)}>
        {sourcePlanItemRows(item).map((row, index, rows) => <AccountRow key={row.label} {...row} last={index === rows.length - 1} />)}
      </RowGroup>
    </View>)}
    <Gutter style={s.actions}>
      <View testID="a-source-plan-selection-help" accessible={disabled} accessibilityRole={disabled ? 'button' : undefined}
        accessibilityState={{ disabled, busy: attachment.busy }}
        accessibilityLabel="Select this plan" accessibilityHint={reason ?? 'Selects the saved plan in Home.'}>
        <PrimaryAction label="Select this plan" accessibilityLabel="Select this plan" captureId="a-source-plan-select"
          onPress={select} disabled={disabled} loading={attachment.busy} />
      </View>
      {reason ? <Notice kind={attachment.outcome === 'unavailable' ? 'warning' : 'info'} text={reason}
        captureId="a-source-plan-selection-status" announce />
        : <Subtitle text="Selects this saved plan in Home. Starting a workout is a separate action." />}
    </Gutter>
  </Screen>;
}

const s = StyleSheet.create({ actions: { marginTop: t.space.s24, gap: t.space.s12 } });
