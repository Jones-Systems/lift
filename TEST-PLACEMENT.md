# Public test placement

The advisory **Public eligible breadth** job runs nightly at 3:41 AM EDT /
2:41 AM EST (07:41 UTC), and on manual dispatch. It adds execution for public
tests outside the existing hosted selection. It is not a required PR check and
does not establish complete coverage or private Form qualification.

`scripts/public-test-placement.json` assigns every conventional test file to
exactly one placement. Discovery includes `.test.cjs`, `.test.mjs`, `.test.ts`,
`.test.tsx`, `.test.py` and `test_*.py` under apps, services, packages and scripts.
Dependency, generated and invocation scratch directories are excluded.
Unknown additions, missing entries, overlaps and drift from the existing public
runner selection fail before installs. Reconcile new tests with this manifest
and their owning execution group in the same change; a passing old group cannot
prove that a new test was selected.

| Placement/group | Files | Execution and reason |
| --- | ---: | --- |
| Existing hosted | 76 | Current public runner selection, native identity and CI placement contracts; retain their existing triggers. |
| `api-breadth` | 89 | Compile API TypeScript with `tsc`; run emitted TS tests and original MJS/CJS tests using the existing source hook. Never run the private projection build. |
| `app-breadth` | 80 | Compile the transport compatibility output, then run explicit CJS files serially. Phone sign-in embeds the standalone transport suite exactly once. |
| `app-renderer` | 1 | Existing Jest renderer command selects `runtime-auth.test.tsx`; onboarding remains in the existing hosted group. |
| `website` | 29 | Explicit recursive Node test paths include nested voice modules. Require the real portable session-controller source before execution. |
| `adapter-unit` | 4 | Same four files and serial Node options as adapter `npm test`, with explicit TAP reporting. |
| `breadth-contract` | 1 | This runner's selection, result and lifecycle contract runs inside the breadth job. |
| Blocked | 32 | Exact files, reasons, missing inputs and intended private/manual qualification routes remain in the manifest. |

Current discovery has 312 files. The public runner's `lifecycle-runtime` group
selects exactly 36 API modules, including purchases, reconciliation, status
reader, codec and both Source27 suites exactly once. The three existing purchase
suites move from `api-breadth` to existing hosted placement; the two new suites
join hosted placement. API discovery has 105 ordinary modules and 175 total
files. The Source27 fixture helper is required/digested/compiled source only,
excluded from discovery, invocation and module counts. The codec's 18 synthetic
cases establish bounded syntax, content identities and conservative ordering.
Projection57 and source52 exercise a fresh repaired unmounted source-only
`subscription-status-v1` cohort with explicit selected27 migration, native
currentness, real ledger consumption, conservative replay/conflicts, atomic
History/notification/delivery invalidation and original-producer fencing.
Old experimental identities may remain held/conflicting; no backfill, rewrite
or transparent migration is qualified. Default16/v1/default-off remain unchanged.
These synthetic checks do not qualify live Apple proof/transport, activation,
authenticated/native outcomes, operational restore, retention or adoption;
full backend/PLAN17 remains partial.
The two Source26 suites join core API discovery
and existing hosted placement exactly once. Their shared fixture helper is a
required compiled source input, excluded from test discovery, invocation and
module counts. Source26 placement covers dedicated email/phone action proof,
intent-free upgrades and quiescent synthetic restores; it does not qualify
runtime/default activation or arbitrary/crash restore. Provider execution uses injected synthetic material and
Apple transport only. This is source-only synthetic placement, without live
generation, provider, backup or retention qualification. The default
`lifecycle-wire-v2` group adds the API wire suite and app interop suite to hosted
execution, and moves the existing v1 app lifecycle suite from `app-breadth` to
hosted execution exactly once. Its API compilation precedes actual
backend-encoder/client-parser interop. These unmounted syntax and compatibility
tests do not qualify future producers, evidence authority, transport or consumer
exposure. There are 203 additional public product test files, plus the breadth
contract.
The default `plan-revision` group moves the existing backend suite from
`api-breadth` to hosted placement exactly once and adds the planning revision
suite to hosted placement and ordinary API discovery exactly once. Both run
serially from fresh emissions after full strict API compilation. Coverage is
limited to the unmounted legacy PLAN16 transactional revision/receipt/undo core
and test-only disposal role/identity assertions; it does not establish arbitrary
async-hook safety, runtime activation or authenticated product acceptance.
These are source selection counts, not executed case counts or proof of passing
tests. The 32 blocked files remain intact: 29 need private research/projection
inputs, one needs the internal website route inventory, one needs
`docs/live-coaching/usage/offline-cost.mjs`, and one needs the
adapter's admitted exact-source donor and Linux x64 dependency qualification.
Do not recreate private inputs in Lift, provide an unqualified donor, or
reenable private Form workflows through this runner.

