# Shared foundation

Motion, feedback, light, icons and illustration shared by every Form screen. Screens import components from
`../shared/ui` where they are re-exported, and hooks from their own module. Everything here honours Reduce
Motion and works without a network.

| Module | Owns |
| --- | --- |
| `motion.ts` | Duration, distance, scale, easing and spring tokens; `springConfig`, `timingConfig`, `fadeTiming`, `staggerDelay`; `haptic` |
| `motionProvider.tsx` | `MotionProvider`, `useReduceMotion`, `useMotionState` |
| `motionPrimitives.tsx` | `PressFeedback`, `usePressFeedback`, `Entrance`, `Stagger`, `AnimatedNumber`, `ProgressBar`, `ProgressRing`, `CompletionMoment` |
| `motionFeedback.tsx` | `Shake`, `useShake`, `Highlight`, `useHighlight` |
| `motionTransitions.tsx` | `TabTransition`, `StackTransition`, `useStackDirection` |
| `motionContinuity.tsx` | `ContinuityProvider`, `ContinuitySource`, `ContinuityTarget`, `useContinuity` |
| `toast.tsx`, `toastModel.ts` | `ToastProvider`, `useToast`; queue, timing and swipe rules |
| `inline.tsx` | `FieldError`, `InlineStatus`, `StatusBadge`, `BusyIndicator`, `useInlineTask` |
| `foundation.tsx` | `FoundationProvider`, `ShellStack` |
| `tokens.ts`, `contrast.ts`, `light.tsx` | `light` tokens and `lightTextPairs`; WCAG helpers; `LightBackdrop`, `LightSurface`, `Sheen`, `elevationStyle` |
| `icons.tsx`, `lucideIcons.ts` | `Icon`, `iconSize`, `semanticIcon`, `hasIcon`, `iconNames`; Lucide path data |
| `illustration.tsx` | `MovementIllustration`, `poseForMovement` |
| `FoundationGallery.tsx` | Gallery page; on web open `?gallery=1&foundation=1` |

## Mounting

`FormAccountApp` renders `FoundationProvider` as the root of every phase (loading, error, signed out,
onboarding, signed in), so one toast host survives sign-in and route changes. Its `scopeKey` is the account
session: when it changes, all toasts are cleared so one session's messages and Undo/Retry actions never reach
the next. The signed-in route stack is wrapped in `ShellStack`, and Training tab content in `TabTransition`.
Screens never mount providers of their own; `useToast()` outside a provider is a silent no-op, and
`useReduceMotion()` outside one reads the system setting itself.

## Toast, inline or full page

| Situation | Use |
| --- | --- |
| A field is invalid or a save for one field, row or card failed | Inline: `errorMessage` on the field, `FieldError`, or `InlineStatus` next to the row with Retry. Keep the user's input. |
| A background action finished or failed away from where the user is looking (saved, synced, offline, retry later) | Toast. |
| A destructive action can be reversed | Toast with an `Undo` action (`persistent` or the longer action duration). |
| The screen cannot render anything useful (first load failed, account unavailable) | Full-page state on the screen (`Notice` with Try again). |

Never show the same failure as both a toast and an inline error. A failure that blocks the user's next step
stays on the screen (inline or full page), not in a toast that can time out.

## Motion

Durations live in `motionDuration` (transitions 150–400 ms; `press` 90 ms, `value` 600 ms for counting
numbers). Springs are `motionSpring` presets: `snappy` (press, toasts), `smooth` (default UI), `gentle`
(calm settles), `lively` (one completion pop), `page`, `sheet`, `morph`; `springConfig('press' | 'standard' |
'bouncy' | preset, reduceMotion)` also accepts the aliases. Stagger is 40 ms per item, capped at five steps.

```tsx
const reduce = useReduceMotion();
offset.value = withSpring(0, springConfig('standard', reduce));
opacity.value = withTiming(1, fadeTiming(reduce));
```

Reduce Motion rules:

- No travel, scale, parallax, stagger, pulse or ambient motion; use a crossfade of `motionDuration.reduced`
  (120 ms). `fadeTiming` already does this.
- Essential progress keeps moving (for example a rest timer draining linearly): pass
  `keepUnderReducedMotion` to `timingConfig`.
- Every animation config passes `reduceMotion` explicitly; read the live value with `useReduceMotion()`.
  Until the system answers, the hook reports `true`.

Haptics: `haptic(intent)` fires on iOS only and never throws. One haptic per user action, from the action
(`PressFeedback haptic="light"`), not from press-in. Toasts fire a haptic only when the caller asks
(`haptic` option) because the triggering action usually already gave feedback.

Components:

```tsx
<PressFeedback kind="row" haptic="selection" accessibilityLabel="Open plan" onPress={open}>{row}</PressFeedback>
<Stagger>{cards.map((card) => <Card key={card.id} {...card} />)}</Stagger>
<Entrance index={2} play={firstVisit}>{block}</Entrance>
<AnimatedNumber value={kilograms} format={(n) => `${n.toFixed(1)} kg`} />
<ProgressBar progress={done / total} accessibilityLabel="Workout progress" />
<ProgressRing progress={remaining / rest} transition={{ durationMs: 1000, easing: 'linear' }} />
<Shake trigger={failedAttempts || null}>{field}</Shake>
<Highlight trigger={savedValue} tone="success">{value}</Highlight>
<CompletionMoment visible={finished} title="Workout complete" detail="Nice, steady work today." />
```

