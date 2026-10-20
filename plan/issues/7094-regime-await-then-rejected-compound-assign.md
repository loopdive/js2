---
id: 7094
title: "Regime gap: `r += await p.then(f, g)` on a rejected `p` answers 0 on both native lanes"
status: done
assignee: ttraenkler/opus-7094-await-then
completed: 2026-10-19
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: async/await
goal: architecture
sprint: current
parent: 5385
related: [7089, 6982, 6979]
---

# #7094 — compound assignment of an awaited `then(f, g)` on a rejected promise

Found by #7089 (2026-10-19) while testing combinator rows; it is not specific
to the combinators. On native-first (JS environment) and standalone:

```ts
let r = 0;
const p = Promise.reject(new Error("x"));
r += await p.then((v) => 1, (e) => 2);
// Node: r === 2.  Native lanes: r === 0.
```

The awaited value of the `then` call with a rejection handler is lost when
the await sits inside a compound assignment: the right operand reads as 0.
The plain form `const v = await p.then(f, g); r += v;` is not yet
measured and must be part of the first step.

## Plan

1. Measure: a `.tmp` probe matrix: `r += await <expr>` with `<expr>` ∈
   {`p.then(f, g)` on rejected `p`, `p.then(f)` on resolved `p`,
   `p.catch(g)`, a plain resolved promise}; the two-statement form; `r = r +
   await …`; on native-first and standalone against Node. Record whether the
   defect is in the async-CPS resume slot for the compound-assignment RHS,
   in the `then(f, g)` rejection handler's return value, or in the
   onRejected result settling the derived promise.
2. Implement in the native promise provider / async scheduler (shared
   runtime, not direct-AST bodies): the defect's actual site from step 1.
3. Tests: a focused test under native-first and standalone comparing with
   Node; the test262 rows under `built-ins/Promise/prototype/then/` that
   reject and `language/expressions/await/` with compound assignment,
   before/after.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import.

## Implementation notes (2026-10-19)

### Measurement (step 1)

`.tmp` probe: `export async function test(): Promise<number> { <form> }`, exports
read through `wrapCompiledExports`; Node runs the same body. Native-first (JS
environment) and `--target standalone` gave the SAME table, and so did the
default host lane.

| operand \ form | `r += await p` (p bound first) | `r += await <expr>` | two-statement | `r = r + await` | `return await` |
| --- | --- | --- | --- | --- | --- |
| `then(f, g)` on rejected (Node 2) | 0 → **2** | 0 → **2** | 2 | 0 → **2** | 2 |
| `then(f)` on resolved (Node 6) | 0 → **6** | 0 → **6** | 6 | 0 → **6** | 6 |
| `catch(g)` (Node 3) | 0 → **3** | 0 → **3** | 3 | 0 → **3** | 3 |
| `Promise.resolve(4)` (Node 4) | 4 | 4 | 4 | 4 | 4 |
| `then(f, g)` on resolved (Node 7) | 0 → **7** | 0 → **7** | 7 | 0 → **7** | 7 |

(main → branch; a cell with no arrow was already right on main.)

So the defect is NOT in the rejection handler or the settle of the derived
promise: every pending operand loses its value, rejected or not, and the
two-statement form is right on main. It is in the **async-CPS planner**. An
await that is the right operand of a compound assignment or binary operator is
not one of the positions `lowerLinearStatements` accepts, and the #6846
leading-await replay (`isLeadingReplaySafeAwait`) declined it too: it returned
`null` for a compound assignment, and a `let`/`var` left operand is not an
immutable binding. The whole function then fell back to the legacy
pass-through, where `await` is an identity. That still reads the statically
settled `Promise.resolve(4)` right, but a pending derived promise flows on as
the Promise object and adds as 0.

A second, pre-existing defect sat behind it (it also broke #6846's own
`const` case). A binding the replay re-reads after resumption lexically
PRECEDES the await, and `analyzeAsyncBody`'s liveness walk only collects names
that come after the await, so a local read only there was not spilled.
`const k = 10; return k + await p` returned 1 on main, and
`const f = …; return f(k, await p)` trapped with a null dereference.

### Fix (step 2): shared async-CPS planner, no body emitter touched

- `src/codegen/analysis/async-leading-await-replay.ts`
  - `operandsBefore` models `x op= <await>` (identifier target, non-logical
    operator): the target value is read before the right operand. `&&=`, `||=`
    and `??=` stay declined, because they may skip the right operand.
  - `isSuspensionStableLocal`: a `let`/`var` local of the awaiting function is
    replay-safe when no nested function/class scope references it and the
    awaited operand neither names it nor contains `eval`. Nothing else can
    then write it during the suspension, and it is spilled like every local,
    so re-reading it after the resumption gives the value it had before the
    await.
  - `replayPreAwaitReads`: the bare identifiers a replay re-reads (the
    pre-await operands on the path from the await up to its statement).
- `src/codegen/async-cps.ts` `analyzeAsyncBody`: those names join the
  live-after-await set, so they are spilled.

Declined on purpose, so these stay on the legacy path (measured: same result
as main): a local captured by a closure, an awaited operand that writes the
target (`r += await (r = 5, p)`), and logical assignment (`r ||= await p`).

### Byte identity

I took every inline source that contains an `await` in `tests/*.test.ts` and
`tests/equivalence/*.test.ts`: 660 sources, compiled on gc, standalone and wasi,
1,980 rows in all (601/604/597 compiled). I hashed them once with main's two
files restored and once with the branch's: **0 rows differ**. A program without
`await` cannot change, because both edits run only on await points.

### Tests (step 3)

- `tests/issue-7094-await-in-compound-assignment.test.ts`: 12 rows × {native-first
  JS environment, standalone}, each compared with Node. On main 20 of 24 fail;
  on the branch all 24 pass.
- test262 standalone (`scripts/run-test262-paths.mts --standalone`,
  `JS2WASM_EVAL_ENGINE=interpreter`), 98 rows: all of
  `built-ins/Promise/prototype/then/` and `language/expressions/await/`, plus
  every async-function / compound-assignment file with an await operand.
  main: `pass 88 / fail 7 / compile_error 3`. Branch: the same counts, with the
  same non-pass rows. **Deterministic delta: 0.** No test262 row in those
  directories awaits a pending promise as a compound/binary operand.

### Acceptance (step 4)

- Equivalence gate (single fork, `--configLoader runner`): `20 failing, 2020
  passing, 22 known-failures in baseline` and "✓ No new equivalence
  regressions." The 2 baseline rows it reports as now passing
  (`delete-sentinel`, `Reflect.construct`) have nothing to do with this change
  (0 bytes differ on await-bearing sources).
- No host import added: the change is compile-time planning only.
  `check:host-import-policy` exits 0.
- Async/await/Promise vitest files (126 files, matched by filename): 261
  failures on main, 241 on the branch. The difference is exactly the 20 new
  #7094 rows; no test fails on the branch that passes on main.

### Left out (separate defects found while probing; this change did not cause them)

- An await inside a `for` loop body loses pending values, even in the plain
  `const v = await p.then(…); r += v;` and `r = await p.then(…)` forms. That is
  the loop CFG planner, not the replay lane.
- After an await, `s.length` on a `let s: string` built with `s += t` reads 1
  where Node reads 3. The two-statement form does the same, and `s` itself
  still compares equal to `"abc"`.
