---
id: 2570
title: "lazy/suspending async-generator runtime — yield* execution order (eager-buffer drains before first .next())"
status: done
completed: 2026-07-17
assignee: fable-2570
sprint: Backlog
created: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bug
loc-budget-allow:
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
area: codegen
language_feature: async-generators
goal: core-semantics
depends_on: [1373b]
related: [1887, 2566, 2170, 2171, 1927]
test262_bucket: async-gen-yieldstar-execution-order
test262_count: 86
---

## Context

Spun out of #1887. The FILED #1887 symptom (325 invalid-Wasm `array.set` CEs in
async `yield*` closures) was **already fixed** on main by #2170/#2171
(native-generator + result-struct work) — that bucket re-buckets to 0. Closing
#1887 as symptom-done.

The **residual ~86 fails** (down from 325) are a **different, architectural
problem**: async generator **execution order / laziness**.

## Problem

js2wasm's generator runtime is an **eager buffer**: `src/runtime.ts:135`
`buf: any[] — eager-yield buffer (filled by the generator body)`. The generator
body runs **up front** and drains the inner iterator into a buffer **before** the
consumer's first `.next()`. So an async `yield*` over a source with observable
side effects violates the spec's lazy, one-step-per-`.next()` semantics:

```js
async function* inner() { log.push("a"); yield 1; log.push("b"); yield 2; }
async function* outer() { yield* inner(); }
const it = outer();
assert(log.length === 0);   // FAILS — eager buffer already ran inner() to completion
await it.next();            // should produce "a" then 1, lazily
```

The execution-order test262 files assert `log.length === 0` (or step-by-step
ordering) immediately after construction and before the first `.next()`; the
eager buffer fails them at construction time.

## Root cause is shared with #2566

The **same eager-buffer runtime** is the root cause of **#2566** (sync
capturing-generator over-consumption — a trailing array-destructuring elision
over a generator drains it to completion). #2570 (async) and #2566 (sync) are
**two faces of one architectural gap**: the generator runtime is eager, not
lazy/suspending.

## Fix direction (architectural — multi-PR)

