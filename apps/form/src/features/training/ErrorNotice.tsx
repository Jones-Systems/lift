// Shared training load-error notice: server error copy with an in-place Try again.
import { Notice } from '../shared/ui';
import { TC, trainingErrorCopy } from './copy';
import type { Remote } from './model';

export function ErrorNotice({ remote, onRetry }: { remote: Remote<unknown>; onRetry: () => void }) {
  if (remote.status !== 'error') return null;
  return <Notice kind="error" text={trainingErrorCopy(remote.error, false)} announce action={{ label: TC.tryAgain, onPress: onRetry }} />;
}
