---
id: 7096
title: "Async-CPS gap: an `await` of a pending promise inside a `for` loop body loses its value (plain `r = await p` and the two-statement form)"
status: done
assignee: ttraenkler/opus-7096-loop-await
completed: 2026-10-20
created: 2026-10-19
updated: 2026-10-20
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
language_feature: async/await
goal: architecture
sprint: current
parent: 5385
related: [7094, 6982, 6979, 7097, 7098]
# 2026-10-20 (#7096): +80 lines in async-cps.ts. The single-loop shape analysis
# (analyzeLoopAsync), its CFG builder (planLoopCfg) and the loop spill set are
# one unit that the admission gate, the frame layout and the planner must all
# read identically; the for-head emit hooks (init/incr) use compileExpression /
# emitCoercedLocalSet, which a leaf module cannot import without joining the
# codegen import cycle. The pure head-admission rules moved to the new leaf
# module src/codegen/analysis/async-loop-head.ts.
loc-budget-allow:
  - src/codegen/async-cps.ts
---

# #7096 — pending `await` inside a `for` loop body

Found by #7094 (2026-10-19) while measuring the compound-assignment matrix.
Inside a `for` loop body, an `await` of a promise that is still pending when
it is reached reads as 0 (the Promise object itself is added) even in the
plain two-statement form and in `r = await p`. The #7094 fix admitted
compound and binary right operands to the leading-await replay path
(`src/codegen/analysis/async-leading-await-replay.ts`) and saved pre-await
reads across the suspension (`replayPreAwaitReads` in
`src/codegen/async-cps.ts`); loop bodies take neither path. All native lanes
and the host lane agree, so this is the async-CPS planner, not the promise
provider.

## Plan

1. Measure: a `.tmp` matrix on native-first and standalone against Node —
   `for (…) { r += await p; }`, `for (…) { const v = await p; r += v; }`,
   `for (…) { r = await p; }`, `for…of` with the same bodies, `while` and
   `do…while`; with `p` pending vs. already settled; with the loop variable
   read after the await and not. Record which shapes lose the value and
   whether the loop variable itself survives the suspension.
2. Fix in the async-CPS planner: the loop-body suspension must save the loop
   state (induction variable, accumulator) and resume into the body with the
   settled value, the same way the straight-line replay does; keep every
   binary without an `await` inside a loop byte-identical.
3. Tests: a focused test under native-first and standalone vs Node; test262
   `language/statements/for*/` + `expressions/await/` rows with awaits in
   loop bodies before/after on standalone (deterministic delta only).
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; direct-AST freeze respected (planner/analysis code, no new body
   emitter semantics).

## Implementation notes (2026-10-20)

Stacked on #7094 (PR 6780): the branch is based on its branch, because both
change the async-CPS planner's spill decisions.

### Measurement (step 1)

`.tmp` probe: `export async function test(): Promise<any> { let r = 0; let x = 0; <loop> return r; }`,
exports read through `wrapCompiledExports`; Node runs the same body. Loops:
`for (let i = 0; i < 3; i++)`, `for (const i of [0, 1, 2])`,
`let i = 0; while (i < 3) { … i++; }`, `let i = 0; do { … i++; } while (i < 3)`.
Bodies: `r += await p`, `const v = await p; r += v`, `x = await p; r += x`, each
with and without a following `r += i * 100` (the loop variable read after the
await). `p` pending = `Promise.resolve(2).then((v) => v)`, settled =
`Promise.resolve(2)`. Native-first (JS environment), `--target standalone` and
the default host lane gave the SAME result in every cell.

| loop \ body | `r += await p` | `const v = await p; r += v` | `x = await p; r += x` |
| --- | --- | --- | --- |
| `for`, pending (Node 6 / 306) | 0 / 300 → **6 / 306** | 0 / 300 → **6 / 306** | 0 / 300 → **6 / 306** |
| `for`, settled | 6 / 306 | 6 / 306 | 6 / 306 |
| `do … while`, pending (Node 6 / 306) | 0 / 300 → **6 / 306** | 0 / 300 → **6 / 306** | 0 / 300 → **6 / 306** |
| `do … while`, settled | 6 / 306 | 6 / 306 | 6 / 306 |
| `for…of`, pending and settled | 6 / 306 | 6 / 306 | 6 / 306 |
| `while`, pending and settled | 6 / 306 | 6 / 306 | 6 / 306 |

(First number: no loop-variable read. Second: with `r += i * 100`. A cell with an
arrow shows main → branch. Of the 48 cells × 3 lanes, 12 cells were wrong on
main; all 48 are right on the branch.)

So only `for (init; cond; incr)` and `do … while` lose the value. The loop
variable itself is NOT lost (the `i * 100` part is right on main), because those
two loop kinds never reach the async machine at all: the function falls back to
the legacy pass-through, where the loop runs synchronously and `await` is an
identity. A settled `Promise.resolve(2)` still reads right there, but a pending
derived promise flows on as the Promise object and adds as 0.

### Defect site

