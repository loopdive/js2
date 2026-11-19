---
id: 7359
title: "IR DCE dropped a value `if` whose result is unused: `a > 0 && f();` never called f"
status: done
sprint: current
created: 2026-11-17
updated: 2026-11-17
completed: 2026-11-17
priority: critical
horizon: s
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7354, 2134, 1267, 1922]
---

# #7359 — An unused `&&` / `||` / `?:` value dropped its effectful arm

## Problem

A wrong answer on every IR target, ordinary pipeline and Prepared path alike. In plain, fully typed TypeScript:

```ts
function boom(v: number): boolean { if (v) throw 9; return false; }
function f(a: number, b: number): number { a > 0 && boom(b); return 0; }
export function main(): number { return f(1, 1); } // node throws; we returned 0
```

The right operand of a `&&` / `||` whose value is unused never ran — an expression statement, a local nobody reads,
a top-level statement, a loop body. Its call, a throw inside it, a counter bump inside it were all lost. The same
held for a conditional whose value is unused but not in statement position (`const r = a > 0 ? boom(b) : false;`).
On `origin/main` 9cf78f2666 the ordinary pipeline emitted `$main` as `f64.const 0; return` on both the default and
`--target standalone`; found by the #7354 slice T adversarial review.

## Cause

`isSideEffecting` (`src/ir/analysis/effects.ts`) is the DCE facet of the IR effect model: it decides whether an
instruction with an unused result may be dropped, by DCE (`src/ir/passes/dead-code.ts` `shouldKeep`) and by the
lowerer's emission contract (`src/ir/lower-generic.ts`: a zero-use instruction is emitted and dropped only if it is
side-effecting, #1267). It is a hand list of kinds. Every instruction that carries nested instruction buffers is in
it — `forof.*`, `while.loop`, `for.loop`, `try`, `if.stmt`, `labeled.block`, `switch` — **except the value `if`**,
the structured conditional `lowerLogicalAndOr` and `lowerConditional` build. So an `if` whose result is unused was
judged by its own kind alone, not by the instructions its arms run, and went away with the call in its arm.

The scheduler's facet `effectsOf` was already right: it merges the effects of the `if`'s buffers.

A conditional in statement position was correct because `lowerDiscardedExpression` (`src/ir/from-ast.ts`) lowers it
to an `if.stmt`; a logical expression has no discarded form there, so `a && f();` stayed a value `if`.

## Implementation Plan

- **Module:** `src/ir/analysis/effects.ts`, the one DCE facet. No change in DCE, the lowerer or from-ast — both
  consumers read `isSideEffecting`, so one rule fixes both.
- **The one rule:** an instruction that runs nested buffers is as side-effecting as what it runs —
  `isSideEffecting(i)` is also true when any instruction in a buffer of `i` (`forEachNestedBuffer`, the single
  authority on buffer-bearing kinds) is side-effecting, recursively. Generic over every buffer-bearing kind, so a
  future one cannot repeat the hole.
- **Existing listings:** the statement-level control kinds (`forof.*`, loops, `try`, `if.stmt`, `labeled.block`,
  `switch`) stay listed unconditionally — "always kept because they are control flow", whatever their buffers hold
  — so their behaviour does not change. The new clause adds only the value `if`.
- **Quality criterion:** one clause inside `isSideEffecting`, no new declaration (the effect module's declarations
  are pinned by `tests/issue-3518-semantic-verification-ownership.test.ts`), no per-operator case; an `if` whose
  arms are pure is still dropped (tested).

## Result

