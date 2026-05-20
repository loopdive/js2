---
id: 1484
sprint: 52
title: "wasi: provide standalone setTimeout/setInterval via poll_oneoff (or fail loud)"
status: ready
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, runtime
language_feature: timers, async
goal: wasi-completeness
related: []
---

## Problem

Under `--target wasi`, `setTimeout` / `setInterval` / `setImmediate`
have no implementation. The async scheduler in
`src/codegen/async-scheduler.ts` and the call sites that emit
`setTimeout` lookups produce a module that depends on JS host
imports (`env::setTimeout`, `env::setInterval`) which wasmtime does
not supply. The module then fails to instantiate.

The user-facing failure modes are:

1. **Silent no-op** — when import resolution masks the missing
   function, the timer never fires and the program hangs or exits
   without running the callback.
2. **Unknown-import error** — wasmtime refuses to instantiate.
3. **Confusing CE output** — currently no compile-time diagnostic
   tells the user "timers are not supported in WASI mode".

Without timer support, every Promise-based or `await sleep(n)`-style
program is broken in standalone mode.

## Current behavior

- `grep -rn "setTimeout\|setInterval" src/codegen/` returns no hits —
  the codegen has no special-case path; timer references are routed
  through the generic extern-call machinery into the `env` module.
- `src/codegen/async-scheduler.ts` orchestrates the JS-host async
  state machine but has no WASI branch.
- No compile-time error fires when a `--target wasi` build contains
  `setTimeout`. Compare with the DOM-vs-WASI diagnostic in
  `src/codegen/index.ts:7157-7189` which IS plumbed for DOM globals.

## Expected behavior

Pick **one** of the following, in order of preference:

### Preferred: Wasm-native timer via `poll_oneoff`

- Register `wasi_snapshot_preview1::poll_oneoff(in, out, nsubs, nevents_out)`.
- Emit a `__wasi_sleep_ms(ms)` helper that constructs a single
  `subscription_t` of type `CLOCK` with timeout=`ms * 1_000_000` ns
  and awaits it. Synchronous; blocks the wasm thread, matching
  wasmtime's single-threaded execution model.
- For `setTimeout(cb, ms)`: in a WASI-only single-tasked world,
  treat the call as `await __wasi_sleep_ms(ms); cb();` — wire it
  into the async scheduler so that the scheduler's main loop is
  driven by sequential sleeps rather than JS event-loop ticks.
- `setInterval(cb, ms)` becomes a loop on top of `__wasi_sleep_ms`.

### Fallback: Compile-time diagnostic

If full async-scheduler integration is too much for one issue, at
minimum emit a compile-time error mirroring the DOM-rejection path
in `src/codegen/index.ts:7157`. Message:

> setTimeout/setInterval are not yet supported under `--target wasi`.
> Use a synchronous loop or split the work into discrete `_start`
> invocations.

This prevents silent runtime hangs and gives users a clear path
forward.

## Implementation plan

1. **Detection.** In `src/codegen/index.ts` (sibling of
   `registerWasiImports` and `rejectDomUnderWasi` at line 7157),
   walk the source for `setTimeout`, `setInterval`, `setImmediate`,
   `queueMicrotask`, and `requestAnimationFrame`. Track each.

2. **MVP (fallback path).** Emit a TypeScript-level diagnostic
   (call site + message). Use the same emit path as the DOM
   rejection. Land this first so the silent-hang failure mode is
   eliminated.

3. **Full path (poll_oneoff).** Add helper emission:
   ```
   ;; subscription struct (48 bytes):
   ;;   userdata (8)
   ;;   tag       (1)   = EVENTTYPE_CLOCK (0)
   ;;   pad (7)
   ;;   clockid (4)     = CLOCK_MONOTONIC (1)
   ;;   timeout (8)     = ms * 1_000_000
   ;;   precision (8)   = 0
   ;;   flags (2)       = 0  (relative)
   ;;   pad (6)
   ```
   Reserve a fixed 48-byte slot in the bump scratch (extend the
   reserved zone from 32 to 80 bytes; still well under 1024).
   Allocate an 8-byte `nevents` out-pointer and a 32-byte event
   out-buffer adjacent to the subscription. Call
   `poll_oneoff(subPtr, eventPtr, 1, nEventsPtr)`, drop the result.

4. **Async scheduler hook.** In `src/codegen/async-scheduler.ts`,
   gate on `ctx.wasi`: when emitting an `await` whose right-hand side
   is a `setTimeout`-derived promise, lower directly to a call to
   `__wasi_sleep_ms(ms)` followed by the continuation. Skip the
   state-machine emission entirely for that node. (Multiple
   in-flight timers are out of scope for v1 — single-tasked WASI.)

5. **JS polyfill.** Extend `buildWasiPolyfill` in
   `src/runtime.ts:4870` with `poll_oneoff` that uses
   `setTimeout` under the hood. This lets vitest tests exercise the
   path without leaving Node.

## Acceptance criteria

- **MVP**: `--target wasi` source containing `setTimeout` produces a
  compile error with a clear, actionable message — no silent hang,
  no `unknown import: env::setTimeout` from wasmtime.
- **Full**: `wasmtime app.wasm` running
  `setTimeout(() => console.log("done"), 100)` prints `done` after
  ~100ms and exits cleanly.
- `setInterval` likewise produces periodic output.
- New equivalence test under `tests/wasi-timers.test.ts` (skipped
  until the full path lands; flips to active in the follow-up).

## Files to modify

- `src/codegen/index.ts` ~7157 — add `rejectTimersUnderWasi` (MVP)
  next to `rejectDomUnderWasi`, and the `poll_oneoff` registration
  in `registerWasiImports` (full path).
- `src/codegen/async-scheduler.ts` — branch on `ctx.wasi` for the
  await-of-timer lowering.
- `src/codegen/context/types.ts` — add `wasiPollOneoffIdx`.
- `src/runtime.ts` ~4870 — `poll_oneoff` polyfill.
- New: `tests/wasi-timers.test.ts`.

## Notes

This issue is intentionally split into two milestones inside one
file: ship the MVP diagnostic first to stop the silent failure,
then iterate the full `poll_oneoff` implementation. A reviewer may
prefer to split this into 1484a / 1484b after the MVP lands.
