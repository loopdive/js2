// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Usage-driven vec element inference for an `Array<any>` / initially-empty
// array binding (moved out of statements/variables.ts by #7154).
import type { TypeFact } from "../../checker/oracle.js";
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

/** (#7154) The binding's declared element type is `any` or `unknown`. */
function declaredElementIsDynamic(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  return factIsDynamicArray(ctx.oracle.typeFactOf(decl.name));
}

/**
 * (#7154) A static type whose array value lives in the dynamic carrier: an
 * array of `any` / `unknown` (or a union of those; `null` / `undefined`
 * members are already dropped by the oracle, so `any[] | undefined` counts).
 * A bare `any` / `unknown` value is NOT: at run time it usually holds a typed
 * vec, which the dynamic carrier would copy.
 */
function factIsDynamicArray(fact: TypeFact): boolean {
  if (fact.kind === "array") return fact.element.kind === "any" || fact.element.kind === "unknown";
  if (fact.kind === "union") return fact.parts.length > 0 && fact.parts.every(factIsDynamicArray);
  return false;
}

/** Strip wrappers that pass their operand's value through unchanged. */
function skipValueWrappers(node: ts.Node): ts.Node {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isSatisfiesExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/**
 * (#7154) An expression that yields a vec no other binding can name yet: an
 * array literal. A call or `new` may return an existing vec, so it is a share
 * partner classified by its static result type.
 */
function isFreshArrayExpression(expression: ts.Expression): boolean {
  return ts.isArrayLiteralExpression(skipValueWrappers(expression));
}

/** `x as T` / `<T>x`: the value is classified by `T`. */
function isTypeAssertion(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

/**
 * (#7154) Every other place this use of an array binding copies the reference
 * to or from: `other = arr`, `const other = arr`, `arr = other` (a right side
 * that is not a fresh array), seen through value wrappers, `,`, nested `=`,
 * `?:` branches and `||` / `??` / `&&` operands that pass the value on.
 */
function sharePartnersOf(ctx: CodegenContext, identifier: ts.Identifier): (ts.Expression | ts.BindingName)[] {
  const partners: (ts.Expression | ts.BindingName)[] = [];
  let use: ts.Node = identifier;
  let passedThrough = false;
  for (;;) {
    const parent = use.parent;
    if (skipValueWrappers(parent) !== parent && (parent as { expression?: ts.Node }).expression === use) {
      // `xs as number[]` / `xs as any` is a typed value to the other side
      // (`partnerLeavesAreDynamic`), so it is no share from this side either.
      if (isTypeAssertion(parent) && !factIsDynamicArray(ctx.oracle.typeFactOf(parent))) return [];
      use = parent;
      continue;
    }
    if (ts.isVariableDeclaration(parent)) {
      if (parent.initializer === use) partners.push(parent.name);
      return partners;
    }
    if (ts.isConditionalExpression(parent) && (parent.whenTrue === use || parent.whenFalse === use)) {
      use = parent;
      passedThrough = true;
      continue;
    }
    if (!ts.isBinaryExpression(parent)) return partners;
    const op = parent.operatorToken.kind;
    const passes =
      parent.right === use ||
      (parent.left === use && (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken));
    if (op === ts.SyntaxKind.EqualsToken && parent.left === use) {
      if (!passedThrough && !isFreshArrayExpression(parent.right)) partners.push(parent.right);
      return partners;
    }
    if (!passes) return partners;
    if (op === ts.SyntaxKind.EqualsToken) partners.push(parent.left);
    else if (
      op !== ts.SyntaxKind.CommaToken &&
      op !== ts.SyntaxKind.BarBarToken &&
      op !== ts.SyntaxKind.QuestionQuestionToken &&
      op !== ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return partners;
    }
    use = parent;
    passedThrough = true;
  }
}

/**
 * (#7154) Calls `leafIsDynamic` for every value the share partner can yield,
 * through parens, `!`, `satisfies`, `,` / `&&` right sides, `=` / `||` / `??`
 * operands and `?:` branches; `x as T` / `<T>x` is typed unless `T` is an
 * `any` / `unknown` array. True when every leaf is dynamic.
 */
function partnerLeavesAreDynamic(
  ctx: CodegenContext,
  partner: ts.Node,
  leafIsDynamic: (leaf: ts.Node) => boolean,
): boolean {
  const recurse = (node: ts.Node): boolean => partnerLeavesAreDynamic(ctx, node, leafIsDynamic);
  if (isTypeAssertion(partner)) {
    return factIsDynamicArray(ctx.oracle.typeFactOf(partner)) && recurse(partner.expression);
  }
  if (ts.isParenthesizedExpression(partner) || ts.isNonNullExpression(partner) || ts.isSatisfiesExpression(partner)) {
    return recurse(partner.expression);
  }
  if (ts.isConditionalExpression(partner)) return recurse(partner.whenTrue) && recurse(partner.whenFalse);
  if (ts.isBinaryExpression(partner)) {
    const op = partner.operatorToken.kind;
    if (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.AmpersandAmpersandToken) return recurse(partner.right);
    if (
      op === ts.SyntaxKind.EqualsToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return recurse(partner.left) && recurse(partner.right);
    }
  }
  return leafIsDynamic(partner);
}

/**
 * (#7154) The binding's share group needs the dynamic carrier: it shares with
 * at least one other place, and every member reachable through shares is an
 * `any` / `unknown` element binding, an array literal, or a value whose
 * static type is an `any` / `unknown` array (a call by its return type).
 */
function shareGroupIsDynamic(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  const seen = new Set<ts.VariableDeclaration>([decl]);
  const queue = [decl];
  let shared = false;
  const leafIsDynamic = (leaf: ts.Node): boolean => {
    if (ts.isArrayLiteralExpression(leaf)) return true;
    const member = ts.isIdentifier(leaf) ? ctx.oracle.variableDeclarationOf(leaf) : undefined;
    if (member) {
      if (!seen.has(member)) {
        seen.add(member);
        queue.push(member);
      }
      return declaredElementIsDynamic(ctx, member);
    }
    return factIsDynamicArray(ctx.oracle.typeFactOf(leaf));
  };
  for (let member = queue.pop(); member; member = queue.pop()) {
    if (!declaredElementIsDynamic(ctx, member) || !ts.isIdentifier(member.name)) return false;
    const partners: ts.Node[] = [];
    if (member.initializer && !isFreshArrayExpression(member.initializer)) partners.push(member.initializer);
    const name = member.name;
    const current = member;
    const visitUses = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name.text && node !== name) {
        if (ctx.oracle.variableDeclarationOf(node) === current) partners.push(...sharePartnersOf(ctx, node));
      }
      forEachChild(node, visitUses);
    };
    visitUses(enclosingScope(member));
    for (const partner of partners) {
      shared = true;
      if (!partnerLeavesAreDynamic(ctx, partner, leafIsDynamic)) return false;
    }
  }
  return shared;
}

/** The function body or source file that holds every use of a local binding. */
function enclosingScope(decl: ts.VariableDeclaration): ts.Node {
  let scope: ts.Node = decl;
  while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  return scope;
}
