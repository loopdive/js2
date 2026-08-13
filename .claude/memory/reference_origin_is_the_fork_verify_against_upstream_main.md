---
name: reference_origin_is_the_fork_verify_against_upstream_main
description: "In the /workspace checkout `origin` is the FORK (ttraenkler/js2), not upstream — so every `origin/main` check silently reads a stale ref and can report a landed fix as missing"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-28T12:08:50.744Z
---

**CLAUDE.md says `origin` is upstream (`loopdive/js2wasm`). In the `/workspace`
checkout that is FALSE.** Measured 2026-07-26:

```
fork      https://github.com/ttraenkler/js2   (fetch/push)
origin    https://github.com/ttraenkler/js2   (fetch/push)   <-- the FORK
upstream  https://github.com/loopdive/js2wasm     (fetch/push)   <-- real main
```

`git fetch origin main` prints `From https://github.com/ttraenkler/js2` — that
line is the tell, and it is the only visible warning.

**What it costs you.** PR #3685 merged to upstream at 20:13Z. Minutes later
`origin/main` was still 3 commits behind, so a by-content verification against
`origin/main` found *no* trace of the fix: the test file was absent and the old
lowering was still present. That reads exactly like the #3681 failure mode
(a PR reporting MERGED while only its docs commit landed), and I was one step
from reporting a correctly-landed fix as missing. The two failure modes are
**indistinguishable from the `origin/main` side** — which is what makes this
dangerous rather than merely annoying.

**Rule: verify landed code against `upstream/main`, explicitly.**

```bash
git fetch upstream main -q
SHA=$(gh pr view <N> -R loopdive/js2wasm --json mergeCommit -q '.mergeCommit.oid')
git merge-base --is-ancestor "$SHA" upstream/main && echo ON-MAIN || echo NOT-ON-MAIN
git ls-tree upstream/main path/to/added/test.ts        # floor: the new file must exist
```

Ancestry of the merge commit is the authoritative check. A name-grep is not —
grepping `externref|widen` inside a file called `object-shape-widening.ts`
returns dozens of pre-existing hits and proves nothing ([[reference_silent_empty_is_indistinguishable_from_real]]).
Grep for the *distinguishing* line of the change, or `git show <ref>:<file>`
and read the branch.

**On `scripts/sync-workspace-main.sh`** — it *does* know about the fork lag
(it fast-forwards the fork's `main` from `upstream/main` when origin is a
strict ancestor), so don't assume it is broken. Two real caveats:

- Its `already current (<sha>)` line is a statement about **`origin/main`**.
  That can be true while `/workspace` is behind real main, if the last run
  predates the newest upstream merge. Read the sha, not the word "current".
- On this container it **timed out at 2 min** (SIGTERM) mid-run over the
  bind mount, leaving the tree clean and no `MERGE_HEAD` — safe, but no
  progress. Give it a longer timeout or accept the lag.

Manual `git merge --ff-only upstream/main` from `/workspace` is **blocked by
`pre-merge.sh`**, which cannot distinguish a fast-forward pull from a
merge-to-main and demands test proof. Do not bypass it; the lag is cosmetic
as long as you verify against `upstream/main` refs directly, which works
regardless of local HEAD.

## Third manifestation: the issue-id reservation ledger is SPLIT-BRAIN

**Verified 2026-07-28.** `scripts/claim-issue.mjs:74` reads

```js
const REMOTE = process.env.CLAIM_ASSIGN_REMOTE || "origin";
```

and its own comment says the `issue-assignments` orphan ref "lives on the FORK
(origin)". But **CI's collision gate and other lanes read the UPSTREAM ledger.**
Measured: fork ref `0f90e2311`, upstream ref `31a3427d2` — **different SHAs, two
disjoint books.**

Consequence: a reservation made in a fork-origin worktree is **invisible** to
everyone else. On 2026-07-28 three PRs collided in a chain — #3715 reserved
3750/3751/3752 on the fork ledger; #3723 took 3750/3751 via upstream and merged;
#3719 took 3752 — forcing #3715 to renumber **twice** (→3753/3754/3755 with
`CLAIM_ASSIGN_REMOTE=upstream`).

**Workaround until fixed:** `CLAIM_ASSIGN_REMOTE=upstream node scripts/claim-issue.mjs --allocate`
(and mirror to the fork ledger so both books agree).

Note the script *already* knows about the fork problem for `main` — line ~86
picks `upstream` when the remote exists, and lines 76-77 warn that `origin/main`
lags "by thousands of commits". The assignments ref simply never got the same
treatment. That inconsistency is the bug.

Related: [[reference_issue_id_collides_while_pr_is_open]] ·
[[reference_fork_origin_behind_upstream]] ·
[[project_fork_origin_behind_upstream_pr_base]] ·
[[project_dup_prs_upstream_vs_fork_same_branch_name]] ·
[[feedback_branch_from_upstream_main_not_fork]]
