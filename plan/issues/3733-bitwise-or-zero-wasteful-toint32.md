---
id: 3733
title: "compileBitwiseBinaryOp runs the full float-based ToInt32 on a compile-time-constant operand (loop.ts landing-page benchmark)"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: performance
area: codegen
language_feature: bitwise-operators
goal: performance
depends_on: []
related: [3704, 3734]
loc-budget-allow:
  - src/ir/lower.ts
func-budget-allow:
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
---
# #3733 — `x | 0` runs the full float-based ToInt32 on the literal `0` too

## Context

Discovered while investigating why the landing-page playground benchmark
(`website/playground/examples/benchmarks/loop.ts`) shows wasm running ~3x
*slower* than JS for a tight `for` loop doing `s = (s + i) | 0` — a classic
"truncate to int32" idiom. Confirmed via bisection (see #3704/PR history) that
this is not a recent regression — the codegen for this pattern has been
unchanged for a while; it's simply always been this expensive.

## Root cause

`src/codegen/binary-ops.ts::compileBitwiseBinaryOp` (used for `&`, `|`, `^`,
`<<`, `>>`, `>>>` when operands are untyped `number`/f64 locals) truncates
**both** operands to i32 via `emitToInt32` before applying the i32 bitwise op:

```ts
function compileBitwiseBinaryOp(fctx, i32op, unsigned): ValType {
  // Stack: [left_f64, right_f64]
  const tmpR = allocTempLocal(fctx, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: tmpR });
  emitToInt32(fctx);           // left
  fctx.body.push({ op: "local.get", index: tmpR });
  releaseTempLocal(fctx, tmpR);
  emitToInt32(fctx);           // right
  fctx.body.push({ op: i32op });
  fctx.body.push({ op: unsigned ? "f64.convert_i32_u" : "f64.convert_i32_s" });
  return { kind: "f64" };
}
```

`emitToInt32` (same file, ~line 2890) is the full ECMA-262 `ToInt32` algorithm
implemented in floating point — correctly handling out-of-i32-range wraparound,
which is observable and required (e.g. `loop.ts`'s running sum exceeds 2^31
well before the loop ends):

```
f64.trunc
local.tee tmp
local.get tmp
f64.const 4294967296
f64.div
f64.floor
f64.const 4294967296
f64.mul
f64.sub
i32.trunc_sat_f64_u
```

That's 9 instructions, run **twice** per `|`/`&`/`^`/shift — once for each
operand — even when one operand is the compile-time-constant literal `0`
(the single most common RHS for this idiom: `x | 0`, `x & 0xffffffff` has a
non-zero mask but `x | 0`/`x ^ 0` are extremely common "coerce to int32"
idioms). `ToInt32(0)` is trivially `0` and never needs the runtime float
dance at all.

Measured impact on the `loop.ts` benchmark (1,000,000 iterations of
`s = (s + i) | 0`): wasm ~17ms vs JS ~5.8ms in this environment (JIT-tier
sensitive; CI showed similar magnitude, see #3704's PR description). The
redundant `ToInt32(0)` computation is roughly half of every iteration's
"truncate" work.

## Fix

In `compileNumericBinaryOp` (the caller, which still has the original
`ts.BinaryExpression` AST node with `expr.left`/`expr.right` in scope — by
the time `compileBitwiseBinaryOp` runs, both operands are already compiled
onto the stack and that context is gone), special-case a numeric-literal
operand for `|`/`^` specifically:

- `x | 0` and `x ^ 0` are semantically exactly `ToInt32(x)` — skip compiling
  the constant side, skip the second `emitToInt32`, skip the `i32.or`/`i32.xor`
  entirely (OR/XOR with 0 is the identity).
- More generally, ANY numeric literal operand can skip its own `emitToInt32`
  call and instead push a precomputed `i32.const <ToInt32(literalValue)>`
  directly — correct for `&`/`<<`/`>>`/`>>>` too, and cheaper even when the
  literal isn't `0` (e.g. `x & 0xff` currently ToInt32's the literal `0xff`
  every call, which is also wasted work — it's already an i32-range integer
  literal, no float round-trip needed).

Keep the non-literal operand's `emitToInt32` as-is (still needs the real
runtime wraparound semantics — do not weaken correctness for the
dynamic operand).

## Acceptance criteria

- [ ] `x | 0` / `x ^ 0` (and the general literal-operand case for
      `&`/`<<`/`>>`/`>>>`) no longer emit the float-based `emitToInt32`
      sequence for the literal operand.
- [ ] `x | 0` specifically emits close to the minimum instruction count:
      compile `x`, `emitToInt32`, convert back to f64 — no `i32.or` and no
      second `ToInt32` at all.
- [ ] New codegen-shape test (inspect `.wat` output, or count emitted
      `f64.div`/`f64.floor` occurrences) proving the literal-zero fast path
      fires for `x | 0`.
- [ ] Equivalence tests still pass for the full range of bitwise-operator +
      literal-operand combinations, including large-magnitude values that
      exercise real ToInt32 wraparound on the *non*-literal side (e.g.
      `(2**32 + 5) | 0`, negative literals, `NaN | 0`, `Infinity | 0`).
- [ ] Re-run `scripts/generate-playground-benchmark-sidebar.mjs` (or the
      relevant slice) locally and confirm `loop.ts`'s wasm time improves
      materially relative to before the fix (exact target ratio TBD — this
      issue does not claim it alone restores wasm-faster-than-JS, only that
      it removes the specific wasted-work identified above).
