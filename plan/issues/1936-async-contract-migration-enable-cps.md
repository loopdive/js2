---
id: 1936
title: "Async contract migration — teach call sites to drive Promises, then enable the built-but-disabled CPS lowering"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: async-await
goal: conformance
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
