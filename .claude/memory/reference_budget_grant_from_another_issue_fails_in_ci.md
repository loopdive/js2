---
name: reference_budget_grant_from_another_issue_fails_in_ci
description: "`granted by <other-issue>.md` from check:loc-budget/check:func-budget is a FAILURE IN WAITING — CI only counts grants from issue files the PR itself touches"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-31T15:02:47.907Z
---

# A budget grant attributed to an issue your PR doesn't touch will NOT exist in CI

`check:loc-budget` / `check:func-budget` resolve `loc-budget-allow` /
`func-budget-allow` **only from issue files in the current change-set** — the files
the PR adds or modifies.

Locally, your merge-base diff is often wider than the PR's, so a grant can resolve
through a **neighbouring issue file** that is not actually part of your change. It
passes locally. In CI that file is not in the change-set, the grant does not exist,
and the ceiling applies.

## The tell — and why it reads as success

The tool **prints the attribution**:

```
granted by plan/issues/<id>-<slug>.md, plan/issues/<id2>-<slug2>.md
```

That line is the warning, not a receipt. Measured 2026-07-31 on PR #3871:
`quality` failed with `assignment.ts::compileElementAssignment: 710 > 685` after
passing locally **every** run, because the grant was resolving through #3017/#3420
— neighbours, not the issue the PR owned.

## Rule

**If the budget check reports `granted by <an issue your PR does not modify>`, treat
it as a failure in waiting.** Grant the allowance on **the issue this PR owns**,
whose file is definitely in the change-set. Do not widen anything else.

## Family

Fourth member of the "signal that looks authoritative and isn't" family, all
measured in one session:

1. `cmd | tail -n; echo "EXIT=$?"` reports **`tail`'s** status — made two failed
   operations look clean, and made a pre-dispatch STOP print `EXIT=0`.
   **⚠️ FIRED 3× IN ONE SESSION (2026-07-31), including on the coordinator who had
   this very note in memory.** `git worktree remove … | head -2 && echo "removed"`
   printed success over two hard failures (`&&` sees `head`'s status); and a
   `claim-issue.mjs --release` crash was reported as `RELEASE_EXIT=0`, nearly
   leaving #2916 falsely claimed by a departed agent — the exact stranding the
   claim ref exists to prevent, caused by the tool meant to prevent it.
   **Knowing this trap does not stop it. Make it mechanical:** never pipe a command
   whose exit status you need. Redirect to a file, or use `${PIPESTATUS[0]}`, or
   run it bare — and **verify the effect** (read the record back), never the code.

   **⚠️ VERIFY THE EFFECT IN *BOTH* DIRECTIONS — the same tool fails both ways.**
   `claim-issue.mjs --allocate` was observed (2026-07-31) producing **no output at
   all and hitting a 600s timeout**, which reads as total failure — while the
   reservation had **already gone through**. Two ids were burned that way (one left
   as a permanent hole). The agent had meanwhile hand-picked "the next free id" and
   was about to ship a workflow file **citing another agent's reservation**, made
   4 minutes earlier — exactly the collision `--allocate` exists to prevent.

   > **"No output + timeout" is not evidence of failure**, just as a clean exit is
   > not evidence of success. Both readings must be settled by inspecting the
   > **per-id metadata on the ref**, never by the highest number visible on `main`.

   Same tool, five failures the other direction (crash/lock reported as success).
   The invariant is not "distrust exit 0" — it is **never infer state from the
   tool's behaviour; read the state.**

   **And read it at the MOMENT OF ACTION, not from a fetched copy.** Shared state
   goes stale in seconds: a branch tip moved between one agent's fetch and its push
   (rejected non-fast-forward while `merge-base --is-ancestor` still passed), a
   claim ref showed a holder who had stood down, and another issue had three merged
   PRs with no claim at all. **Every dispatch error of that session came from
   trusting a cached view of shared state.** Use `git ls-remote` before a contended
   push, `git show` on a freshly-fetched claim ref, `rev-list --count` for
   merged-ness — and re-read immediately before acting, not at the start of the task.

   **The claim ref does NOT prevent branch collisions.** Twice in that session a
   second lane pushed onto a branch this fleet held a live claim on
   (`issue-3877-*`, `issue-3559-cross-fctx-capture`) — detected only as a
   non-fast-forward rejection at push time. **Assume a parallel session may be on
   your branch**: `git ls-remote` the branch immediately before pushing, and if the
   tip moved, put your work on a fresh branch rather than forcing it.

   **Your own verification goes stale against your own later commits.** An agent ran
   the issue-integrity gate, passed, then added a commit whose prose contained a
   **glob-shaped path** (`plan/issues/<id>-*.md`, for #2916) — which that gate
   resolves as a link to a nonexistent file. "I ran the gate" was **true and stale
   at the same time**. **Re-run gates after every edit, not once per branch.**

   The gate's link regex is `plan\/issues\/(\d+[a-z]?-[^)\s"'#]+\.md)`, so **any
   prose that spells a literal `plan/issues/<digits>-….md` is a link to it**, even
   inside a code fence and even when the elision is obviously a placeholder. Write
   placeholders with a non-numeric stand-in (`plan/issues/<id>-<slug>.md`) and keep
   the real issue number in the surrounding prose.
2. `git checkout origin/main -- <paths>` **stages** the reverted version — the next
   `git add` silently reverts your own committed work.
3. `git fetch origin main` leaves `origin/main` **stale** (hit 3× in one session).
   Use `git fetch origin '+refs/heads/main:refs/remotes/origin/main'` and verify
   against `gh api repos/loopdive/js2wasm/commits/main --jq .sha`.
4. **This one** — a budget grant borrowed from a neighbouring issue.

Also related: `actions/runs?head_sha=` silently returns 0 for a **short** sha
([[reference_dropped_synchronize_only_cla_check_repush]]), and `prunable` means
"not visible from this mount"
([[reference_never_git_worktree_prune_inside_container]]).

## Companion habit

`quality` **fail-fasts** under `bash -e`, so the one visible failure is never the
whole set — later gates never execute. After fixing a `quality` failure, run the
gates it skipped (`harness-compile-budget`, `stack-balance`, `codegen-fallbacks`,
`any-box-sites`, `coercion-sites`, `ir-fallbacks`, `dead-exports`) **before**
re-pushing, or you burn a second CI cycle discovering the next one.
See [[reference_quality_failfast_masks_downstream_gates]].
