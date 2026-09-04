---
id: 5306
title: "check:harness-compile-budget sits 29 traversals under its ceiling on main (150,774 / 150,803) — the next harness-path PR trips a gate that measures drift since 2026-08-20, not its own change"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-04
completed: 2026-09-04
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: infra
area: ci
goal: ir-full-coverage
related: [3437, 3433, 3374, 5297, 5313]
requested_by: ttraenkler/orchestrator
assignee: "ttraenkler/opus-5306"
---

# The pre-merge compile-work budget has silently used up its margin

`pnpm run check:harness-compile-budget` (#3437) compiles a fixed
harness-shaped assembly and counts shared `forEachChild` traversals
(`src/ts-api.ts`). It fails when the count exceeds the committed budget plus
15 %. The committed budget is `131,133` (`scripts/harness-compile-budget.json`,
last rebanked 2026-08-20), so the ceiling is `150,803`.

Measured 2026-09-03 on PR #5541's branch (#5297) with the `quality` job's
own command, twice — with and without that PR's new test file, identical:

| | traversals |
| --- | --: |
| budget (committed 2026-08-20) | 131,133 |
| ceiling (+15 %) | 150,803 |
| measured on `origin/main` `986bbf7705` | **150,774** |
| margin left | **29** (0.02 %) |

The number does not depend on #5297 (same count with its test file deleted),
so it is main's. Fourteen days of ordinary IR-migration landings consumed
19,641 traversals of headroom (+15 %) without any single PR being flagged.

## Why this is a defect and not "the gate working"

The gate exists to catch **one PR** introducing an O(call-sites × file-size)
scan (#3433's class, fixed by #3374). A budget that is 99.98 % consumed no
longer does that: the next PR that touches the harness compile path fails
`quality` for the cumulative drift of every PR before it, and its author has
no local reproduction that isolates their own contribution. That is the
"red gate costs a full cycle plus a branch re-sync" outcome the pre-commit
gates are supposed to prevent (CLAUDE.md, "Hooks and ratchet gates").

Whether the 15 % growth is itself a regression (a new per-file scan hiding
in the last two weeks of IR landings) or the expected cost of the IR path
compiling more of the harness is **not established** — that is the first
thing to measure.

## Acceptance criteria

1. **Bisect the growth**, not just rebank it. Run the gate's `--json` output
   at the 2026-08-20 rebank commit, at `986bbf7705`, and at the
   merge commits in between (a coarse bisection over the ~60 merges is
   enough). Report the top three commits by traversal delta with their PR
   numbers. If one commit contributes more than a third of the growth,
   file it as its own issue with the scan named.
2. **Rebank** with `pnpm run check:harness-compile-budget -- --update` only
   after (1), in a PR whose body carries the bisection table, so the new
   budget is a measured number, not a ceiling reset.
3. **Add a soft-warning band**: when `measured > budget × (1 + marginPct/2)`
   the gate prints a `::warning::` naming the remaining margin, so the
   drift is visible in every PR's `quality` log long before it fails. No
   new required check.
4. Record in `scripts/harness-compile-budget.json`'s `note` the date and
   the measured number the budget was rebanked from (the current note says
   "post-#3433 main" with no figure).

## Non-goals

- Raising `marginPct`. A wider band hides the same drift longer.
- Rebanking from a PR branch. The budget is main's number; `--update` runs
  on `origin/main` and the result is reviewed.

## Landed

### Method

`npx tsx scripts/check-harness-compile-budget.ts --json` at each of 100
detached checkouts on the first-parent chain, ~7 s per measurement. The gate
script and the `src/ts-api.ts` meter are **unchanged since they were
introduced** (`bd20d07c11`), so every commit in the window was measured with
the same fixture and the same counter — the numbers below are comparable
without normalisation.

The range is `d633020ab9..origin/main` (2026-08-20 rebank → 2026-09-04,
`5240be0a10`). Of 956 first-parent commits only the **382 that touch `src/`**
can move the count, so those were the search space: a 21-point sweep at every
20th, then every commit inside each interval that showed a jump. Result: three
single commits carry 99.7 % of the growth, and all three are pinned exactly
(their immediate first-parent predecessor measures the pre-jump number).

Attribution to a named scan was done by patching the meter to record the
caller frame of every shared-`forEachChild` invocation and diffing the
per-file profile across each jump commit and its first parent. One full pass
over the fixture costs **3,919 traversals**, which is why the deltas are near
multiples of it.

### Bisection

Total: **131,133 → 150,774 = +19,641** (+15.0 %) over 15 days.

| # | commit | date | PR | before → after | delta | share |
| - | ------ | ---- | -- | -------------- | ----: | ----: |
| 1 | `523bd0428b` | 2026-08-29 | #5204 `feat(selfhost): compile TypeScript 5 parser graph to Wasm` | 139,016 → 146,863 | **+7,847** | 40.0 % |
| 2 | `52b61990fe` | 2026-08-26 | #4922 `fix(es5): combine standalone conformance gains` | 131,169 → 139,007 | **+7,838** | 39.9 % |
| 3 | `e285c0f29d` | 2026-08-31 | #5336 `feat(deno): complete linked runtime bootstrap` | 146,872 → 150,767 | **+3,895** | 19.8 % |
| — | six others | — | — | — | +61 | 0.3 % |

Named scans, from the per-file caller profile:

- **#5204** — two new whole-program passes, both properly memoized:
  `prepareIdentityPreservingStructuralParams` in `src/codegen/declarations.ts`
  (+3,928, cached in `assertedStructuralParamsByContext`) and the new
  `src/codegen/analysis/mixed-assignment-carrier.ts` (+3,919, cached per scope
  in `byScope`). Linear, one pass, deliberate.
- **#4922** — two **unconditional** whole-file walks in
  `src/codegen/declarations/object-shape-widening.ts`
  (15,661 → 23,499): `markRealmGlobalWithTargets` inside
  `collectGrowableObjectLiterals`, and `visit` inside the new
  `collectRedeclaredWithTargetObjects`. Both exist only to find `with`
  statements and both run on sources that contain no `with`.
- **#5336** — `sourceNodeWeight` in the new
  `src/codegen/module-init-chunks.ts` (+3,895), a `WeakMap`-cached AST node
  count for module-init chunk planning.

Two commits (not one) cleared the "more than a third" bar in acceptance
criterion 1. Only one of them is a defect, so only one follow-up was filed:
**#5313** for #4922's unconditional `with` scans, which are ~7,838 traversals
bought for a construct almost no source uses and which the existing
`source-scan-predicates.ts` short-circuit pattern can gate away. #5204's and
#5336's passes were assessed and deliberately accepted — memoized single
passes that buy something on every source — and that assessment is recorded
here rather than as a second issue nobody would action.

None of the three is the #3433 quadratic class: every one is O(file), not
O(call-sites × file). The gate did its job; the drift is additive cost, not a
re-explosion.

### Changes

- **Rebanked** `scripts/harness-compile-budget.json` 131,133 → **150,774**,
  measured on `origin/main` with the tree carrying no `src/` change. Ceiling
  150,803 → **173,391**; margin 29 (0.02 %) → 22,617 (13.04 %).
- **Soft-warning band** in `scripts/check-harness-compile-budget.ts`.
  `evaluateBudget` gained `softCeiling` (= budget × (1 + marginPct/2 %)),
  `nearCeiling`, `marginLeft` and `marginLeftPct`. Crossing the half-margin
  line prints a `::warning::` on stderr naming the remaining margin in both
  traversals and percent; the exit code is untouched and no new required check
  was added. The warning is emitted **after** the hard checks so a real failure
  is never softened into a warning, and on stderr so `--json` stdout stays
  parseable. Every run — pass or warn — now also prints `margin-left=` on the
  human-readable line, so the drift is visible in `quality` logs even before
  the band trips.
- **Provenance** — `--update` now writes a note carrying the rebank date, the
  measured figure, the fixture call-site count and the margin, replacing the
  figure-free "post-#3433 main".
- Eight new cases in `tests/issue-3437-harness-compile-budget.test.ts` cover
  the band's boundaries (no warn at the soft ceiling, warn one past it, warn at
  the hard ceiling, **no** warn once over budget), the reported margin, and the
  note's provenance. 18 tests pass.

Against the pre-rebank budget the band reproduced this issue's own figures
exactly — `margin-left=29 (0.02%)`, exit 0.
