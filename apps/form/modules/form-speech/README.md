# Form speech bridge

Form-owned local Expo iOS module; sources are original implementation, not copied vendor code. Source assumptions inspected October 8, 2026: Expo 57.0.26, ExpoModulesCore 57.0.20, React Native 0.86.3, deployment target iOS 16.4 or newer. General implementation-role fallback; no role/runtime adoption claimed.

## Behavior and caller contract

`FormSpeech` exposes `availability(locale)`, `requestPermissions()`, `start(locale, sessionId)`, `stop(sessionId)` and `cancel(sessionId)`. Events `onResult`, `onState`, `onError` have their complete TS shapes in `../../src/native/speech.types.ts`. IDs distinguish late callbacks and cancellation from a subsequent capture.

The exact requested locale must appear in `SFSpeechRecognizer.supportedLocales()` after case/separator normalization, and that recognizer must be available and support on-device recognition. Every request sets `requiresOnDeviceRecognition = true`. There is no network fallback, recording file, backend upload or provider credential. Permission requests are explicit; probes/start never prompt. Microphone authorization is requested only after speech authorization succeeds. iOS 17+ uses AVAudioApplication; iOS 16.4 uses the compatible AVAudioSession APIs.

Capture is limited to 60 seconds and finalization to 8 seconds. These are Form implementation bounds, not Apple service guarantees. Stop ends microphone capture while awaiting Apple's final callback. Cancel, errors, interruption, media-services reset, backgrounding and module destruction stop/reset the engine, remove its tap, cancel recognition, discard buffers, remove observers and attempt audio-session deactivation/restoration. Cleanup failure is reported and prevents reusing an unresolved audio session. Transcription quality, asset availability and device permission behavior require native qualification.

`FormSpeechAdapter` keeps text in memory. Partial/error/cancelled drafts cannot be accepted. `acceptReview({ sessionId, text, reviewed: true })` requires the current completed final draft, allows explicit user correction, returns `ReviewedSpeechText`, and clears its internal transcript. It does not parse/apply any profile field or persist the returned text. The consuming feature must present a microphone review and call its authenticated profile update only after explicit owner review. Caller-owned copies must follow that feature's retention policy. Dispose the adapter when its feature closes.

`getSpeechAvailability(locale)` is nonthrowing and distinguishes Expo Go, unsupported platform, missing module/probe failure, missing Info.plist strings, unavailable/unsupported locale and denied/required/unknown permissions. A development binary is required; Expo Go does not contain this module.

## Parent integration changes

1. Keep this directory under `apps/form/modules`; SDK 57's default `expo.autolinking.nativeModulesDir` is `./modules`. The package metadata, iOS module config, podspec and scoped ignore override are included. No extra JS dependency is needed: adapters import the maintained exports from `expo`.
2. Add `"./modules/form-speech/app.plugin.js"` to the app's `expo.plugins`, or add its two permission descriptions directly to `expo.ios.infoPlist`. The plugin only sets `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`, preserving existing strings unless explicitly overridden. Optional plugin properties: `microphoneUsageDescription` and `speechRecognitionUsageDescription`. Review/localize the purpose strings for the actual feature before distribution.
3. Rebuild the iOS binary through the parent's single reconciled source/output tree. Generated Info.plist must contain both nonempty strings. Native availability reports `configuration_missing` if either is missing. No background-audio mode, recording-storage permission, Siri entitlement or additional entitlement is added by this bridge/plugin. Validate the signing/capability configuration on the actual candidate rather than inferring it from these sources.
4. Wire feature lifecycle, consent, final/error handling and explicit review/apply outside this lane. No App.tsx, feature, app config, lockfile, backend or Mac output was changed here.

## Check commands and evidence limits

After the parent grants a serial CPU turn and records fresh same-host admission, from `apps/form`:

```sh
node --test src/native/__tests__/speech.test.cjs src/native/__tests__/storeKitDelivery.test.cjs
node node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false
node node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js resolve --platform apple
```

The Node speech test transpiles only the production adapter in memory and injects a controlled native boundary. It creates no files, processes, credentials or recordings; it proves JS review/cancellation/error handling only. Typecheck, autolinking resolution, Apple framework compilation, permission prompts, microphone operation, unsupported locale rejection, offline operation and interruption/destruction cleanup have **not** been executed by this lane. Parent owns telemetry, install/prebuild/build, source/scheme/simulator/DerivedData binding, disk admission and actual device evidence. No Mac access or output mutation occurred.

## Research basis

Read the accepted `docs/workstreams/form-accounts-onboarding/native-seams-research.md` and `docs/engineering-specs/form-accounts-onboarding.md` at their current parent-owned worktree bytes. Read Form `AGENTS.md` and `docs/agent-core.md`; the documented local Core checkout was absent, so verified canonical `/path/to/Form` origin and read immutable Core `4db43e53c9855ad54a89032e0d274ee3727fc5ea`. Core source loading is not runtime activation.

App-Development research inspected at `948e6f60fec18f09ef713a135ee0752ed6e31983`: root AGENTS (only AGENTS in that tree), `docs/mobile/voice-to-t3-20260907-a1-f872c9d4/README.md`, Apple delivery README/source ledger S20/S21/S22/S34/S36 and `docs/research/app-delivery/apple-app-store/README.md`/report. These are incomplete research proposals and a non-live demonstrator, not mobile integration proof. Graphify provided discovery from an older snapshot; all selected claims were checked in the pinned source. No external repository was changed.

Primary sources checked October 8, 2026:

- [Expo Modules API](https://docs.expo.dev/modules/module-api/): module definitions, main-queue AsyncFunction, promises, events and destruction/background listeners; declarations also checked in the installed ExpoModulesCore source.
- [Expo local modules](https://docs.expo.dev/modules/get-started/) and [autolinking](https://docs.expo.dev/modules/autolinking/): local modules discovery and native rebuild requirement.
- [Apple on-device request flag](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition) and [recognizer support](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition): use support for the selected recognizer before requiring local recognition.
- [Apple speech permission](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition) and [microphone permission](https://developer.apple.com/documentation/avfaudio/avaudioapplication/requestrecordpermission(completionhandler:)): purpose strings and explicit authorization. Apple's general SFSpeechRecognizer permission prose discusses server recognition; this implementation additionally enforces the supported on-device request path.

Apple pages exposed JS-only shells to the web reader; selected Markdown endpoints were subsequently read directly through bounded HTTPS requests. No example code was copied. Future compiler/API differences are a parent build gate, not an assumed pass.
