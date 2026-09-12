---
id: 6428
title: "Standalone / WASI: `return <thenable>` from a never-suspending async function still reads NaN through the #1727 raw-value sink"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Split out of [#5371](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5371-await-compiled-async-returning-host-promise),
which fixed the JS-host half and deliberately left this one open rather than
paper over it.

§27.7.5.2 resolves an async function's promise capability with the return
value, and §27.2.1.3.2 makes a thenable result adopt. #5371 made that work on
the host lane by keeping a legacy-pass-through async function's wasm result on
the **externref** carrier whenever its body can `return` a thenable, so the
call site's adopting `Promise.resolve` settles with the inner value instead of
`Number(promise)` === `NaN`.

That ABI rule is lane-independent and does reach standalone/WASI — the callee
now hands back a real `$Promise`. It does not fix the answer there, because the
standalone consumer within reach of an exported entry point is the **#1727
raw-value sink** (`f() as unknown as number`), which unboxes a `$Promise` to
`NaN` exactly as it unboxed the host promise before.

## Measurement (2026-09-12, upstream/main cf82f78d6d, both lanes, base AND with #5371's fix — identical)

| case | `--target wasi` | `--target standalone` |
| --- | --- | --- |
| `async function f(): Promise<number> { return Promise.resolve(7) }` | `NaN` | `NaN` |
| `function mk(): Promise<number> {…}; async function f() { return mk() }` | `NaN` | `NaN` |
| `async function f() { const p = Promise.resolve(9); return p }` | `NaN` | `NaN` |
| `async function g() { const v = await f(); return v }` (f as above) | `NaN` | `NaN` |
| `async function f() { return await Promise.resolve(7) }` (control) | `7` | `7` |
| `async function f() { return 7 }` (control) | `7` | `7` |

Consumer in every row: `export function test(): number { return (f() as unknown as number); }`.
Probe: `.tmp/probe-5371-standalone.mjs` in the #5371 worktree (a plain
`compile()` + `WebAssembly.instantiate`, no host imports).

## Acceptance criteria

1. The four failing rows above return their values on **both** `wasi` and
   `standalone`, with the two controls unchanged.
2. Regression test under `tests/` covering both targets, failing on the parent
   and passing with the fix, exact counts both ways, with the two controls as
   the anti-vacuity check.
3. No regression in the 17 dogfood suites (host lane) — the fix must not move
   the host ABI.

## Notes for whoever picks this up

The fix is NOT another result-carrier rule; #5371 already applied that one. It
is the **value-sink half** of the async contract: when an async callee's result
is consumed as a raw value (`asyncResultConsumedAsValue` / `classifyAsyncConsumer`
returning `value`), the consumer must unwrap a settled `$Promise` (the AG0
`$Promise.value` read already used by `await` on that lane) instead of running
`__unbox_number` over the struct. See `src/codegen/expressions.ts`
(`asyncResultConsumedAsValue`, `wrapAsyncReturn`) and the AG0 unwrap in
`src/codegen/async-frame.ts`.
