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
trees. Node 24 is required for the selected TypeScript source tests, hooks and
the runner contract's actual API/app source-import regression.
Use a fresh evidence output path for each invocation; an existing one is
refused. Dependencies must be installed for compilation, app checks and product
tests. The simulator driver checks need only Python; the portable runner
contract also needs Node 24, without installed npm dependencies.

| Group ID | Selected checks | Public claim |
| --- | --- | --- |
| `runner-contract` | `python3 -B scripts/run-public-checks.test.py` | Group selection, baseline enforcement, actual API/app source-import resolution, subprocess status, evidence and scratch cleanup, SIGINT/SIGTERM cancellation |
| `lifecycle-runtime` | API lifecycle, runtime modules, canonical account composition, request-factory, provider-revocation, action-reauthentication purchase/reconciliation/status, codec and Source27 tests (36 modules) | Synthetic generation-bound scoped evidence, purge authority, rollback/residuals, relocated restore admission, closed runtime boundaries and bounded canonical codec/ordering; source-only dedicated email/phone action proof, intent-free Source26 upgrades and quiescent synthetic restores; fresh unmounted Source27 cohort with verified synthetic status-to-ledger consumption, conservative projection, atomic History/notification/delivery invalidation and original-producer fencing; injected synthetic Apple material only; no live provider, real purge or restore qualification |
| `lifecycle-wire-v2` | New API wire-v2 suite; APP contracts-v2 interop and existing v1 lifecycle suites | Unmounted v2 syntax, bounds, subject/evidence consistency, actual backend encoder to independent client parser and v1 compatibility; no producer, transport or evidence-authority qualification |
| `api-compile` | `node node_modules/typescript/bin/tsc -p tsconfig.json` in `services/api` | TypeScript compilation and fresh emitted API/test modules |
| `app-static` | `npm run typecheck`; `npm run check:tokens` in `apps/form` | App TypeScript and token-style checks |
| `form104-139` | Every `*.test.mjs` recursively in API `tests/wearables/` and `tests/direct-provider-transport/` | Synthetic wearable ingestion/providers/suggestions, persistence/checkpoints, upload/purge, canonical consumer and provider transport/auth coverage present at this SHA |
| `form196` | API board `correction`, `board`, `persistence-races`; APP feature-board `controller` | Board correction and controller state, persistence and race regressions |
| `form203` | APP API `community-group-role-controller`; community matching `controller` | Community role and matching controller regressions |
| `form208` | API voice `standard-wire`, `turn-controller`; usage `standard-observation`, `standard-composition`, `live-composition`; APP Standard `wire-codec` | Wire bounds and app/API interoperability, turn and synthetic usage accounting |
| `simulator-portable` | `python3 -B scripts/ci-ios-simulator.test.py`; `python3 -B scripts/ios_e2e.test.py` in `apps/form` | Portable build-driver and E2E helper lifecycle, evidence and diagnostic checks, without native compilation |
| `native-e2e-backend` | API `tests/e2e/native-backend.test.ts` after compilation | Real local no-Origin authentication, allowlist, onboarding, deterministic legacy first plan, persisted workout/profile state, session revocation and owned-backend cleanup |
| `native-e2e-app` | APP integration `account-switch-session`, `settings-mode-http`, `manual-progress-session`, `runtime-lifecycle-composition`; renderer `tests/renderer/onboarding-save.test.tsx` | App authentication, settings/manual-session lifecycle and injury save/navigation concurrency regressions affected by native journeys |

To run a group, use `--group GROUP_ID` (repeatable). Board, Standard interop and
both native E2E groups, `lifecycle-runtime` and `lifecycle-wire-v2` automatically include `api-compile` first: workers and app tests load
fresh emitted JavaScript. Tests execute serially; intentional worker races
remain intact. The exact argv and selected source paths are available through
`--list` and each run's receipt. API source tests use the existing integration
source hook, `--experimental-transform-types`, `--test-isolation=none` and
`--test-concurrency=1`. That hook resolves missing relative `.js` imports to
their canonical `.ts` files inside either the API or app source root, preserving
native resolution when JavaScript exists. Its source resolver refuses symlinks
and out-of-root fallback. Both loader files are included in receipt input digests.

