// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6417) Did the closure stored in a callable property lower this OMITTABLE
 * formal to `externref`? The call site must then ask for the same slot.
 *
 * `compileCallablePropertyCall` derives its argument types from the property's
 * checker signature, where an optional `number` is a plain `number` → `f64`.
 * The stored closure was lowered by one of two rules, mirrored exactly here
 * and never generalised:
 *
 * - a `function` declaration: every omittable formal without a native
 *   annotation is `externref` (`lowerParamType` / `parameterMayBeOmitted`,
 *   declarations.ts);
 * - an arrow / function expression: only a JSDoc-optional, unannotated,
 *   undefaulted formal (`@param {Number} [position= 0]`, closures.ts). A TS
 *   `(position?: number) =>` arrow keeps its f64 undefined-sentinel ABI.
 *
 * Without this the declared-f64 wrapper is the only dispatch arm, the stored
 * `(externref) -> R` closure matches none of them, and the call threw "Cannot
 * access property on null or undefined". axios' `utils.endsWith(str, search,
 * position)` is that shape, and `toFormData` calls it for every object, array
 * and Date parameter of `buildURL`.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { parameterMayBeOmitted } from "../declarations.js";
import { nativeTypeOfDeclaration } from "../native-type-annotations.js";

export function storedClosureWidensOmittableParam(ctx: CodegenContext, sym: ts.Symbol | undefined): boolean {
  const decl = sym?.valueDeclaration;
  if (decl === undefined || !ts.isParameter(decl) || !parameterMayBeOmitted(decl)) return false;
  const owner = decl.parent;
  if (ts.isFunctionDeclaration(owner)) return nativeTypeOfDeclaration(ctx.checker, decl) === null;
  if (!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) return false;
  return decl.type === undefined && decl.questionToken === undefined;
}
