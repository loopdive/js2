// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-4 lane G) Give `Math.<fn>` read as a first-class VALUE a body
 * that actually computes, instead of the degrade-to-catchable TypeError.
 *
 * ## The defect
 *
 * Every self-hosted `Math` function already exists as a pure `(f64…) -> f64`
 * defined function (`Math_sin`, `Math_atan2`, … — `math-helpers.ts`), and the
 * CALL lowering uses it directly (`expressions/builtins.ts` `hostUnary` arm:
 * `compileExpression(arg)` → `call Math_<m>`). But `Math.sin` read as a VALUE
 * fell to the `default:` arm of `emitBuiltinStaticMethodValue`
 * (`builtin-value-read.ts`), which reifies an identity-stable closure whose
 * body is `emitThrowTypeError(… "is not yet implemented in --target
 * standalone")`. So passing a Math function to another function threw, while
 * calling it directly worked.
 *
 * Measured on this branch's base with the real `runTest262File`
 * (`--target standalone`), `language/statements/function/S13.2.1_A5_T2.js`
 * (`derivative(Math.sin, 0.0001)`):
 *
 * ```
 * TypeError: Math.sin is not yet implemented in --target standalone
 * ```
 *
 * ## The two halves
 *
 * The gap is NOT in the numeric kernels — it is that the two phases which
 * decide "does this module need `Math_sin`?" and "what body does the reified
 * `Math.sin` value get?" both keyed on the CALL form only:
 *
 * 1. **Emission.** `collectImports` (`declarations/import-collector.ts`) added
 *    to `state.mathNeeded` only from a `ts.isCallExpression` whose callee is
 *    `Math.<m>`. A bare `Math.sin` value read therefore never put `sin` in the
 *    `needed` set, so `emitInlineMathFunctions` never emitted `Math_sin` and
 *    there was no kernel to call even in principle. Fixed at that collector by
 *    also scanning non-call `Math.<m>` property reads.
 * 2. **Body.** This module. It supplies the body the `default:` arm would
 *    otherwise fill with a throw.
 *
 * Both halves are required; either alone leaves the row failing.
 *
 * ## The body
 *
 * Params arrive as the generic all-`externref` static-method shape the
 * `default:` arm already chose (`self`, then one or two boxed args), and the
 * result is `externref`. So the body is the engine's ordinary ToNumber
 * pipeline into the existing kernel and back:
 *
 * ```
 * local.get <argN>; call __any_from_extern; call __any_to_f64   ; per argument
 * call Math_<m>                                                 ; f64 kernel
 * call __box_number                                             ; f64 -> externref
 * ```
 *
 * `__any_from_extern` → `__any_to_f64` is the SAME coercion pair the variadic
 * `Math.max`/`Math.min` value body two arms above already uses — deliberately,
 * so an extracted `Math.sin` coerces its argument exactly like an extracted
 * `Math.max` does, rather than growing a second hand-rolled matrix. Result
 * boxing likewise uses `__box_number` (the native `$BoxedNumber` carrier) and
 * not `__any_box_f64`, for the reason spelled out at that arm: an
 * `$AnyValue` box reads back NaN through `__unbox_number`.
 *
 * ## Scope / safety
 *
 * - **Declining is always safe and is the default.** The emitter returns
 *   `false` unless the kernel (`Math_<m>`) and all three helpers are already in
 *   `ctx.funcMap`; the caller then keeps the pre-existing throw body. So a
 *   module that never triggered the collector half simply behaves as before.
 * - **Additive only.** Every shape reaching here previously produced a closure
 *   that THREW on invocation. Nothing that used to return a value changes: the
 *   value's identity, `.name`/`.length` and `===` behaviour are decided by the
 *   caller and are untouched — only the body between them is replaced.
 * - Direct calls (`Math.sin(x)`) never route here; they keep the dedicated
 *   `hostUnary` f64 lowering, so the hot path is unchanged.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/**
 * The self-hosted `Math` kernels, by method name and arity. Every entry has a
 * `Math_<name>` defined function registered by `emitInlineMathFunctions`
 * (`math-helpers.ts`) when the name is in that pass's `needed` set.
 *
 * `random` is deliberately absent: it is 0-arg and its `Math_random` is a HOST
 * import in js-host mode, so it is not a pure f64 kernel this body can call.
 * `abs`/`floor`/`ceil`/`round`/`sqrt`/`trunc`/`sign`/`fround`/`clz32`/`imul`
 * are absent too — they lower to inline Wasm opcodes rather than to a
 * `Math_<m>` function, so there is nothing here to call; they keep the
 * existing behaviour.
 */
