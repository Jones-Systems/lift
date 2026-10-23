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
Requests for the same source/ref serialize. A PR synchronize event cancels older
work in that PR's existing concurrency group; edits, reopens and manual dispatch
do not request in-progress cancellation. Do not rerun cancelled superseded heads;
the latest exact head and current base must still finish green.
Every PR from a branch in this repository receives an exact-head simulator
build, including draft PRs. The Lift public checks workflow runs separately.
Manual dispatch remains available for any pushed source revision. The read-only workflow token is
not persisted by checkout. No private secrets or signing accounts are required.

The first post-checkout identity step runs stdlib self-tests and records a
versioned SHA-256 fingerprint of the head's app tree and root attributes, the
checked-out tooling's driver tree, workflow, helper and self-test. A separately
domain-separated record digest binds these inputs to explicit source/tooling/
workflow provenance. Equal content can retain its fingerprint across heads;
the provenance record still changes. Head and tooling are separate revisions.
An absent root `.gitattributes` is recorded as absent, never as an
empty file. Missing objects, ref mismatches or unsupported file types/modes
leave the fingerprint unavailable and select full/unknown.

This is shadow recording only: dependency closure (including dynamic imports,
config and install hooks) remains unproved, so identity eligibility and reuse
are always unknown and execution is always full. No prior-run lookup, artifact
reuse or native skipping occurs. Only after build, smoke checks and artifact
upload succeed does `native executed <fingerprint>` record actual execution for
that run/attempt. A skipped marker or its name alone is not a receipt; the step
and whole job must succeed. Even a successful marker is not reuse authorization
or qualification of another head/base. Live cancellation latency and native
speed improvements have not been measured by these portable checks.

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
