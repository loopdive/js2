---
id: 4054
title: "PARKED — detached builtins: the `__extern_get` fix is a measured no-op and reaches ≤382 tests, not 1,038"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: n/a
goal: standalone-mode
---
# PARKED — detached builtins: the `__extern_get` fix is a measured no-op and reaches ≤382 tests, not 1,038

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**PARKED and downgraded 2026-07-26. The hypothesis was reasonable, the fix site is wrong, and the reach was overstated by an order of magnitude.**

## Why parked

**1. The fix as built is a measured no-op.** `opus-loop-e` completed the `__extern_get` hook and ran the suite: **4 failed / 12 passed — byte-identical to the merge base.** A no-op means the hook is never reached for that read, so the fix site is evidently wrong. Committed as WIP (`b1b986e5c`, typechecks clean) with the no-op recorded **in the commit message** so nobody mistakes it for working.

**2. Deliberately NOT pushed.** The LOC ratchet blocks it (`src/runtime.ts` 15352 > 15228, +124) and **no `loc-budget-allow` was granted** — buying permanent budget for a change that demonstrably does nothing would be backwards. Correct call.

**3. The reach was overstated.** Of **5,067** tests calling `verifyProperty`, only **382** pass `{restore:true}` — the *only* path reaching the detached `__defineProperty`. So this cell is reachable in **at most 382** tests, and only when they also hit the sidecar condition. **Not 1,038.** The "unifies #3647 + #3661" claim does not survive.

**4. Superseded.** Task **#35** (property slot monomorphism) is what actually gates the corpus — it runs in essentially every `verifyProperty` call that asserts `writable`, on plain assignment, with no sidecar or detached read involved.

## ⚠️ Do NOT land the red tests yet — unresolved contradiction

Branch `issue-3667-detached-builtin-statics` carries 4 red arms + 12 guards. **Hold them.**

- **loop-g** measures detached **read** as *working* (only detached **write** broken).
- **loop-e** measures detached **read** returning `undefined` in isolated compiles.

Both had controls. One is wrong, or the environments differ materially. **A regression test asserting something a peer measures as working is worse than no test** — settle this first.

## What survives and is still worth something

The mechanism analysis is sound as far as it goes: `__get_builtin` is `(n) => globalThis[n]`, so a detached read returns the **raw host function**, while the direct call lowers to the sidecar-aware import (`runtime.ts:10137/198`, `_isWasmStruct(o) ? _readOwnDescriptor(o,k) : <host gOPD>`). That still plausibly explains the ≤382 subset — it is simply **not the corpus gate**.

The identity/per-key memoization guards are also worth keeping whenever this is revisited: a single shared memo cell would make `Object.keys === Object.getOwnPropertyDescriptor` — identity "correct", semantics wrong, and it would pass a naive identity test.

## If resumed
Find why the hook is never reached for the failing read before writing more code. A no-op is evidence about the *dispatch path*, and that evidence has not been followed up.
