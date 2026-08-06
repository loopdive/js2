---
name: reference_pr_title_citation_is_not_completion_evidence
description: "A merged PR whose title cites #N is NOT evidence #N is done — measured 0/26 true positives. Four distinct attribution bugs; the issue's own acceptance checkboxes reject all of them."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-08-01T07:34:00.436Z
---

# "A merged PR cites #N" ⇒ "#N is done" is FALSE — measured at 0/26

**2026-08-01.** `scripts/reconcile-tasklist.mjs` reported 26 issues as done-but-open.
A full audit qualified **zero**. Half were stale reads; the other half were real rows
with wrong attribution, **100% false-positive**.

Had it been actioned as framed, 26 issues would have been closed wrongly — including
one with **17 merged PRs that is open by design**, and one whose file literally reads
`## Status — partially addressed, deliberately NOT closed`.

## The four attribution bugs — they are distinct, not one bug

1. **Slice PR counted as closing its epic.** A PR fixing one slice cites the epic in
   its title. Most common by far.
2. **Wrong-issue incidental mention.** Two issues were both attributed to the *same*
   PR, whose title cited one while its change dropped a pin that "rode in on" the
   other. One PR, two false positives, subject of neither.
3. **Filed-by counted as fixed-by.** The only PR citing the issue was the one that
   **discovered** it ("finds #N").
4. **Docs/diagnosis PR counted as a fix.** Three PRs *correcting* an issue's
   root-cause claim read as three fixes.

## The cheap discriminator

**Require the issue's own acceptance checkboxes to be checked.** That single signal
would have rejected **all 13** false positives. Even then, verify: the one candidate
with zero unchecked boxes still failed, because its criteria were headed *"Slice 1"*
and one criterion required an external matrix to still name it as **live owner** —
flipping it would have pointed that matrix at a closed issue.

> **Done-ness lives in the issue's acceptance criteria, not in any PR's title.**
> Read the merged bytes against those criteria. `git log --grep="#N"` is worse than
> useless here: PR numbers and issue ids share ONE sequence, so it matches
> `Merge pull request #N`.

## Second half: the tool must read REMOTE state

13 of 26 rows were phantom because the reconciler read frontmatter from a **local
checkout** whose `origin/main` had silently rotted (`5824539` local vs `b0a4047`
remote). Read from remote `main`, or refuse to run and say so — see
[[reference_budget_grant_from_another_issue_fails_in_ci]] on never inferring shared
state from a cached view.

## The meta-rule

A reconciler with a ~100% false-positive rate **trains everyone to ignore it**, which
is worse than not having one. When it cannot tell slice-of-epic from closure it must
report **unknown**, not **done** — the same invariant as every other detector here:
*what does it do when it cannot see?*

Related: [[feedback_verify_fix_in_git_not_narrative]] ·
[[reference_silent_empty_is_indistinguishable_from_real]] ·
[[reference_stale_bail_comment_and_its_test_defend_the_defect]]
