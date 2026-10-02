# ES2015 standalone lead — Context Summary

**Session**: 2026-10-01 → 2026-10-02 11:30 UTC (Claude Code on the web, lead role)
**Team**: js2wasm (lead + Opus implementation lanes, two cloud sessions)
**Goal**: 100 % ES2015 pass rate in standalone mode (test262, `--standalone`).

## State at hand-over

| issue | PR / branch | state | rows |
| --- | --- | --- | --- |
| #6769 TypedArray residue | PR #6365 | merged | +27 |
| #6773 Iterator chunks/windows/join | PR #6421 | merged | 21 / 21 |
| #6775 misc built-ins | PRs #6416 + #6434 | merged | 38 / 70 (+4 restored by #6434) |
| #6771 Array residue | PR #6422 | merged | 30 / 34 |
| #6774 expressions + computed property names | PR #6414 | merged (after a LOC-grant fix in the queue) | 40 / 60 |
| #6770 Object + Reflect | PR #6442 | main `f156b4ba83` merged in; see Open threads | 44 / 49 |
| #6772 class residue | branch `issue-6772-class-residue` @ `a086bbecc4`, **no PR** | paused (budget); S1a, S1b, S2, S3, S5, S6 committed | see issue record |

Earlier in the session: #6349, #6351, #6348 (compiler-boundaries edit), #6363,
#6439 (CLAUDE.md line-1 fix) merged.

## Open threads

- **#6770** — the "regression" reported at wrap-up was stale: the control's
  chunk 00 ran on a tree from before `c53b9be2c2`, which fixed that row
  (`Object/assign/strings-and-symbol-order-proxy.js` passes 6/6 on the final
  tree). The merge queue's full standalone run is the control for the
  2,361 unrun rows. Details: the issue's "Controls" / "Handoff" sections.
- **#6772** — S6 (`a086bbecc4`) was committed at wrap-up from the paused
  lane's worktree; the lead did not re-run its measurements. Remaining steps
  per the issue's implementation plan (S7–S12). Before a PR: rows base vs
  merged, pins, controls, full gate chain.
- **#6774** — still `in-progress` after #6414: S9 (2 rows), S10 (2), S14 (3),
  S20 (1), S22 (2), S23 (1); 10 rows belong to other lanes (#6772, #3371,
  #1472, #680, eval provider).
- **Unassigned ES2015 standalone buckets**: Proxy (~37 rows), language
  statements / module / global misc (~56 rows).
- **Unanswered user questions**: whether the ~75 cross-realm rows stay in the
  100 % target; whether iterator-chunking rows should be reclassified out of
  ES2015 (classifier left unchanged).
- PR subscription for #6442 remains active in the old session; a scheduled
  check-in (`trig_01HbNwzdTiHP7tNiy6JMmFmk`) may fire into it.

## Proposed and accepted

- Fable plans, Opus implements; one lane per residue issue (#6769–#6775).
- Budget (7-day limit in the warning band, resets 2026-10-08 08:00 UTC):
  "land, then 1 lane" — land finished work, run only #6770, keep #6772 paused.
- #6797 import-cycle / flat-dir gates: **break the cycles** — restructure
  imports and move files into subdirectories; never run `--update` and never
  edit `scripts/import-cycles-baseline.json` or
  `scripts/flat-dir-budget-baseline.json`.
- Local spawn cap raised to 6 (`.claude/max-load`), with user approval.

## Proposed and rejected

- Editing the cycle / flat-dir baselines to unblock the parked PRs (rejected
  in favour of breaking the cycles).

## Mechanics that cost time (keep)

- Row runs: `flock /tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts <list> --isolate --standalone`
  (paths relative to `test262/test/`); eval rows need
  `npx tsx scripts/build-quickjs-eval-provider.mjs` in that tree first.
- Agent worktrees can have an incomplete `test262/` checkout: symlink the main
  checkout's (same submodule commit) and never stage it.
- Pins need `VITEST_FORK_MAX_OLD_SPACE_SIZE=1024`; pre-push needs
  `NODE_OPTIONS=--max-old-space-size=4096 VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`.
- Gate chain must include the #6797 gates: `check-import-cycles.mjs`,
  `check-flat-dir-budget.mjs`, plus `check-claude-md-paths.mjs` and
  `npm run -s typecheck` (a bare `tsc --noEmit` misreports Node types).
- Pin the main sha for `LOC_GATE_BASE`: another lane's `git fetch` moves
  `origin/main` mid-verification in a shared clone.
- **Stranded LOC grant**: when a sibling PR touching the same file merges
  first, main's baseline refresh resets that file's ceiling and the later PR
  fails `quality` in the merge group (hit #6414 on `array-holes.ts`). Re-run
  `check-loc-budget` against the new main before re-queueing.
- A parked PR that stays in the queue poisons the groups behind it; close and
  reopen to dequeue (steward skill §5).
- Local `--isolate` controls run ~7–8 s/row behind the shared lock; a
  second unlocked worker running chunks from the tail halves the wall-clock.

## Files written/modified

- Issue files: `plan/issues/6769-…` through `6775-…` (plans + implementation
  records); #6770's "Controls" / "Handoff" sections on its branch.
- New leaves from the cycle-breaking work: `src/codegen/helpers/core-delegates.ts`,
  `src/codegen/helpers/reserved-helper-funcs.ts`,
  `src/codegen/registry/expression-helper-delegates.ts`.
- All `.tmp/` scratch (row lists, snapshots, control logs) is lost with the
  container; each issue file lists its rows.
