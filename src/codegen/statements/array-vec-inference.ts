// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Usage-driven vec element inference for an `Array<any>` / initially-empty
// array binding (moved out of statements/variables.ts by #7154).
import { forEachChild, ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { resolveWasmType } from "../index.js";
import { getOrRegisterHoleyArrayType, getOrRegisterVecType } from "../registry/types.js";
import { shareGroupIsDynamic, skipValueWrappers } from "./array-share-group.js";
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
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === varName &&
      ctx.oracle.variableDeclarationOf(node.left) === decl
    ) {
      seedLiterals.push(node.right);
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
  const seedLiterals: ts.Expression[] = [];
  visit(scope);
  if (!inferredElemType && !sawDynamicElementWrite) return null;
  // (#7154) The binding shares its vec with other places (`cur = b`,
  // `const alias = arr`): a pinned slot whose representation differs from the
  // other place's converts by COPYING, so a later push on one is lost on the
  // other. When the whole share group is `any` / `unknown` element bindings
  // and array literals, they all take the dynamic carrier. Any typed member
  // (a `T[]`, a call returning one, a bare `any` value) keeps every member on
  // the layout it infers, as before #7154.
  if (shareGroupIsDynamic(ctx, decl)) sawDynamicElementWrite = true;
  // (#7154) A non-empty literal initializer seeds elements of its own kind:
  // `const a: any[] = [1]; a.push([2])` must not pin a vec-of-vec slot that
  // coerces the seeded `1` to null. Holes and spreads are not single typed
  // values, so they force the dynamic carrier.
  // An array literal assigned later (`xs = [1]`) seeds the same way.
  if (decl.initializer) seedLiterals.push(decl.initializer);
  for (const seed of seedLiterals) {
    const literal = skipValueWrappers(seed);
    if (!ts.isArrayLiteralExpression(literal)) continue;
    for (const element of literal.elements) {
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
