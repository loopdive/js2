---
id: 1483
title: "wasi: route Date.now and performance.now to clock_time_get"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: Date, performance
goal: wasi-completeness
sprint: 52
related: []
---
## Problem

`Date.now()` is lowered to a `__date_now` env-import in
`src/codegen/expressions/calls.ts:3523` regardless of target. Under
`--target wasi`, the resulting module asks wasmtime for an `env`
function it does not provide, so the module fails to instantiate
(or instantiates only because the user added a custom polyfill).
The standalone-mode promise from `CLAUDE.md` — *"new features should
have Wasm-native implementations for standalone mode"* — is violated.

The same gap exists implicitly for `performance.now()` /
`new Date().getTime()` (which all reach a single host shim) and for
anything that derives a timestamp.

## Current behavior

- `Date.now()` → `call $__date_now` in module's `env` import. wasmtime
  does **not** populate that name; instantiation fails with
  `unknown import: env::__date_now`.
- `grep -rn "clock_time_get" src/` → no hits. The WASI clock API is
  entirely absent.

## Expected behavior

When `ctx.wasi` is true:

1. Register `wasi_snapshot_preview1::clock_time_get(clockid, precision, out_ptr) -> errno`.
2. Compile `Date.now()` to a call that:
   - Invokes `clock_time_get(CLOCK_REALTIME=0, precision=1_000_000, out)`,
   - Loads the i64 nanoseconds at `out`,
   - Converts to f64 milliseconds (`ns / 1_000_000`).
3. Compile `performance.now()` similarly but with
   `CLOCK_MONOTONIC=1` and return f64 milliseconds since some
   arbitrary epoch.

`wasmtime app.wasm` running `console.log(Date.now())` should print
roughly the current Unix epoch in milliseconds.

## Implementation plan

1. **Add context fields.** `src/codegen/context/types.ts`:
   `wasiClockTimeGetIdx?: number`.

2. **Detect + register.** In `src/codegen/index.ts:3036`
   (`registerWasiImports`) walk the AST for `Date.now`,
   `performance.now`, or `new Date()` (which calls `Date.now` under
   the hood). When found, register:
   ```ts
   const t = addFuncType(ctx,
     [{ kind: "i32" }, { kind: "i64" }, { kind: "i32" }],
     [{ kind: "i32" }], "$wasi_clock_time_get");
   addImport(ctx, "wasi_snapshot_preview1", "clock_time_get",
     { kind: "func", typeIdx: t });
   ctx.wasiClockTimeGetIdx = ctx.funcMap.get("clock_time_get")!;
   ```

3. **Emit helper.** `__wasi_date_now() -> f64`:
   ```
   i32.const 0          ;; CLOCK_REALTIME
   i64.const 1000000    ;; precision = 1 ms
   i32.const 16         ;; scratch out_ptr (memory[16..23])
   call clock_time_get
   drop                 ;; errno
   i32.const 16
   i64.load
   f64.convert_i64_u
   f64.const 1000000
   f64.div              ;; ns → ms
   ```
   Reserve memory offsets 16..23 in the scratch region (the existing
   `__wasi_write_string` helper uses 0..15; expand the reserved zone
   to 32 bytes — still under the 1024-byte scratch budget).

4. **Re-route Date.now in calls.ts.** At
   `src/codegen/expressions/calls.ts:3522`, when `ctx.wasi` is true,
   call `__wasi_date_now` instead of `ensureLateImport("__date_now")`.
   Same treatment for the `new Date()`-without-args path in
   `src/codegen/expressions/new-super.ts:1610`.

5. **performance.now.** Add a similar `__wasi_performance_now`
   helper that uses `CLOCK_MONOTONIC` (clockid=1). Wire it where
   `performance.now()` resolves (currently routed through the
   `env::performance_now` import — find the registration site under
   `compiler/import-manifest.ts` or `runtime.ts`).

6. **JS polyfill.** Extend `buildWasiPolyfill` in
   `src/runtime.ts:4870` to implement `clock_time_get` from
   `Date.now() * 1e6` and `performance.now() * 1e6`. Without this,
   the vitest equivalence tests can't exercise the WASI path
   in-process.

## Acceptance criteria

- `wasmtime app.wasm` with body `console.log(Date.now())` prints a
  positive number within 10 seconds of host `date +%s%3N`.
- A `--target wasi` module with `Date.now()` instantiates in wasmtime
  with **no** `env::__date_now` import requested.
- `performance.now()` returns monotonically non-decreasing values
  across consecutive calls.
- New equivalence test compares JS-mode vs WASI-mode timestamps
  for roughly-equal output (allow ±100ms drift).

## Files to modify

- `src/codegen/context/types.ts` — add `wasiClockTimeGetIdx`.
- `src/codegen/index.ts` ~3036 — detect & register clock_time_get,
  emit `__wasi_date_now` + `__wasi_performance_now` helpers.
- `src/codegen/expressions/calls.ts` ~3519 — branch on `ctx.wasi`
  for `Date.now`.
- `src/codegen/expressions/new-super.ts` ~1610 — branch on `ctx.wasi`
  for `new Date()`.
- `src/runtime.ts` ~4870 — polyfill `clock_time_get`.
- New: `tests/wasi-clock.test.ts`.
