---
id: 4483
title: "ES5 standalone: built-ins/Function residual — call/apply arg semantics, bind carrier surface, __get_builtin CE (~30 tractable of 58 rows)"
status: done
completed: 2026-08-16
sprint: current
created: 2026-08-15
updated: 2026-08-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-methods
goal: standalone-gap
loc-budget-allow:
  # Both entries are CONSUMED by the shipped diff (`npm run check:loc-budget`
  # names each one and its delta); no entry is speculative.
  #   expressions/calls.ts  +32  three arms in the ONE `.call`/`.apply` /
  #                              call-expression dispatcher: the Function-ctor
  #                              reshape, the §20.2.3.1 argArray guard and the
  #                              §10.2.1 class-call guard. Each arm's BODY
  #                              lives in its own new module
  #                              (function-ctor-reflective-call.ts,
  #                              apply-arglist-typeerror.ts,
  #                              class-call-without-new.ts); what stays here is
  #                              the dispatch line plus the comment that says
  #                              why it sits at that exact position, which is
  #                              order-sensitive and cannot move out.
  #   property-access.ts    +10  one dispatch site for the primitive
  #                              absent-property arm, placed LAST before the
  #                              legacy tail so no existing arm loses its claim.
  - src/codegen/expressions/calls.ts
  - src/codegen/property-access.ts
func-budget-allow:
  # compileCallExpression +29: the three dispatch lines above, in the function
  # that IS the call dispatcher — a new call-shape decision has nowhere else to
  # be made, and the arms it calls are already extracted.
  # inlineUserFunctions +27 (crosses 300): the caller-poison strictness guard
  # must sit inside the per-call-site admission loop, next to the other
  # `declined(...)` reasons, because it is one more admission rule; hoisting it
  # out would need the loop's callee/caller pair passed to a helper for a
  # two-line comparison. The bulk of the +27 is the comment that records the
  # measurement and why the guard is free when no `.caller` is read.
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/ir-inline.ts::inlineUserFunctions
related: [4442, 4437, 4440, 4480, 4157, 1472]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. built-ins/Function = 58 ES≤5 standalone failures after the #4442 wave (+19); signatures split into apply/call TypeErrors (8), bind-carrier reads (4), null-length (3), __get_builtin CE (3), tail."
---

# #4483 — built-ins/Function residual families

## Problem

After #4442's `%Function%` carrier (+19), `built-ins/Function` still holds 58
ES≤5 standalone failures. Measured signatures:

- **A — apply/call argument semantics (8 rows)**: "Expected a TypeError" —
  §15.3.4.3/4 require TypeError when `argArray` is neither object nor
  array-like, and when the callee is not callable; also `arguments`-object
  pass-through rows.
- **B — bound-function surface (4 rows)**: `typeof obj.touched` — bind's
  carrier loses own-property writes / target surface.
