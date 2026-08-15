// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4442) THE single standalone `%Function%` value emitter, and the
 * `<fn>.constructor` arm that reads it (§20.2.3.1, R6 of #4440).
 *
 * ## The defect
 *
 * `<function value>.constructor` answered `undefined` for every AOT-compiled
 * closure. Measured on this branch's base with the real `runTest262File`
 * (`--target standalone`), before this change:
 *
 * | probe (`function g(a,b){}`)          | base       | spec       |
 * | ------------------------------------ | ---------- | ---------- |
 * | `g.constructor`                      | `undefined`| `%Function%` |
 * | `g.constructor === h.constructor`    | `true`     | `true` — but as `undefined === undefined`, a tautology |
 * | `g.constructor.length`               | **THREW**  | `1`        |
 * | module imports for `g.constructor`   | `[]`       | `[]`       |
 * | module imports for `g.constructor === Function` | `[js2wasm:runtime-eval]` | unavoidable, see below |
 *
 * Note the last row, because it decides the design: **a module cannot compare
 * against `Function` and stay host-free**, since reading the bare `Function`
 * value is itself a runtime-eval boundary site (`intrinsic-value`,
 * `providerDisposition: "required"`). `.constructor` is therefore the only
 * demand for `%Function%` a host-free module can make — which is exactly what
 * the self-contained arm below exists to serve.
 *
 * ## Why #4440 built the fix twice and shipped neither
 *
 * #4440's R6 record has the two attempts and their measurements:
 *
 *   1. **`__builtin_ctor_Function` carrier** — adding `"Function"` to
 *      `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES`. Produced a genuine identity-stable
 *      object, and `f.constructor === Function` was **still false**: the BARE
 *      `Function` identifier read does not route through
 *      `emitBuiltinConstructorIdentity`, so the two sides were two
 *      self-consistent objects that are not each other.
 *   2. **A synthetic bare-`Function` identifier read** on the `.constructor`
 *      arm. This WORKED (+9/−1 over the 509-file `built-ins/Function`
 *      directory) and was dropped anyway, because that read resolves through
 *      `emitStandaloneIntrinsicFunctionValue` → `js2wasm:runtime-eval`, so
 *      **every** `.constructor`-reading standalone module stopped being
 *      host-free. No gate measures standalone-ness, so it would have shipped
 *      silently against the point of the `standalone-gap` goal (#2860).
 *
 * Both failures are the same failure: `%Function%` had no ONE emitter, so the
 * two sides of `f.constructor === Function` were free to disagree, and the only
 * emitter that existed pulled the provider.
 *
 * ## What this module is
 *
 * ONE function — {@link emitStandaloneFunctionIntrinsicValue} — that every
 * `%Function%` consumer calls, dispatching on a module-level fact that is fixed
 * BEFORE any lowering runs:
 *
 * | module kind (does the source read the BARE `Function` value?) | `%Function%` is |
 * | -------------------------------------------------------------- | --------------- |
 * | YES — an `intrinsic-value` site named `Function` in the boundary plan | the provider's realm-owned intrinsic (`emitStandaloneIntrinsicFunctionValue`) |
 * | NO                                                              | a self-contained `__builtin_ctor_Function` singleton — zero imports |
 *
 * Identity then holds **within each module by construction**, which is the
 * property the two rejected attempts each lacked, and it holds without any
 * flow analysis: the answer is one boolean per module, so two reads in one
 * program cannot take different arms. See
 * {@link moduleReadsBareFunctionValue} for why the question is that narrow one
 * and not the broader "does this module touch the runtime-eval boundary".
 *
 * ### Why the provider still wins when it is linked
 *
 * In a provider-linked module `%Function%` must stay CALLABLE: `var F =
 * Function; F("a", "return a")` loads the value from the binding at the call
 * site (`resolvesToGlobalFunctionAlias`, eval-inline.ts) and calls it. A plain
 * `$Object` carrier has no [[Call]], so serving the carrier there would trade
 * an identity bug for a call bug. It must also stay identity-equal to the
 * value the PROVIDER hands back for an interpreted function's `.constructor`.
 * Both are satisfied by keeping today's route — the change is that the
 * `.constructor` arm now takes that same route instead of answering
 * `undefined`.
 *
 * ### Why the provider-free arm cannot regress host-freeness
 *
 * The self-contained arm is reachable exactly when the boundary plan found no
 * bare `Function` VALUE read (`intrinsic-value` + `intrinsicName: "Function"`,
 * ir/runtime-eval-boundary-plan.ts). So a module that reaches the carrier arm
 * provably contains no bare `Function` read to disagree with, and the arm
 * itself emits only `__new_plain_object` / `__defineProperty_value` — defined
 * functions, never imports. `tests/issue-4442.test.ts` asserts the import list
 * is empty rather than trusting that argument.
 *
 * ## The `.constructor` arm's shape
 *
 * `constructor` is an INHERITED property (§20.2.3.1 puts it on
 * `Function.prototype`), not an own one, so the arm lives in the
 * property-access dispatcher and adds nothing to `getOwnPropertyNames` /
 * `hasOwnProperty` / gOPD — the #4436/#4437 own-property surfaces are
 * deliberately untouched. It fires on a receiver whose STATIC type is
 * function-like and declines when the module writes or deletes a `constructor`
 * property anywhere (`moduleTouchesConstructorProp`), because an own
 * `constructor` must shadow the inherited one and the arm never consults the
 * receiver's own properties.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { emitBuiltinConstructorIdentity } from "./builtin-static-globals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitStandaloneIntrinsicFunctionValue } from "./expressions/eval-inline.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { moduleTouchesConstructorProp } from "./property-access.js";
import { compileExpression } from "./shared.js";

/**
 * Does this module read the BARE `Function` value anywhere?
 *
 * Read from `ctx.runtimeEvalBoundaryPlan`, which `compile*` builds from the
 * whole program BEFORE codegen starts (`buildIrRuntimeEvalBoundaryPlan`), so
 * the answer is a module-level constant rather than something that depends on
 * how far lowering has got. That is what makes the two arms below
 * identity-safe: every `%Function%` read in one module takes the same one.
 *
 * ### Why this, and not `callableBoundaryRequired`
 *
 * The first cut asked the broader question — "does this module touch the
 * runtime-eval boundary at all?" — and it was measurably too broad. A module
 * with a FOLDABLE `eval("1")` plus a `<fn>.constructor` read links no provider
 * on base, and under the broad predicate it started linking one:
 *
 * | `var z = eval("1"); function g(){} … g.constructor …` | imports |
 * | ----------------------------------------------------- | ------- |
 * | base                                                   | `[]`    |
 * | broad predicate (`callableBoundaryRequired`)           | `[js2wasm:runtime-eval]` |
 * | this predicate                                         | `[]`    |
 *
 * Silently adding that import is the EXACT failure that stopped #4440's fix
 * from shipping, so the narrow question is the correct one: the only thing the
 * provider's `%Function%` buys is agreeing with a bare `Function` read, and if
 * the module never spells `Function` there is nothing to agree with. Everything
 * else the provider does for an interpreted function (its own `.constructor`
 * field) is overridden by the arm anyway, uniformly, so the module stays
 * self-consistent.
 *
 * The site list's carve-outs come along for free, and they matter: a
 * `Function.prototype.call.bind(…)` chain (test262's `propertyHelper.js`, i.e.
 * a large fraction of the corpus) is deliberately NOT a site, so those modules
 * keep the self-contained carrier — whereas `Function.prototype.constructor`
 * IS one, because it must equal a bare `Function` read.
 */
export function moduleReadsBareFunctionValue(ctx: CodegenContext): boolean {
  const sites = ctx.runtimeEvalBoundaryPlan?.sites;
  if (sites === undefined) return false;
  return sites.some((site) => site.kind === "intrinsic-value" && site.intrinsicName === "Function");
}

/**
 * Push the realm's `%Function%` value. Standalone only — returns `undefined`
 * having pushed NOTHING otherwise, so callers can gate after the fact.
 *
 * Stack: `[] → [externref]` on success.
 */
export function emitStandaloneFunctionIntrinsicValue(ctx: CodegenContext, fctx: FunctionContext): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (moduleReadsBareFunctionValue(ctx)) return emitStandaloneIntrinsicFunctionValue(ctx, fctx);
  // Self-contained arm. `Function` already carries `length: 1` in
  // `BUILTIN_CTOR_ARITY`, so #3006's carrier machinery seeds the §20.2.2 own
  // properties (`length`, `name`, `prototype`) and #4120's callable brand
  // (`typeof === "function"`) with no new table entry.
  return emitBuiltinConstructorIdentity(ctx, fctx, "Function");
}

/**
 * Does `type` denote a FUNCTION value — the receiver shape whose
 * `.constructor` is `%Function%` (§20.2.3.1)?
 *
 * Two accepted shapes, and the second is the load-bearing one:
 *
 *   - a type with call signatures (`function g(){}`, an arrow, a method value);
 *   - the ambient `Function` interface itself, which is what `new Function(…)`
 *     is typed as and therefore what every `built-ins/Function` test's receiver
 *     is. It has NO call signatures in lib.d.ts (it declares `apply`/`call`/
 *     `bind`, not a signature), so the first test alone misses exactly the
 *     family this arm exists for.
 *
 * CLASS values are deliberately excluded even though `C.constructor` is also
 * `%Function%`: a class value's type has construct signatures and its own
 * `.constructor` lowering (`class-proto-object.ts`), and widening into it would
 * change reads this slice has not measured.
 */
export function isFunctionValuedReceiverType(type: ts.Type): boolean {
  if (type.getConstructSignatures().length > 0 && type.getSymbol()?.name !== "Function") return false;
  if (type.getCallSignatures().length > 0) return true;
  const name = type.getSymbol()?.name;
  return name === "Function" || name === "CallableFunction" || name === "NewableFunction";
}

/**
 * The `<function value>.constructor` arm itself (§20.2.3.1) — the whole thing,
 * so `property-access-dispatch.ts` spends four lines on it rather than growing
 * a subsystem inside the dispatcher (#3102's rule, and the reason this module
 * exists rather than a patch at the call site).
 *
 * Returns the pushed type, or `undefined` having pushed NOTHING when the arm
 * declines — so the caller can splice it unconditionally between two other
 * `constructor` arms.
 *
 * The DECLINE conditions, in order:
 *   - not standalone (gc/host keeps its genuine `Object_get_constructor` read);
 *   - the key is not `constructor`, or the receiver is not function-valued;
 *   - the module WRITES or DELETES a `constructor` property anywhere. An own
 *     `constructor` must shadow the inherited one and this arm never consults
 *     the receiver's own properties, so it steps aside for the whole module —
 *     the same conservative module-wide gate #4223 uses for the wrapper arm.
 */
export function tryEmitFunctionValueConstructorRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
): ValType | undefined {
  if (!ctx.standalone || propName !== "constructor") return undefined;
  if (!isFunctionValuedReceiverType(objType)) return undefined;
  if (moduleTouchesConstructorProp(expr.getSourceFile())) return undefined;

  // Spec order: the object expression is evaluated for its side effects before
  // the property is read; the identity itself does not depend on it.
  const objResult = compileExpression(ctx, fctx, expr.expression);
  if (objResult) fctx.body.push({ op: "drop" });
  const intrinsic = emitStandaloneFunctionIntrinsicValue(ctx, fctx);
  if (intrinsic !== undefined) return intrinsic.kind === "externref" ? intrinsic : { kind: "externref" };
  // The emitter declined AFTER the receiver was consumed (it can only do that
  // by refusing before pushing anything, but the receiver is already gone) —
  // push the pre-#4442 answer rather than leaving the stack short.
  emitUndefined(ctx, fctx);
  return { kind: "externref" };
}
