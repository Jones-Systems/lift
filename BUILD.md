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
Automatic PR builds cover workflow/driver changes from branches in this repository;
ordinary product revisions use manual dispatch. The read-only workflow token is
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
