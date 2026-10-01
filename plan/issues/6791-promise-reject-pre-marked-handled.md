---
id: 6791
title: "runtime: every compiled `Promise.reject(x)` is pre-marked handled (`p.catch(() => {})`) — dropped rejections never reach `unhandledRejection`"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: runtime
language_feature: promises
goal: async-model
related: [5235, 1312, 1151, 5883]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H8"
---

# #6791 — the builtin swallows the rejection signal for all callers

## Problem

`src/runtime.ts:17549-17551`:

```ts
const p = PROMISE_INTRINSICS.reject(val);
p.catch(() => {});
return p;
```

Every `Promise.reject(err)` a compiled program creates is already "handled"
from the host's point of view. A rejection the program then drops is silent:
Node's `unhandledRejection` never fires, `--unhandled-rejections=strict` never
exits, and test harnesses that rely on it (see #5235, where the changed-root
gate masks the same signal) see green. The identical JS run natively reports
it.

The no-op catch was added for the for-await drive path (#2978) where an
internally created rejected promise is always consumed.

## Correction

Move the `catch(() => {})` to the internal creation site that needed it
(the for-await / async-iterator drive helper), and leave the user-visible
`Promise.reject` builtin returning the bare rejected promise. If other
internal sites construct rejected promises they always consume, mark those
individually.

## Acceptance

- A compiled program that calls `Promise.reject(new Error("x"))` and drops
  it triggers `process.on("unhandledRejection")` in a Node test (run in a
  child process with `--unhandled-rejections=strict`, assert exit code 1).
- for-await over an async iterator that throws still reports exactly one
  rejection at the awaiting site (no new unhandled rejections in the
  equivalence suite; run the gate with `--unhandled-rejections=strict` once
  and report).
- test262 `built-ins/Promise/reject` rows unchanged.
