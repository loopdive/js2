---
id: 1727
title: "internal async-function call result wrapped in Promise then unboxed → NaN"
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

# #1727 — internal async-function call result reads as NaN

## Problem

In the synchronous-wasm async model, calling an async function **internally**
(a wasm `call`/`call_ref`, not the JS export boundary) and consuming its value
as a primitive returns **NaN** instead of the resolved value. Fails the 7
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

[Earlier "sink coercion keys on TS type" hypothesis was inconclusive; the
sharper isolation below is decisive.]

## SHARPER ROOT CAUSE (dev-b, after deeper probing)

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
async-codegen model.

ESCALATED to architect for a micro-spec on the internal async-call result
convention. **Root cause now fully pinned via WAT disassembly — see
Implementation Plan below.**

## Repro / acceptance

- `tests/equivalence/async-function.test.ts` — 7 NaN/illegal-cast failures → pass.
- `f() as number` from an async `f(): Promise<number>` returns the value.
- No regression in sync function call coercion.
- Full-CI net ≥ 0; no new async/generator regressions; equivalence-shard-4
  flips green.

## Source

dev-b root-cause recon 2026-05-29 (the equivalence-shard-4 main drift,
independently hit on PRs #902/#913).

---

## Implementation Plan (architect — 2026-05-29)

### Root cause (pinned via WAT disassembly of the exact repro)

The "internal-call convention diverges from export" framing is correct, but the
divergence is **not** in how the value is computed — it is that the internal
call site runs `wrapAsyncReturn` (Promise.resolve wrapping) on a value the
consuming primitive sink then immediately unboxes as a number.

Disassembling the repro (`f(): Promise<number> { return 42 }`,
`main(): number { return f() as unknown as number }`) produces:

```wasm
(func $f (type 8)            ;; type 8 = (func (result f64))
  f64.const 42
  return)

(func $main (type 8)         ;; main also returns f64
  (try (result externref)
    (do
      f64.const 42           ;; f() inlined to its f64 return value
      call 1                 ;; __box_number(42)   → externref
      call 2                 ;; Promise_resolve(..) → a JS Promise OBJECT (externref)
    )
    (catch_all
      call 4 ;; __get_caught_exception
      call 3 ;; Promise_reject
    ))
  call 0                     ;; __unbox_number(Promise{42}) → +Promise{42} === NaN
  return)                    ;; main returns NaN
```

Func-index map for the repro: 0 `__unbox_number`, 1 `__box_number`,
2 `Promise_resolve`, 3 `Promise_reject`, 4 `__get_caught_exception`,
5 `$f`, 6 `$main`.

So the **export path** (`instance.exports.f()`) calls `$f` directly with its
real wasm signature `() -> f64` and gets raw `42` — no box, no Promise wrap,
no unbox. Correct.

The **internal path** (`f()` inside `main`) hits the async-call wrap at
`src/codegen/expressions.ts:946` → `wrapAsyncReturn`
(`src/codegen/expressions.ts:202`), which:
1. boxes the f64 → externref (`__box_number`, `coerceType` at L216), then
2. wraps it in `Promise_resolve(...)` (L239-243) producing a **JS Promise
   object**.

The consuming sink — `return ... : number`, i.e. `coerceType(externref → f64)`
— then emits `__unbox_number` (`call 0`), which is `Number(Promise{42})` =
**NaN**. The runtime confirms: `Promise_resolve` returns `Promise.resolve(val)`
(`src/runtime.ts:7106`), a real Promise object, never the bare value.

This is exactly symmetric to the **already-handled** `await` consumer case at
`expressions.ts:964-978`: when the parent is `await`, the code skips the wrap
and leaves the raw `T` on the stack. The bug is that the **primitive sink**
consumer (`f() as any as number` feeding a numeric return / var-init / arg /
arithmetic) is NOT recognised as a raw-`T` consumer, so the wrap fires and the
sink unboxes a Promise object → NaN.

### The divergence in one line

Export call: `$f` invoked directly → raw `f64` on the wasm boundary.
Internal call in a numeric sink: `$f` result → `__box_number` →
`Promise_resolve` (Promise object) → `__unbox_number` → **NaN**. The internal
path adds a box+wrap+unbox round-trip that the export path never does, and the
final unbox is applied to a Promise object instead of a boxed number.

### Fix — extend the raw-`T` consumer detection at the async-call wrap site

**File: `src/codegen/expressions.ts`**, function `compileExpressionBody`, the
async-call block at **lines 946-985** (the `if (isAsyncCallExpression(...))`
branch). The existing parent-walk (L964-973) already unwraps
`Parenthesized`/`As`/`NonNull`/`TypeAssertion` and skips the wrap when the
parent is an `AwaitExpression`. **Generalise that skip** to also cover the
"value is consumed as a primitive / non-Promise sink" case.

Add a helper `asyncResultConsumedAsValue(ctx, expr)` (place it next to
`isAsyncCallExpression`, ~L190) that walks the same wrapper chain from
`expr.parent` and returns `true` when the immediate semantic consumer is one
of:

1. **`AwaitExpression`** — existing case; fold the current L974 check into the
   helper so there is a single decision point.
2. **A cast/assertion whose target type is NOT `Promise<…>`** — i.e. the
   user wrote `f() as any`, `f() as number`, `f() as unknown as number`, or a
   `<number>f()` type assertion. Use `ctx.checker.getTypeAtLocation` on the
   **outermost** cast node and test `!isPromiseType(castType)`
   (`isPromiseType` is already imported/used at L186). `as any` and
   `as unknown` resolve to the `any`/`unknown` type → not a Promise → treated
   as value consumer. This is the repro and the 7 equivalence cases.
3. **The cast chain terminates in a numeric/primitive sink**: a
   `ReturnStatement` whose enclosing function's return type is a number/bool/
   string primitive, a `VariableDeclaration` with a primitive declared type, a
   binary arithmetic operand, or a call argument typed as a primitive. This is
   belt-and-suspenders for casts that elide the explicit `as` (rare) — gate it
   behind the cast-type check so it only fires when a cast is present, to keep
   blast radius minimal.

When `asyncResultConsumedAsValue` returns `true`, **`return callResult`
unchanged** (skip both `wrapAsyncReturn` and `wrapAsyncCallInTryCatch`), exactly
as the await branch does today at L977. The raw `f64`/`T` already on the stack
is what the sink wants; no box, no Promise, no unbox.

When it returns `false` (the consumer genuinely wants a Promise:
`f().then(...)`, `const p = f();` where `p: Promise<T>`, `return f()` from an
`async`/`Promise`-returning function, `Promise.all([f()])`), keep the existing
`wrapAsyncReturn` + `wrapAsyncCallInTryCatch` path verbatim.

**Minimal-diff variant (recommended for the first PR):** scope (2) only —
extend the existing L964-978 parent-walk so that after unwrapping the
cast/assertion wrappers, if ANY unwrapped node was an `AsExpression`/
`TypeAssertion`/`NonNullExpression` whose type is not a Promise, skip the wrap
(return `callResult`). This covers `as any` / `as unknown as number` /
`as number` — precisely the 7 failing equivalence cases and the test262
`f() as any as number` idiom — with the smallest possible change. Add scope (3)
only if a follow-up equivalence/test262 case needs it.

### Why not "fix the sink coercion" or "change f's signature"

- Changing `$f`'s return signature to externref (the future CPS model, #1042
  Step 3 `rewriteFuncResultType`) is out of scope and high-risk; the legacy
  model deliberately keeps async fns returning unwrapped `T` so the export
  boundary and `await` passthrough both work. Don't touch it.
