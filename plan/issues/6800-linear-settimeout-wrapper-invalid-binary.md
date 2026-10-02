---
id: 6800
title: "linear backend: the injected `setTimeout` wrapper passes an f64 delay to the i32 `__timer_set_timeout` helper — invalid binary"
status: ready
sprint: Backlog
created: 2026-10-01
updated: 2026-10-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: timers
goal: crash-free
related: [6776, 6778, 6793]
requested_by: ttraenkler/claude-dev-6776
origin: "found by #6776's validate-by-default gate"
---

# #6800 — linear `setTimeout` wrapper emits an engine-invalid binary

## Problem

Any linear-target program that calls the bare `setTimeout` compiles to a
binary the engine rejects:

```ts
// compile(src, { target: "linear" })
setTimeout(() => {}, 1);
```

Engine message (V8, Node 22.22, measured 2026-10-01; the function index and
byte offset vary with the program):

```
WebAssembly.Module(): Compiling function #51:"setTimeout" failed:
call[1] expected type i32, found local.get of type f64 @+4205
```

It does not matter whether `JS2WASM_LINEAR_IR` is `1`, `0` or unset. With
`0`, only the function number and offset change (`#50`, `@+4182`).

Before #6776 this compiled to `success: true` with no diagnostics, so the bug
was invisible until instantiate time. Since #6776 the compile fails with
`code: "invalid-module"`.

## Evidence

The WAT for the wrapper (`compile(…, { target: "linear", validate: false })`):

```wat
(func $__timer_set_timeout (param i32 i32) (result i32) …)   ;; #50
(func $setTimeout (param i32 f64) (result f64)                ;; #51
    local.get 0
    local.get 1        ;; f64 delay passed to an i32 parameter
    call 50
    return             ;; i32 result returned as f64
    unreachable
  )
```

The wrapper is the #1501 timer shim that `buildTimerShim` in
`src/import-resolver.ts` injects as TypeScript:

```ts
declare function __timer_set_timeout(cb: any, ms: any): any;
function setTimeout(cb: () => void, ms: number): number { return __timer_set_timeout(cb, ms); }
```

The linear backend lowers the `any`-typed host declaration to
`(i32, i32) -> i32` and the wrapper's `number`s to f64. The call site then
inserts no conversion in either direction: f64 → i32 on the argument, i32 →
f64 on the result. `setInterval` almost certainly has the same shape;
`clearTimeout` / `clearInterval` take `h: number` into an `any` parameter and
should be checked too.

## Reproduction

- **Test:** `tests/linear-number-to-string.test.ts`, the case "keeps
  compiler-injected timer wrappers outside linear attempt-root telemetry".
  It compiles with `validate: false` only because it asserts telemetry. It
  also asserts `validateEmittedBinary(result.binary).valid === false`, so
  fixing this issue makes that test fail. When it does, delete both the opt-out
  and the inverted assertion.
- **Probe:** the two-line program above, then
  `validateEmittedBinary(result.binary)` or `new WebAssembly.Module(bytes)`.

## Acceptance

- `compile("setTimeout(() => {}, 1);", { target: "linear" })` returns
  `success: true` and the binary validates.
- The same holds for `setInterval`, `clearTimeout` and `clearInterval`.
- `tests/linear-number-to-string.test.ts` drops its `validate: false` opt-out
  and its `valid === false` assertion.
