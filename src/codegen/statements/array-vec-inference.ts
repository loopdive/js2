// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Usage-driven vec element inference for an `Array<any>` / initially-empty
// array binding (moved out of statements/variables.ts by #7154).
import { forEachChild, ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { resolveWasmType } from "../index.js";
import { getOrRegisterHoleyArrayType, getOrRegisterVecType } from "../registry/types.js";
export function inferArrayVecType(ctx: CodegenContext, decl: ts.VariableDeclaration): ValType | null {
  if (!ts.isIdentifier(decl.name)) return null;
  if (ctx.holeyArrayDeclarations.has(decl)) {
    return { kind: "ref_null", typeIdx: getOrRegisterHoleyArrayType(ctx) };
  }
  const varName = decl.name.text;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = decl;
  while (
    scope &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }
  if (!scope) return null;

  let inferredElemType: ts.Type | null = null;
  let inferredElemWasm: ValType | null = null;
  let mixedElementCarrier = false;
  let sawDynamicElementWrite = false;

  // (#2806) A write whose value type is purely `undefined` / `void` / `null`
  // must NOT pin the array's element kind to a numeric (i32) vec. The canonical
  // source is acorn's `var elt = (void 0); elt = <nodeRef>; elts.push(elt)`:
  // the binding's DECLARED type is `undefined`, but the runtime value is an AST
  // node reference. Letting `undefined` resolve the element type to i32 lowers
  // `elts` to an i32 vec, so every pushed reference coerces to i32 `0` — silently
  // dropping the node refs (#2801, the compiled-acorn `arguments` bug). Skip such
  // writes exactly like `any` (let a later concrete write pin the kind; if none,
  // the caller falls through to `any[]` → externref). Genuine numeric pushes
  // (`number`/`boolean` literals) still pin f64/i32 and keep the fast path.
  const isUnpinnableWriteType = (t: ts.Type): boolean =>
    (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) !== 0 &&
    (t.flags & ~(ts.TypeFlags.Any | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) === 0;

  const recordWriteType = (value: ts.Expression): void => {
    const valueType = ctx.checker.getTypeAtLocation(value);
    if (isUnpinnableWriteType(valueType)) {
      sawDynamicElementWrite = true;
      return;
    }
    const wasmType = resolveWasmType(ctx, valueType);
    if (!inferredElemType || !inferredElemWasm) {
      inferredElemType = valueType;
      inferredElemWasm = wasmType;
      return;
    }
    const sameType =
      inferredElemWasm.kind === wasmType.kind &&
      (wasmType.kind !== "ref" && wasmType.kind !== "ref_null"
        ? true
        : (inferredElemWasm as { typeIdx: number }).typeIdx === wasmType.typeIdx);
    if (!sameType) mixedElementCarrier = true;
  };

  function visit(node: ts.Node) {
    // (#7154) The binding shares its vec with another binding (`cur = b`,
    // `const alias = arr`): a pinned slot whose representation differs from
    // the other binding's converts by COPYING, so a later push on one is lost
    // on the other. Keep the dynamic carrier both share instead.
    if (ts.isIdentifier(node) && node.text === varName && node !== decl.name) {
      const partner = sharePartnerOf(node);
      if (partner && ctx.oracle.variableDeclarationOf(node) === decl && partnerIsDynamic(ctx, partner)) {
        sharesVec = true;
      }
    }
    // arr[i] = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === varName
    ) {
      const writeDecl = ctx.oracle.variableDeclarationOf(node.left.expression);
      if (writeDecl === decl) recordWriteType(node.right);
    }

    // arr.push(value)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === varName &&
      ctx.oracle.variableDeclarationOf(node.expression.expression) === decl &&
      node.arguments.length >= 1
    ) {
      for (const argument of node.arguments) recordWriteType(argument);
    }

    // (#7154) arr.unshift(value) / arr.fill(value) / arr.splice(i, n, ...values)
    // also store into the vec. They only constrain an element kind a push or
    // index write pinned (below), so a program with none of those keeps its
    // checker-typed slot byte-identical.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === varName &&
      ctx.oracle.variableDeclarationOf(node.expression.expression) === decl
    ) {
      const method = node.expression.name.text;
      const stored =
        method === "unshift"
          ? node.arguments
          : method === "fill"
            ? node.arguments.slice(0, 1)
            : method === "splice"
              ? node.arguments.slice(2)
              : [];
      secondaryStores.push(...stored);
    }

    forEachChild(node, visit);
  }

  const secondaryStores: ts.Expression[] = [];
  let sharesVec =
    decl.initializer !== undefined &&
    !isFreshArrayExpression(decl.initializer) &&
    partnerIsDynamic(ctx, decl.initializer);
  visit(scope);
  if (!inferredElemType && !sawDynamicElementWrite) return null;
  // Only a share between two `any` / `unknown` element sides needs it (both
  // resolve to the dynamic carrier). A typed `T[]` side pins its typed vec and
  // an `any[]` partner of it infers the same vec from the same stores, as
  // before #7154, so forcing one side generic would split the layout.
  if (sharesVec && declaredElementIsDynamic(ctx, decl)) sawDynamicElementWrite = true;
  // (#7154) A non-empty literal initializer seeds elements of its own kind:
  // `const a: any[] = [1]; a.push([2])` must not pin a vec-of-vec slot that
  // coerces the seeded `1` to null. Holes and spreads are not single typed
  // values, so they force the dynamic carrier.
  if (decl.initializer && ts.isArrayLiteralExpression(decl.initializer)) {
    for (const element of decl.initializer.elements) {
      if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) sawDynamicElementWrite = true;
      else secondaryStores.push(element);
    }
  }
  for (const value of secondaryStores) {
    if (ts.isSpreadElement(value)) sawDynamicElementWrite = true;
    else recordWriteType(value);
  }

  // Heterogeneous queue/scratch arrays must preserve every JS value. ReactDOM's
  // concurrentQueues stores [fiber, queue, update, lane] in one initially-empty
  // array; committing to the first ref shape coerced the update/lane writes and
  // later made `update.next = update` operate on boolean false.
  const elemWasm: ValType = mixedElementCarrier || sawDynamicElementWrite ? { kind: "externref" } : inferredElemWasm!;
  const elemKey =
    elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
      ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
      : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/** (#7154) The binding's declared element type is `any` or `unknown`. */
