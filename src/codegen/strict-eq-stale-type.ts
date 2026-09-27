// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Runtime-carrier guards for expressions whose checker type is stale after
 * an indexed or union-alias object property write. Arithmetic, storage and
 * output consumers must preserve that value until the actual JS operation.
 */
import { ts } from "../ts-api.js";
import { moduleGlobalIsDynamicButStaticallyPrimitive } from "./declarations/heterogeneous-scalar-var-widening.js";
import { paramReadIsJsDefaultGuess } from "./js-default-param-type-guess.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

const indexedStaleProperties = new WeakMap<CodegenContext, Set<ts.Declaration>>();

export function markIndexedPropertyStale(ctx: CodegenContext, property: ts.Declaration): void {
  let stale = indexedStaleProperties.get(ctx);
  if (stale === undefined) {
    stale = new Set<ts.Declaration>();
    indexedStaleProperties.set(ctx, stale);
  }
  stale.add(property);
}

/** Whether a value derives from a property whose carrier was widened. */
export function expressionHasWidenedPropertyType(
  ctx: CodegenContext,
  expr: ts.Expression,
  seen?: Set<ts.Node>,
): boolean {
  if (!indexedStaleProperties.get(ctx)?.size) return false;
  seen ??= new Set<ts.Node>();
  if (seen.has(expr)) return false;
  seen.add(expr);
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    expr = expr.expression;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (
      expressionHasWidenedPropertyType(ctx, expr.left, seen) || expressionHasWidenedPropertyType(ctx, expr.right, seen)
    );
  }

  if (ts.isIdentifier(expr) && ctx.objectLiteralIndexedAssignedPropertyTypes.size > 0) {
    const declaration = ctx.oracle.valueDeclarationOf(expr);
    if (declaration && ts.isVariableDeclaration(declaration) && !declaration.type && declaration.initializer) {
      return expressionHasWidenedPropertyType(ctx, declaration.initializer, seen);
    }
  }

  let key: string | undefined;
  let receiver: ts.Expression | undefined;
  let propertyNode: ts.Node | undefined;
  if (ts.isPropertyAccessExpression(expr)) {
    key = expr.name.text;
    receiver = expr.expression;
    propertyNode = expr.name;
  } else if (ts.isElementAccessExpression(expr)) {
    propertyNode = expr.argumentExpression;
    let keyExpr: ts.Expression = expr.argumentExpression;
    while (
      ts.isParenthesizedExpression(keyExpr) ||
      ts.isAsExpression(keyExpr) ||
      ts.isSatisfiesExpression(keyExpr) ||
      ts.isTypeAssertionExpression(keyExpr) ||
      ts.isNonNullExpression(keyExpr)
    ) {
      keyExpr = keyExpr.expression;
    }
    if (ts.isStringLiteralLike(keyExpr)) {
      key = keyExpr.text;
    } else if (ts.isNumericLiteral(keyExpr)) {
      const numericKey = Number(keyExpr.text);
      if (Number.isFinite(numericKey)) key = String(numericKey);
    }
    receiver = expr.expression;
  }
  if (receiver === undefined || key === undefined) return false;
  const property =
    (propertyNode ? ctx.oracle.declarationsOf(propertyNode)[0] : undefined) ?? ctx.oracle.declarationsOf(expr)[0];
  const stale = property !== undefined && indexedStaleProperties.get(ctx)?.has(property) === true;
  if (!stale) return false;
  const propertyKey = key;
  const propertyReceiver = receiver;
  return (
    ctx.oracle.typeFactOf(propertyReceiver).kind === "object" &&
    ctx.oracle.propertyFactOf(propertyReceiver, propertyKey).kind !== "unresolvable"
  );
}

// (#6651 VR1) Fourth stale carrier, same kind as the three below: an
// evolving-`any` binding (`var x;` — no annotation, no initializer) whose only
// assignments live inside a NESTED function. TypeScript's control-flow analysis
// does not cross a function boundary, so at a reference in the declaring
// function it reports the evolving type's start state, `undefined`. That is not
// a sound upper bound on the runtime value — it is a statement that CFA saw no
// assignment REACHING this point, which the nested assignment falsifies.
//
// Measured shape (test262
// `built-ins/TypedArray/prototype/slice/speciesctor-get-species-custom-ctor-invocation.js`):
// `var ctorThis;` is assigned `this` inside the @@species constructor, so the
// checker answers `undefined` (`ts.TypeFlags.Undefined`) at
// `ctorThis instanceof S` while the runtime value is a live object whose
// `[[Prototype]]` is `S.prototype`. Every consumer that reads the RUNTIME value
// answers correctly there (`===`, `typeof`, `Object.getPrototypeOf`, and a
// ternary over the same read, whose join goes through `coerceType`); only the
// consumers that fold on the STATIC type are wrong.
//
// Deliberately pinned to a narrowing of exactly `undefined` / `null`: that is
// the evolving type's start state, i.e. the one narrowing the cross-function
// assignment directly contradicts. A binding CFA narrowed to some other type
// (`var x; x = 1; … x`) had an in-flow assignment it did see, which is a
// different question and is left alone.
const crossFunctionAssignedAutoBindings = new WeakMap<ts.Declaration, boolean>();

function functionLikeContainer(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

/**
 * True when `expr` reads an evolving-`any` binding that is assigned from inside
 * a function nested in the binding's own scope — so the checker's `undefined`
 * narrowing at this reference is stale, not a fact.
 */
export function autoBindingNarrowedAcrossFunctionBoundary(
  ctx: CodegenContext,
  expr: ts.Expression,
  narrowed: ts.Type,
): boolean {
  if ((narrowed.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0) return false;
  if (!ts.isIdentifier(expr)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(expr);
  if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
  if (declaration.type || declaration.initializer || !ts.isIdentifier(declaration.name)) return false;
  const cached = crossFunctionAssignedAutoBindings.get(declaration);
  if (cached !== undefined) return cached;
  const owner = functionLikeContainer(declaration);
  let found = false;
  if (owner) {
    const name = declaration.name.text;
    const visit = (node: ts.Node, depth: number): void => {
      if (found) return;
      if (
        depth > 0 &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        node.left.text === name &&
        ctx.oracle.valueDeclarationOf(node.left) === declaration
      ) {
        found = true;
        return;
      }
      const nextDepth = ts.isFunctionLike(node) ? depth + 1 : depth;
      ts.forEachChild(node, (child) => visit(child, nextDepth));
    };
    ts.forEachChild(owner, (child) => visit(child, 0));
  }
  crossFunctionAssignedAutoBindings.set(declaration, found);
  return found;
}

/** Equality also observes pre-existing dynamic module/for-in carriers. */
export function equalityOperandHasStaleStaticType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): boolean {
  return (
    (ts.isIdentifier(expr) &&
      (fctx.forInIdentifierVars?.has(expr.text) === true || moduleGlobalIsDynamicButStaticallyPrimitive(ctx, expr))) ||
    // (#6651 C3) Third stale carrier, same kind as the two above: a JS
    // defaulted parameter's checker type is read off its own initializer, so
    // the §7.2.16 step-1 fold in `binary-ops-typed-dispatch` decided
    // `Type(number) !== Type(boolean)` and answered a constant `false` for
    // `a === false` without ever reading the boxed boolean that arrived.
    paramReadIsJsDefaultGuess(ctx, expr) ||
    expressionHasWidenedPropertyType(ctx, expr)
  );
}
