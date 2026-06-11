---
id: 2028
title: "new Promise(executor): invoking the host-provided resolve/reject from wasm traps null deref — executor pattern fully broken in JS-host mode"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: host-interop
language_feature: promises
goal: core-semantics
related: [1950, 1382, 1042, 1326]
origin: "2026-06-10 spec-conformance sweep (async agent): verified on main"
---

# #2028 — host functions flowing INTO wasm as callable params have no bridge

## Problem

```ts
return new Promise<string>((resolve) => { resolve("ok"); });
// wasm: RuntimeError: dereferencing a null pointer at __cb_0
//       (thrown synchronously during new Promise)
// node: promise resolving "ok"
```

Reject path identical — `.catch` receives the RuntimeError, not the
intended reason. Every executor probe (sync resolve, resolve-twice,
reject-after-resolve, via .then, throw-in-executor) hits the same trap.

## Root cause

`src/codegen/expressions/new-super.ts:1748` bridges the executor closure
to the host `Promise_new` import (`src/runtime.ts:7954`, wrapped via
`callback_maker` at `src/runtime.ts:8904`). Inside the lifted callback the
host JS functions `resolve`/`reject` arrive as plain externref, but the
call site compiles them through the WasmGC closure-struct path
(`src/codegen/expressions/calls-closures.ts:568` ref.test/ref.cast +
`struct.get` + `call_ref`) — the cast fails → null → trap.
Host-function-as-callable-param is the inverse of #1382 (wasm closure →
JS-callable) and the same trap mechanism as #1950 (different direction).

## Fix direction

In the closure call path, when the callee value is externref (or the cast
fails), fall back to a host `__call_extern_fn(fn, args)` import instead of
trapping. That bridge also unblocks other host-function-param patterns.

## Acceptance criteria

- Repro resolves "ok"; reject path delivers the reason to .catch
- resolve-twice / reject-after-resolve ignored per §27.2.1.3
- Wasm-closure params unchanged

## Dupe check

#1382 (done) opposite direction; #1950 (ready) wasm closures stored via
push/Map.set. No issue covers host functions as params. New.

## Note for #1042

The async agent also confirmed #1042's scope: `await` on real host
promises never unwraps (NaN values, "132" vs "123" ordering, uncatchable
rejections). #1042's claim that "trivial `Promise.resolve(x)` patterns
work" is stale — `await Promise.resolve(41)` now yields NaN inside wasm.