const MATH_KERNEL_ARITY: Record<string, number> = {
  exp: 1,
  log: 1,
  log2: 1,
  log10: 1,
  sin: 1,
  cos: 1,
  tan: 1,
  asin: 1,
  acos: 1,
  atan: 1,
  sinh: 1,
  cosh: 1,
  tanh: 1,
  acosh: 1,
  asinh: 1,
  atanh: 1,
  cbrt: 1,
  expm1: 1,
  log1p: 1,
  pow: 2,
  atan2: 2,
};

/** Method names this module can supply a computing body for. */
export function isSelfHostedMathValueMethod(builtinName: string, propName: string): boolean {
  return builtinName === "Math" && propName in MATH_KERNEL_ARITY;
}

/**
 * Emission half of the fix — the collector half described in the module header.
 *
 * Returns the `Math` method name when `node` is a `Math.<m>` property access in
 * NON-call position whose kernel this module can call, so `collectImports`
 * (`declarations/import-collector.ts`) can add it to `state.mathNeeded` and
 * `emitInlineMathFunctions` will emit the `Math_<m>` kernel. Returns `undefined`
 * for everything else, including the CALL position — that is already collected
 * by the existing `ts.isCallExpression` arm, and leaving it alone keeps the call
 * path's collection byte-identical.
 *
 * The membership gate is the same `MATH_KERNEL_ARITY` table the body emitter
 * uses, so a name can only become "needed" here if there is in fact a kernel to
 * call; the two halves cannot drift into disagreement.
 */
export function mathValueReadMethod(node: ts.Node): string | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "Math") return undefined;
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) return undefined;
  const method = node.name.text;
  return method in MATH_KERNEL_ARITY ? method : undefined;
}

/**
 * Push — into `closureFctx.body` — the ToNumber → `Math_<propName>` → box body
 * for the reified `Math.<propName>` value.
 *
 * Returns `false` without pushing anything when the kernel or a coercion helper
 * is unavailable, so the caller can keep its degrade-to-catchable throw body.
 * Stack on success: `[] → [externref]`, matching the declared result.
 */
export function emitMathStaticValueBody(ctx: CodegenContext, closureFctx: FunctionContext, propName: string): boolean {
  const arity = MATH_KERNEL_ARITY[propName];
  if (arity === undefined) return false;

  const kernelIdx = ctx.funcMap.get(`Math_${propName}`);
  const fromExternIdx = ctx.funcMap.get("__any_from_extern");
  const toF64Idx = ctx.funcMap.get("__any_to_f64");
  const boxNumIdx = ctx.funcMap.get("__box_number");
  if (kernelIdx === undefined || fromExternIdx === undefined || toF64Idx === undefined || boxNumIdx === undefined) {
    return false;
  }

  // Param 0 is `self`; the coerced arguments start at 1.
  for (let i = 1; i <= arity; i++) {
    closureFctx.body.push(
      { op: "local.get", index: i },
      { op: "call", funcIdx: fromExternIdx },
      { op: "call", funcIdx: toF64Idx },
    );
  }
  closureFctx.body.push({ op: "call", funcIdx: kernelIdx });
  closureFctx.body.push({ op: "call", funcIdx: boxNumIdx });
  return true;
}
