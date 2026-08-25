---
id: 4580
title: "STANDALONE: `Math.<fn>` read as a VALUE threw 'not yet implemented' — `[1,4,9].map(Math.sqrt)` and `derivative(Math.sin, dx)` failed while the direct call worked"
status: done
completed: 2026-08-20
sprint: current
created: 2026-08-20
updated: 2026-08-20
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: math
goal: es5
loc-budget-allow:
  # 2026-08-20: all logic lives in the new subsystem module
  # src/codegen/math-value-read.ts. The god-file grows by the IMPORT LINE plus
  # the one-line dispatch condition and nothing else — the floor; the branch
  # body and its rationale are in the module.
  - src/codegen/builtin-value-read.ts
func-budget-allow:
  # The +1 is the dispatch condition itself; the branch body lives in the new
  # module. Splitting this already-652-line dispatcher is a separate refactor
  # (#3399) and not something to attempt inside a conformance fix.
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
coercion-sites-allow:
  # 2026-08-20: one `__any_to_f64` call in the new src/codegen/math-value-read.ts.
  # This is the gate seeing the fix DO the right thing: the arguments arrive as
  # externref and run the ENGINE ToNumber pipeline
  # (`__any_from_extern` -> `__any_to_f64`), which is exactly what the gate
  # exists to push work towards — the same pipeline `Math.max`/`Math.min` use
  # for their variadic fold, so an object with a `valueOf` coerces identically
  # whether it reaches `Math.sin` by direct call or through an extracted value.
  # There is no hand-rolled ToNumber here to route anywhere else; the counter is
  # per-vocabulary-token and cannot tell an engine CALL from a hand-roll.
  - src/codegen/math-value-read.ts
related: [2933, 1907, 4163]
origin: "2026-08-20, ES5 standalone push follow-up. Found by bucketing the residue's explicit 'not yet implemented in --target standalone' refusals."
---

# #4580 — `Math.<fn>` as a value threw, while the direct call worked

## The asymmetry

```js
Math.sin(0.5)                    // 0.479425538604203  — always worked
derivative(Math.sin, 0.0001)     // TypeError: Math.sin is not yet implemented
[1, 4, 9].map(Math.sqrt)         // same
```

Calling `Math.sin(x)` directly has a dedicated call-site lowering that resolves
the self-hosted `Math_sin` provider and emits a direct `call`. Reading `Math.sin`
as a **value** did not: the reified value got the generic
`"<key> is not yet implemented in --target standalone"` throwing body from
`builtin-value-read.ts`.

The value itself was already spec-shaped — identity holds
(`Math.sin === Math.sin`), and `.name` / `.length` read correctly. **Only
invoking the extracted value threw**, which is why this presented as a missing
implementation rather than a missing property.

Passing a builtin as a function value is ordinary JS, so the two conformance
rows badly understate it.

## Fix

New `src/codegen/math-value-read.ts`, wired as one branch in
`builtin-value-read.ts` ahead of the generic refusal. For a `Math` method with a
self-hosted `Math_<name>` provider it emits a real body; anything else keeps the
refusal, so an over-wide entry is a **miss, never a wrong answer**.

Two details that are load-bearing:

- **Late minting is safe here.** `emitInlineMathFunctions` appends **defined**
  functions, and defined-function indices are appended after the import block —
  so minting one at this point cannot shift an existing index. That is unlike a
  late **import**, which is the hazard `addUnionImports` exists to manage. The
  surrounding path already mints defined functions at this moment.
- **Arguments run the engine ToNumber pipeline** (`__any_from_extern` →
  `__any_to_f64`) rather than a hand-rolled unbox — the same pipeline the
  `Math.max`/`Math.min` variadic fold uses (#2933). So an object argument with a
  `valueOf` coerces identically whether it reaches `Math.sin` through a direct
  call or through an extracted value. The result is boxed with `__box_number`,
  not `__any_box_f64`, for the reason the `Math.max` fold already documents: an
  `$AnyValue` box reads back NaN through `__unbox_number`.

Covers the 1-arg self-hosted set (`sin`, `cos`, `tan`, `asin`, `acos`, `atan`,
`sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `exp`, `expm1`, `log`,
`log2`, `log10`, `log1p`, `cbrt`) and the 2-arg pair (`atan2`, `pow`).

## Measurement

| | |
| --- | --- |
| `test262/test/language/statements/function/S13.2.1_A5_T2.js` | FAIL → **PASS** |
| `test262/test/language/statements/return/S12.9_A4.js` | FAIL → **PASS** |
| 551-row standalone ES5 guard | **551 / 551** |

Both rows verified individually, one process per test, `target=standalone`.

**Re-verified on the merged PR tree, 2026-08-20** (the two rows are this issue's
permanent repro, per the #2093 gate — they are cited above with their full
`test262/test/…` paths so the gate can find them):

```
TEST262_TARGET=standalone \
TEST262_PATH_FILTER="language/statements/function/S13.2.1_A5_T2.js|language/statements/return/S12.9_A4.js" \
  bash scripts/run-test262-vitest.sh
→ COMPLETED: 2 pass / 2 total
```

A note for whoever probes this next, because it cost a lane an hour: the fix is
reached through the **builtin value-read** path, and a hand-written
`const f: any = Math.cos; f(0)` in a TS module does **not** reach it — that shape
still throws, from a different refusal, and the compiled binary contains neither
the `math-value-read` body nor the generic `"not yet implemented"` string. So a
probe in that shape looks exactly like "the fix does nothing" while the real
conformance rows pass. Measure this one through the test262 runner, not a
bespoke probe.

## Still open in the same family

Bucketing the residue's explicit refusals turned up two more, each a distinct
mechanism rather than this one:

- **`<Boxed>.prototype.valueOf`** — now isolated and filed as **#4582**. It is
  not the harness: merely mentioning `Boolean.prototype` anywhere in the module
  switches a working `Object(true).valueOf()` onto the reflective `makeGlue`
  path, every member of which is a refusal stub for the boxed brands. A fix was
  attempted, measured to answer `false` instead of `true`, and **reverted** —
  see #4582 before retrying. 4 rows.
- **`Object.prototype.isPrototypeOf`** — 2 rows (`Object/create/15.2.3.5-3-1`,
  `-4-1`). A native `__isPrototypeOf` helper already exists and #4556
  deliberately left `Object` on it as "strictly more faithful", so this is a
  wiring gap rather than a missing algorithm.