The first breadth execution diagnosed one website failure before assertions:
`member-ecosystem-connections.test.mjs` read an internal inventory under the
explicitly excluded `docs` root. Its exact case name, body and assertions now
live in `member-ecosystem-inventory.test.mjs`, beside the original. The other
eight public connection cases still run. No guard, skip, replacement fixture
or assertion relaxation was added; direct inventory execution still fails
without its real prerequisite. The matching Form patch preserves conventional
website discovery. Its manual qualification route is recorded in the manifest;
that route is not evidence of execution. The original failed receipt is retained
by this workstream.

The API purchase suite also retains its existing **real Apple-signed Sandbox
positive-proof gate** skip because licensed, provisioned signed JWS evidence
is absent. Only that exact name and reason are recognized as documented
unavailable coverage. Any other skip, todo, missing result summary, zero passing
cases or test failure fails public eligibility. New failures require diagnosis;
they do not automatically become missing prerequisites. There are no retries
and no changed product assertions. Real Apple positive proof remains a separately
authorized manual qualification, not an execution claim of this workflow.

```sh
python3 -B scripts/run-public-breadth.test.py
python3 -B scripts/run-public-breadth.py --list
python3 -B scripts/run-public-breadth.py --install --output public-breadth-evidence
python3 -B scripts/run-public-breadth.py --list --require-all-coverage
```

The last command intentionally fails while coverage is unavailable. Receipts
always expose `all_coverage_available: false`; a successful run is labelled
`passed-public-eligible`. The runner records source SHA, selection and manifest
hashes, discovered and selected files, completed successful file invocations,
not-run files, logs, case pass/fail/skip/todo counts and cleanup outcome. A failed
group's per-file execution remains unconfirmed; selected files are not silently
reported as executed. Existing hosted files are accounted for, not rerun or
qualified by the breadth receipt.

Each invocation owns one unique `.lift-breadth-*` directory beneath the checkout.
Locked API, app and adapter dependencies, npm cache, copied source, generated
JavaScript and nested temporary state live there. Evidence is a separate new
direct child of the checkout. Normal success, failure, SIGINT and SIGTERM clean
the exact scratch root after terminating the owned command process group. The
ephemeral hosted VM is the hard-termination fallback. Local evidence belongs to
the caller; hosted evidence has one-day artifact retention.

Storage admission requires 6 GiB additional peak plus 2 GiB free reserve on the
checkout filesystem before copying and before each producer. This conservative
budget covers the approximately 1.5 GiB installed dependencies, source copies,
npm cache, emitted files and nested fixtures; it is not a filesystem quota.
Insufficient space fails without deleting existing data. Reused local dependencies
are allowed only without `--install`; hosted execution always installs locked
dependencies into the owned tree. No repository/index is manufactured in scratch.

Affected-check group `public-breadth-contract` owns the runner, its test,
placement manifest, this workflow and this guide. Its inner loop is
`python3 -B scripts/run-public-breadth.test.py`; the coherent execution check is
the full breadth command above on Node 24. Workflow/source changes additionally
retain the existing `ci-placement`, native identity and public runner contracts
under their existing owners. Source completion, local passing evidence and an
exact-SHA hosted qualification are separate results.
