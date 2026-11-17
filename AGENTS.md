# lift working agreements

This is an intentionally public, code-only Form snapshot for simulator builds.
Start with README.md, BUILD.md and SOURCE-SNAPSHOT.json. Lift temporarily owns day-to-day code development and hosted tests. Keep a
matching PR on private Form for retained integration; private Form owns research
and documents. Follow PAIRED-DEVELOPMENT.md. This is not an automatic mirror.

## Shared guidance and agent roles

Read AGENT-GUIDANCE.md before substantive work. It defines how Lift combines
application-specific rules with the shared guidance and roles delivered to the
current provider at user scope. Follow the delivered shared startup bridge and
read the guidance it selects; a link alone is not a completed read. Keep Lift
policy here and in PAIRED-DEVELOPMENT.md. Shared methods belong to Codex V3;
shared roles belong to Universal Agents. Route changes to those owners rather
than copying their definitions into this public repository.

A repository instruction file does not install shared guidance or prove that a
provider loaded it. Missing required guidance, stale delivery or an unresolved
source conflict holds dependent work; report the exact gap and continue only
independent work within the known scope. Preserve current owner instructions
and existing feature-review, dependency and integration holds.

## Public source and development boundaries

Preserve notices and source provenance. Do not add private research, account or
health data, screenshots from private accounts, credentials, signing material,
private host settings, or the private repository's Git history. Scan every new
export before publishing it. Keep the default API disabled unless an explicit
public-safe configuration is selected.

Use a non-main task branch and isolated worktree, verify identity and status
before edits, preserve other writers and declare one Git owner. Use the portable
build-driver checks for workflow changes and an exact-SHA hosted run for native
qualification. Keep compilation, downloadable artifacts, visual inspection and
authenticated product acceptance as separate claims.

Do not enable paid runners, alter billing, deploy services, use signing accounts,
or delete unrelated artifacts as part of a simulator build.

## CI placement and budget

`Public app, API and portable checks` is required for routine Lift merges.
`Synthetic installed-app journeys` is advisory: native E2E runs nightly,
manually, or for relevant same-repository PRs carrying `native-e2e`. Preserve
its exact-source evidence, assertions and cleanup when changing placement.
The existing `Lift iOS simulator` workflow remains a paired Form qualification
hold under PAIRED-DEVELOPMENT.md; E2E's advisory status does not release it.
Public checks and launch retain PR `edited` events for that refresh route.

Target required-check PR-to-green latency is median 10 minutes and p90
20 minutes, including queue time; target required-job duration is 390 seconds.
These are measurement budgets, not permission to skip checks, relax assertions,
or add retries. Scope native E2E PR execution by paths and label, and cancel
superseded qualifying runs without letting ignored events cancel active work.

The `ci-placement` workflow contract is `scripts/ci-placement.test.py`, run by
`python3 -B scripts/ci-placement.test.py` in the public job. It covers E2E
trigger paths, PR opt-in/trust, cancellation isolation and exact-source wiring.
Keep this small contract alongside the existing public groups; their runner
and PUBLIC-TESTING.md are maintained separately.

The advisory public breadth workflow owns `public-breadth-contract`, checked by
`python3 -B scripts/run-public-breadth.test.py`. Its exhaustive placement manifest,
eligible groups, unavailable-input holds and full execution command are documented
in TEST-PLACEMENT.md. Add new test modules to their placement and affected group
in the same change; public eligibility never implies private or real-provider
qualification.
