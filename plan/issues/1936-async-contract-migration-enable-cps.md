---
id: 1936
title: "Async contract migration — teach call sites to drive Promises, then enable the built-but-disabled CPS lowering"
status: done
assignee: ttraenkler/se1
completed: 2026-06-16
sprint: 62
created: 2026-06-10
updated: 2026-06-16
priority: top
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: async-await
goal: conformance
note: "2026-06-15: elevated to TOP priority by stakeholder (Proxy/Promise/async-to-100% epic). Census/architect spec (started in s62) → impl in s63. Precedes #1796 CPS flip."
---
# #1936 — Async contract migration (enable CPS)

## Problem

The sound async lowering exists and is switched off. `src/codegen/async-cps.ts`
splits bodies at awaits, computes live-local capture sets
(`analyzeAsyncBody`), and chains continuations via `Promise.then` — but
`ASYNC_CPS_ENABLED = false` (`async-cps.ts:60`), with the reason documented
at `async-cps.ts:38-58`: legacy call sites consume async results
**synchronously** (`asyncFn() as any as number` returns an unwrapped value).
The gate is per-definition but the contract is per-call-site, so a global
flip can't preserve both.

Consequences: shipped async semantics are spec-wrong by design (async
functions don't return Promises synchronously); the CPS path bit-rots; and
the standalone scheduler (`async-scheduler.ts` — clean native `$Promise` +
microtask queue, drained after `_start`) is underused. This is the single
biggest semantic landmine in the runtime layer and a major test262 bucket.

## Proposed approach

Architect spec first (this is the review's #1 architect-level item):

1. **Call-site census**: classify every consumer of an async call result
   (await in async context / `.then` / synchronous consumption) over the
   playground + tests corpora; the sync-consumption set is the migration
   surface.
2. **Compile-time await-elision** for the statically-resolvable chains
   (fits the "compile away" principle): where an async function's awaited
   values are all synchronously-resolved (no real suspension), compile it as
   a sync function returning a resolved `$Promise` — this preserves most
   current sync-consumption behavior *soundly*.
3. Per-module (or per-function-strongly-connected-component) flip:
   `ASYNC_CPS_ENABLED` becomes a per-function decision driven by the census,
   ratcheted like IR adoption.
4. Wire the standalone scheduler as the CPS path's substrate in
   standalone/WASI mode; js-host mode uses host Promises.
5. Track conformance: built-ins/promise and async-function test262 buckets
   are the oracle.

## Acceptance criteria

- `asyncFn()` returns a then-able in both modes (spec shape).
- No equivalence regressions in the sync-consumption corpus (elision covers
  them, or they're flagged as deliberate breaks with migration notes).
- `ASYNC_CPS_ENABLED` constant removed in favor of the per-function decision.

## Source

Compiler quality review 2026-06. Related: #1373 (IR async adoption — align
so IR adopts the CPS form, not the legacy form), async-scheduler phases.
Needs `/architect-spec`.

## Implementation Plan

### Root cause

The compiler ships two incompatible async return contracts and resolves the
conflict per-definition while the conflict is actually per-call-site:

- **Definition side** — an async function is lowered *synchronously*: its wasm
  body returns the unwrapped `T`, not a `Promise`. The async-return rewrite is in
  `src/codegen/declarations.ts` (`unwrapPromiseType` at 173, 2332, 2774, 2917
  strips `Promise<T>` so the registered result type is `T`).
- **Call site** — `compileExpressionInner` (`src/codegen/expressions.ts:1118`,
  `isAsyncCallExpression` def at 154) decides per-consumer whether to wrap the raw
  `T` in a real Promise via `wrapAsyncReturn` (287) or to elide the wrap
  (`asyncResultConsumedAsValue`, 252). `await` and non-Promise casts take the
  raw-value path; `.then`/`Promise.all`/typed-Promise bindings take the wrap path.

The sound CPS state machine (`src/codegen/async-cps.ts`) is fully built but inert
behind `ASYNC_CPS_ENABLED = false` (`async-cps.ts:59`) — flipping it globally makes
every async fn return a Promise (externref) which synchronous-consumption sites
unbox as `Number(Promise) === NaN` (async-cps.ts:46-57). This issue is the
census + elision spec that makes a per-function flip safe; #1796 does the flip.

### Deliverable = SPEC + per-function decision scaffold (NOT the global flip)

1. the call-site census classifier, 2. the compile-time await-elision rule,
3. the `ASYNC_CPS_ENABLED`-replacing predicate `asyncFnNeedsCps`.

### Changes

- `src/codegen/async-cps.ts`: add `asyncFnNeedsCps(ctx, fn): boolean` — true only
  when the fn genuinely suspends: `analyzeAsyncBody().awaitPoints.length >= 1`,
  at least one awaited expr is not statically resolved, and `splitBodyAtAwait`
  succeeds. Keep `ASYNC_CPS_ENABLED` as a transitional kill-switch routed through
  the predicate (final removal is #1796).
- `analyzeAsyncBody`: add `awaitedStaticallyResolved` map. An await is statically
  resolved when its operand is a literal/arithmetic over literals, a call to a
  transitively-resolved async fn (worklist over the SCC), or `Promise.resolve(<static>)`.
- `src/codegen/expressions.ts`: `asyncResultConsumedAsValue` (252) becomes a
  3-state census classifier `classifyAsyncConsumer` → `{value|thenable|await}`.
  Compile-time await-elision: when `asyncFnNeedsCps` is false (all awaits static),
  compile the callee as a sync fn that returns a resolved thenable (force
  `wrapAsyncReturn`, no raw-value elision) — spec shape without CPS cost.

### Census deliverable
Add `scripts/async-call-census.mjs` (mirrors `check:ir-fallbacks`): walk
`playground/examples/**` + `tests/**/*async*.ts`, bucket every async-callee
consumer (await / thenable / value). The `value`-bucket-not-statically-resolved
set is exactly what #1796 must migrate.

### CPS lowering (already built; this spec only re-gates it)
`emitAsyncStateMachine` (async-cps.ts:164): prefix runs sync → `Promise_resolve`
of awaited (await V == PromiseResolve §27.7.5.3) → build captures struct →
`__make_callback` → `Promise_then2` (chained promise is the fn result) → return.
**Standalone substrate**: when `isStandalonePromiseActive` (async-scheduler.ts:1258),
use native `$Promise` + microtask queue (`emitStandalonePromiseResolve`/`Then`
at 1089/1132), continuation via `__microtask_enqueue` drained after `_start`.
This is the #1326→#1326c→#1373b engine — reference, don't re-spec.

### Edge cases
await in loops/branches → `splitBodyAtAwait` returns null → stay on legacy sync
path with a migration diagnostic, NOT silent mis-lowering (census bucket
`cps-unsupported-shape`); try/catch across await → legacy fallback (#1373c);
`return await P` → handled (async-cps.ts:248); async throw → uncaught throw in
prefix must `Promise.reject` (§27.7.5.2 step 4); nested async arrow/method → each
gets its own decision.

### Test-gate plan
`tests/async-census.test.ts` (classifier buckets a fixed corpus); `tests/issue-1042.test.ts`
skipIf block becomes the per-function regression suite; test262
`built-ins/Promise/**`, `language/expressions/await/**`,
`language/statements/async-function/**`. Net async delta ≥ 0 (net-neutral; #1796
banks gains).

### Spec citations
await V = PromiseResolve(%Promise%,V) §27.7.5.3/§27.7.5.1; async-fn rejection on
sync throw §27.7.5.2 step 4 / §27.7.5.4.

## Implementation Notes (se1, 2026-06-16, sprint 62)

Shipped the **scaffold + census** deliverable (NOT the global flip — that is
#1796). Net-neutral by construction: the gate stays off, the call-site dispatch
is a behaviour-preserving refactor.

### What landed

1. **`awaitIsStaticallyResolved(operand)`** (`src/codegen/async-cps.ts`) — pure,
   conservative predicate for settled-at-compile-time await operands (literals,
   arithmetic-over-literals, unary, `void`, `Promise.resolve(<static>)` /
   `Promise.resolve()`). Anything else (call result, member read, bare
   identifier) is `false` so the safe path is chosen. Per §27.7.5.3 `await V`
   carries `V` unchanged when `V` is not a thenable, which is what makes these
   awaits elision-safe.

2. **`AsyncCpsPlan.awaitedStaticallyResolved`** map, populated in
   `analyzeAsyncBody` per await point. Drives the per-function decision.

3. **`asyncFnNeedsCps(fn, plan)`** — the `ASYNC_CPS_ENABLED`-replacing per-fn
   predicate: true only when (a) ≥1 await, (b) ≥1 await is NOT statically
   resolved (a genuine suspension; fully-static bodies are await-elidable →
   sync + fulfilled Promise), and (c) `splitBodyAtAwait` accepts the shape.
   `ASYNC_CPS_ENABLED` is retained as a transitional master kill-switch routed
   through the predicate — while it is `false` the predicate is always `false`,
   so behaviour is byte-identical to today. #1796 removes the constant.

4. **`classifyAsyncConsumer(checker, expr)` → `"await" | "value" | "thenable"`**
   — the 3-state census classifier (the per-call-site half). The shipped
   `asyncResultConsumedAsValue` in `expressions.ts:252` now delegates to it
   (`!== "thenable"` is exactly the legacy boolean), making async-cps.ts the
   single source of truth. `tests/async-census.test.ts` pins the parity so a
   future refactor can't silently diverge the two. **No live dispatch change** —
   the `value`/`thenable` split is recorded but not yet acted on; #1796 changes
   how `value` is lowered.

5. **`scripts/async-call-census.mjs`** (`pnpm run census:async`) — mirrors
   `check:ir-fallbacks`; walks `website/playground/examples/**` +
   `tests/**/*async*.ts`. Buckets consumers (await/value/thenable) and async
   function definitions (no-await / await-elidable / cps-able / cps-unsupported).
   Current corpus snapshot: 35 await, 0 value, 1 thenable consumers; 37 cps-able,
   6 cps-unsupported definitions. The `value`-consumed set is the #1796
   migration surface; `cps-unsupported` is the legacy-fallback diagnostic bucket.

### Validation

- `tests/async-census.test.ts` — 13/13 pass (predicate, classifier, gate-off
  parity).
- `tests/issue-1042.test.ts`, `tests/async-await.test.ts` — unchanged, pass
  (behaviour-neutral refactor confirmed).
- `pnpm exec tsc --noEmit` — clean.
- `biome lint` on changed files — clean.
- Pre-existing, unrelated to this change: 2 `promise-combinators.test.ts`
  failures (`Promise.race` host `_toIterable` returns undefined — reproduces on
  clean main) and `async-function.test.ts` failing to load a missing
  `tests/helpers.js` (missing fixture on main).

### Acceptance-criteria status

The issue's top-level ACs ("`asyncFn()` returns a thenable in both modes",
"`ASYNC_CPS_ENABLED` removed") are the **#1796** end-state, not this scaffold
issue's deliverable (the Implementation Plan scopes this to "SPEC + per-function
decision scaffold (NOT the global flip)"). This PR delivers exactly items 1–3 of
that scaffold + the census tool. #1796 consumes them to perform the flip and
satisfy the top-level ACs.