- Built: the buffer clause at the end of `isSideEffecting` in `src/ir/analysis/effects.ts` (after review round 1
  derived from `effectsOf` with the caller's cache — see below).
- Tests: `tests/issue-7359-dce-keeps-effectful-if.test.ts` (ordinary pipeline, default and standalone targets, and
  the unit rule including the pure-arm half); `tests/issue-7354-h3-unused-logical-operand.test.ts` (Prepared path).
- Ordinary pipeline: a generated sweep of 429 programs (11 forms × 13 positions — statement, unread `const` /
  `let`, unread assignment, top level, `for` / `while` / nested loops, `if` arm, `try`, `switch`, comma — × counter,
  wrong counter, throw) on the default and standalone targets: 0 wrong (wrong on main for every non-short-circuited
  form). Bytes identical on 300 test262 files (logical-and/-or, conditional, statements/expression, coalesce,
  logical-assignment, `x && f();` idioms, while / do-while, Array some/every) × 2 targets and on the 13 playground
  examples × 2 targets, so no test262 verdict can move; the change is reached by typed TypeScript where the IR claims
  the function.
- Mutations: deleting the clause = main (25 of 30 tests in the #7359 file fail, 74 of 108 in the Prepared file);
  `||=` → `=` (only the last buffer counts) and `some` → `every` are killed by the unit rows.
- Other measurements: the #7354 record "Follow-up: unused `&&` / `||` keeps its right operand".
- **Seen, not fixed:** `return x ?? 7` with `x: number | undefined` returns NaN for `undefined` on the ordinary
  (legacy) path — filed as #7360 (`plan/issues/7360-nullish-number-or-undefined-f64.md`).

### Review round 1: MET

No must-fix (reviewer at `6c2cb8bf5d`: 80/80 ordinary probes correct on both targets, 54 wrong without the fix;
220 test262 files and 13 playground examples byte-identical; a pure-arm `if` still removed; 5 mutants killed).
The should-fixes:

1. **Closed — the buffer rule had no memo** (a nested chain re-walked once per level). The clause now asks
   `effectsOf`, the one authority on what a buffer does, and takes the caller's `effectsOf` cache:
   `isSideEffecting(i, cache = new Map())`. DCE makes one cache per run; the lowerer passes its function-level
   cache (renamed `instrEffects`). A buffer-bearing instruction is kept when its buffers write the heap or a slot
   (every throw, control transfer and opaque op also has `writesHeap`, so no other facet is needed — both the
   `control` and `allSlots` terms were mutants that survived and were removed). Leaf kinds are untouched: the clause
   runs only for kinds with buffers. No new top-level declaration in `effects.ts`, so the ownership pin is unchanged.
   Behaviour: the 30 + 108 tests, the pure-arm tests and the earlier mutants hold; new unit rows (a slot write and a
   throw keep the `if`; a slot read and a call-like leaf, `dyn.current_this`, are still dropped). The only
   classification that moved: an arm holding only an `extern.regex` (a regex literal; `effectsOf` calls it pure,
   the hand list keeps it) is now dropped with an unused result — a literal pattern is checked at compile time.
   Timing (ordinary, standalone, median of 3, my stress programs): 120 nested effectful ternaries 194 ms → 157 ms
   (main 179 ms, which drops the code); 2,000-statement function 22.4 s → 22.0 s (main 22.1 s); 50 nested 121 ms →
   121 ms. The reviewer's 591 / 441 ms and 27.4 / 25.0 s programs were not re-run here.
2. **Recorded — known code-size cost.** An unused `a % 3` or `String(a).length` inside an arm is now kept, about
   200 lines of Wasm where main emitted none (`const r = b > 0 ? a % 3 : 0;`). The cause is not `raw.wasm`: `%` is a
   nested `if` whose fallback arm calls the exact `__fmod` helper (inlined later), and `String(a)` is a call; both
   are calls by kind. Narrowing that would mean proving those callees pure, which this fix does not attempt.
3. **Closed — the kind list must follow `effectsOf`.** Stated in `isSideEffecting`'s doc comment: every listed
   leaf kind is one `effectsOf` classifies as writing or control, except the documented divergence `extern.regex`;
   the statement-level control kinds are kept whatever their buffers hold; a buffer-bearing kind not listed is
   judged by `effectsOf` of its buffers.

Also filed: #7360, the `??` defect above.
