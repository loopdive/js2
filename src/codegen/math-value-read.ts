// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4565) `Math.<fn>` read as a VALUE, for `--target standalone`.
 *
 * Calling `Math.sin(x)` directly has always worked on this lane: the call site
 * has a dedicated lowering that resolves the self-hosted `Math_sin` provider and
 * emits a direct `call`. Reading `Math.sin` as a value did not — the reified
 * value got the generic "not yet implemented in --target standalone" throwing
 * body, so
 *
 *     derivative(Math.sin, 0.0001)      // test262 S13.2.1_A5_T2
 *     [1, 4, 9].map(Math.sqrt)          // ordinary JS
 *
 * threw as soon as the extracted value was invoked. The value itself was
 * spec-shaped (identity, `.name`, `.length` all correct); only invoking it
 * failed, which is why this reads as a missing implementation rather than a
 * missing property.
 *
 * ## Why this can mint late
 *
 * `emitInlineMathFunctions` appends DEFINED functions. Defined-function indices
 * are appended after the import block, so adding one here cannot shift any
 * existing index — unlike a late IMPORT, which is the hazard `addUnionImports`
 * exists to manage. The surrounding value-read path already mints defined
 * functions at this point (`mintDefinedFunc`), so this is the same moment.
 *
 * ## Coercion
 *
 * Arguments arrive as `externref` and the provider is `f64 -> f64`, so each
 * argument runs the ENGINE ToNumber pipeline (`__any_from_extern` ->
 * `__any_to_f64`) rather than a hand-rolled unbox: that is the same pipeline
 * `Math.max`/`Math.min` use for their variadic fold, so an object argument with
 * a `valueOf` coerces identically whether it reaches `Math.sin` through a direct
 * call or through an extracted value.
 *
 * The result is boxed with `__box_number` (the native `$BoxedNumber` carrier),
 * NOT `__any_box_f64` — the same choice, and for the same reason, as the
 * `Math.max` fold documents: call-site `__unbox_number`, `__any_from_extern`
 * tag-3 and `__any_strict_eq` all recover a `$BoxedNumber` correctly, while an
 * `$AnyValue` box reads back NaN through `__unbox_number`.
 */

import type { Instr } from "../ir/types.js";
import { emitWasmMathClz32, emitWasmMathImul } from "../ir/backend/wasm-int32-coercion.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureAnyFromExternHelper, ensureAnyHelpers } from "./any-helpers.js";
import { addUnionImports } from "./index.js";
import { emitInlineMathFunctions } from "./math-helpers.js";

/**
 * Math methods with a self-hosted `Math_<name>` provider of shape
 * `(f64, ...) -> f64`. Kept in step with `emitInlineMathFunctions`' own
 * `needed` switch — a name here that it does not mint simply falls back to the
 * generic refusal body, so an over-wide entry is a miss, never a wrong answer.
 */
const MATH_SELF_HOSTED_F64: ReadonlyMap<string, number> = new Map([
  ["sin", 1],
  ["cos", 1],
  ["tan", 1],
  ["asin", 1],
  ["acos", 1],
  ["atan", 1],
  ["sinh", 1],
  ["cosh", 1],
  ["tanh", 1],
  ["asinh", 1],
  ["acosh", 1],
  ["atanh", 1],
  ["exp", 1],
  ["expm1", 1],
  ["log", 1],
  ["log2", 1],
  ["log10", 1],
  ["log1p", 1],
  ["cbrt", 1],
  ["atan2", 2],
  ["pow", 2],
]);

/**
 * (#5383 S2) `Math.<fn>` whose kernel is a SHORT instruction sequence rather
 * than a self-hosted `Math_<name>` provider. The direct-call lowering emits
 * these inline, so before this the value read had no provider to point at and
 * fell to the refusal body — even though the arithmetic is two opcodes.
 *
 * Found compiling `@js-temporal/polyfill` for `--target standalone`: jsbi's
 * feature-detect header is
 *
 *     JSBI.__clz30 = Math.clz32 ? function (i) { … } : function (i) { … };
 *     JSBI.__imul  = Math.imul  || function (i, _) { return 0 | i * _; };
 *
 * Both READ the builtin as a value (truthy — so the fallback never runs) and
 * then call it, which is the first thing the polyfill's `__module_init` does
 * with a number. `JSBI.multiply` is the first caller, so `Temporal`'s very
 * first `JSBI.BigInt(3600) * 1e9` died with
 * `TypeError: called value is not a function`.
 *
 * Each entry is the value-read twin of an existing direct-call lowering, and
 * the f64 opcode IS the ECMAScript operation for these five: `f64.floor` /
 * `ceil` / `trunc` / `abs` / `sqrt` agree with §21.3.2 on -0, NaN and ±∞.
 * `Math.round` and `Math.sign` are deliberately absent — `f64.nearest` rounds
 * ties to EVEN while §21.3.2.28 rounds ties toward +∞, so a naive entry would
 * be a WRONG ANSWER rather than a miss, which is the one outcome this file's
 * contract forbids.
 */
