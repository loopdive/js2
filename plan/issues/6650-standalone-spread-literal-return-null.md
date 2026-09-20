---
id: 6650
title: "standalone: a spread-built object literal returned from a function is null at the caller"
status: in-progress
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/sendev-s70
created: 2026-09-20
loc-budget-allow:
  # 2026-09-20 (#6650): +1 line in the god-file — a single `import` for the
  # new subsystem module `src/codegen/declarations/host-carrier-object-literal.ts`.
  # The mechanism itself (helper + rationale) lives in that module, per the
  # gate's own "add code to the subsystem module, not the barrel/driver"
  # guidance; only the import can't be moved out of the driver.
  - src/codegen/declarations.ts
---

# `Temporal.PlainDate.prototype.add` fails for every input — a spread-built object dies at the function return

Handed over by S69 (#6647). `Temporal.PlainDate.prototype.add` answers
`TypeError: Cannot destructure 'null' or 'undefined'` for **every** input under
`--target standalone`: 22/39 rows in
`test/built-ins/Temporal/PlainDate/prototype/add/` and 56/111 across
`PlainDate/prototype/subtract/` + `PlainYearMonth/prototype/{add,subtract}/`.
Not eval-related, not link-related — it reproduces through
`compileWithTemporalGlobal` with no harness, and `PD.with(…)` /
`zdt.add(dur)` are clean controls.

## Reduction

S69 reduced it to a provider-local spread literal crossing a function return.
S70 reduced it further to a **single standalone module with no provider and no
link at all** (`.tmp/s70/probes/solo1.mts`, ~5 s per run):

```js
function noCollide() { const o = { years: 1, months: 2 }; return { ...o, days: 9 }; }
noCollide().days   // TRAP: dereferencing a null pointer   (typeof says "object")
```

`function f(o) { return { ...o, days: 9 }; }` (spread of a **parameter**) is
clean, as is the same spread read **inside** the function without returning the
object.

## Root cause — one missing predicate at the return boundary

`wasm-dis` of the compiled module (`.tmp/s70/probes/wat1.wat`) shows the two
halves disagreeing:

- the literal is built on the **open host `$Object`** route
  (`__new_plain_object` + `__extern_set` per property) and yields an
  **externref** — because `objectLiteralSpreadTakesHostPath` (#2804) routes a
  spread literal in a non-specific contextual position there, and a `return`
  with no return annotation has no contextual type;
- the function's Wasm result ABI is the **concrete struct**
  `(ref null $20)` — `resolveWasmType` of the checker-inferred
  `{years, months, days}`.

So the emitted return is a guarded downcast that can never succeed:

```wat
(return
 (if (result (ref null $20))
  (ref.test (ref $20) (local.tee $9 (any.convert_extern (local.get $1))))
  (then (ref.cast (ref null $20) (local.get $9)))
  (else (ref.null none))))          ;; ← every call takes this arm
```

`typeof` survives (a null ref still reads as `"object"`); every property read
answers null or traps.

The compiler already has a lane for exactly this — `functionReturnsReferenceBoundaryCarrier`
→ `functionReturnsHostObjectLiteralCarrier` (`src/codegen/declarations.ts`),
whose own comment says *"A concrete WasmGC result ABI then null-drops the valid
externref at `ref.test`"*. It consulted only `objectLiteralForcesHostPath`
(shape-driven: accessors, computed keys, colon-`__proto__`, empty-string key,
…) and never `objectLiteralSpreadTakesHostPath` (context-driven). The
**local-binding** boundary (`statements/variables.ts` :966) and the
**captured-init** boundary (`statements/nested-declarations.ts` :1674) already
consult both in lockstep; the return boundary was the missing third.

## Fix

`src/codegen/declarations.ts` — one helper, `objectLiteralTakesHostCarrier`,
that ORs the two host-path predicates, used at both literal sites inside
`functionReturnsHostObjectLiteralCarrier` (the returned expression and the
local-variable carrier it may be returned through).

## Measurement

`.tmp/s70/probes/solo3.mts` — 20 shapes, top-level declarations, standalone,
base = a file-copy revert of `src/codegen/declarations.ts` to `0813ae554d`.

| shape | base | fix |
| --- | --- | --- |
| `function f() { const o = {…}; return { ...o, days: 9 }; }` | TRAP null | **9** |
| … via a local (`const x = {...o,…}; return x;`) | TRAP null | **9** |
| `let` source | TRAP null | **9** |
| spread-only `return { ...o }` | TRAP null | **2** |
| source from a call (`const o = mk()`) | TRAP null | **9** |
| module-global const source | TRAP null | **9** |
| key collision (`{years,days:0}` → `days:9`) | TRAP null | **9** |
| two spread sources | TRAP null | **9** |
| the read done INSIDE a second provider function | TRAP null | **9** |
| nested spread source (`{ ...t.date, days: 9 }` — the polyfill's `Wr`) | TRAP null | **9** |
| controls: param spread · read-inside · non-spread literal · plain local return · `@returns {any}` | 9 / 9 / 9 / 2 / 9 | unchanged |

The S69 linked reduction (`.tmp/s70/probes/linked8.mts`, a real provider
module through the two-module link) goes from 6 of 7 expressions erroring to
**7 of 7 answering**, including `collideLast` (`{days:9, ...o}`) whose correct
answer is `0`, not `9`.

## Residuals (measured, not fixed)

The return boundary is fixed for **function declarations** only. Four other
callable shapes still carry the same mismatch — same probe file
(`.tmp/s70/probes/solo3.mts`), identical before and after:

| shape | result |
| --- | --- |
| arrow function (`const m1 = () => ({...o, days:9})`) | `NaN` |
| function expression (`const P1 = function () {…}`) | `NaN` |
| object-literal method (`{ mk() {…} }`) | TRAP `illegal cast` |
| class method | TRAP `dereferencing a null pointer` |
| nested function declaration (inside another function) | TRAP `dereferencing a null pointer` |

Each needs its own registration site widened (`declarations.ts` :2966 for the
nested lane; the closure/method lanes elsewhere). Out of scope here because the
Temporal polyfill's arithmetic path (`Wr()`) is a top-level function
declaration, which is what the briefed rows exercise.