The wearable/provider group requires every existing baseline module by name;
missing baseline files fail selection. New modules in those two directories,
including branch-specific direct-connections, bootstrap or provider-controller
tests, join automatically. There is no skip-if-missing fallback. A passing
snapshot with those additions absent only qualifies the tests listed in its
receipt; it does not qualify a later branch's new behavior. Other groups have
explicit module lists in `scripts/run-public-checks.py`; add new test modules to
their owning group when extending that contract.

The two Source26 action-reauthentication suites run from fresh API emissions in
`lifecycle-runtime` and belong to core API discovery and existing hosted placement
exactly once. Their shared `lifecycle-reauthentication-fixture.ts` is a required,
digested source input compiled by the API TypeScript configuration, never a
standalone test invocation or counted test module. Registration does not qualify
runtime/default activation, real delivery, arbitrary/crash restore or provider
acceptance.

The purchase, reconciliation and status reader suites, pure subscription status
codec and two Source27 suites run exactly once from fresh compiled JavaScript
in `lifecycle-runtime`. The codec's 18 synthetic cases cover bounded canonical
parsing, identities and conservative ordering; the projection and source suites
cover 57 and 52 synthetic cases respectively. `status-source-fixture.ts` is a
required, digested and compiled input, excluded from discovery, test invocation
and module counts. API discovery registers 104 ordinary modules and discovers
174 total files, including both new suites exactly once in purchases.

Source27 qualification is limited to a fresh, repaired, unmounted source-only
`subscription-status-v1` cohort selected explicitly by
`selected-subscription-status-27`. Synthetic file-backed tests exercise numbered
migration27, native continuity/currentness, real ledger consumption, signed-grace
proof correlation, original freshness on replay, conservative conflicts and
atomic invalidation. Older experimental identities may remain held or conflict;
there is no backfill, history rewrite or transparent old-data migration. Default
migration16, v1 and default-off API behavior remain. The purchase suite retains
its genuine Apple-signed Sandbox positive-proof gate skip because the required
signed evidence is unavailable. Synthetic verifier maps do not qualify live
Apple proof, transport, provider activation, native or authenticated product
acceptance, operational restore, retention or adoption. Full backend/PLAN17
completion remains partial.

`lifecycle-wire-v2` is included by default with the other group IDs. Its app
suite requires the freshly compiled real backend encoder and independently
transpiles the client parser with the app's installed TypeScript helper. Missing
inputs or backend emission fail; there is no substitute codec or missing-build
skip. Synthetic scoped-completion fixtures prove wire representation only.
Existing v1 routes, settings and consumers remain unchanged; production mapping,
current evidence, provider methods and consumer exposure require separate qualification.

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
provider, medical, deployment, native build or visual acceptance claim. The
native backend group proves synthetic local HTTP behavior, not installed-app
interaction. Native simulator compilation and launch evidence are separately
provided by `Lift iOS simulator`; installed-app synthetic journeys are provided
by the additional E2E workflow described in `BUILD.md`.

The E2E backend is test-only and starts the real API server with its real SQLite
migrations, catalog and allowlisted `synthetic.invalid` email. Its sole product
substitution is deterministic first-plan preparation: `Native E2E plan`, one
`goblet-squat` catalog item, two numeric set targets. It does not qualify exercise
prescriptions or private source material. It requires a fresh database root,
binds API and control listeners only on `127.0.0.1`, and publishes an atomic ready
file outside that root only after both listeners bind. Tests select random
ports; native builds use the journey contract's fixed ports and fail on collision.

The separate control listener requires the random `E2E_CONTROL_TOKEN` from the
child environment on every request. It can revoke only the allowlisted user's
sessions or assert final persisted state. Acceptance requires completed
onboarding, the saved legacy plan, one completed workout with one genuinely
edited confirmed set and one voided set, and the expected profile name/load
unit. Responses expose only aggregate counts; neither token nor password is
logged. Handled SIGINT/SIGTERM closes both listeners and storage before removing
the exact owned database root; the ready file remains available as evidence.
Startup failures also clean owned state without adopting preexisting roots.
