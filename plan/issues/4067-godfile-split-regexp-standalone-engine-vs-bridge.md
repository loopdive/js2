---
id: 4067
title: "God-file split: separate the RegExp ENGINE from the String↔RegExp protocol bridge in regexp-standalone.ts"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: refactor
language_feature: n/a
goal: dogfood
---
# God-file split: separate the RegExp ENGINE from the String↔RegExp protocol bridge in regexp-standalone.ts

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

⚠ RE-FRAMED on the measuring agent's own recommendation. Schedule this against the
COMPILER CONSOLIDATION goal (plan/log/compiler-consolidation-plan.md), NOT as ratchet
cleanup.

WHY THE REFRAME: the residual allowance on regexp-standalone.ts is **+19 lines**
(4,280 vs a 4,261 cap) — corrected from an initially-reported +59, which came from
reading `git diff --stat`'s changed-line count as a size delta. Only `wc -l` answers
what the ratchet asks. Retiring 19 lines of allowance does NOT justify relocating the
protocol bridge and re-measuring a 99-file population plus a 166-file passing guard.
The split is worth doing because `regexp-standalone.ts` is a 4,280-line god-file mixing
two concerns; the allowance disappearing is a bonus.

WHAT THE SPLIT SEPARATES:
  ENGINE  (stays)  — matching, compilation, flags, exec/test
  BRIDGE  (moves)  — the six String.prototype search-value methods + the
                     RegExp.prototype[@@...] dispatcher that shares their cores
  target: regexp-standalone.ts 4,280 -> ~3,500

IMPLEMENTATION EXISTS, PRESERVED, VERIFIED ON THE REMOTE:
  fork branch `shepherd-4016-loc-extraction-followup` @ 837661d52  (no PR)
  measured on it: regexp-standalone.ts 3,519 · string-ops.ts 3,735 · 994 moved lines
  BYTE-IDENTICAL · all gates + 110 targeted tests green on a post-merge base

⚠ IT PREDATES #3996 (merged 68d74d66d). It will conflict with the landed
`src/codegen/string-search-value.ts` (391 lines) and must be reworked ON TOP of it —
do not cherry-pick.

TWO CYCLE GOTCHAS, recorded by the agent that built it:
  - `staticRegExpFlags` must STAY in the engine file — `.test`/`.exec` need it, and
    moving it creates an import cycle.
  - `tryCompileStandaloneRegExpSymbolCall` must move WITH the cores, same reason.

AND A THIRD, from the landed fix — the seam has to move WHOLE or it is not a seam:
#3996 also had to move the pre-existing #2161 B2 undefined arm, because the
per-function ceiling (#3400) failed on `compileNativeStringMethodCall` when only the
new arm moved. Expect the same: a partial extraction re-fails a different gate.

⚠ THE RELOCATION OWES ITS OWN RE-MEASUREMENT. A byte-identical move still has to prove
it changed no behaviour: re-run the 99-file population and the 166-file passing guard.
A clean cherry-pick can produce an incoherent file — non-overlapping hunks apply
silently.

Then drop the `loc-budget-allow` from the #4016 issue frontmatter and confirm the gate
passes with no allowance.
