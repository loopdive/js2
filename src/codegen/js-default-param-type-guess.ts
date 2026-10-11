// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster C, slice C3) A defaulted parameter in a JAVASCRIPT source file
 * has no type. The checker reports one anyway, read off the parameter's own
 * default initializer, and that report is a statement about ONE call.
 *
 * ## The defect
 *
 * `method(aFalse = falseCount += 1)` infers `aFalse: number`, so
 * `resolveWasmType` gives it an `f64` slot and `C.prototype.method(false)`
 * arrives as `0` — the test262 signature `Expected SameValue(«0», «false»)`,
 * carried by 10 rows of the cluster-C manifest and 2 of cluster G (measured on
 * this branch's base, `--standalone --isolate`). `method(aString = c += 1)`
 * called with `''` is the same defect wearing a different value.
 *
 * The cluster's OTHER 8 rows read `SameValue(«NaN», «undefined»)` and are a
 * DIFFERENT defect, which this rule does not move: measured unchanged before
 * and after, `function g({ w: [x,y,z] } = { w: [7, undefined, ] }) {}` called
 * with no argument reads `z` as JS `null` where §13.3.3.7 says `undefined`,
 * only when the WHOLE-parameter default object is the one materialized.
 *
 * This generalises #5360, which fixed exactly the `= undefined` / `= null`
 * spelling ({@link widenUndefinedDefaultParamSlot},
 * `paramUndefinedTypeIsDefaultArtifact`). That slice keyed on the SHAPE of the
 * initializer because in a `.ts` file `b = undefined` is the one default whose
 * inferred type is never a usable contract. In a `.js` file **no** default
 * yields a contract: there is no annotation the author could have written that
 * the checker would then enforce at every call site. So the gate here is the
 * FILE, and the rule it produces is the one JavaScript already has — every
 * unannotated parameter is dynamic, defaulted or not. (An unannotated
 * parameter WITHOUT a default is already `any` ⇒ externref; the defaulted one
 * was the anomaly.)
 *
 * ## Two halves, and one alone is worse than neither
 *
 * - **Slot** — {@link paramTypeIsJsDefaultGuess} widens the parameter to
 *   `externref` in {@link widenUndefinedDefaultParamSlot}, which every
 *   parameter-list derivation applies: the class-method collection phase and
 *   its fctx-build twin, the function-declaration lane, the closure lane and
 *   the three object-literal-method lanes. #5221 recorded what a partial
 *   application costs — widening ONE derivation turned a wrong answer into a
 *   thrown "Cannot access property on null or undefined", because the stored
 *   closure's `ref.test` then failed.
 * - **Read** — {@link paramReadIsJsDefaultGuess}. The prologue was already
 *   right (`__extern_is_undefined` gates the default), but the next
 *   instruction at every use was `call $__unbox_number`: an identifier read
 *   re-narrows an externref local to the checker's type, and the strict-equality
 *   arm folds `Type(number) !== Type(boolean)` to a constant `false` without
 *   ever reading the value. Widening the slot alone just moves the coercion one
 *   instruction later — measured, `typeof a` answered `"number"` for an
 *   argument that had arrived as a boxed boolean.
 *
 * Both halves refuse the same three things, for the reason each sibling
 * predicate already refuses them: an explicit annotation (`a: number` is a
 * chosen lowering, and `param.type === undefined` also implies no
 * `type i32 = number` native pin, since `nativeTypeOfDeclaration` reads only
 * `decl.type`), either JSDoc spelling (`@param {number=} x` /
 * `@param {number} [x]` — the pair `parameterMayBeOmitted` has always ORed),
 * and a rest parameter.
 *
 * Scope is the SCALAR slots, by the caller's own guard. A JS default that
 * resolves to a ref (`= {}`, `= ""`) is structurally open for the identical
 * reason, and the closure lane already carries that rule locally; extending it
 * to the other lanes is an ABI change for every object-shaped parameter in
 * every npm package and is deliberately not part of this slice.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Is this parameter's checker type a guess read off its own default? */
export function paramTypeIsJsDefaultGuess(param: ts.ParameterDeclaration): boolean {
  return (
    param.type === undefined &&
    param.dotDotDotToken === undefined &&
    param.initializer !== undefined &&
    ts.getJSDocType(param) === undefined &&
    ts.getJSDocParameterTags(param).length === 0 &&
    /\.(?:[cm]?js|jsx)$/i.test(param.getSourceFile().fileName)
  );
}

/**
 * The slot decision, as ONE function every derivation calls.
 *
 * There is no single place where a parameter's Wasm type is decided: the
 * callee's own lowering has ~a dozen lanes (constructor ×4, class method ×2,
 * function declaration ×3, closure ×2, object-literal method ×3) and a CALL
 * SITE independently rebuilds a candidate signature from the checker to match
 * a stored closure against it. Every one of those must reach the same answer.
 * A disagreement is not a wrong value — it is a failed `ref.test` on the
 * stored closure, which surfaces as an uncaught throw at the call
 * (`function outer(f = function (q = 2) { return q; }) { return f(7); }`
 * measured: correct on the base, uncaught Wasm exception when only the callee
 * side was widened).
 *
 * Accepts any node so the symbol-driven call sites can pass
 * `sig.parameters[i]?.valueDeclaration` without a local type test.
 */
export function widenJsDefaultGuessSlot(decl: ts.Node | undefined, wasmType: ValType): ValType {
  if (decl === undefined || !ts.isParameter(decl) || !paramTypeIsJsDefaultGuess(decl)) return wasmType;
  if (wasmType.kind !== "i32" && wasmType.kind !== "f64" && wasmType.kind !== "i64") return wasmType;
  return { kind: "externref" };
}

/** {@link widenJsDefaultGuessSlot} for a call site holding the parameter SYMBOL. */
export function widenJsDefaultGuessSymbolSlot(sym: ts.Symbol | undefined, wasmType: ValType): ValType {
  return widenJsDefaultGuessSlot(sym?.valueDeclaration ?? sym?.declarations?.[0], wasmType);
}

/**
 * Does `expr` READ such a parameter?
 *
 * Callers must already have established that the value is on the dynamic
 * carrier — the identifier-read narrowing gate requires
 * `declaredType.kind === "externref"`, and the equality fold requires an
 * externref operand. That is what keeps this from disabling a SOUND narrowing
 * or fold for a parameter this rule never widened.
 *
 * The declaration query goes through `ctx.oracle.declarationsOf` (#1930/#3273)
 * — the question is about the declaration's SYNTAX, not about a type, which is
 * exactly what `paramUndefinedTypeIsDefaultArtifact` established beside it.
 */
export function paramReadIsJsDefaultGuess(ctx: CodegenContext, expr: ts.Expression): boolean {
  let bare: ts.Expression = expr;
  while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
  if (!ts.isIdentifier(bare)) return false;
  for (const decl of ctx.oracle.declarationsOf(bare)) {
    if (ts.isParameter(decl) && paramTypeIsJsDefaultGuess(decl)) return true;
  }
  return false;
}