- **C — `.length` of null (3 rows)**: `cannot read property 'length' of
  null` — a Function.prototype method value read answers null then dies
  (identity family; overlaps #4481 — coordinate, do not double-fix).
- **D — `__get_builtin` CE (3 rows)**: dynamic-shape object/property on a
  builtin — compile error where a decline was possible.
- **E — tail** (`this["feat"]` rows, constructor.length): assorted.

`fn.prototype`-dependent rows belong to #4480, not here.

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`);
   produce the per-family file list first.
2. Family A: the call/apply lowering (grep `"apply"`/`"call"` arms in
   `src/codegen/expressions/calls.ts`) — add the §15.3.4.3 step-2/3 guards
   with real TypeError instances (`buildThrowJsErrorInstrs`). Arity/spread
   semantics for `arguments` receivers exist in the #4436 work — read
   `function-expected-argument-count.ts` first.
3. Family D first among the rest (CE class beats wrong-answer class): find
   the `__get_builtin` emission site, make the unsupported shape DECLINE to
   a runtime miss instead of a compile error.
4. Family B: read the bind lowering; bound carriers are closures — the
   #4437 metadata pattern may carry the target/own-props surface.
5. Family C: coordinate with #4481 (identity singletons) — if #4481 lands
   first, C may already be fixed; re-measure before touching.
6. Controls: fn-family pins (4436/4437/4440/4442/4456/4460/4464); scoped
   sweep `built-ins/Function` before/after; byte-identity on modules not
   using apply/call/bind.

## Acceptance criteria

- ≥15 rows flip in `built-ins/Function`; zero regressions; families not
  taken recorded with owners.

## Re-verification (the issue's map vs. what is actually there)

The family map above was written off the lagging baseline. Re-measured live on
this branch's base with `runTest262File(…, "standalone")` over ALL 509 `.js`
files under `built-ins/Function` (3-way sharded, one process per shard):

| state | pass | fail | compile_error |
| ----- | ---- | ---- | ------------- |
| base  | 363  | 132  | 14            |

Three corrections that changed what was worth doing:

1. **Family D is 9 rows, not 3** — every `__get_builtin` CE in the directory is
   the SAME shape, `Function.call(thisArg, body)` (8 files) plus `JSON.bind()`
   (1). The other 5 CEs are a different refusal (#3371 `Reflect.construct`
   NewTarget, #1907 builtin static value read).
2. **Family C is not an identity bug and does not overlap #4481.** The three
   "cannot read property 'length' of null" rows are
   `Function("a1,a2,a3", …).call(null, arguments, "", 2)` — the `arguments`
   OBJECT arriving as null across the runtime-eval provider boundary. #4481's
   instance-proto singletons are unrelated; nothing here was double-fixed.
3. **Family B's `typeof obj.touched` rows are not bind at all.** They are
   §15.3.4.3 A5 (`ToObject(thisArg)` for a PRIMITIVE thisArg), and the actual
   defect is one level down and much wider than `bind`: an absent property of a
   `number`/`boolean` primitive answered `null` instead of `undefined`
   (`typeof null === "object"` is what the assertions see). The real
   bind-carrier gap (`.length`/`.name`) is measured and left as a residual.

Two of the four eval-tier families additionally required the local quickjs
provider artifact; without it 9 rows fail with a "provider is not built"
infrastructure error that is NOT a conformance signal. It is linked from
`.test262-cache/` — worth knowing before reading any local sweep.

## Root cause

Five independent defects, one per family. Each was measured on this branch's
base by the driver, not inherited from an artifact.

**R1 — `Function.call/apply` was a dynamic builtin member read.**
`Function` is a builtin VALUE, so `Function.call` went to the generic member
path → `env::__get_builtin` → the #1472 Phase A standalone COMPILE ERROR. The
identical program spelled `Function("…")` compiles and runs. Nothing about the
shape needs a host: §15.3.1 says the constructor's [[Call]] discards `this`, so
`Function.call(x, …args)` IS `Function(…args)`.

**R2 — absent property of a number/boolean primitive answered `null`.**
`(1).touched` fell through every arm to the legacy tail's `ref.null.extern`
placeholder. Measured, one module, six receivers
(`.tmp/probes/p6-missing-prop.js`): number `null`, boolean `null`, and string /
object / array / function all already `undefined`. So the hole was exactly the
two primitives with no string-like or object-like fast path of their own.

**R3 — the IR inliner merged activations of different strictness.**
The §15.3.5.4 caller marker is emitted per WASM FUNCTION body by
`finalizeFunctionPoisonPillCalls`, which runs *immediately after*
`inlineUserFunctions`. A strict callee inlined into a sloppy caller therefore
had its calls marked SLOPPY. Traced on `15.3.5.4_2-42gs`'s shape with the
pass's own debug view: `f` (strict) was registered and instrumented correctly
(`marker strict=true at call 2097226`) and then left DEAD, while the executed
copy — `__closure_42`, the sloppy `f1` — carried `marker strict=false at call
2097226`, i.e. the same callee handle, inlined. The sloppy self-`caller` read
then read 0 and did not throw.

**R4 — `Function.prototype.{call,apply,bind}` read as a VALUE was treated as
possibly-constructable.** `classifyNonConstructableValue` had an arm for
`f.call(x)` (a CALL, correctly only a "probe" — it returns an arbitrary value)
but none for `f.call` (the READ, which IS the intrinsic and has no
[[Construct]]).

**R5 — two missing spec throws.** `f.apply(thisArg, <primitive>)` skipped
§20.2.3.1 step 4 → CreateListFromArrayLike step 2; a `class` constructor called
without `new` skipped §10.2.1 [[Call]] step 2 and silently answered `null`.

## Fix

Four new modules + four dispatch sites; every arm DECLINES rather than guessing.

| file | what it does |
| ---- | ------------ |
| `src/codegen/function-ctor-reflective-call.ts` | R1 — AST reshape `Function.call/apply(thisArg, …)` → `Function(…)`, reusing the ORIGINAL `Function` identifier as the callee so downstream resolution sees what the source wrote. Declines for a user `Function` shadow and for a non-literal `.apply` argument list. |
| `src/codegen/primitive-absent-property.ts` | R2 — `undefined` for a provably-absent property of a `number`/`boolean` primitive. Declines for any wrapper-chain member, for a module that extends `Number`/`Boolean`/`Object.prototype`, and for write/delete targets. Dispatched LAST, immediately before the legacy tail, so no existing arm loses its claim. |
| `src/codegen/ir-inline.ts` (guard) | R3 — decline to inline across a strictness boundary, **only** when `ctx.callerStrictGlobalIdx >= 0` (i.e. some function really reads a legacy `caller`). A module that never observes `.caller` — every real program — keeps every inlining decision it had. |
| `src/codegen/expressions/non-constructable.ts` (arm) | R4 — the `.call`/`.apply`/`.bind` READ is `"provable"`, narrowed to a receiver the oracle types as `function` (or the `Function` builtin). |
| `src/codegen/apply-arglist-typeerror.ts` | R5a — §20.2.3.1 step 4 TypeError for a provably-primitive argArray. `null`/`undefined` deliberately do NOT throw (step 3). |
| `src/codegen/class-call-without-new.ts` | R5b — §10.2.1 step 2 TypeError. Declines for ambient (`.d.ts`) classes, which is how the callable builtins (`Number(1)`, `String(x)`) are modelled — that exclusion is the whole correctness story. |

All type queries go through `ctx.oracle`; `npm run check:oracle-ratchet` reports
`getTypeAtLocation +0, ctx.checker +0` across the 9 changed files.

## Test Results

See `## Sweep` below for the final before/after over the whole directory, and
`tests/issue-4483.test.ts` for the per-family pins (each positive pin has a
negative control, because every family's failure mode is over-application).

## Residuals — measured here, NOT fixed

| residual | rows | evidence | owner |
| -------- | ---- | -------- | ----- |
| Bound function has no `length` / `name` | `bind/instance-length-remaining-args`, `instance-length-prop-desc`, `instance-name{,-chained,-non-string}`, `instance-length-default-value` (~6) | `.tmp/probes/p12-bind-meta.js` on this branch: `bar.bind(null).length` is **NaN**, `bar.bind(null).name` is **undefined**; spec 2 / `"bound bar"`. The carrier (`$__bound_fn`) has target/thisArg/boundArgs/bag and no metadata fields. `it.fails` pins in `tests/issue-4483.test.ts`. | unclaimed — successor to #4483, family B |
| Eval-provider global bindings read wrong | `S15.3_A3_T3/T4/T5/T6`, `S15.3.2.1_A1_T10`, `S15.3.2.1_A3_T15` (6) | `S15.3_A3_T*` now COMPILE (was CE) and fail at `f()` returning `null` where a hoisted-but-unassigned global var must read `undefined`. NOT a boundary-marshalling bug: `.tmp/probes/p10-eval-undef.js` shows `undefined`/`null`/`42` all cross correctly. `.tmp/probes/p11-eval-global.js` shows the same read answering `0`/`NaN` in a differently-shaped module, so the value depends on the module's binding layout. | unclaimed — runtime-eval lane |
| `arguments` object arrives as null across the provider | `prototype/call/S15.3.4.4_A6_T5/T6/T9` (3) | "cannot read property 'length' of null" inside a `Function(…)` body handed `arguments` via `.call`. | unclaimed — runtime-eval lane |
| `Function(…)` product used as a mutable thisArg | `prototype/{apply,call}/S15.3.4.{3,4}_A5_T8` (2) | `obj = Function(); Function("this.touched=true").apply(obj)` leaves `obj.touched` unset — the provider's function object is not the same mutable object on both sides. | unclaimed — runtime-eval lane |
| `Function.prototype.toString` source text | `prototype/toString/*` (~25, 11 of them Proxy) | "Conforms to NativeFunction Syntax" — the whole cluster is out of this issue's families and is the largest remaining one in the directory. | unclaimed — needs its own issue |
| Realm / Proxy `__module_init` null-deref | 14 rows (`*-realm.js`, `Symbol.hasInstance/*`) | `$262.createRealm` / revoked-proxy shapes. | unclaimed — not ES≤5 |
| `Function.call/apply` in a plain ES-MODULE lane | 0 (no test262 row) | In `export function test(){ var f = Function.call(…) }` the shape is claimed by an earlier eval-boundary arm and yields a non-function. **Verified identical on base** by reverting `calls.ts` alone, so this change did not move it; the reshape only ever adds behaviour where base refused to compile. `runRunnerLike` in the pin file documents the seam. | unclaimed — runtime-eval lane |
