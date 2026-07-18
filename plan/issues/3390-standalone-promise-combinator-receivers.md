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
# intentional +119 in calls.ts: slice-1 receiver classifier
# (isStaticNonConstructorReceiver) + the synchronous native-TypeError emitter
# (tryEmitStandaloneCombinatorCallTypeError) + its NON_CONSTRUCTOR_GLOBALS set,
# wired as an early pre-check in the .call block.
loc-budget-allow:
  - src/codegen/expressions/calls.ts
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

## Design decisions + measurement (fable-dev-3, 2026-07-18) — LIVE

### Measure-first result (standalone runner lane, current main)

Ran the full `built-ins/Promise/{all,allSettled,race,any,prototype}` corpus
(396 files) through `runTest262File(..., "standalone")`:
**pass=130, host_import_leak=121, fail=145, skip=0.** The 121 leaks (matches
the ~119 estimate) bucket by shape family:

| bucket                                                  | files | slice |
| ------------------------------------------------------- | ----: | ----- |
| resolve/reject-element-function-\* (element props)      |    25 | 3     |
| invoke-resolve-\* (per-iter `Promise.resolve` lookup)   |    18 | 3     |
| capability-\* (NewPromiseCapability protocol)           |    15 | 3     |
| call-resolve/reject-\* (custom ctor receiver)           |     8 | 3     |
| resolve-throws-iterator-return-\*                       |     8 | 3     |
| same/new-resolve/reject-function                        |     7 | 3     |
| resolve-before-loop-exit                                |     6 | 3     |
| \*-from-same-thenable                                   |     6 | 3     |
| iter-arg-is-string-\* (direct form, string iterable)    |     5 | (sep) |
| ctx-ctor-throws (constructor throws)                    |     4 | 3     |
| ctx-ctor (custom constructor receiver)                  |     4 | 3     |
| **ctx-non-ctor (non-constructor receiver → TypeError)** |     4 | **1** |
| **ctx-non-object (undefined/null/primitive recv)**      |     4 | **1** |
| species-get-error                                       |     4 | 3     |
| other                                                   |     3 | —     |

