---
id: 5172
title: "Four rotted test rows fail on current main but never run in CI (fix-on-touch ratchet blind spot): #3529 dataflow unary `!` ×2, #3529 externref console identity, #3522 standalone console parity"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir, tests
goal: ir-full-coverage
related: [3529, 3522, 5092]
origin: "2026-08-29 PR #5102 drive-to-green — clean merge-base attribution during the issue-4502 fix-on-touch repair"
---

# #5172 — four rotted test rows, red on main, never run in CI

## Problem

During PR #5102's drive-to-green (commit `7fb7dc2b` on
`codex/5092-ir-conditional-expression`), a clean attribution pass found four
test rows that fail on a tree byte-identical to origin/main's source (verified:
the branch's merge-base `33099f2` has an EMPTY `git diff … origin/main -- src/
scripts/`), reproduced with CI's own vitest flags
(`--pool=forks --singleFork --no-file-parallelism`):

1. `#3529` dataflow unary `!` — two rows;
2. `#3529` externref console identity — one row;
3. `#3522` standalone console parity — one row.

Counts: 4 failed / 47 passed across their files, identical at the clean
merge-base and at the PR branch head.

## Why CI is green anyway

`ci.yml`'s changed-root gate runs ONLY the `tests/*.test.ts` files a PR
touches ("Untouched root test files do NOT run at PR time … touching a rotted
one means fixing it — the fix-on-touch ratchet"). Nothing on main touches
these files, so the rot is invisible until someone edits them — at which point
the editor inherits four unrelated failures (this nearly cost PR #5102 a
second CI cycle).

## What to do

1. Reproduce each row on current main with CI's vitest flags; classify: stale
   expectation (product moved, pin not updated) vs real regression (find the
   introducing commit — `git log -S` on the asserted strings).
2. Fix product or pin per classification; each edited file then enters the
   fix-on-touch ratchet, so the WHOLE file must be green.
3. Deliberately left out of PR #5102 to avoid widening it — this issue is the
   tracked follow-up.

## Acceptance criteria

- The four rows green on main under CI's flags, with the rest of their files
  green (fix-on-touch).
- Each fix's classification stated (stale pin vs regression + introducing
  commit).
- Ratchet gates chained bare before commit.

---

## 2026-08-29 — inventory addition: `tests/comma-operator.test.ts` (fixed here)

`tests/comma-operator.test.ts` failed **5/5** on `origin/main` at `ddab1b0743`.
It is a fifth instance of the class above and is repaired in this PR; the
systemic CI-selection gap stays this issue's scope.

**All five rows are OBSOLETE PINs of the compiler's IMPORT SURFACE, not of
comma-operator semantics.** Every row compiled successfully and returned the
correct value on both pipelines the whole time — the file's hand-rolled
WebAssembly import object (only `env.console_log_{number,string,bool}`) simply
stopped being a complete import surface. **Zero real regressions.**

Classification, with the runtime value measured on each pipeline against a
hand-written JavaScript reference run on Node:

| # | Row | Node | IR | legacy | Owner (`trackIrOutcomes`) | Class |
| - | --- | ---- | -- | ------ | ------------------------- | ----- |
| 1 | returns the right-hand value `(1, 2)` | 2 | 2 | 2 | IR `emitted` | OBSOLETE PIN (harness) |
| 2 | evaluates left side for side effects `x = (x = 5, x + 10)` | 15 | 15 | 15 | legacy, `body-shape-rejected` | OBSOLETE PIN (harness) |
| 3 | chains multiple commas `(1, 2, 3)` | 3 | 3 | 3 | IR `emitted` | OBSOLETE PIN (harness) |
| 4 | for-loop update `i = i + 1, a = a + 1` | 15 | 15 | 15 | IR `emitted` | OBSOLETE PIN (harness) |
| 5 | different types `(x = 10, x + 1)` | 11 | 11 | 11 | legacy, `body-shape-rejected` | OBSOLETE PIN (harness) |

No post-claim demotions on any row. Rows 2 and 5 staying legacy-owned is the
**#4459 discard-purity line** that #5164 inherited — a comma whose LEFT operand
mutates is rejected pre-claim — and row 4 being IR-owned is #5164 S2, where each
side of a for-incrementor comma re-enters the update-clause rules and the
mutating `i++` idiom is admissible. The rewrite pins that split explicitly, so
the boundary can no longer move silently.

### Attribution — NOT #5164/#5211

The natural suspect was PR #5211 (#5164, the comma IR adoption, merged
`efb50daeca` 2026-08-29 02:30Z), since it is the comma operator's most recent
change. **It is not the cause.** Two independent proofs:

- The failure reproduces identically with `experimentalIR: false`, and #5211's
  entire diff is `src/ir/*` + its own test + plan docs — it touches nothing on
  the legacy lowering path or the import surface.
- The failing import, `string_constants`, was introduced **2026-08-08** by
  `6786454b4f` (`perf(#4157): hoist constant number boxing to module globals`)
  / #4219 — three weeks earlier. Constant boxing moved to module globals, and
  from then on every module imports the string-constant pool that carries its
  export names, even a module with no user string literals (`stringPool` for
  `export function test()` is `["test", ""]`).

So the row rotted on 2026-08-08 and sat red for three weeks. This is worth
recording as a pattern: **the blind spot makes the most recent related change
look guilty**, because the rotted row surfaces only when someone touches the
file for an unrelated reason. Attribution must be measured (`git log -S` on the
failing symbol), never inferred from topical adjacency.

### The class is much larger than four rows — measured

21 test files hand-roll the same import object (`console_log_number: () => {}`
with no `string_constants` and no `buildImports`). Running all 21 on
`ddab1b0743`:

- **18 of 21 files fail — 120 failed / 55 passed (175 tests).**
- **117 of the 120 failures are this identical `string_constants` rot**
  (`Import #0 module="string_constants"` ×114, `Import #1` ×3).
- The remaining 3 are NOT the harness and need their own triage:
  `tests/typed-array-basic.test.ts` (Float32Array / Uint16Array — `Compile
  failed`), and `tests/issue-328.test.ts` (array holes/elision — `Compile
  failed` plus one genuine wrong answer, `expected 10 to be 15`).

The one-line repair for the 117 is mechanical: build the import object with
`buildImports(result.imports, undefined, result.stringPool)` from
`src/runtime.ts` instead of hand-rolling it. The two suspected real defects
behind the remaining 3 are the reason the sweep should not be done blind as a
single mass edit — each file entering the fix-on-touch ratchet must be green,
and those two carry findings, not pins.
