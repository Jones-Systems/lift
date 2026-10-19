# Paired development

Lift temporarily owns public code development and hosted checks. Keep a matching
PR on private Form and retain private research, designs and operational evidence
there. This arrangement does not move Git history, reviews or comments between
repositories.

1. Start a Lift branch from the current integration branch. Scan new source for
   credentials, private data and publication rights before pushing it.
2. Open the Lift PR and the corresponding Form PR. Include `Form-PR: NUMBER`
   in the Lift body and `Lift-PR: NUMBER` in the Form body. Keep these markers
   on their own lines. Carry code changes to Form as a bounded patch, preserving
   its private content and public-specific configuration differences.
3. Run Lift public checks and the iOS simulator workflow for the exact Lift PR
   head. Both workflows run for same-repository PRs, including drafts. Download
   the simulator artifact to inspect the unsigned app and launch evidence.
4. Run Form's lightweight Lift verification after those runs finish. It checks
   the paired PR, exact changed-file bytes/modes and successful runs for that
   Lift head. An early pending result needs a rerun; it is not a passing test.
5. Review and merge each PR under its repository's normal authority. Do not
   infer approval to merge from a green build or this document. Update both
   branches together and repeat verification after either changes.

Form's duplicate test workflows are temporarily paused by their workflow IDs;
the repository Actions setting remains enabled for lightweight verification.
Re-enable the recorded workflows when private runner capacity returns. This
pause has no automatic expiration and does not cancel existing runs.

The public API default remains disabled. Successful compilation, synthetic
tests and simulator launch do not verify authenticated flows or research
projection behavior. See PUBLIC-TESTING.md and BUILD.md for exact coverage.
Changes to files with deliberate public sanitization require explicit parity
handling; a mismatch must fail rather than be assumed equivalent.

For the initial transition, Form #104 adds direct wearable connections and
#139 adds provider activation on top. The product changes from #196, #203 and
#208 already exist in the initial Lift snapshot; their Lift counterparts carry
receipts and provide branch-specific check runs. Design-only and agent-guidance
PRs remain private. Form #241's simulator driver was already adapted into Lift.

## Keeping an active pair synchronized

One contributor owns synchronization for each pair. Both PRs keep their own
history, reviews and draft/acceptance holds. Use the following process after every
change; there is no background mirror or automatic cross-repository push.

| Change | Required follow-up |
| --- | --- |
| New Lift product PR | Open its private Form counterpart using only the scoped product patch; add reciprocal markers before qualification. |
| Edit on Lift | Copy the new scoped product delta to the existing Form branch, preserving its private files; push both and wait for both Lift workflows. |
| Edit on Form | Scan the exact public-safe product delta before copying it to the existing Lift branch. Keep private docs, history and configuration on Form. |
| Lift base advances or PR is retargeted | Refresh both named Lift PR workflows for the current head and base; then run Form verification again. |
| Both Lift workflows finish | Rerun Form verification even if its older result was green. Use a full rerun for a previously successful job; use `--failed` only for a failed run. |
| Pair marker changes | Check reciprocal markers and rerun qualification. |
| Deliberately sanitized product file differs | Stop that pair. Obtain a separately approved exact equivalence approach; never copy private settings to Lift to force a pass. |

Both public workflows also trigger on PR edits, including base retargeting and
body edits. Finalize pairing/body changes before waiting for CI. A base branch
advancing alone does not emit a PR event: edit the Lift PR body to request fresh
runs, or update the branch under its existing Git owner. Wait for the new runs;
an older success is not fresh qualification of a changed base.

Form workflow commands and stale-result rules live in its private operating guide.
Before integrating a feature, the contributor must obtain a fresh Form verification
for its current source head and Lift pair, then satisfy its original review and
acceptance gates. A past green check is an observation, not a permanent sync lock.
When Form integration lands, carry any newly integrated product changes back to
Lift through a scanned, bounded PR and requalify affected open pairs. Do not push
Form Git history or mirror its whole repository into Lift.
