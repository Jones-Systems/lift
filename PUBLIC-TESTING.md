# Public snapshot checks

`Lift public checks` runs on every same-repository pull request and manual
dispatch, using a standard `ubuntu-latest` runner and Node 24. It checks out the
exact PR head SHA, uses a read-only token without persisted credentials, and
requires no repository secrets or live provider accounts. Fork PRs do not run
this trusted-head workflow. The app's default API stays disabled at
`http://127.0.0.1:9`.

Run the same contract locally from the repository root:

```sh
python3 -B scripts/run-public-checks.py --list
python3 -B scripts/run-public-checks.py --install --output public-check-evidence
```

`--install` runs `npm ci` in both copied projects, serially. Without it, the
runner reuses existing `services/api/node_modules` and `apps/form/node_modules`
through read-only-use dependency links; it does not install or change those
trees. Node 24 is required for the selected TypeScript source tests and hooks.
Use a fresh evidence output path for each invocation; an existing one is
refused. Dependencies must be installed for compilation, app checks and product
tests. The Python runner contract and simulator driver tests are portable.

| Group ID | Selected checks | Public claim |
| --- | --- | --- |
| `runner-contract` | `python3 -B scripts/run-public-checks.test.py` | Group selection, baseline enforcement, subprocess status, evidence and scratch cleanup, SIGINT/SIGTERM cancellation |
| `api-compile` | `node node_modules/typescript/bin/tsc -p tsconfig.json` in `services/api` | TypeScript compilation and fresh emitted API/test modules |
| `app-static` | `npm run typecheck`; `npm run check:tokens` in `apps/form` | App TypeScript and token-style checks |
| `form104-139` | Every `*.test.mjs` recursively in API `tests/wearables/` and `tests/direct-provider-transport/` | Synthetic wearable ingestion/providers/suggestions, persistence/checkpoints, upload/purge, canonical consumer and provider transport/auth coverage present at this SHA |
| `form196` | API board `correction`, `board`, `persistence-races`; APP feature-board `controller` | Board correction and controller state, persistence and race regressions |
| `form203` | APP API `community-group-role-controller`; community matching `controller` | Community role and matching controller regressions |
| `form208` | API voice `standard-wire`, `turn-controller`; usage `standard-observation`, `standard-composition`, `live-composition`; APP Standard `wire-codec` | Wire bounds and app/API interoperability, turn and synthetic usage accounting |
| `simulator-portable` | `python3 -B scripts/ci-ios-simulator.test.py` in `apps/form` | Portable build-driver lifecycle/diagnostic checks, without native compilation |

To run a group, use `--group GROUP_ID` (repeatable). Board and Standard interop
groups automatically include `api-compile` first: workers and app tests load
fresh emitted JavaScript. Tests execute serially; intentional worker races
remain intact. The exact argv and selected source paths are available through
`--list` and each run's receipt. API source tests use the existing wearable
persistence resolver, `--experimental-transform-types`, `--test-isolation=none`
and `--test-concurrency=1`.

The wearable/provider group requires every existing baseline module by name;
missing baseline files fail selection. New modules in those two directories,
including branch-specific direct-connections, bootstrap or provider-controller
tests, join automatically. There is no skip-if-missing fallback. A passing
snapshot with those additions absent only qualifies the tests listed in its
receipt; it does not qualify a later branch's new behavior. Other groups have
explicit module lists in `scripts/run-public-checks.py`; add new test modules to
their owning group when extending that contract.

The helper owns a unique `TemporaryDirectory` under the repository workspace.
It copies `apps`, `services` and `packages`, excluding dependency trees,
`dist`, `.scratch`, `.expo`, Python caches and Git internals. Fresh installs,
compiler output, test scratch and package-cache files stay inside that owned
tree. Success, failure and handled cancellation remove it after stopping its
child process group. Other invocations and existing build/dependency trees
remain untouched. The disposable GitHub runner is the fallback for an
unconditional host/process kill. Local cancellation cannot clean resources
after SIGKILL; reconcile the receipt's exact scratch path before any cleanup.

Evidence remains outside disposable scratch. The one-day Actions artifact
contains `receipt.json` and command logs. The receipt records the checked-out
Git SHA, helper digest, selected group manifest digest, selected input digests,
commands, outcomes, unrun commands and scratch-removal status. Local dirty-tree
results describe the current files, so only a clean exact-SHA hosted run is
publication evidence. A failure stops later commands and reports them as
unrun; it does not turn them into passing checks.

This public snapshot excludes `sources`, `docs`, `vendor` and other private
corpus roots identified in `SOURCE-SNAPSHOT.json`. API `npm run build` also runs
`build-projection.py` and `build-form-coverage.py`, which require that corpus;
the public workflow deliberately invokes the TypeScript compiler separately.
It does not invoke blanket API `npm test`, the full app runner, research
projection/grounding/catalog qualification, website or adapter suites. Those
existing tests remain unchanged, and full private Form qualification still
belongs in the canonical private repository. This contract provides no live
provider, authenticated product, medical, deployment, native build or visual
acceptance claim. Native simulator compilation and launch evidence are
separately provided by `Lift iOS simulator` and described in `BUILD.md`.
