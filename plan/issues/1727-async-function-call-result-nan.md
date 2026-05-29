---
id: 1727
title: "async function call result coerced as externref → NaN (sync-wasm async model)"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: high
task_type: bugfix
area: codegen
language_feature: async-functions, type-coercion
goal: test262-conformance
related: [1042, 1373, 1151]
---

# #1727 — async function call result reads as NaN

## Problem

In the synchronous-wasm async model, calling an async function and reading its
value returns **NaN** instead of the resolved value. Fails the 7
`tests/equivalence/async-function.test.ts` cases (+1 math-pow that depends on
it) — the pre-existing `equivalence-shard (4)` drift failing every PR.

```ts
async function f(): Promise<number> { return 42; }
export function main(): number { return f() as unknown as number; }
// main() === NaN (expected 42)
```

A byte-for-byte SYNC control passes:
```ts
function f(): number { return 42; }
export function main(): number { return f() as any; } // → 42 ✓
```
Only the `async` modifier changes the result.

## Root cause (localized — dev-b recon 2026-05-29)

The async function `f` is compiled with the Promise-unwrapped return type
(`function-body.ts:570` `effectiveRetType = unwrapPromiseType(...)`), and its
**wasm signature returns f64**. Confirmed: `export async function f(): Promise<number> { return 42 }`
returns raw `42` (typeof number) when called directly from JS, identical to the
sync `g(): number`.

The plain-call dispatch (`calls.ts:8518`) correctly returns
`getWasmFuncReturnType(finalFuncIdx)` = f64 for the call expression. So the
call site produces an f64 on the stack.

**The NaN is introduced at the SINK coercion.** When the f64 call result flows
into a sink (return statement / var initializer / argument), the coercion layer
keys off the expression's *TS type* — `Promise<number>`, an object type — and
treats the value as an externref, emitting an externref→f64 unbox (`__unbox_number`
or `extern.convert`) against a value that is actually a raw f64. The unbox of a
non-boxed f64 yields NaN. Reproduced for every sink (return-direct, var-init,
arg-to-sync-fn) — all NaN — so it is a coercion-layer issue, not a per-sink one.

The coercion layer must consult the **actual produced ValType** (f64) for async
call results, not the declared `Promise<T>` TS type, OR async call expressions
must carry the unwrapped type through `getTypeAtLocation`-based coercion.

## Why escalating (per tech-lead "fix if localized, else escalate with root cause")

The locus is the call→sink coercion that keys on TS type vs produced ValType,
shared across return/var/arg coercion paths and intertwined with the #1042/#1373
async-codegen model. It is NOT a one-line change and risks the async model.
Root cause is pinned (above); recommend a focused fix by an async-codegen owner
or an architect micro-spec on "async call result ValType vs TS-type in coercion".

## Repro / acceptance

- `tests/equivalence/async-function.test.ts` — 7 NaN failures → pass.
- `f() as number` from an async `f(): Promise<number>` returns the value.
- No regression in sync function call coercion.

## Source

dev-b root-cause recon 2026-05-29 (the equivalence-shard-4 main drift,
independently hit on PRs #902/#913).


## SHARPER ROOT CAUSE (dev-b, after deeper probing)

The earlier "sink coercion" hypothesis is WRONG. Instrumented the return path:
`exprType={kind:f64}`, `returnType={kind:f64}` — no coercion runs; the f64 is
on the stack with the correct type the whole way up. Yet the result is NaN.

Decisive isolation — the SAME async function, exported AND called internally:
```ts
export async function f(): Promise<number> { return 42; }
export function main(): number { return f() as unknown as number; }
```
- `instance.exports.f()`            → **42**   (export-wrapper call path)
- `instance.exports.main()`         → **NaN**  (internal `call` to the same f)

`f.length === 0` (no hidden arity mismatch). So `f`'s body is correct; the
**internal async-call lowering emits/returns the wrong value** while the export
wrapper's call is correct. The divergence is in the internal async call
convention, not in coercion or the sink. This sits in the #1042/#1373
async-codegen model — pinning the exact bad instruction needs a wasm
disassembler (none in this container) and the async-codegen owner.

ESCALATING per tech-lead "fix if localized, else escalate with root cause": the
root cause is pinned to the internal async-call path (export call OK, internal
call NaN, same fn), but the fix lives in the async call convention, not a
localized coercion. Recommend async-codegen owner / architect.
