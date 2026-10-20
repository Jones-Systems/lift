# Simulator builds

Use the `Lift iOS simulator` workflow on the `build/lift` default branch.
Manual dispatch accepts an optional full lowercase SHA in this repository.
Without it, the selected workflow ref's commit is built. To request an exact
pushed revision:

```sh
gh workflow run form-ios-simulator.yml --repo Jones-Systems/lift \
  --ref build/lift -f source_sha=FULL_40_CHARACTER_LIFT_SHA
```

Find the run in Actions and download its named artifact, or use:

```sh
gh run list --repo Jones-Systems/lift --workflow form-ios-simulator.yml
gh run download RUN_ID --repo Jones-Systems/lift --dir ./lift-build
```

Extract `Form-simulator-arm64.zip` on an Apple Silicon Mac with the compatible
iOS 27 simulator. After booting that simulator, install and launch the app:

```sh
xcrun simctl install booted /path/to/Form.app
xcrun simctl launch booted com.jonessystems.form.private
```

The job uses the standard arm64 `xcode-27` runner, Xcode 27.0 / 27A266a,
Node 24, CocoaPods and the locked Expo dependencies. The driver rejects toolchain
drift. Native modules, fonts, local bundle identity and Form scheme are retained.
It does not use a private npm registry or fetch private source during the build.

Portable driver cleanup/diagnostic checks:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 apps/form/scripts/ci-ios-simulator.test.py
```

The hosted job has a 60-minute limit and its build step a 55-minute limit.
Requests for the same source/ref serialize without cancelling active work.
Every PR from a branch in this repository receives an exact-head simulator
build, including draft PRs. The Lift public checks workflow runs separately.
Manual dispatch remains available for any pushed source revision. The read-only workflow token is
not persisted by checkout. No private secrets or signing accounts are required.

Each invocation owns a fresh scratch directory and one simulator. Success,
failure and handled cancellation clean those resources; the disposable VM is
the hard-termination fallback. Logs and deliverables live outside scratch.
An upload error fails the job even if compilation passed: inspect `manifest.json`
and do not treat a missing artifact as a downloadable build. Artifact storage
capacity is independent of free public compute. Retention is one day.

Launch acceptance uses the exact PID returned by `simctl launch`, its simulator
and executable path, a non-zombie process state and at least 15 seconds of
process lifetime. The final process check runs after screenshot capture and
simulator diagnostics. Missing or malformed process evidence fails verification;
a timed-out simulator query is recorded as unavailable rather than app death.
Screenshot capture permits two 60-second attempts with a five-second gap and
separate output paths/logs. A successful PNG capture is still required. Inspect
the resulting `launch.png` before claiming that the initial screen rendered.

## Synthetic installed-app journeys

`Lift native E2E` (`lift-ios-e2e.yml`) is a separate same-repository PR and manual
workflow. It builds the exact source SHA once, installs it on one owned iPhone 17
simulator, and runs seven ordered Maestro journeys against the real local API.
The fixture uses deliberately public synthetic credentials, real HTTP auth and
SQLite, and deterministic first-plan preparation with existing catalog IDs.
It installs API dependencies once in the archived scratch tree and runs the
TypeScript fixture directly; it does not build private research projections.

```sh
gh workflow run lift-ios-e2e.yml --repo Jones-Systems/lift \
  --ref BRANCH_WITH_E2E_WORKFLOW -f source_sha=FULL_40_CHARACTER_LIFT_SHA