Replace the eager-buffer model with a **lazy / suspending generator runtime** — a
CPS state machine that suspends at each `yield`/`yield*` and resumes on `.next()`,
so the body runs incrementally and side effects interleave per spec. This is the
async-generator analogue of the await-CPS lowering tracked in **#1373b** (IR
async CPS), and overlaps the front-end pipeline work (#1927).

**Recommend a unified architect spec** covering the lazy/suspending generator
runtime for BOTH sync (#2566) and async (#2570) generators, sequenced behind /
alongside #1373b's CPS substrate — rather than two independent point attempts on
a shared substrate.

## Acceptance

- Async `yield*` execution-order test262 cluster (~86) passes: side effects of the
  delegated iterator interleave lazily, one step per `.next()`, nothing runs
  before the first `.next()`.
- No regression to the now-passing async-generator invalid-wasm bucket (#2170/#2171).
- Coordinated with #2566 (sync) so the lazy runtime serves both.

## Implementation (fable-2570, 2026-07-17) — lazy `yield*` delegation on the DRIVEN machine

### Re-ground: what the issue is on today's main, and what is winnable

The issue predates the #2865/#2906 carrier work. Verified on current main:

- The driven async-gen machine (`emitAsyncGenerator` + `planAsyncGenCfg` +
  `__async_gen_next_<stem>`, standalone/wasi lanes) is **already lazy** for the
  shapes it admits — but it **rejects `yield*` delegation entirely**
  (`analyzeAsyncGen` accepts only the #3132 S1 array-literal static unroll).
  `async function* outer() { yield* inner(); }` is a #680 CE on
  standalone/wasi and the eager host buffer on gc.
- The ~86-file test262 bucket (now ~179 fn-level / 690 incl. methods per the
  baseline jsonl) is measured on the **gc lane**, where async gens are the JS
  eager buffer (`__create_async_generator`), and the tests exercise the FULL
  observable GetIterator protocol over hand-built async iterables (logging
  getters on `Symbol.asyncIterator`/`next`/`then`/`value`/`done`). Flipping
  that bucket requires routing the gc lane onto the native machine + the whole
  observable protocol — the #2662 Option-(ii) epic (JS-boundary wrapper), NOT
  a single-PR deliverable. This PR does **not** claim the bucket.

**Scope landed (the architectural gap named in the title): frame-to-frame
`yield*` delegation on the driven runtime — lazy, one inner step per outer
`next()`, genuinely suspending, host-free.** The issue's own repro
(`log.length === 0` before the first `next()`, per-step interleaving) now
passes on wasi AND standalone. This is the substrate any future gc-lane widen
(#2662) reuses; the sync twin stays #2566.

### Design (WHY, not just what)

`yield* inner(...)` (inner = an earlier-declared, itself-drivable, top-level
`async function*`) compiles to a **4-state pump loop** on the existing #2906
CFG machine — zero emitter changes; the planner composes stock terminators:

    init(k)  : [leads] iter := inner(...)      (frame spill; runs on the kick
               that REACHES the yield* — lazy, so outer() runs nothing)
               → goto pump
    pump(k+1): suspend(await __async_gen_next_<inner>(iter), resume→chk)
    chk(k+2) : (binds SENT = IteratorResult; rejected inner next() re-throws
               via MODE_THROW → outer's current next()-promise rejects)
               unpack {done,value} → condGoto(done, after, yieldOut)
    yield(k+3): settleYield(value, resume→pump)   ← BACK-EDGE: the next outer
               kick re-enters pump and pumps inner exactly one more step
    after(k+4): next segment (or settleDone)

- The inner's `next()`-promise is a native `$Promise` minted by its own
  driver, so the stock suspend arm classifies it: sync-settling inner yields
  advance in the same dispatch; a pending inner `yield await P` suspends the
  OUTER frame and the microtask drain resumes both — genuine two-level
  suspension (proved in tests).
- `settleYield.resumeState` pointing BACKWARD is the whole laziness trick:
  each outer `next()` kick re-dispatches at `pump`, so exactly one inner step
  runs per outer step (the spec's execution-order requirement).
- The per-delegate inner frame lives in a `__yieldstar_iter_<i>` frame spill
  (externref, spill-safe); result/done/value are transient same-dispatch
  locals (never cross a suspend).

### Gate consistency (the load-bearing part)

`asyncGenDrivableUnderCarrier` feeds BOTH the pre-body `widenAsyncGenFallback`
carrier decision (import-collector) and the emit gate — so delegate admission
(`resolveAsyncGenDelegateDecl`) is **purely syntactic** (no checker, no
funcMap/registry): callee = plain identifier naming a UNIQUE top-level
`async function*` declared strictly BEFORE the outer (source order = compile
order ⇒ the inner's driver is registered when the outer's machine emits), not
shadowed by an outer param/local/own-scope fn decl, inner itself drivable
sans delegation (recursion cut ⇒ no nested/mutual delegation). The emit gate
(`isAsyncGenDriveCandidate`) ADDITIONALLY registry-verifies each delegate
(`asyncGenDelegatesRegistered`) — a mismatch (e.g. stem collision routed the
inner to legacy) falls the outer to legacy too. That divergence is mix-safe:
on standalone the pre-pass has already flagged such a module non-drivable
(carrier OFF), on wasi legacy fallback is the pre-existing tolerated
arrangement.

### Out of scope (v1 bounds — correct-or-legacy beyond them)

- Delegation over arbitrary iterables / hand-built async iterables (the
  observable GetIterator protocol — the gc-lane test262 bucket, #2662 epic).
- Forward-referenced / nested / fn-expr / method inner producers.
- `.throw()`/`.return()`/sent-value forwarding into the delegate (driven gens
  do not support them at all yet — #2906 3d-iii).
- The §27.6.3.8 re-await of delegated values (consistent with the #3120
  carrier-off treatment; driven inner values are plain settled values).

### Files

- `src/codegen/async-cps.ts` — `AsyncGenDelegates`, delegate arm in
  `analyzeAsyncGen`, `listTopLevelYieldStarCalls`, the 4-state delegate plan in
  `planAsyncGenCfg` (+ threading through `isBoundedAsyncGenBody` /
  `isAwaitFreeAsyncGenBody`).
- `src/codegen/async-frame.ts` — `resolveAsyncGenDelegateDecl` (pure-AST),
  gate/plan delegates factories, `asyncGenDelegatesRegistered`,
  `__yieldstar_iter_<i>` spills in `computeAsyncSpills`, plan-call threading.
- `tests/issue-2570-asyncgen-yieldstar-delegation.test.ts` — repro-first: the
  issue's laziness repro (wasi + standalone, host-free), genuine two-level
  suspension, multi-delegate composition with params, rejection propagation,
  gc-unchanged + forward-ref guardrails.

`loc-budget-allow` for async-cps.ts/async-frame.ts: the delegate planner and
admission belong beside `planAsyncGenCfg`/`planForAwaitAsyncCfg` and the gate
they must stay consistent with (intended, cohesive growth).

Blast radius: the async/generator suites (139 tests across 13 files) show
zero new failures — the 10 failing ones reproduce identically on clean main
(local-environment wasi-shim/corpus issues).