`analyzeWhileAsync` in `src/codegen/async-cps.ts`, the shape analysis behind the
async loop CFG. Three places read it and must agree: the admission gate
(`asyncFnNeedsDrive` → `computeLoopSpills`), the frame layout
(`loopAsyncSpillInfo`) and the planner (`planWhileLoopCfg`). It required the
single awaiting top-level statement to be a `while`, so `for` and `do … while`
were declined before planning. `for…of` goes through a different planner (the
region body in `lowerRegionBody`), which is why it was already right.

A second gap sat in the same spill set and also affected `while`: the set held
only the locals referenced inside the loop statement. A pre-loop local read only
by the post-loop statements (which run in the exit state, after the suspensions)
was not spilled. `let a = 5; …loop with await…; return r + a` returned `r + 0`.

### Fix (step 2): shared planner/analysis code, no body emitter touched

- `analyzeLoopAsync` (renamed from `analyzeWhileAsync`) admits `while`,
  `do … while` and `for (init; cond; incr)`. The condition and the `for` head's
  init/incr must be await-free, and a `for` head must pass
  `asyncForHeadAdmissible`.
- `src/codegen/analysis/async-loop-head.ts` (new leaf module) holds
  `asyncForHeadAdmissible`:
  - the head may declare only identifier `let`/`var` bindings (no
    `const`/`using`), and every `let` needs an initializer;
  - no nested function in the loop may mention a head name: a capture is what
    makes the per-iteration environments of §14.7.4.4 observable, and a captured
    binding lives in a ref cell that the plain head store would overwrite;
  - a `let` head name must be declared nowhere else in the function, because
    spill slots are keyed by name;
  - an expression initializer, or none, is always admitted.
- `planLoopCfg` (renamed from `planWhileLoopCfg`):
  - `for` runs its initializer as the entry state's `emit` step (the existing
    hook the for-await planner uses). A missing condition becomes `goto body0`.
    The incrementor is the continuation state's `emit` step, before the
    back-edge.
  - `do … while` has no head state. The entry state (or body0 itself) starts
    the body, and the continuation ends in `condGoto(cond, body0, exit)`.
  - A `while` loop builds exactly the machine it built before.
- `loopAsyncSpillInfo` also spills the pre-loop locals that the post-loop
  statements read. It skips names that only the post statements declare,
  because those are born in the exit state.

Declined on purpose. Measured: these keep main's result, which is still wrong
for a pending operand.
- a head binding captured by a closure;
- a `let` head that shadows another declaration of the same name;
- a `break`/`continue`/`return`, a nested loop or a `try` in the body;
- an await in the condition or the head;
- a loop that is not the only awaiting top-level statement.

### Byte identity

I compiled every inline template-literal source in `tests/*.test.ts` and
`tests/equivalence/*.ts` on gc, standalone and wasi, once with main's planner (a
copy of `src/` holding the base `async-cps.ts`) and once with the branch's:

| corpus | rows per target | compiled (gc / standalone / wasi) | rows that differ (gc / standalone / wasi) |
| --- | --- | --- | --- |
| sources containing `await` | 707 | 554 / 557 / 546 | 4 / 3 / 4 |
| equivalence sources (all) | 1,735 | 1,665 / 1,665 / 1,644 | 0 / 0 / 0 |

The 11 differing rows come from 5 sources, and every one awaits inside a
`for (let i …)` body: `issue-1042-host-drive`, `issue-2710-late-bind`,
`issue-4124-ir-final-async`, and two sources in
`issue-6780-await-static-suspends`. Other programs cannot change, because the
new code runs only when the loop analysis admits a `for`/`do` loop with an
await in its body, or a `while` whose post-loop statements read a pre-loop
local.

### Tests (step 3)

- `tests/issue-7096-async-await-loop-body.test.ts`: 24 rows × {native-first
  JS environment, standalone}, each compared with Node. The rows are:
  - the `for`/`do … while` matrix above, pending and settled;
  - `var`, expression and missing initializers;
  - two declarators with a comma incrementor;
  - zero iterations, and two awaits per body;
  - a `const` loop bound;
  - the post-loop read, for `for` and for `while`;
  - a `do … while` whose condition is false at once, and one whose condition
    reads the induction variable;
  - a rejection that rejects the result.

  On main 34 of 48 fail; on the branch all 48 pass.
- `tests/issue-1042-host-drive.test.ts`: the row "await inside a loop still
  compiles via the legacy path" pinned `f() as any as number === 3` for exactly
  the `for (let i …) { s = s + (await g()); }` body that is now a real
  suspension. The row now pins the legacy path with a body the loop CFG still
  declines (one with a `break`), and a new row checks that the plain `for` body
  resolves to 3 as a Promise.
- test262 standalone (`scripts/run-test262-paths.mts --standalone`,
  `JS2WASM_EVAL_ENGINE=interpreter`), 223 rows:
  - all of `language/expressions/await/`, `language/statements/async-function/`
    and `language/expressions/async-function/`;
  - every `for`/`do-while`/`while` row that mentions `async`;
  - every `for-of` row with an await;
  - every `language/` row whose source has an await in a loop body.

  main: `pass 209 / fail 10 / compile_error 4`. The branch has the same counts,
  with the same non-pass rows and reasons, and no row timed out.
  **Deterministic delta: 0.** test262 has almost no rows that await a pending
  promise in a `for`/`do` body.
