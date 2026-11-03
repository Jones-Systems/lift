// Coach tab placeholder (settings-training v2 DESIGN #training, flow.md, contracts.md#mode-matrix). Server data only; no sample numbers.
import { Gutter, Nav, Screen, Section, StatusLine, Title, Txt } from '../shared/ui';

/* ---------------- Coach tab ---------------- */

/** The fifth Open Mat tab has no backing feature yet; it says so instead of drawing a fake chat. */
export function CoachUnavailable() {
  return (
    <Screen testID="screen-coach" nav={<Nav leading={<Txt role="bodyStrong">Coach</Txt>} />}>
      <Gutter><Title text="Coach" /></Gutter>
      <Section><StatusLine text="Coach chat isn’t available yet." testID="a-coach-status" /></Section>
    </Screen>
  );
}
