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

## Implementation Plan

**Confirmed on upstream/main 23a0ddaa26** (`.tmp/probe-6428.mjs`, `compile()` + `WebAssembly.instantiate(bin, {})`): r1–r4 → `NaN`, both controls → `7`, identically on `wasi` and `standalone`. The responsible arm is exactly the one the issue names: `src/codegen/expressions.ts` ~L1402 `if (asyncResultConsumedAsValue(ctx, expr)) return callResult;` — on the carrier lane `callResult` is now an **externref `$Promise`** (rows 1–3: #5371's `widenAsyncThenableResult`; row 4: the callee is drive-lowered, `__async_resume_ff` exists and its `$Promise` resultp is what the inlined frame leaves on the stack) and the enclosing `return` coerces externref→f64 (`i31` test, else `__unbox_number`-style call) → NaN. Nothing else is wrong; `emitStandaloneAwaitUnwrap` (L567) already does the right read for `await` consumers (L1565).

1. **Reduction first** (`.tmp/`): extend the probe with a `wasi` variant that calls the exported `__drain_microtasks` before reading, to learn whether row 4's drive-lowered frame settles synchronously when its awaited `$Promise` is already fulfilled, or only after a drain (the await on a fulfilled `$Promise` enqueues a microtask; `test()` is a sync export that returns before `_start`'s auto-drain). This decides whether step 3 needs the drain call.
2. **`src/codegen/expressions.ts`, the `value` arm (~L1402)**: split the classifier result — `const kind = classifyAsyncConsumer(ctx.checker, expr)`. Keep `"await"` byte-identical (the await site unwraps). For `kind === "value"` **and** `isStandalonePromiseActive(ctx)` **and** `callResult.kind === "externref"`: emit `emitStandaloneAwaitUnwrap(ctx, fctx)` and return `{kind:"externref"}`. The `ref.test $Promise` guard makes it a no-op for a non-Promise externref (a `Promise<string>` callee's string passes through), so no other value sink moves. Host/gc lane: the gate is false → zero byte change, host ABI untouched (AC3).
3. **Drive-lowered callee (row 4)**: if step 1 shows the resultp is still PENDING after the call, emit `emitDrainMicrotasks(ctx, fctx)` (`src/codegen/async-scheduler.ts` L1965; registers the drain on demand) between the call and the unwrap, only when `calleeIsDriveLowered(ctx, expr)` — a legacy pass-through callee returns a fulfilled `$Promise` and must not pay a drain. Order is load-bearing: call → drain → `ref.test`/`struct.get value` → the existing externref→f64 coercion by the consumer. Do not touch `wrapAsyncReturn`, `wrapAsyncCallInTryCatch`, the `thenable` arm, or `async-thenable-return.ts`.
4. **IR lane check**: `grep classifyAsyncConsumer src/ir` is empty today; confirm via the probe's WAT that the cast-sink consumer function compiles through `expressions.ts` (it does on this HEAD — the `__inl9_*` inlined frame is the legacy emitter). If an IR-lowered consumer emits the async call itself, mirror step 2 in `src/ir/lower-generic.ts` next to the existing `emitStandaloneAwaitUnwrap` mirror (~L3412) — keep the two in lockstep per `lower-contracts.ts` L272.
5. **Regression test** `tests/issue-6428-standalone-async-value-sink.test.ts`: two-file project — `mod.js` (untyped) holds the four failing async shapes + the two controls; `entry.ts` holds the `(f() as unknown as number)` sinks (the value sink is a TS-cast idiom by construction, so the entry must be `.ts`; the package half stays untyped `.js`). `compileProject` once per target (`wasi`, `standalone`), instantiate with `{}`, one `it` per row × target: r1–r4 `=== 7/8/9/7` (fail on parent — measured NaN), controls `=== 7` (anti-vacuity: pass on parent too, so an "unwrap everything" fix is not distinguishable without them). Exact counts: 12 assertions, 8 red on parent, 12 green with the fix.
6. **Gates**: `check-loc-budget`, `check-func-budget`, `check-coercion-sites` (the new `struct.get` read is not a coercion site, but re-run), `check:oracle-ratchet` (no new `checker.*` — reuse `classifyAsyncConsumer`), `check:dead-exports`.

**Expected movement**: dogfood host lane — none (webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 · hono 259/324 all unchanged; the change is gated off on gc/host). Standalone lane: the cast sink does not occur in test262 JS, so the standalone floor/net guards should read 0/0; any negative delta there means the `ref.test` guard or the drain placement is wrong — stop and re-measure rather than widen.

## Dispatch

**opus** — one gated arm plus a drain-ordering question the reduction answers up front; medium, not hard.