const MATH_INLINE_F64_OPS: ReadonlyMap<string, Instr[]> = new Map([
  ["abs", [{ op: "f64.abs" }] as Instr[]],
  ["floor", [{ op: "f64.floor" }] as Instr[]],
  ["ceil", [{ op: "f64.ceil" }] as Instr[]],
  ["trunc", [{ op: "f64.trunc" }] as Instr[]],
  ["sqrt", [{ op: "f64.sqrt" }] as Instr[]],
  // §21.3.2.16 — round to the nearest float32, back to a Number.
  ["fround", [{ op: "f32.demote_f64" }, { op: "f64.promote_f32" }] as Instr[]],
]);

/** Arity of the two exact-32-bit entries (`MATH_INLINE_F64_OPS` are all 1). */
const MATH_INT32_OPS: ReadonlyMap<string, number> = new Map([
  ["clz32", 1],
  ["imul", 2],
]);

/**
 * The ONE ToNumber/box route every `Math.<fn>` value body uses — the engine
 * pipeline (`__any_from_extern` → `__any_to_f64`), never a hand-rolled unbox,
 * so an object argument with a `valueOf` coerces exactly as it does through the
 * direct call. Resolved in one place so the inline and self-hosted bodies
 * cannot drift apart. Undefined when the substrate is unavailable, in which
 * case the caller keeps its refusal body.
 */
function mathValueSubstrate(
  ctx: CodegenContext,
): { fromExternIdx: number; toF64Idx: number; boxNumIdx: number } | undefined {
  const fromExternIdx = ctx.funcMap.get("__any_from_extern");
  const toF64Idx = ctx.funcMap.get("__any_to_f64");
  const boxNumIdx = ctx.funcMap.get("__box_number");
  if (fromExternIdx === undefined || toF64Idx === undefined || boxNumIdx === undefined) return undefined;
  return { fromExternIdx, toF64Idx, boxNumIdx };
}

/** Shared prologue: coerce params 1..arity from externref to f64 on the stack. */
function pushCoercedArgs(closureFctx: FunctionContext, arity: number, fromExternIdx: number, toF64Idx: number): void {
  for (let i = 1; i <= arity; i++) {
    closureFctx.body.push(
      { op: "local.get", index: i },
      { op: "call", funcIdx: fromExternIdx },
      { op: "call", funcIdx: toF64Idx },
    );
  }
}

/**
 * Body for an inline-kernel `Math.<name>` value read. Returns false when the
 * name has no inline kernel or the boxing substrate is missing, so the caller
 * keeps its refusal body.
 */
function emitInlineMathValueReadBody(ctx: CodegenContext, closureFctx: FunctionContext, name: string): boolean {
  const f64Ops = MATH_INLINE_F64_OPS.get(name);
  const int32Arity = MATH_INT32_OPS.get(name);
  if (f64Ops === undefined && int32Arity === undefined) return false;

  const substrate = mathValueSubstrate(ctx);
  if (substrate === undefined) return false;
  const { fromExternIdx, toF64Idx, boxNumIdx } = substrate;

  if (f64Ops !== undefined) {
    pushCoercedArgs(closureFctx, 1, fromExternIdx, toF64Idx);
    closureFctx.body.push(...f64Ops.map((instr) => ({ ...instr })));
    closureFctx.body.push({ op: "call", funcIdx: boxNumIdx });
    return true;
  }

  // `Math.clz32` / `Math.imul` need the EXACT ToUint32/ToInt32 of §7.1.6-7.1.7,
  // not a trapping `i32.trunc_f64_s`. Reuse the IR backend's decomposition
  // (`wasm-int32-coercion.ts`) verbatim so the value read and the direct call
  // cannot disagree on a magnitude >= 2**63 or on a NaN/Infinity argument.
  const scratch = {
    bits: allocLocal(closureFctx, "mv_i32_bits", { kind: "i64" }),
    exponent: allocLocal(closureFctx, "mv_i32_exp", { kind: "i64" }),
    significand: allocLocal(closureFctx, "mv_i32_sig", { kind: "i64" }),
    magnitude: allocLocal(closureFctx, "mv_i32_mag", { kind: "i64" }),
  };
  pushCoercedArgs(closureFctx, int32Arity as number, fromExternIdx, toF64Idx);
  if (name === "clz32") {
    emitWasmMathClz32(closureFctx.body, scratch);
  } else {
    emitWasmMathImul(closureFctx.body, scratch, allocLocal(closureFctx, "mv_imul_rhs", { kind: "i32" }));
  }
  closureFctx.body.push({ op: "call", funcIdx: boxNumIdx });
  return true;
}

