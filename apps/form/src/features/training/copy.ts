// Exact strings from settings-training v2 copy.md (#training, #errors). Keys follow that file.
import type { ServerError } from './model';

export const TC = {
  confirm: 'Confirm set',
  confirmedOnly: 'Only confirmed sets count toward your stats.',
  saving: 'Saving…',
  saved: 'Saved',
  unconfirmed: 'Not confirmed',
  setUnknown: (n: number) => `Set ${n} may not have saved. Try again. It won’t be counted twice.`,
  setExists: 'This set was already logged on another device. We’ve loaded it.',
  finishTitle: 'Finish workout?',
  finishBody: (done: number, planned: number) => `You confirmed ${done} of ${planned} planned sets. Sets you didn’t log stay unlogged.`,
  keepGoing: 'Keep going',
  resumeFootnote: 'Your unfinished workout stays in History.',
  statsEmptyTitle: 'No workouts logged yet.',
  statsEmptyBody: 'Confirm a set during a workout and it shows up here.',
  statsEmptyAction: 'Go to workout',
  statsStale: 'Couldn’t refresh. Showing your last loaded stats.',
  statsActiveIncluded: 'Includes confirmed sets from a workout in progress.',
  historyEnd: 'That’s everything.',
  notFinished: 'Not finished',
  plansEmpty: 'No plans yet.',
  tryAgain: 'Try again',
  removeConfirm: (n: number) => `Remove set ${n}? It won’t count toward your totals. You can’t undo this.`,
  removePrimary: 'Remove set',
  removeCancel: 'Keep set',
  removing: 'Removing…',
  removed: 'Removed',
  removeUnknown: (n: number) => `Set ${n} may not have been removed. Try again. It won’t be removed twice.`,
  removeConflict: 'This set changed on another device. Check it and try again.',
  getUnavailable: 'Can’t reach Form. Check your connection and try again.',
  writeUnknown: 'The result couldn’t be confirmed. Try again; it won’t be applied twice.',
} as const;

/** Error copy keyed by server code (copy.md#errors); falls back to the server's own message. */
export function trainingErrorCopy(error: ServerError, write: boolean): string {
  switch (error.code) {
    case 'stale_revision': return 'This changed somewhere else. We’ve loaded the latest. Check it, then try again.';
    case 'session_completed': return 'This workout is already finished.';
    case 'plan_archived': return 'This plan was archived. Choose another plan.';
    case 'set_voided': return 'This set was removed and can’t be edited.';
    case 'network_unavailable': return write && error.effectUnknown ? TC.writeUnknown : TC.getUnavailable;
    default:
      if (error.effectUnknown) return TC.writeUnknown;
      if (error.status === 0 || error.status >= 500) return TC.getUnavailable;
      return error.message;
  }
}
