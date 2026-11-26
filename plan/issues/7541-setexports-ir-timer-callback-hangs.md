---
id: 7541
title: "An embedder that binds with `setExports` hangs silently when an IR timer callback fires"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
goal: core-semantics
related: [7533]
---

# #7541: `setExports` plus an IR timer callback is a silent hang

## Problem

Found while planning #7533 (lane S25, main `1a726b3e`, 2026-11-26).

- The IR timer callback is dispatched through the branded authority in
  `src/runtime/standalone-timer-callback-bridge.ts` `readAuthority`. Only `setInstance` establishes that authority.
- An embedder that binds with `setExports` (the older API, still used by many tests) gets no authority.
- An IR build has no `__call_fn_method_0` export for the generic fallback.
- So the callback never runs, the native promise stays pending, and nothing reports an error.

## Acceptance criteria

- With `setExports` only, the timer callback either runs or the runtime throws a clear error naming `setInstance`. It
  must never hang silently.
- A test covers both binding styles for a `setTimeout` callback compiled by the IR.
