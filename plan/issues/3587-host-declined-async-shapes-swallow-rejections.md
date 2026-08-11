---
id: 3587
title: "Host lane: async shapes the host-drive engine declines (try/catch across await, non-linear bodies) silently SWALLOW awaited rejections — execution continues past the await"
status: done
completed: 2026-07-25
assignee: ttraenkler/fable-3587
sprint: 77
created: 2026-07-25
updated: 2026-07-30
priority: critical
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: async, promises
goal: async-model
related: [1042, 1796, 2906, 2967, 1373b, 3545, 4302]
origin: "2026-07-25 Fable substrate/async review (plan/agent-context/fable-substrate-async-review-2026-07-24.md), probes a5b/a5c/a5d"
loc-budget-allow:
  - src/codegen/async-frame.ts
  - src/codegen/closures.ts
func-budget-allow:
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
  - src/codegen/closures.ts::compileArrowAsClosure
---

# Declined async shapes swallow rejections on the default (gc host) lane

## Problem (verified on main 7652f0337, DEFAULT gc host lane)

When `asyncFnNeedsHostDrive` (src/codegen/async-frame.ts:197) declines an
async function — e.g. because `planLinearAwaits` rejects try/catch across an
await — the function falls to the **legacy synchronous pass-through**, where an
awaited REJECTION does not throw: execution **continues past the `await` as if
it fulfilled**, catch blocks never run, `.catch` handlers never run, and the
rejected host promise leaks as an unhandledRejection.

```ts
export async function test(): Promise<number> {
  try {
    await Promise.reject(7);
    return -1; // must not reach
  } catch (e) {
    return e as number; // expect 7
  }
}
// node: 7 · gc host: -1 (reached the must-not-reach line) · SILENT
```

Wider probe (a5c) — all four rejection shapes swallowed in one declined body:

```ts
await p; // p = Promise.reject(1) — continues, no throw
await rejector(); // async fn returning Promise.reject — continues
await Promise.reject(5).catch(handler); // handler NEVER runs
await new Promise((_res, rej) => rej(9)); // continues + leaks unhandledRejection "9"
// node: 9531 · gc host: 7000000 (all three must-not-reach arms hit)
```

## Control (the engine-claimed shape is correct)

Same rejection, no try/catch in the async fn (single-await linear shape →
host-drive engine claims it): correct.

```ts
async function f(): Promise<number> {
  await Promise.reject(7);
  return -1;
}
export async function test(): Promise<number> {
  let out = 0;
  await f().then(
    (_v: number) => {
      out = 100;
    },
    (e: number) => {
      out = e;
    },
  );
  return out; // node AND gc host: 7 ✓  (probe a5d)
}
```

Synchronous `throw` inside a declined async fn DOES propagate (probe a5:
first arm caught 42) — only promise-carried rejections are lost.

## Why this is the worst kind of boundary

The decline predicate is invisible to the user. Adding a `try/catch` around an
`await` — the very construct that signals "I care about this rejection" — is
what flips the function onto the lane that **cannot deliver rejections**. Same
syntax, silently different error semantics, on the DEFAULT lane.

This is a known architectural residue (#1796 scope note: only linear shapes
got the CPS/host-drive model; #2906 is generalizing the machine for
standalone), but no open issue owned the HOST-lane consequence, and none
documented that the declined population swallows rejections rather than
merely being "sync-timed". test262's async harness (`$DONE`) under-detects
this because harness bodies are often engine-claimed shapes.

## Direction