PYTHONDONTWRITEBYTECODE=1 python3 apps/form/scripts/ios_e2e.test.py
```

Select a branch containing this workflow; after integration that is `build/lift`.
The requested source SHA must also contain the E2E tooling and journeys.

`--mode e2e` embeds `http://127.0.0.1:47621` and produces
`Form-e2e-simulator-arm64.zip`. This artifact requires the synthetic backend to
exercise its authenticated paths. Default `--mode launch` retains disabled
port 9, its process-survival check and `Form-simulator-arm64.zip`.
Only E2E mode adds simulator Keychain entitlements to the generated Form Release
target's link inputs. It embeds XML in `__TEXT,__entitlements` and DER in
`__TEXT,__ents_der`; both contain only `application-identifier` and one
`keychain-access-groups` entry scoped to `com.jonessystems.form.private`.
The driver uses the runner's `/usr/bin/derq` only for DER encoding and
the existing locked `xcode` package for target-specific link settings, preserving
other targets and existing flags. It follows the pinned
[rules_apple linking mechanism](https://github.com/bazelbuild/rules_apple/blob/27c50237cc62dfb8fb08a657ca941f6cb1498274/apple/internal/linking_support.bzl#L501)
and [DER encoding command](https://github.com/bazelbuild/rules_apple/blob/27c50237cc62dfb8fb08a657ca941f6cb1498274/apple/internal/entitlements_support.bzl#L380).

There is no post-build re-signing. The linker-created ad-hoc host signature is
retained, and iOS entitlement slots in that signature are rejected: simulator
entitlements and host code-signature entitlements are separate mechanisms.
Before final executable hashing, packaging or installation, the driver reads
both sections from the arm64 executable and checks the extracted XML's exact
identity. The encoder input XML must parse to the expected entitlement dictionary;
its output must be nonempty and at most 65536 bytes. That invocation's output is
retained in memory across compilation, and the extracted DER section must match
it byte for byte. This proves preservation of the native encoding without a DER
decoder. The driver verifies the executable's original signature with
`codesign --verify --strict --ignore-resources Form.app/Form`. A linker ad-hoc
signature does not seal bundle resources; the resource check is omitted while
executable hashes and strict validation remain required. This follows Apple's
[linker-signature verification guidance](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes)
and the pinned [resource/strict validation separation](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/OSX/libsecurity_codesigning/lib/StaticCode.cpp#L2788).
Before that command, the driver retains `diagnostic-Form-executable.bin` and
`diagnostic-Form-Info.plist`, with SHA256 values in `diagnostic_files_sha256`.
These are diagnostic copies of the exact executable and bundle metadata, not an
installable app or passing acceptance. A verification error still fails the run,
leaves signing unverified and prevents packaging, installation and journeys.
Diagnostic files survive owned scratch cleanup and are included in evidence
hashes on successful and failed verification paths.
Missing, malformed or mismatched evidence fails the build. The manifest records
`signing: linker-ad-hoc-simulator` and `signing_verified: true` only after those
checks, together with the simulator entitlements, `simulator_der_matches_input`
and host signature flags/slots. Input files, extracted sections and verification
logs remain in hashed evidence. No developer account, certificate or provisioning profile is
used. Ordinary launch mode retains `signing: disabled`. Portable checks use
synthetic Mach-O fixtures, the retained native DER fixture and a fake that accepts
only the qualified encoder command; native Keychain and simulator
launch behavior require the hosted journeys. The target-settings check also
uses the repository's existing Node prerequisite.

`apps/form/e2e/journeys.json` owns fixture inputs, expected profile values,
journey names and screenshot basenames. The journeys cover email account
creation/error, onboarding/first plan, workout set editing/removal/history,
session restore/sign-out, server revocation/401, settings unit persistence and
navigation, and session-only manual body measurements. Settings verifies the
existing name survives relaunch; it does not claim an editable name field.
No saved body-measurement, external-provider, purchase, signing or private
research acceptance is claimed.

The workflow uses pinned Maestro 2.11.0 (official ZIP SHA256
`5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a`), verified
before execution, and the runner's arm64 Java 17 installation. The helper
requires Java 17 or newer, disables analytics/update checks and routes the
pinned CLI's unused asynchronous API lookup to disabled loopback. Tools and
state stay under invocation scratch; no global installer or paid API is used.
The job limit is 80 minutes, with 75 minutes for build/journeys and 20 minutes
for Maestro. There are no automatic journey retries. Public compute eligibility
does not provide unlimited artifact storage; evidence retention is one day.

Acceptance requires all seven exact-name JUnit testcases with no failures,
errors or skips; a complete CRC-checked PNG per journey; a finalized MP4 with
video payload and `moov`; and the backend's persisted plan/workout/set/profile
assertions. `manifest.json` records the source, tool pins, synthetic scope and
SHA256 of every other retained evidence file, including `summary.md`. The
Actions summary records the manifest hash. Screenshots and hierarchy/debug
output remain under `maestro-results` and `maestro-debug`; `journeys.mp4`
records the entire suite. These validations prove evidence completeness, not
visual correctness. Inspect the actual PNGs and video frames from the same run
before claiming that the journeys rendered correctly.

The parent waits for the owned recorder's ready message before starting Maestro.
Teardown finalizes it with SIGINT before simulator shutdown/delete, then stops
Maestro and the fixture. Handled cancellation gives recorder/Maestro/backend
4/1.5/1 seconds, ignores repeated signals only while unwinding cleanup, and
preserves the original failure alongside cleanup errors. These are per-child
budgets; simulator operations, file cleanup and hashing take additional time.
They do not guarantee completion within a hosting service termination window.
Video validation and backend-root removal are recorded even after a failed or
cancelled journey. Any cleanup error
fails an otherwise successful run. All scratch/database paths are invocation
owned and outside `/tmp`; retained evidence is outside scratch. Runner loss or
SIGKILL may prevent cleanup/video finalization and cannot produce passing
acceptance. Failure artifacts are diagnostics, not a successful run.
