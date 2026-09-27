// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster C, C2) `C.prototype.<name> = value` — the two predicates that
 * make the TOP-LEVEL form of that statement compile at all in standalone.
 *
 * ## The defect
 *
 * The module-init keep analysis (`declarations.ts`) retains a top-level
 * `C.<name> = …` STATIC write on a compiled class, and the host lane retains
 * `F.prototype.m = …` for a top-level FUNCTION. Neither arm matches a CLASS's
 * prototype chain, so the statement fell past every keep and compiled to
 * NOTHING. Verified by instrumentation rather than inferred:
 * `compileAssignment` is never entered for it, while the identical statement
 * inside a function body is — and works.
 *
 * Measured on the branch base, standalone (`.tmp/w6651C/m7.ts`):
 *
 * ```
 * class Plain {}
 * Plain.prototype.tagy = "Y";        // dropped
 * new Plain()["tag"+"y"]             // undefined      node: "Y"
 * Plain.prototype["tag"+"y"]         // undefined      node: "Y"
 * ```
 *
 * …with an ordinary `holder.k = "H"` and a bare `ran = 5` in the SAME module
 * both landing, so this is not "module init did not run". It is not
 * Error-specific either — the probe uses a plain class. It matters well beyond
 * one shape: the honest test262 harness compiles every test body at MODULE
 * scope, where `A.prototype.fromA = 'a'` is one of the suite's commonest
 * idioms.
 *
 * ## Why two predicates, not one
 *
 * Keeping the statement is necessary but not sufficient: once it is compiled,
 * `compilePropertyAssignment` resolves the receiver's static type, and the
 * checker types `C.prototype` as the INSTANCE type `C`. For an
 * externref-backed subclass that makes the own-field-write arm claim a write
 * aimed at the PROTOTYPE object, which is never an `$Error_struct` — the cast
 * TRAPS ("illegal cast", uncatchably, taking the module with it). So the keep
 * must land together with the decline. `error-instance-field-write.ts` already
 * carries the same guard for the same reason; it was simply unreachable while
 * this statement was being dropped before compilation.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** Strip parens / `as` / `!` / `<T>` wrappers from a receiver expression. */
function unwrapReceiver(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/**
 * Is `target` a `<X>.prototype.<name>` property access?
 *
 * The decline predicate for `compilePropertyAssignment`'s externref-backed
 * own-field arm — deliberately shape-only, exactly like the guard in
 * `error-instance-field-write.ts`: what matters is that the receiver is a
 * prototype OBJECT, not which class it belongs to.
 */
export function targetReceiverIsPrototypeAccess(target: ts.PropertyAccessExpression): boolean {
  return (
    ts.isPropertyAccessExpression(target.expression) &&
    !ts.isPrivateIdentifier(target.expression.name) &&
    target.expression.name.text === "prototype"
  );
}

/**
 * Should a top-level `<Class>.prototype.<name> = value` statement be KEPT in
 * `__module_init`?
 *
 * Standalone only — the host lane has its own `F.prototype.m = …` keep for
 * top-level functions and stays byte-identical. The root must resolve to a
 * genuine class DECLARATION (the same evidence the static-write keep beside it
 * demands), so a same-named binding that is not this module's class does not
 * resurrect an unrelated statement.
 */
export function isTopLevelClassPrototypeWrite(ctx: CodegenContext, left: ts.Expression): boolean {
  if (!ctx.standalone) return false;
  if (!ts.isPropertyAccessExpression(left) || ts.isPrivateIdentifier(left.name)) return false;
  if (!ts.isPropertyAccessExpression(left.expression)) return false;
  if (ts.isPrivateIdentifier(left.expression.name) || left.expression.name.text !== "prototype") return false;
  const protoRoot = unwrapReceiver(left.expression.expression);
  if (!ts.isIdentifier(protoRoot)) return false;
  if (!ctx.classSet.has(ctx.classExprNameMap.get(protoRoot.text) ?? protoRoot.text)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(protoRoot);
  return declaration !== undefined && ts.isClassDeclaration(declaration);
}
