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
import type { CodegenContext, FunctionContext } from "./context/types.js";
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
 * Emit a real body for `Math.<name>` read as a value, into `closureFctx`.
 *
 * Returns false when no self-hosted provider can be materialised, in which case
 * the caller must keep its existing refusal body — a miss, not a wrong answer.
 * Params: 0 = self, 1..arity = the arguments, all `externref`.
 */
export function emitMathValueReadBody(ctx: CodegenContext, closureFctx: FunctionContext, name: string): boolean {
  const arity = MATH_SELF_HOSTED_F64.get(name);
  if (arity === undefined) return false;

  const symbol = `Math_${name}`;
  if (ctx.funcMap.get(symbol) === undefined) emitInlineMathFunctions(ctx, new Set([name]));
  const providerIdx = ctx.funcMap.get(symbol);
  if (providerIdx === undefined) return false;

  const fromExternIdx = ctx.funcMap.get("__any_from_extern");
  const toF64Idx = ctx.funcMap.get("__any_to_f64");
  const boxNumIdx = ctx.funcMap.get("__box_number");
  if (fromExternIdx === undefined || toF64Idx === undefined || boxNumIdx === undefined) return false;

  const body: Instr[] = [];
  for (let i = 1; i <= arity; i++) {
    body.push({ op: "local.get", index: i });
    body.push({ op: "call", funcIdx: fromExternIdx });
    body.push({ op: "call", funcIdx: toF64Idx });
  }
  body.push({ op: "call", funcIdx: providerIdx });
  body.push({ op: "call", funcIdx: boxNumIdx });
  closureFctx.body.push(...body);
  return true;
}