function declaredElementIsDynamic(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  const fact = ctx.oracle.typeFactOf(decl.name);
  return fact.kind === "array" && (fact.element.kind === "any" || fact.element.kind === "unknown");
}

/** (#7154) An expression that yields a vec no other binding can name yet. */
function isFreshArrayExpression(expression: ts.Expression): boolean {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) {
    inner = inner.expression;
  }
  return ts.isArrayLiteralExpression(inner) || ts.isCallExpression(inner) || ts.isNewExpression(inner);
}

/**
 * (#7154) The other side when this use of an array binding copies the
 * reference to or from another place: `other = arr`, `const other = arr`, or
 * `arr = other` with a right side that is not a fresh array.
 */
function sharePartnerOf(identifier: ts.Identifier): ts.Expression | ts.BindingName | undefined {
  let use: ts.Node = identifier;
  while (
    ts.isParenthesizedExpression(use.parent) ||
    ts.isAsExpression(use.parent) ||
    ts.isNonNullExpression(use.parent)
  ) {
    use = use.parent;
  }
  const parent = use.parent;
  if (ts.isVariableDeclaration(parent)) return parent.initializer === use ? parent.name : undefined;
  if (!ts.isBinaryExpression(parent) || parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  if (parent.right === use) return parent.left;
  return parent.left === use && !isFreshArrayExpression(parent.right) ? parent.right : undefined;
}

/**
 * (#7154) The share partner also holds the dynamic carrier: a binding, field
 * or element whose declared element type is `any` / `unknown`. Any other
 * non-fresh expression (`c ? [] : [1]`, `x || []`) has no single binding to
 * agree with, so it keeps the dynamic carrier.
 */
function partnerIsDynamic(ctx: CodegenContext, partner: ts.Expression | ts.BindingName): boolean {
  let inner: ts.Node = partner;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) {
    inner = inner.expression;
  }
  if (!ts.isIdentifier(inner) && !ts.isPropertyAccessExpression(inner) && !ts.isElementAccessExpression(inner)) {
    return true;
  }
  const fact = ctx.oracle.typeFactOf(inner);
  return fact.kind === "array" && (fact.element.kind === "any" || fact.element.kind === "unknown");
}
