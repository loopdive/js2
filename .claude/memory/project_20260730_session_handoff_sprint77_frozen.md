---
name: project_20260730_session_handoff_sprint77_frozen
description: "HANDOFF 2026-07-30 — sprint 77 frozen (late) in OPEN PR #3848, NOT yet on main; #3658 RESOLVED; worktree-prune incident needs HOST-side repair; 283 orphan worktrees ~47GB pending approval"
metadata:
  node_type: memory
  type: project
---

# Handoff — 2026-07-30 (supersedes the 2026-07-26 open-valve handoff)

## ⚠️ ACTION REQUIRED ON THE HOST

`git worktree prune` was run **from inside the container** and deleted ~25 of the
**host session's live** worktree registrations. Fix, on the host only:

```bash
cd "/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm"
git worktree repair /private/tmp/js2-*
```

Full hazard: [[reference_never_git_worktree_prune_inside_container]]. Short
version: one shared `.git` ⇒ one registry; host worktrees live at
`/private/tmp/js2-*`, invisible from `/workspace`, so they read `prunable`.
**`prunable` here means "not visible from where I'm standing", never "stale".**

## Sprint 77 — FROZEN IN AN OPEN PR (#3848), **not yet on `main`** (late freeze)

⚠️ The freeze lives in **PR #3848**, awaiting the merge queue. Until that merges,
`main` still has all 321 issues as `sprint: current` and no `sprints/77.md`.
Do not read "frozen" as "landed" — that exact blur is what produces the
merged-but-open drift documented below.

`freeze-sprint.mjs --force` at `88e12f2`: **79 issues** re-tagged → `sprint: 77`,
**242 rolled forward**, `plan/issues/sprints/77.md` written, plus
`plan/log/retrospectives/sprint-77.md` (two post-mortems). Range
`sprint-77/begin` (bb5b414, 07-24) .. 07-30 = 1,541 commits / 671 merged PRs.

- Frozen **after** the budget rollover — nobody froze at the boundary (the
  token-budget source is still unwired, #2751). The script re-tags by **current
  frontmatter, not by date**, so the window spans the intended tail *plus* the
  following days. Stated in the doc; don't quietly re-read it as a clean window.
- **`sprint/77` tag NOT pushed** — needs explicit per-push permission.
- The "79 completed" figure is a **floor, not a census**:
  `reconcile-tasklist.mjs` lists issues whose fixing PR merged but whose
  frontmatter still reads `ready`/`in-progress`. Deliberately NOT bulk-flipped —
  the matcher keys on PR titles and `#N` collides between issue ids and PR
  numbers, so a blind sweep mislabels. Needs per-issue verification.

## Numbers — the drop is the WIN, not a regression

| | window begin | freeze |
|---|---|---|
| host | 30,364 / 43,102 | 29,856 / 43,099 |
| `ORACLE_VERSION` | 10 | 12 |

`ORACLE_VERSION` moved 10 → 12 **inside** the window (`69493a7` = declared
re-baseline for the #3603 host de-inflation). The oracle bump **is** the
verdict-logic change ⇒ both sides classify rows differently ⇒ the two counts are
**different quantities**, not a delta. Standalone highwater **22,626**
(official 22,394 / 43,106).

## ✅ #3658 RESOLVED (was the 2026-07-26 "top item")

The landing-page summary sync had frozen at `15:43Z / 30390-43098` while
reporting SUCCESS five times. It commits every few hours again (verified through
07-30 20:44). **The hardening is still open** — fail loudly when new baseline
data yields no commit. Issue is still `status: ready` on main.

## Open

- **283 orphan worktrees**, `/workspace/.claude/worktrees/`, ~**47 GB**, volume
  at **94%** (15 G free). Only 4 metadata entries survive; `git status` inside
  them fails. A calibrated survey ran (284 rows: 41 clean, 241 with
  post-checkout edits). Safe-delete discriminator, verified working:
  `git hash-object <file>` → `git cat-file -e <sha>`; blob already in the object
  DB ⇒ that content was committed ⇒ deleting loses nothing. First sample: all
  edited files already committed.
- **#3659** ratchet the unmeasured 2500 `regressions-allow` ceiling to
  measured+margin (v12 measurements now exist). Gross-fixed and
  honest-regressions **separately, never a net**.
- **#3660** a `trap-growth-allow` is consumed by exactly ONE promote run.
- `freeze-sprint.mjs --dry-run` is advertised in its usage block but gated
  **behind** the trigger check — bare `--dry-run` prints the no-op and previews
  nothing. Use `--force --dry-run`.

## Gotcha that cost time

`/workspace` had rotted **1,279 commits** behind `origin/main` and is now level.
It does not advance on its own — run `bash scripts/sync-workspace-main.sh`.
Reverting its dirty files was safe (every local-only line already existed on
`main` in evolved form) but it belonged to a **live session** — check for a
concurrent lane before touching that tree.
