---
id: 4052
title: "`src/runtime.ts` internals are destructible by test262's own harness — `verifyProperty` deletes realm intrinsics and call-time method resolution breaks for the rest of the worker"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: n/a
goal: core-semantics
---
# `src/runtime.ts` internals are destructible by test262's own harness — `verifyProperty` deletes realm intrinsics and call-time method resolution breaks for the rest of the worker

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Found 2026-07-26 by `opus-loop-a` during the #3603 cohort census. It fixed its own module; the pre-existing exposure is untouched and unowned.**

## The mechanism

**`verifyProperty` is destructive by design.** Its `isConfigurable` check does `delete obj[name]` — so `verifyProperty(WeakMap.prototype, "get", …)` in `test/built-ins/WeakMap/prototype/get/get.js` **deletes `WeakMap.prototype.get` for the entire realm**. The host lane shares real host builtins across in-process runs, so anything in `src/runtime.ts` that resolves a method *at call time* breaks for every subsequent test in that worker.

**This is not theoretical — it caused a real corpus regression.** loop-a's mirror registry is a `WeakMap` probed on every host-call bridge, so it was the first thing to break, turning an unrelated **passing** test into a failure (`TypeError: _vecMirrorSource.get is not a function`).

## Fix pattern that works (already applied in `src/runtime/vec-mirror-writeback.ts`)

**Capture intrinsics at module load and invoke through the captured reference** — no property lookup on the prototype, and no lookup of `.call` on the method, at call time. loop-a captured `WeakMap.prototype.get/set` and `Reflect.apply`, and removed two more call-time dependencies: `Array.prototype.push` (→ index assignment) and `Math.min` (→ ternary).

## The remaining exposure — this task

`src/runtime.ts` has the same pattern in at least:
- **`_hostProxyCache`** (WeakMap)
- **`convertedArrays`** in `__make_iterable` (WeakMap)

Audit the whole file for call-time resolution of any deletable intrinsic — not just `WeakMap`. `Map`, `Set`, `Reflect`, `Array.prototype.*`, `Object.*` and `Math.*` are all reachable by `verifyProperty`.

**Scope honestly:** a compiled end-to-end program cannot survive intrinsic deletion regardless, so a broad end-to-end test will fail for defects this work does not own. Scope tests to each module's own contract, as loop-a did.

## Two traps when writing the test — both cost loop-a a cycle, both caught by controls not by reading

1. **Deleting the intrinsic *before* `compile()` fails inside the TypeScript compiler** (`Math.min is not a function` in `typescript.js`).
2. **Asserting while the intrinsic is missing fails inside vitest** (`globalThis[MATCHERS_OBJECT].get is not a function`) — **the assertion library has the same exposure as the code under test.**

Delete, exercise, restore, *then* assert.

## Verification standard
Prove the fix by **reverting it** and showing the same error family reappears — that is how loop-a confirmed its own (`_vecMirrorSource.set is not a function`). A green test here proves nothing without that control.

## Note
File the issue via `claim-issue.mjs --allocate`, then **hand-verify the id** against main, every open PR's file list, and all branches — the allocator has handed out taken ids (#3636).