Only shake after a failed attempt, never while the user types. `CompletionMoment` is calm: a glow and a
check, no medals, flames or confetti.

Transitions: `TabTransition activeKey={tab}` fades and lifts incoming tab content; `ShellStack` (or
`StackTransition` with `useStackDirection`) slides a pushed route in and brings a popped one back from the
left. Both animate the incoming content only.

Continuity (Today → Workout): wrap the source card in `ContinuitySource id="today-workout"` and the
destination in `ContinuityTarget id="today-workout"`; call `await capture('today-workout')` from
`useContinuity()` before navigating. A capture is used once and expires after 1.5 s; without one, with
unusable measurements or under Reduce Motion, the target simply fades in. The source is never hidden.

## Toasts

```tsx
const toast = useToast();
toast.show({ tone: 'success', title: 'Workout saved' });
toast.show({ tone: 'warning', title: 'You’re offline', body: 'Changes sync when you reconnect.', icon: semanticIcon.offline, key: 'offline' });
const id = toast.show({ tone: 'error', title: 'Couldn’t save the set', action: { label: 'Retry', onPress: retry }, key: 'set' });
toast.dismiss(id);
```

- Tones `info`, `success`, `warning`, `error`. At most three are visible, newest on top; past that the oldest
  transient toast is dropped and extra persistent ones wait for a free slot.
- `key` updates a visible toast in place instead of stacking a duplicate.
- Toasts without an action auto-dismiss (`info` 4 s, `success` 3.6 s, `warning` 6 s, `error` 7 s); with an
  action they stay at least 10 s; `persistent` keeps them until acted on or dismissed (default for error and
  warning toasts with an action).
- Swipe or the close button dismisses. Errors and warnings are announced assertively; info and success
  politely. Cards keep 44 pt targets and grow with text size.
- Action labels: `Retry` uses `rotate-cw`, `Undo` uses `undo-2`. Keep copy short and specific.

## Inline errors and status

```tsx
<TextAnswer label="Plan name" value={name} onChangeText={setName} errorMessage={nameError} />
<StepperField label="Weight" value={weight} onStep={step} errorMessage={weightError} />
<InlineStatus tone="error" message="Couldn’t load recent sessions." onRetry={reload} />
<BusyIndicator label="Loading plan" />
```

- `errorMessage` adds the error outline and an announced message under the field. The typed value is never
  cleared or replaced.
- `InlineStatus` shows tone icon and message; a promise-returning `onRetry` shows busy on the button, ignores
  repeat presses and shakes the line if it fails again.
- `useInlineTask()` tracks one async action (`idle`, `busy`, `error`, `success`) without touching input.

## Light layers and contrast

`light` adds luminous paper, raised surfaces, warm and aqua glows, an action gradient and layered elevation.
Text colours on these layers come from `lightTextPairs`; the renderer test checks every pair against WCAG AA
(4.5:1), compositing translucent layers first. `actionLight` and the glows are graphics-only colours.

```tsx
<View style={{ flex: 1 }}>
  <LightBackdrop />
  <LightSurface level="e2" glow="warm">{content}</LightSurface>
</View>
```

Use `contrastRatio(text, background)` or `meetsAA(text, background, { large })` when adding a pair, and
add the pair to `lightTextPairs` so the test covers it.

## Icons

```tsx
<Icon name="rotate-cw" />                                   // decorative, standard size, ink
<Icon name={semanticIcon.offline} size="notice" color={t.color.warning} accessibilityLabel="Offline" />
```

- `size` accepts `iconSize` names (`status`, `inline`, `notice`, `nav`, `standard`, `large`, `hero`) or points.
- Icons are hidden from assistive tech unless labelled; a labelled icon is an image.
- `semanticIcon` names the meaning (retry, undo, offline, syncFailed, success, warning, error, busy, edit,
  remove, history and more); use it instead of picking glyphs per screen.
- Path data is copied unchanged from Lucide (ISC; Feather portions MIT); see the header of
  `lucideIcons.ts`. Add icons by copying the exact Lucide nodes.

## Movement illustration

`MovementIllustration` draws an Open Mat figure only when `poseForMovement(movement)` matches a generated
pose (today: squat variants). Otherwise it renders nothing, or the empty mat with `fallback="mat"`; it never
shows a mismatched figure. Pass `breathKey` to play one short breath (under 5 s) of the figure; off under
Reduce Motion. Illustrations are decorative and never carry meaning.

## Testing

- Renderer tests (`npm run test:renderer`) render these modules with the Reanimated Jest mock, where
  animations jump to their end value. Use `MotionProvider reduceMotion` to pin the preference.
- The integration harness replaces `../shared/ui` with a names proxy, so components imported from `ui`
  become host elements there. Hooks are not proxied: a component that the harness executes directly and that
  starts calling a foundation hook needs its harness updated in the same change.
- Training harnesses inject dependencies by name (`start-write.test.cjs`, `source-training-mount.test.cjs`);
  register new identifiers used inside `TrainingHome` there.
