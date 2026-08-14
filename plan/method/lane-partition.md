# Lane partition (two concurrent lanes)

**Directive (2026-07-18):** two agent lanes run concurrently and intentionally.
To stop them duplicating work (2026-07-17: #3310/#3311/#3341/#3308 were each
re-implemented by both lanes — the opus PRs closed as redundant), the
`sprint: current` queue is **partitioned by goal**, and every dispatch runs a
**pre-dispatch gate**.

## Why the old setup collided

- Both lanes pulled the same `sprint: current` queue.
- Both claimed under the same `ttraenkler/senior-dev` slug, so
  `claim-issue.mjs` returned exit 0 to both — the lock is **advisory**, not
  exclusive.
- Both pushed same-named branches to **different head repos** (one lane to
  upstream `loopdive/js2wasm`, one to the `ttraenkler` fork), so GitHub could not
  apply its normal same-head+base duplicate-PR rejection.

## The partition (by goal)

| Lane | Owns (goals / areas) |
| --- | --- |
| **Lane A — lead + opus** (this checkout) | `runtime-eval` (eval ladder #2927/#2928/#3101/#3308/#3343), `error-model`, `self-hosting-dogfood` / `acorn-dogfood`, `core-semantics`, **and all CI / infra / pipeline / tooling** (baseline promote/sync, merge-queue shepherding, test harness) |
| **Lane B — fable / porffor / symphony** | `backend-agnostic-ir`, `ir-full-coverage` (IR north star), **Porffor backend** (#3288 family, `sprint: porffor-backend`), `value-rep-substrate`, **standalone gap** (#2860 umbrella) |
| **Shared / broad** (`test262-conformance`, `spec-completeness`, `builtin-methods`, `property-model`, `class-system`, `npm-library-support`) | **Claim-first-wins** — whoever passes the pre-dispatch gate first owns it; the other lane skips it |

An issue may carry an explicit `lane: A` / `lane: B` frontmatter field to
override the goal-based default. Absent that, the `goal:` field decides.

## Pre-dispatch gate (MANDATORY, every dispatch, both lanes)

Before spawning ANY agent on issue #N — including a `[CI-FIX]` on a DIRTY PR —
verify ALL three, and do NOT dispatch on any hit:

1. **Not already merged:** `git log origin/main --grep="#N"` is empty.
2. **No open PR for it:** no open PR adds/modifies `plan/issues/N-*.md` or
   references `#N` in its title.
3. **Not claimed by the other lane:**
   `git log origin/issue-assignments --format='%s' | grep N` shows no
   other-lane claim.

On a hit: adopt the existing PR, close a stale one, or route to the owning
lane — never start a parallel implementation.

## Branch / PR hygiene (kills the surviving dup mechanism)

- Push every branch to the **`fork`** remote: `git push fork <branch>`, then
  `gh pr create -R loopdive/js2wasm --head ttraenkler:<branch>`. With both lanes on
  the same head repo, GitHub rejects a duplicate same-head+base PR for free.
- A PR that goes **DIRTY on files it itself touched** is a duplicate-merge
  smell — check `origin/main` before "resolving" it.

## Adjudicating a suspected duplicate

Have the authoring agent run **its own test suite unmodified against main's
implementation**. Green ⇒ no delta ⇒ close as superseded. If it cannot write a
test that fails on main today, the delta is not real. "Mine is cleaner" never
resurrects a branch.

See also: `.claude/memory/feedback_mandatory_predispatch_gate_and_lane_partition.md`,
`project_dup_prs_upstream_vs_fork_same_branch_name`.
