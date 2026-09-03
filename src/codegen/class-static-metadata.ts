// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static metadata for class objects.
 *
 * A compiled class object is a closed WasmGC carrier rather than an ordinary
 * `$Object`.  Keep the constructor's standard own keys and its declared own
 * static method keys in one small codegen helper so class-specific lowering
 * does not have to infer them from the carrier's instance shape.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { fnInstanceNameOf } from "./function-instance-meta.js";

/** The own keys created by a class constructor before static declarations. */
export const CLASS_CONSTRUCTOR_OWN_KEYS = ["length", "name", "prototype"] as const;

/**
 * Resolve a direct class identifier to the canonical class identity used by
 * `classSet` and the class metadata maps.  Transparent wrappers are accepted
 * because TypeScript commonly inserts them around an expression used at an
 * externref boundary.
 */
export function classIdentityFromExpression(ctx: CodegenContext, expression: ts.Expression): string | undefined {
  let bare = expression;
  while (
    ts.isParenthesizedExpression(bare) ||
    ts.isAsExpression(bare) ||
    ts.isTypeAssertionExpression(bare) ||
    ts.isNonNullExpression(bare)
  ) {
    bare = bare.expression;
  }
  if (!ts.isIdentifier(bare)) return undefined;
  const className = ctx.classExprNameMap.get(bare.text) ?? bare.text;
  return ctx.classSet.has(className) ? className : undefined;
}

/**
 * Return the own string keys of a class constructor in ECMAScript order for
 * the metadata currently collected by class-bodies.ts. Static accessors named
 * `name`/`length` are already represented by the standard constructor keys;
 * static methods with those names replace their value without adding another
 * key, so only non-standard static method names are appended.
 */
export function classStaticOwnPropertyNames(ctx: CodegenContext, className: string): string[] {
  const names: string[] = [...CLASS_CONSTRUCTOR_OWN_KEYS];
  for (const methodName of ctx.classStaticMethodNames.get(className) ?? []) {
    if (!names.includes(methodName)) names.push(methodName);
  }
  return names;
}

/**
 * True when `className.propertyName` is a declared static method. This is used
 * only for the two constructor metadata keys whose intrinsic TypeScript types
 * (`string`/`number`) are replaced by a static method at class evaluation.
 */
export function hasClassStaticMethod(ctx: CodegenContext, className: string, propertyName: string): boolean {
  return ctx.staticMethodSet.has(`${className}_${propertyName}`);
}

/**
 * (#5271 step 7, G2) The OBSERVABLE `name` of a class object.
 *
 * `classIdentity` is the compiler's registry key. For an anonymous class
 * EXPRESSION that key is the synthetic `__anonClass_<n>` id assigned during
 * collection — a compiler-internal identifier that must never surface as a
 * property value. `Object.getOwnPropertyDescriptor(class {}, 'name').value`
 * reported exactly that (`"__anonClass_0"` where §10.2.9 NamedEvaluation says
 * the binding's name, `"cls"`).
 *
 * `fnInstanceNameOf` is the shared §10.2.9 answer: a named class expression
 * keeps its own name, an anonymous one takes the binding it is defined into,
 * and anything unresolvable answers `""` — which is also the spec answer for a
 * genuinely anonymous class value.
 */
export function classObjectDisplayName(ctx: CodegenContext, classIdentity: string): string {
  if (!classIdentity.startsWith("__anonClass_")) return classIdentity;
  for (const [declaration, synthetic] of ctx.anonClassExprNames) {
    if (synthetic === classIdentity) return fnInstanceNameOf(declaration);
  }
  return "";
}
