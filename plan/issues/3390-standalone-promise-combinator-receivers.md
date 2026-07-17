---
id: 3390
title: "standalone: Promise combinators with non-Promise receivers — `Promise.all.call(nonCtor)` TypeError + custom-constructor admission (~119 rows)"
status: ready
sprint: current
created: 2026-07-17
updated: 2026-07-17
priority: medium
horizon: m
feasibility: medium
model: opus
reasoning_effort: high
task_type: feature
area: codegen, standalone
language_feature: promises
goal: standalone-mode
umbrella: 3178
related: [2903, 2867, 2919, 2922, 3137]
origin: "2026-07-17 fable-3178 umbrella decomposition — the Promise built-ins residual of the standalone host_import_leak baseline (S5/S6 leftover after #2903 closed)."
---

# #3390 — Promise combinator receiver admission

## Problem

119 official-scope `host_import_leak` rows under `built-ins/Promise/`
(measured 2026-07-17): allSettled 35, all/any 29 each, race 19, prototype 7.
Combos: `Promise_allSettled,__js_array_new,__js_array_push` (22),
`Promise_all,__js_array_new,__js_array_push` (15), bare `Promise_all` (5), etc.
File families: `ctx-non-ctor`, `ctx-ctor[-throws]`, `species-get-error`,
`invoke-resolve-on-{values,promises}-*`, `resolve-from-same-thenable`,
`call-resolve-*`, `resolve-element-function-*` variants.

Probe (2026-07-17, current main): `Promise.all.call(F, [])` with a
non-constructor `F` leaks `env::Promise_all`. Direct
`Promise.all([...])` / `.race` / `.allSettled` / `.any` are native and
host-free (#2867/#2919/#2922/#3137) — the gap is exactly the RECEIVER-generic
`.call` path.

## Root cause

`emitStandalonePromiseCombinator` (`src/codegen/promise-combinators.ts:799`)
serves the direct `Promise.<method>(iter)` form. The `.call(receiver, iter)`
form routes through the host-import fallback in
`src/codegen/expressions/calls.ts` — a partial scanner already exists there
(~lines 2402–2550: "does a non-Promise constructor flow to
`Promise.{all,allSettled,race,any}.call(Constructor, …)`" + the comment at
~2550 noting `Promise.all.call(MyPromise, iter)` then throws on the host
shim). The native path never admits `.call` receivers, so every `ctx-*` /
species test leaks.

## Implementation Plan

Measure-first: many `resolve-element-function-*` rows are already host-free on
current main (probe confirmed one; the promoted baseline lags — #3380).
Re-probe the 119 files and split actual-residual vs stale before slicing.

### Slice 1 — provably-non-constructor receiver → native TypeError (cheap)

Per §27.2.4.1 step 2 (NewPromiseCapability → IsConstructor check), a
non-constructor receiver must throw TypeError BEFORE touching the iterable.
In `calls.ts`, at the `Promise.<combinator>.call(recv, …)` site: when the
static verdict on `recv` is "not a constructor" (arrow fn, plain object,
primitive, undefined — reuse the existing scanner's classification at
~2439–2462), emit the native TypeError throw (the same `__exn`-tag TypeError
pattern `emitStandalonePromiseCombinatorRuntime` uses for non-iterable args —
see calls.ts:7821 comment) instead of the `Promise_<method>` host import.
This covers the `ctx-non-ctor` / `ctx-ctor-throws`-adjacent families.
Note: evaluation ORDER — the receiver check precedes iterable evaluation;
arguments still need their side effects evaluated per spec order (receiver is
already evaluated by then; the iterable must NOT be iterated).

### Slice 2 — `Promise`-receiver `.call` → route to the native combinator

`Promise.all.call(Promise, iter)` is semantically the direct form: when the
receiver is provably the global `Promise` identifier, route into
`emitStandalonePromiseCombinator` (same arg lowering via
`resolveExternrefVecArg`, promise-combinators.ts:896). Covers the
`call-resolve-*` files that use the plain receiver.

### Slice 3 — custom-constructor receivers (species machinery) — MEASURE FIRST

The `invoke-resolve-on-*` / `species-get-error` / subclass families need the
real NewPromiseCapability protocol: call `recv` as a constructor with an
executor, look up `recv.resolve` per iteration, count invocations. This is a
substantially bigger lift (dynamic constructor invocation + per-iteration
`resolve` lookup on an arbitrary object). Only build it if the re-probe shows
the row count justifies it; otherwise leave those rows as honest
`host_import_leak` CEs and record the residual in umbrella #3178. A middle
path: admit receivers that are STATICALLY `class X extends Promise` with no
own `resolve`/`Symbol.species` override — the capability then degenerates to
the native `$Promise` path with the subclass prototype (check what the
object-runtime prototype machinery supports before promising this).

## Edge cases

- `Promise.all.call()` (no receiver) → undefined receiver → TypeError.
- Receiver constructor that THROWS when invoked (`ctx-ctor-throws`) → only
  covered by slice 3; keep leak/legacy meanwhile.
- Do not regress the direct-form native combinators: the `.call` dispatch must
  not intercept the plain `Promise.all(iter)` route.
- `Promise.resolve.call` / `Promise.reject.call` are NOT combinators — out of
  scope (different family; note if the re-probe shows rows there).

## Test plan

- Executed probes: TypeError identity + message-class for slice 1 shapes;
  value/order parity for slice 2 vs direct form.
- Construct-sample the 4 combinator dirs; equivalence suite
  `tests/issue-3390.test.ts`.
- Host lane byte-identical (the `.call` scanner change must gate on
  standalone/wasi).

## Regression risks

- The existing calls.ts scanner (~2402–2550) feeds OTHER decisions (host-shim
  admission); read its consumers before repurposing its classification.
- TypeError-before-iteration ordering is observable (poisoned iterables) —
  the corpus tests it; get the order right in slice 1.