- "Make the sink consult the produced ValType not the TS type" was dev-b's
  first hypothesis; the WAT shows the sink coercion is *correct* (it unboxes
  an externref to f64) — the value it is handed is simply the wrong thing (a
  Promise object instead of a boxed number). Fix the producer, not the sink.

### Wasm IR — target output after the fix

`$main` should collapse to the sync-control shape (raw f64, no round-trip):

```wasm
(func $main (type 8)
  f64.const 42      ;; f() inlined / call $f → f64
  return)           ;; main returns 42
```

i.e. identical to the passing sync control. No `__box_number`,
`Promise_resolve`, `try/catch_all`, or `__unbox_number` in the value path.

### Edge cases (must all be covered + tested)

1. **Sync-context call to async fn consumed as value** (the repro):
   `f() as any as number` in a `return : number` → raw value. ✓ primary fix.
2. **`await` of an internal async call**: `const v = await f();` — already
   handled by the existing await-parent skip; folding it into the helper must
   NOT regress it. Keep `tests/equivalence/async-function.test.ts` "await
   expression is identity" green.
3. **async calling async**: `async function g(){ return f() as any as number; }`
   — inside `g`, `f()` is still a value consumer (cast to number), so skip the
   wrap; `g`'s own return then re-wraps via `g`'s async-return path. Verify the
   "multiple awaits in sequence" + "async function with computation" cases.
