// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4644) Operand padding for compiler-synthesized ZERO-ARGUMENT method calls.
 *
 * Several emitters call a user method with no arguments because the *language*
 * passes none there — `ToPrimitive` invokes `valueOf`/`toString` with an empty
 * argument list (§7.1.1.1), and the `__call_toString` / `__call_valueOf`
 * dispatchers exported for the host do the same. Those emitters pushed the
 * receiver and nothing else.
 *
 * That is a Wasm ARITY bug whenever the method DECLARES parameters, which is
 * legal and common: `toString(e = void 0)` on `@js-temporal/polyfill`'s
 * `PlainMonthDay` compiles to a 2-param Wasm function. The module then passes
 * `compile()` with zero diagnostics and is rejected by `WebAssembly.compile()`
 * — `not enough arguments on the stack for call (need 2, got 1)` — a failure
 * mode that is silent by construction for any corpus that compiles without
 * instantiating.
 *
 * Padding with `undefined` is not a workaround, it is the specified answer: an
 * argument the caller omits IS `undefined`, so a defaulted parameter takes its
 * default and an undefaulted one reads `undefined`.
 */
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { pushDefaultValue } from "./type-coercion.js";
import type { Instr, ValType } from "../ir/types.js";

/**
 * Operands standing in for one omitted argument of the given Wasm type.
 *
 * Returns `null` when no value of that type can be invented — a NON-NULLABLE GC
 * ref (`ref N`). The obvious idiom there, `ref.null` + `ref.as_non_null`,
 * validates and then TRAPS the instant the code runs, which is strictly worse
 * than declining: a caller that cannot pad correctly can fall back to a path
 * that does not call this method at all.
 */
export function zeroArgPadInstrs(ctx: CodegenContext, type: ValType): Instr[] | null {
  switch (type.kind) {
    case "f64":
      return [{ op: "f64.const", value: 0 }];
    case "i32":
      return [{ op: "i32.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "externref":
      return canonicalUndefinedExternInstrs(ctx);
    case "anyref":
    case "eqref":
      return [{ op: "ref.null.eq" }];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: (type as { typeIdx: number }).typeIdx }];
    default:
      return null;
  }
}

/**
 * Operands for every parameter of `funcIdx` BEYOND the leading `this`.
 *
 * Empty array for the ordinary 1-param method (so callers that always spread
 * the result stay byte-identical), `null` when a parameter cannot be padded.
 */
export function zeroArgCallPadInstrs(ctx: CodegenContext, funcIdx: number): Instr[] | null {
  const funcDef = definedFuncAt(ctx, funcIdx);
  if (!funcDef) return [];
  const funcType = ctx.mod.types[funcDef.typeIdx];
  if (!funcType || funcType.kind !== "func") return [];
  const pad: Instr[] = [];
  for (let p = 1; p < funcType.params.length; p++) {
    const one = zeroArgPadInstrs(ctx, funcType.params[p]!);
    if (!one) return null;
    pad.push(...one);
  }
  return pad;
}

/**
 * Push the padding for `funcIdx` directly into `fctx.body`, immediately before
 * the caller emits its `call`. Returns `false` if the method cannot be padded,
 * in which case NOTHING was emitted and the caller must not emit the call.
 *
 * Uses {@link pushDefaultValue} rather than {@link zeroArgCallPadInstrs}: for an
 * `externref` slot that routes to `emitUndefinedValue`, which REGISTERS
 * `__get_undefined` when the module does not import it yet and flushes the
 * resulting index shift through `fctx`. That registration is the difference
 * between `undefined` and JS `null` — measured on
 * `class N { valueOf(hint) { return hint === undefined ? 41 : 7 } }`, where
 * `new N() + 1` is the ONLY use: nothing else pulls the import in, and the
 * inert-instruction pad answered 8 instead of 42.
 *
 * **The shift means a `funcIdx` the caller read BEFORE this call may be stale.**
 * Re-read it from `ctx.funcMap` after this returns `true` before emitting the
 * `call`.
 */
export function pushZeroArgCallPad(ctx: CodegenContext, fctx: FunctionContext, funcIdx: number): boolean {
  // Read the signature FIRST: `definedFuncAt` is indexed off the import count,
  // which the padding below may move.
  const funcDef = definedFuncAt(ctx, funcIdx);
  if (!funcDef) return true;
  const funcType = ctx.mod.types[funcDef.typeIdx];
  if (!funcType || funcType.kind !== "func") return true;
  const extra = funcType.params.slice(1);
  if (extra.length === 0) return true;
  // All-or-nothing: verify every slot is paddable before emitting any of it.
  if (extra.some((p) => zeroArgPadInstrs(ctx, p) === null)) return false;
  for (const p of extra) pushDefaultValue(fctx, p, ctx);
  return true;
}
