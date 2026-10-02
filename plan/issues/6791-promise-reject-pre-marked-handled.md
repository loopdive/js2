---
id: 6791
title: "runtime: every compiled `Promise.reject(x)` is pre-marked handled (`p.catch(() => {})`) — dropped rejections never reach `unhandledRejection`"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-01
completed: 2026-10-01
assignee: "ttraenkler/claude-dev-6791"
branch: "claude/issue-6791-promise-reject-unhandled"
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
# 2026-10-01: +1 line — the host-lane `for await` array drive marks each element
# handled (emitForAwaitMarkHandled), replacing the runtime-wide Promise.reject
# pre-mark. loops.ts is net -4 overall.
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForOfArray
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

## Implementation Plan

What the #2978 no-op catch actually protected: not a compiler-created
promise, but the **user's** `Promise.reject(...)` elements that a `for await`
**sync drive** binds without awaiting (an async fn whose only suspension is the
`for await` compiles as a sync body; the #2978 step cap then drops ~100k
rejected elements). Natively the loop's Await reacts to every element, so the
marking belongs on the drive, per element, on the host-promise lane only.

1. `src/runtime.ts` `Promise_reject` → bare `PROMISE_INTRINSICS.reject(val)`.
   New host import `__forawait_mark_handled` → `markPromiseHandled(v,
   globalSandbox?.Promise)` (`src/runtime/promise-intrinsics.ts`): for a host- or
   sandbox-realm promise, run `try { await v } catch {}` in a detached async fn —
   the native Await's PromiseResolve + PerformPromiseThen (one `constructor`
   read, no species lookup, no overridable `.catch`) — and return `v` unchanged.
2. `src/codegen/statements/for-await-helpers.ts`: `ensureForAwaitMarkHandled`
   registers the import (late import, called first thing in
   `compileForOfStatement`, before any driver captures a function index);
   `emitForAwaitMarkHandled` emits the pass-through call on an externref element;
   `emitForAwaitStackElement` folds the direct drive's carrier-Await block and the
   host mark; `initForAwaitStepCap` dedups the two step-counter inits. All gated on
   `stmt.awaitModifier && !standalone && !wasi && !isStandalonePromiseActive` —
   the native `$Promise` carrier awaits elements itself, standalone/WASI emit no
   new import.
3. `src/codegen/statements/loops.ts`: mark the element in all three sync drives
   — direct struct-iterator (`compileForOfDirectIterator`), host `__iterator`
   (`compileForOfIterator`) and the array drive (`compileForOfArray`, which
   also dropped `[Promise.reject(x)]` elements).
4. Other internal `Promise_reject` users (`wrapAsyncCallInTryCatch`,
   `async-closure-promise.ts`) produce the async call's own result promise —
   natively unhandled when dropped — so they stay bare.

## Resolution

Probes (`node --unhandled-rejections=strict`, JS-host lane, exit code /
`run()` result; native Node in brackets):

| shape | before | after |
| --- | --- | --- |
| `Promise.reject(new Error("x"))` dropped | **0** / 1 [1] | **1** / 1 |
| for-await, async iter `next()` rejects, try/catch (+`await 0`) | 0 / 1 | 0 / 1 [0 / 1] |
| same via caller `try { await drive() }` | 0 / 1 | 0 / 1 |
| #2978 sync iter of rejected elements (step-capped) | 0 / 11 | 0 / 11 |
| struct iterator, 3 rejected elements | 0 / 0 | 0 / 0 [0 / 1] |
| array `[Promise.reject(x)]` | 0 / 0 | 0 / 0 [0 / 1] |

Runtime change alone (no drive marks) makes the last three rows exit 1 — that
is what the drive marks prevent. The struct/array result `0` vs native `1` is
the pre-existing sync-drive gap (#2978/#2895), unchanged.

- Test: `tests/issue-6791-promise-reject-unhandled.test.ts` (5 child-process
  cases). On base: case 1 fails; with only the runtime change: cases 4–5 fail.
- Equivalence/promise suites (single fork): `equivalence/{async-iteration,
  ir-slice10-promise,for-await-of}`, `issue-{2906-3b,2906-3c,2906-3di,2903,
  2903-finally,2980,3228,3387,3587,4167,2671,5197,6492-r5,6492-r20,1347b,1465,
  1510,2038}` all green. `issue-2978-forawait-rejected` (1 fail, #3587 compile
  refusal) and `issue-2906-3dii-asyncgen-consumer` (5 fails, WASI `_start`
  adapter) fail identically on base. Re-run of 5 of them under
  `NODE_OPTIONS=--unhandled-rejections=strict`: 50/50, exit 0.
- test262 (local honest lane, CI-worker-style unhandledRejection suppressor,
  `scripts/run-test262-paths.mts`): `built-ins/Promise/reject` 14 pass / 1 fail
  before and after, same row. Every async-flagged file under
  `built-ins/Promise`, `for-await-of`, `AsyncFromSyncIteratorPrototype`,
  async-function/arrow, `expressions/await` (1,728 rows): 1203 / 515 / 10 CE
  before and after, identical non-pass sets. (Measured with the inline
  pre-refactor form of the mark — same semantics as `markPromiseHandled`.)
- Gates: loc/func/coercion/oracle/dead-exports (local and `LOC_GATE_BASE` =
  origin/main), typecheck, format:check, lint, compiler-boundaries inventory,
  the 17-gate quality loop, `check:ir-fallbacks`, `test:guard` (255/255) — all
  exit 0. One `func-budget-allow` (`compileForOfArray` +1); loops.ts net −4,
  runtime.ts net −10 (the 20-line helper lives in `promise-intrinsics.ts`).
- Not done: standalone/WASI unchanged by design (no new import there; their
  carrier already awaits elements).
