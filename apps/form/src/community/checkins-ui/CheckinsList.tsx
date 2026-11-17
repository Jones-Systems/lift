import { useLayoutEffect, useReducer, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { t } from '../../features/shared/tokens';
import { AccountRow, Gutter, Nav, Notice, PlainAction, PrimaryAction, RowGroup, Screen, Subtitle, Title, Txt } from '../../features/shared/ui';
import type { CheckinsContext, CheckinsPresentation, CheckinsRendererProps } from './contracts';
import { createCheckinsPresentation } from './presentation';

function useCheckins(context: CheckinsContext) {
  const [active, setActive] = useState<{ context: CheckinsContext; model: CheckinsPresentation } | null>(null);
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  useLayoutEffect(() => {
    const model = createCheckinsPresentation(context);
    const subscription = model.subscribe(redraw);
    model.attach(); setActive({ context, model });
    return () => { model.detach(); subscription.remove(); };
  }, [context]);
  return active?.context === context ? { model: active.model, view: active.model.getSnapshot() } : null;
}

export function CheckinsList({ context }: CheckinsRendererProps) {
  const presentation = useCheckins(context);
  if (!presentation) return <Screen><Gutter><Notice kind="info" text="Opening group check-ins…" announce /></Gutter></Screen>;
  const { model, view } = presentation;
  const ended = view.status === 'disposed' || view.status === 'sessionended';
  return <Screen testID="screen-community-checkins" nav={view.canClose ? <Nav back="Group" onBack={model.close} /> : <Nav />}>
    <Gutter>
      <Title text="Group check-ins" />
      <Subtitle text="Read the current page of group posts." />
      <Notice kind={view.notice.kind} text={view.notice.text} announce captureId="community-checkins-notice" />
      {view.commandNotice ? <Notice kind={view.commandNotice.kind} text={view.commandNotice.text} announce captureId="community-checkins-command-notice" /> : null}
    </Gutter>
    <RowGroup>
      {view.rows.map(row => <View key={row.id} testID={`community-checkins-row-${row.id}`}>
        <AccountRow label={row.label} detail={row.alias ?? undefined} />
        <Gutter style={styles.content}>
          {row.notice !== null ? <Txt role="body" tone="secondary">{row.notice}</Txt> : null}
          {row.template !== null ? <Txt role="body">{row.template}</Txt> : null}
          {row.text !== null ? <Txt role="body" testID={`community-checkins-text-${row.id}`}>{row.text}</Txt> : null}
          {row.createdAt !== null ? <Txt role="meta" tone="secondary">{`Recorded creation (UTC): ${row.createdAt}`}</Txt> : null}
          {row.expiresAt !== null ? <Txt role="meta" tone="secondary">{`Recorded expiry (UTC): ${row.expiresAt}`}</Txt> : null}
        </Gutter>
      </View>)}
    </RowGroup>
    {!ended ? <Gutter style={styles.actions}>
      <PrimaryAction label="Refresh check-ins" captureId="community-checkins-refresh" disabled={!view.canRefresh} loading={view.busy}
        onPress={() => void model.refresh()} />
      <PlainAction label="Next page" captureId="community-checkins-next" chevron={null} disabled={!view.canNext}
        onPress={() => void model.next()} />
      {!view.canNext && !view.busy && !view.commandNotice ? <Subtitle text={view.status === 'ready' || view.status === 'empty'
        ? 'No next page is available from this page.' : 'Refresh check-ins to load a page before continuing.'} /> : null}
    </Gutter> : null}
  </Screen>;
}

export function createCheckinsRenderer() { return CheckinsList; }

const styles = StyleSheet.create({
  content: { gap: t.space.s8, paddingBottom: t.space.s16 },
  actions: { gap: t.space.s12, marginTop: t.space.s24 },
});