Either (a) extend `planLinearAwaits`/host-drive to claim try/catch-across-await
(the #2906 Gap-3 skeleton, host settle backend), or (b) make the legacy sync
pass-through LOUD for bodies containing an await inside try/catch or any
rejection-observing construct (compile error / diagnostic), so the silent
lane cannot host rejection-sensitive code. (b) is a cheap stopgap that converts
a silent miscompile into a refusal.

## Acceptance

- Probe a5b returns 7 on gc host; a5c returns 9531; no leaked
  unhandledRejection.
- A regression test for rejection delivery through try/catch, `.catch`, and
  the two-callback `.then` on both engine-claimed and previously-declined
  shapes.

## Implementation Notes (2026-07-25, fable-3587)

**Both directions (a) and (b) landed** — direction (a) turned out to be nearly
free, because the machinery already existed and was only _gated off_:

1. **Claim (a): host lane drives try/catch-across-await.** The #2906 3c CFG
   machine (catch regions as states, `catchState` routing, the routed
   dispatcher `block{loop{try{chain}catch{route}}}`) is backend-agnostic by
   construction — rejection delivery rides the reject step adapter
   (ERROR_FIELD + MODE_THROW), the resume prelude re-throw, and the route,
   none of which touch the settle backend. It was disabled on host purely as
   incremental scoping (`allowTryCatch: !info.host`, "same rationale as
   allowLoops"). Changes:
   - `asyncFnNeedsHostDrive` (async-frame.ts): on a null linear plan, admit
     `computeTryCatchSpills` shapes (same spill-safe rule as the native lane) —
     predicate and producer stay in lockstep;
   - `ensureAsyncResumeFunction`: `allowTryCatch: true` on both lanes
     (`allowLoops` / `allowReturnInTry` remain native-only — loops on host are
     "correct but need their own corpus check", per the #2906 note);
   - **`catch_all` parity (new)**: the legacy try/catch lowering catches
     FOREIGN JS exceptions (a host import throwing, e.g. TypeError from a
     property op / JSON.parse) via `catch_all` + `__get_caught_exception`. The
     routed dispatcher on host now carries the same arm (route body
     `structuredClone`d — never alias one Instr[] into two branches), so a
     sync host throw inside a driven try keeps legacy semantics. The import is
     pre-registered BEFORE any state body is built — registering late would
     shift defined-func indices baked into detached instr arrays the shift
     walker cannot reach (finalizer bodies ride plain local arrays until final
     assembly).

2. **Refuse loudly (b): the residual cannot silently mis-execute.**
   `reportDeclinedAsyncRejectionHazard` (async-activation.ts) fires a
   source-located compile error when a declined async
   declaration/arrow/fn-expr (i) genuinely suspends (statically-resolved
   awaits cannot reject) and (ii) has a suspension point lexically inside a
   `try` block. Hooked at `maybeActivateAsync`, the closure activation path
   (closures.ts), AND `asyncEngineWouldActivate` — the last one matters
   because the IR C-1 selector claims exactly the engine-declined population
   and compiles `await` as the same rejection-swallowing sync pass-through;
   the guard fires on the selector probe, so neither downstream lane can
   silently proceed. Deduped per declaration (WeakSet keyed by ctx).

**Blast radius measured before choosing error severity** (compile-only sweep
of all 139 test262 files containing `await`+`try`): 119 now compile clean
(claimed), 15 CE for unrelated pre-existing reasons, and exactly **5 trip the
loud refusal — all 5 already `fail` in the baseline** (3×
`try-reject-finally-reject` = await-in-finally, genuinely undrivable; 2×
dynamic-import for-await agen). Zero pass→CE flips.

### Remaining silently-wrong async surface (honest residue)

- **Async METHODS (class + object-literal)**: the engine cannot claim them at
  ANY shape yet (#2957 phase-3 residue), so the loud refusal deliberately
  excludes them — a guard there would refuse the whole population, not a
  residue. Awaited rejections in async methods are still silently swallowed.
- **Declined shapes with no `try`** (await in a plain `while`, await nested in
  expressions/`if`): still silently sync-executed; a rejection leaks as
  unhandledRejection and execution continues. Claiming loops on host
  (`allowLoops`) is the natural next slice — the machine handles them, they
  need a corpus check.
- Async fn-exprs passed directly as call arguments were probe-verified to
  route through the closure activation path and get claimed (probe c: 17 ✓);
  a host-API callback position that routes via `compileArrowAsCallback`
  specifically was not exhaustively audited.
- **Refactor follow-up (not this PR)**: `ensureAsyncResumeFunction` is now
  ~1,119 lines; splitting the state-arm builder / dispatcher assembly into
  helpers is worth doing, but it is a real refactor with its own regression
  risk (detached-array shift discipline, br-depth accounting) and must be a
  dedicated byte-diff-checked PR.
- **Claimed linear host shapes** keep the pre-3c non-routed dispatcher, which
  has no `catch_all` arm — a sync host JS exception in a lead escapes the
  machine and strands the result promise pending (pre-existing, unchanged; the
  routed/try-catch population does have the arm).

## Test Results

- `tests/issue-3587-async-rejection-delivery.test.ts` — 14/14: a5b (7), a5c
  (9531, no leak), claimed control, await-in-catch, rethrow-rejects,
  catch+finally ordering, nested, catch_all host-throw parity, `.catch`
  handler, sibling groups, unhandled-rejection-rejects-result, async arrow
  claim, loud-refusal CE, no-refusal-for-static-awaits.
- Scoped suites green: async-await, issue-1042(-host-drive), issue-2967,
  issue-2906-{3c,multiawait,gap3}, async-census, issue-2957, issue-2174,
  issue-2635, issue-2856, equivalence async-function / async-iteration /
  for-await-of / promise-chains / scope-and-error-handling / try-catch-\*.

## Residual package frontier (2026-08-09)

The loud refusal added here is now reached by the published Prettier and Axios
entries and, after explicitly enabling its required filesystem capability, by
Stylelint. That is the intended safe behavior for shapes this completed issue
did not claim. The additional CFG work, exact measurements, and suspended
handoff are tracked in #4302; this issue remains done and its refusal must not
be weakened to make those packages appear to compile.
