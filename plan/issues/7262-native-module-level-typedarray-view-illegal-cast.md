---
id: 7262
title: "Native default target: a module-level TypedArray/SharedArrayBuffer view traps with illegal cast in __module_init"
status: ready
sprint: Backlog
created: 2026-11-06
updated: 2026-11-06
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: typedarray
goal: correctness
parent: 6979
related: [5150, 3097, 6708]
---

# #7262 — module-level TypedArray view: `illegal cast` in `__module_init`

## Problem

On the default target (the native regime since S6, #6708) two test262 rows
trap instead of failing an assertion or passing:

| Row | Trap |
| --- | --- |
| `built-ins/Atomics/notify/null-bufferdata-throws.js` | `RuntimeError: illegal cast in __module_init()` at L31 |
| `built-ins/TypedArray/out-of-bounds-behaves-like-detached.js` | `RuntimeError: illegal cast in __module_init_chunk_0()` at L17 (`assert.sameValue(i8a[2], 10)`) |

Both declare their views at module level. #5150's 2026-09-02 notes describe
the same family on the old JS-host lane (a top-level `new Int32Array(buf)`
becoming a host TypedArray, and a downstream read casting it to the
checker-typed vec); on the native regime the cast still traps.

Measured on `upstream/main` `ed76cef7a0` and on the S7-d base `6a20eb9f18`,
identical, **with the QuickJS eval adapter built**. Without the adapter the
runner fails before the trap, which is why the S7-d run saw only the first row
and recorded the second as passing.

## Witnesses (`it.fails` against this issue, #6979 S7-f)

`tests/issue-5150-es2015-buffers.test.ts`: "host: …/Atomics/notify/
null-bufferdata-throws.js" and "host, no illegal cast: …/TypedArray/
out-of-bounds-behaves-like-detached.js".

## Acceptance

- Neither row traps on the default target; the Atomics row passes.
- Both witnesses pass as plain `it`.
