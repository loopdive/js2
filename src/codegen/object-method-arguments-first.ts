// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A11) §10.2.11 step 22 for an OBJECT-LITERAL method: the arguments
 * object exists BEFORE the formals are initialised, so a parameter default may
 * read it — `{ *method(x = arguments[2], y = arguments[3], z) {} }`
 * (`object/method-definition/params-dflt{,-gen}-meth-ref-arguments.js`).
 *
 * Lane A1 (2026-09-24) reordered four lowering paths (declarations, nested
 * declarations, lifted function expressions); the struct-lane object-literal
 * method in `literals.ts` was a fifth. It compiled the defaults first, so the
 * default read `arguments` before its local existed and threw "Cannot access
 * property on null or undefined". Same rule as A1: only a NON-SIMPLE parameter
 * list is reordered — the only shape with a default to order against, and one
 * whose arguments object is already unmapped (step 22.a), so no param aliasing
 * moves. The argc cache is taken first, because building the object consumes
 * `__argc` (see `precacheParamDefaultArgc`).
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { bodyLexicallyBindsArguments, needsImplicitArgumentsObject } from "./helpers/body-uses-arguments.js";
import { isSimpleParameterList } from "./helpers/is-strict-function.js";
import { emitArgumentsObject } from "./shared.js";
import { cacheParamDefaultArgc, paramDefaultNeedsArgc } from "./statements/nested-declarations.js";

/**
 * Build the method's arguments object ahead of its defaults when the list is
 * non-simple. `fctxParams` are the method's wasm params, receiver first.
 * Returns whether it emitted.
 */
export function argumentsBeforeDefaults(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: ts.MethodDeclaration,
  fctxParams: readonly { type: ValType }[],
): boolean {
  if (isSimpleParameterList(method.parameters) || !needsImplicitArgumentsObject(method)) return false;
  const paramTypes = fctxParams.slice(1).map((p) => p.type); // skip 'this'
  if (method.parameters.some((p, i) => p.initializer !== undefined && paramDefaultNeedsArgc(paramTypes[i]))) {
    cacheParamDefaultArgc(ctx, fctx);
  }
  emitArgumentsObject(ctx, fctx, paramTypes, /* skip 'this' */ 1, /* unmapped, step 22.a */ true, method.parameters);
  return true;
}

/**
 * After the defaults, for a method {@link argumentsBeforeDefaults} handled
 * (`hoisted`): a body `let arguments` is a SEPARATE binding shadowing the
 * object for the whole body, so the body's declaration needs its own slot
 * (A1's `bodyLexicallyBindsArguments` doc). Returns `hoisted`, so the
 * caller's ordinary emission point can skip on it.
 */
export function endArgumentsBeforeDefaults(
  fctx: FunctionContext,
  method: ts.MethodDeclaration,
  hoisted: boolean,
): boolean {
  if (hoisted && method.body && bodyLexicallyBindsArguments(method.body)) fctx.localMap.delete("arguments");
  return hoisted;
}
