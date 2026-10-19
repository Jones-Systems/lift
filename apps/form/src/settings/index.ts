// Settings module: the one account page and the only Basic/Advanced selector
// (design: continuation/mobile/design/settings-training v2, contracts.md#settings and #slot-adapter).
//
// Stable public surface for root wiring. Props are exactly the shell's SettingsSlotContext:
//   renderSettings={(ctx) => <SettingsSlot {...ctx} />}
// Optional SettingsSlotContext seams (openEdit, openCuesIndex, openSystemSettings, openBody, openCommunitySettings,
// bodyPrivacy, openBodyChoice) are additive and absent-safe; the shell supplies them.
export { SettingsSlot, SettingsScreen, useSettingsScreenModel } from './SettingsScreen';
export { appModeFrom } from './appMode';
export type {
  AppModeControl, CommandState, NotificationPermission, Remote, ServerError, SessionCommand, SettingsRow,
  SettingsScreenEvents, SettingsScreenProps,
} from './model';
