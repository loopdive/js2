---
id: 5345
title: "marked Hooks residual (9/30): an absent boolean on a spread-derived struct reads `false`, and `r[o]` answers null for the two hooks with a default parameter"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

marked's single admitted file, `test/unit/Hooks.test.js`, is **9/30** on clean
main `c9a8b48616` (0 at the start of this effort — #5292, #5293, #5315, #5320
each removed one wall). The #5315 agent bisected the remaining 21 into two
clusters and left them, both measured, neither fixed:

**Cluster A — 11 × `The async option was set to true by an extension`.**
marked checks `if (this.defaults.async === false && ext.async === true)
throw …`. `this.defaults` is built by `{ ...this.defaults, ...s }` (a
spread-derived struct, see #5315 defect 2). A boolean field that is **absent**
on the source object reads back `false` — a real `i32 0` — instead of
`undefined`. `undefined === false` is false in JS; `false === false` throws.
The struct slot has no "absent" state for an `i32`.

**Cluster B — 11 × `Cannot read properties of null (reading 'apply')`.**
`use()` installs hooks with `const a = r[o]; r[o] = c => a.call(r, c)`. For
the two hooks declared **with a default parameter** —
`provideLexer(e = this.block)` and `provideParser(e = this.blockParser)` —
`const a = r[o]` reads **`null`**; a fresh instance reads `preprocess` /
`postprocess` (no defaults) correctly through the same computed-key route. So
the computed-key member read of a class method that carries a default
parameter answers null.

## Acceptance criteria

1. `Hooks.test.js` ≥ 20/30 (either cluster fully fixed; both is the goal).
2. Regression tests, one per cluster, failing on parent, passing with fix,
   untyped `.js` two-file fixtures. Cluster A must pin `absent === undefined`
   on a spread-derived object **and** keep `false === false` on a field that
   is really `false` (anti-vacuity). Cluster B must pin a computed-key read
   of a default-param method returning a callable, plus a no-default method
   as control.
3. A/B at one HEAD, 17 suites, per test file — marked improves, nothing else
   moves (anchors in #5338).
4. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

**Cluster B first** — it is the sharper defect and likely smaller.

1. Reduce: `class H { pre(x) { return x; } withDefault(e = 1) { return e; } }
   const h = new H(); for (const o in {pre:0, withDefault:0}) { const a =
   h[o]; assert(typeof a === "function"); }`. Confirm `withDefault` reads
   null. Dump WAT: the computed-key read goes through `__get_member_<name>` /
   `member-get-dispatch.ts` (`classMethodCandidatesForProp`). A method with a
   default parameter has a **different lifted signature** (arity/optional
   sentinel), so `ctx.funcMap.get(classMemberFuncKey(...))` or the
   `methodFuncIdx` lookup likely misses and the arm is dropped. Fix the
   candidate enumeration to resolve default-param methods; do not special-case
   the two names.
2. **Cluster A**: this is the "absent vs false" representation problem. Read
   #5315 defect 2's fix in `literals.ts` `compileObjectLiteralForStruct`
   (spread sources) and how a struct field that the source lacks is
   initialised. Options, in order of preference: (a) when a spread source
   *may* lack a boolean/number field, type that field's slot `externref`
   (nullable) rather than `i32`/`f64` so absence is representable — the
   #2011/#4204 widening precedent in `moduleGlobalWasmType` /
   `heterogeneous-scalar-var-widening.ts` is the model; (b) if the slot must
   stay `i32`, the strict-equality lowering against a boolean literal must
   consult a presence flag. (a) is sound; (b) is a patch. Take (a) unless it
   moves the A/B.
3. Regression tests; A/B; **one PR per cluster**.

Out of scope, recorded in #5315: the standalone/WASI lane still lacks an
own-property predicate; virtual-dispatch call sites are unguarded pending
#5577.

## Dispatch

Model: **opus**. Cluster A is a representation decision with a real
blast-radius trade-off; Cluster B needs the closed-dispatch candidate
machinery read carefully.