4. **Genuine Promise consumer must STILL wrap**: `f().then(...)`,
   `const p: Promise<number> = f();`, `Promise.all([f()])`, and a bare
   `return f();` from an async/Promise-returning function. These must keep
   emitting `Promise_resolve`. Add a regression test asserting `.then` still
   works (or at least that the wrap is still emitted) so the fix does not
   over-broaden into breaking real Promise consumers.
5. **`Promise<void>` async fn consumed as value**: `f() as any` where
   `f(): Promise<void>` — `callResult` is `VOID_RESULT`; the value path must
   not push a stray `ref.null.extern`. The skip returns `callResult`
   (VOID_RESULT) unchanged, which is correct; verify no stack-balance fallout.
6. **async arrow consumed as value**: `const d = async (x:number)=>x*2;
   d(21) as any as number` — currently throws `illegal cast` (test case 6).
   The arrow path may route through a different async-detection branch
   (`calleeType.getCallSignatures()` returning `Promise<T>` at L185-187);
   ensure `asyncResultConsumedAsValue` is consulted on this branch too, so the
   arrow value consumer also skips the wrap.

### Test files to verify

- `tests/equivalence/async-function.test.ts` — all 7 cases flip pass (currently
  5× NaN, 1× illegal cast, 1× conditional NaN). This IS the equivalence-shard-4
  drift; it must go fully green.
- Add a focused `tests/issue-1727.test.ts` with: the export-vs-internal
  divergence repro (both `f()` and `main()` return 42), a `.then` Promise-
  consumer that still works, and the `Promise<void>` value-consumer case.
- math-pow equivalence case that depends on this (per issue) — confirm it
  recovers.

### Risk section — async codegen is delicate (#1042 / #1373)

- **Over-broadening risk**: the dangerous failure mode is skipping the wrap for
  a consumer that actually needs a Promise (`.then`, stored `const p:
  Promise<T>`, `Promise.all`). The cast-type gate (scope 2: only skip when a
  non-Promise cast/assertion is present) is deliberately narrow to avoid this.
  Do NOT skip the wrap for a bare `f()` with no cast feeding a Promise-typed
  sink. The regression test in edge case (4) guards this.
- **Mixed-mode with future CPS (#1042/#1373b)**: the joint async spec
  (`plan/issues/1042-*.md` Step 13) mandates keeping `wrapAsyncReturn` /
  `wrapAsyncCallInTryCatch` for the legacy path during the CPS rollout. This
  fix only adds a *consumer-side skip condition* in front of them — it does
  not remove or alter the wrap helpers, so it is forward-compatible with the
  CPS work. Leave the helpers intact.
- **Mandatory gates**:
  - Full-CI **net ≥ 0** (not just no-regression — net pass delta must not go
    negative).
  - **equivalence-shard-4** async-function tests flip to pass.
  - **Zero new async/generator regressions** — explicitly diff the test262
    buckets `language/expressions/await/*`, `language/statements/for-await-of/*`,
    `built-ins/Promise/*`, and the async-generator dirs against baseline. Any
    single-bucket spike → escalate to tech lead, do not self-merge.
  - Standalone/WASI mode (`isStandalonePromiseActive`) value-consumer path:
    the skip happens BEFORE `wrapAsyncReturn`, so the standalone struct.new
    Promise branch (L227-238) is never reached for value consumers — no WASI
    regression expected, but include one WASI-target smoke compile in the PR.

### Feasibility

**Easy–medium.** The minimal-diff variant (scope 2) is a ~15-line change in a
single function (`expressions.ts` async-call block) plus a new ~20-line helper
and tests. No new imports, no signature changes, no IR work. Medium only
because of the async-codegen blast-radius discipline (full-CI net ≥ 0 + bucket
diff before merge).
