---
name: project_dup_prs_upstream_vs_fork_same_branch_name
description: Two agent lanes (upstream-origin vs fork-origin) with identical branch names produce duplicate PRs GitHub cannot auto-reject; claim-issue lock is advisory. User runs both lanes intentionally — push to the fork so GitHub rejects dups
metadata: 
  node_type: memory
  type: project
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

Confirmed 2026-07-17: an entire dispatch batch (#3310/#3311/#3341/#3308) was
independently re-implemented and merged by a second lane, wasting the opus
lane's work. **The user confirmed they run both lanes intentionally** — so
this is a standing condition to design around, not an incident to clean up.

## Mechanism

- `/workspace` remotes: **`origin` = `loopdive/js2wasm` (upstream)**,
  **`fork` = `ttraenkler/js2`**. Agents inherit these, and `push.default=current`,
  so a plain `git push` goes to **upstream**.
- Lane A (this session) pushed branches to **upstream** → PR head repo =
  `loopdive/js2wasm`. That's why `gh pr create --head ttraenkler:<branch>` fails
  with "No commits between" — the branch was never on the fork.
- Lane B pushed the **same branch NAME** to the **fork** → PR head repo =
  `ttraenkler/js2`.
- Same name, **different head repos** → GitHub cannot apply its normal
  same-head+base rejection. Both PRs coexist; whichever merges first wins.
- `claim-issue.mjs` returned **exit 0** (clean claim) to lane A and lane B
  still landed. Both lanes claim under the **same slug**
  (`ttraenkler/senior-dev`), so the lock cannot even distinguish them. The
  lock is **advisory** — it only binds agents that consult it.

## The mechanical fix (preferred — free and automatic)

Have agents **push the branch to the `fork` remote** (`git push fork <branch>`)
and open the PR with `-R loopdive/js2wasm --head ttraenkler:<branch>`, i.e. the
documented flow. Then both lanes share a head repo and **GitHub itself rejects
the duplicate PR** — no coordination needed. The real hole is the upstream
origin, not a missing check.

## The reactive fix (backstop)

Before dispatching an agent to an issue, AND before asking one to fix a DIRTY
PR: `git log origin/main --grep="#<id>"`. A PR going DIRTY **on files it itself
touched** is a duplicate-merge smell, not an ordinary conflict.

## Adjudicating a suspected dup (the standard that worked)

Have the authoring agent run **its own test suite unmodified against main's
implementation**. Green ⇒ no delta ⇒ close as superseded. If it cannot write a
test that fails on main today, the delta isn't real. "Mine is cleaner" never
resurrects a branch. Docs/reasoning deliverables are the exception — a missing
citation or absent rationale is a real delta without a test.

Worked examples: #3311 closed (own 8/8 suite passed on main; main's version was
strictly *broader*); #3310 closed (own 7/7 passed; the "G2" half was
unreachable, all callers host-gated); #3341 **kept but re-scoped** to only the
deltas main missed. See [[project_sprint64_parallel_session_dup_prs]].