**Correction to the spec's "resolve-element-function already host-free"
note (#3380 baseline lag):** the LIVE probe shows all 25 still leak — they
use `Promise.all.call(NotPromise, [thenable])` (a custom constructor
receiver), so they are genuine slice-3 residuals, NOT stale.

### Scope of THIS PR — Slice 1 only (non-ctor / non-object receiver → TypeError)

Slice 1 is the clean, spec-endorsed, zero-regression win that fits the
medium horizon and the Fable-window deadline. Slices 2/3 are deferred
(slice 3 = the species/NewPromiseCapability machinery = genuinely XL:
dynamic constructor invocation + per-iteration `Promise.resolve` lookup +
element-function objects with correct props; the spec says build only if
justified — the 54-file bucket is real but hard).

**Target files:** `ctx-non-ctor` (4) + `ctx-non-object` (4) = 8 files across
all/allSettled/race/any. Shapes:
`Promise.all.call(eval, …)` (callable non-constructor),
`Promise.all.call(undefined|null|86|'string', [])` (non-object).
Both must throw TypeError SYNCHRONOUSLY (§27.2.4.1 step 2 IsConstructor,
BEFORE touching the iterable).

**Anchor + approach:**

- `src/codegen/expressions/calls.ts`, the `.call`/`.apply` block at ~5909
  (`propAccess.name.text === "call"`). Add an early pre-check
  `tryEmitStandaloneCombinatorCallTypeError(ctx, fctx, expr, propAccess)`
  BEFORE the generic reshape.
- Gate: `isStandalonePromiseActive(ctx)` (standalone/wasi only → host lane
  byte-identical) AND `propAccess.expression` is `Promise.{all,allSettled,
race,any}` (PropertyAccess whose `.expression` is the `Promise`
  identifier and `.name` ∈ the four combinators).
- Receiver = `expr.arguments[0]` (unwrap as/paren/nonnull). Static
  non-constructor verdict, SIDE-EFFECT-FREE receivers only (else fall
  through to host — correct-or-legacy):
  - missing arg / `undefined` / `null` keyword or identifier,
  - numeric / string / boolean literal, object literal, arrow function,
  - identifier resolving to a known non-constructor global (`eval`,
    `parseInt`, …) or an arrow-bound `const`/`var`.
    A CONSTRUCTOR (class/function decl, `Promise`, subclass, custom ctor
    identifier, or any unresolvable/dynamic receiver) → fall through.
- Emit (synchronous native throw — the class-to-primitive.ts:190-216
  pattern): `emitWasiErrorConstructor(ctx, "TypeError", 1)`;
  `ensureExnTag(ctx)`; `addStringConstantGlobal(msg)`; then
  `stringConstantExternrefInstrs(ctx, msg)` + `call __new_TypeError` +
  `{ op: "throw", tagIdx }`. Do NOT compile the iterable arg (no iteration).
  Result type is `never`-ish → return an externref `ref.null.extern` after
  the throw is unreachable, matching the surrounding block's contract.

**Ordering caveat (spec edge case):** receiver is evaluated before the
IsConstructor check, but for the side-effect-free receivers slice 1 admits
there is nothing to evaluate — so emitting the throw directly is correct.
Poisoned-iterable order tests belong to slice 3.

### Done-vs-remaining checklist

- [x] Slice 1 helper `tryEmitStandaloneCombinatorCallTypeError` +
      `isStaticNonConstructorReceiver` + `NON_CONSTRUCTOR_GLOBALS` in
      calls.ts, wired as an early pre-check in the `.call` block. Emits the
      synchronous `__exn`-tag TypeError (class-to-primitive.ts pattern);
      does NOT compile the iterable.
- [x] `tests/issue-3390.test.ts` — 21 cases: synchronous TypeError for
      undefined/null/primitive/Symbol()/eval/arrow/empty-object/no-arg
      receivers on all 4 combinators; iterable NOT touched (poison-getter
      probe); host (gc) lane unchanged; direct form + real subclass ctor +
      global `Promise` receiver all fall through (correct-or-legacy). PASS.
- [x] Corpus re-probe (built-ins/Promise/{all,allSettled,race,any,prototype},
      396 files): **pass 130 → 138 (+8), leak 121 → 113 (−8), fail 145
      unchanged.** The 8 flips are exactly ctx-non-ctor (4) + ctx-non-object
      (4); ZERO regressions.
- [x] Blast-radius suites green: promise-combinators, #2867/#2867-gap4,
      #3137, #2918, #2623-subclass-identity, #2671-capability (68 tests).
- [x] Gates: tsc 0 err, prettier clean, oracle-ratchet +0 checker usage
      (pure-AST classifier — no `getTypeAtLocation`), loc-budget allow-listed
      (+119).
- [ ] RESIDUAL (follow-up issue, recorded below): slice 2 (`Promise`
      receiver `.call` → native combinator) + slice 3 (custom-ctor/species
      machinery, ~54 files: element-function 25, invoke-resolve 18,
      capability 15, ctx-ctor(+throws) 8, …) + the iter-arg-is-string
      direct-form string-iterable gap (5). To be filed under umbrella #3178.

## Slice-1 completion note (fable-dev-3, 2026-07-18) — DONE

Slice 1 landed: `Promise.{all,allSettled,race,any}.call(recv, …)` with a
statically non-constructor, side-effect-free receiver now throws a native
TypeError on the standalone/wasi lane (§27.2.4.1 IsConstructor, before
iteration) instead of leaking `Promise_<method>` host imports. +8 host-free
passes, zero regressions. The remaining 113 `built-ins/Promise` leaks are the
custom-constructor / species / NewPromiseCapability families (slice 3, an XL
lift the spec defers) plus the direct-form string-iterable gap (5) — left as
honest `host_import_leak` residuals for a follow-up under #3178.