/**
 * Emit a real body for `Math.<name>` read as a value, into `closureFctx`.
 *
 * Returns false when no self-hosted provider can be materialised, in which case
 * the caller must keep its existing refusal body — a miss, not a wrong answer.
 * Params: 0 = self, 1..arity = the arguments, all `externref`.
 */
export function emitMathValueReadBody(ctx: CodegenContext, closureFctx: FunctionContext, name: string): boolean {
  if (emitInlineMathValueReadBody(ctx, closureFctx, name)) return true;
  const arity = MATH_SELF_HOSTED_F64.get(name);
  if (arity === undefined) return false;

  const symbol = `Math_${name}`;
  if (ctx.funcMap.get(symbol) === undefined) emitInlineMathFunctions(ctx, new Set([name]));
  const providerIdx = ctx.funcMap.get(symbol);
  if (providerIdx === undefined) return false;

  const substrate = mathValueSubstrate(ctx);
  if (substrate === undefined) return false;
  const { fromExternIdx, toF64Idx, boxNumIdx } = substrate;

  // (#5383 S2) Through the SAME `pushCoercedArgs` the inline kernels use — one
  // ToNumber route for every `Math.<fn>` value body, so the two can never drift.
  pushCoercedArgs(closureFctx, arity, fromExternIdx, toF64Idx);
  closureFctx.body.push({ op: "call", funcIdx: providerIdx }, { op: "call", funcIdx: boxNumIdx });
  return true;
}

/**
 * (#5383 S2) Pre-register the natives every `Math.<fn>` value body reads —
 * `__any_from_extern`, `__any_to_f64`, `__box_number` — BEFORE the caller
 * builds the closure's wrapper types and `FunctionContext`.
 *
 * This is the #2704 discipline: a FIRST registration made mid-body desyncs
 * codegen, so the body emitters below only ever READ `ctx.funcMap`. Before this
 * existed they read it in a context where nothing had registered the three, so
 * `emitMathValueReadBody` returned false for every name and EVERY `Math.<fn>`
 * value read — including the self-hosted transcendentals #4565 added — kept the
 * "not yet implemented in --target standalone" refusal body. That is why
 * `[1, 4, 9].map(Math.sqrt)` still threw with #4565 in place.
 *
 * Safe to call unconditionally for the `Math` namespace: all three registrations
 * are idempotent, and a module that reads no `Math.<fn>` value never gets here.
 */
export function prepareMathValueRead(ctx: CodegenContext, name: string): void {
  if (!MATH_INLINE_F64_OPS.has(name) && !MATH_INT32_OPS.has(name) && !MATH_SELF_HOSTED_F64.has(name)) return;
  addUnionImports(ctx); // __box_number
  ensureAnyFromExternHelper(ctx);
  ensureAnyHelpers(ctx); // __any_to_f64
}

/**
 * (#5383 S2) True when `Math.<name>` read as a value gets a REAL body from this
 * module — the inline kernels above plus #4565's self-hosted transcendentals.
 *
 * Read by `builtin-static-plain-alias.ts` to decide whether `var f = Math.<fn>;
 * f(x)` may route through the reified closure's ABI. Deliberately keyed on
 * "we can actually compute it", not on "it is a Math static": routing a name
 * whose body is still the refusal would swap one throw for another and move a
 * working js-host shape for no reason.
 */
export function mathValueReadHasBody(name: string): boolean {
  return MATH_INLINE_F64_OPS.has(name) || MATH_INT32_OPS.has(name) || MATH_SELF_HOSTED_F64.has(name);
}
