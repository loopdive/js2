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

/** (#7154) How one use of a share-group member treats the member's vec. */
interface UseVerdict {
  /** The vec reaches a place this pass cannot prove holds the dynamic carrier. */
  readonly typed: boolean;
  /** Places the vec is copied to or from (other side of `=` / a declaration). */
  readonly partners: readonly ts.Node[];
}

const SAFE_USE: UseVerdict = { typed: false, partners: [] };
const TYPED_USE: UseVerdict = { typed: true, partners: [] };

/**
 * (#7154) Classifies one use of an array binding. Positively recognised uses
 * are safe: a member access / element access / `for-of` / `for-in` receiver,
 * a truthiness or comparison operand, a stringification, a discarded value,
 * an argument stored into an `any` / `unknown` array (`dyn.push(xs)`), an
 * escape (call argument, `return`, object property, array element) whose
 * contextual type is an `any` / `unknown` array, and shares (`other = xs`,
 * `const other = xs`, `xs = other`), seen through value wrappers, `,`,
 * nested `=`, `?:` branches and `||` / `??` / `&&` operands. Every other use
 * — a typed or bare-`any` escape, spread, destructuring, a type assertion to
 * a non-dynamic type, anything unrecognised — is `typed`: the group keeps the
 * layout it infers, as before #7154. Unrecognised never means dynamic.
 */
function classifyUse(ctx: CodegenContext, identifier: ts.Identifier): UseVerdict {
  const partners: ts.Node[] = [];
  const safe = (): UseVerdict => (partners.length === 0 ? SAFE_USE : { typed: false, partners });
  const escapeVerdict = (value: ts.Node): UseVerdict => {
    const fact = ts.isExpression(value) ? ctx.oracle.contextualFactOf(value) : undefined;
    return fact && factIsDynamicArray(fact) ? safe() : TYPED_USE;
  };
  let use: ts.Node = identifier;
  let passedThrough = false;
  for (;;) {
    const parent = use.parent;
    if (!parent) return TYPED_USE;
    if (skipValueWrappers(parent) !== parent && (parent as { expression?: ts.Node }).expression === use) {
      if (isTypeAssertion(parent) && !factIsDynamicArray(ctx.oracle.typeFactOf(parent))) return TYPED_USE;
      use = parent;
      continue;
    }
    if (ts.isConditionalExpression(parent)) {
      if (parent.condition === use) return safe();
      use = parent;
      passedThrough = true;
      continue;
    }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      switch (op) {
        case ts.SyntaxKind.EqualsToken:
          if (parent.left === use) {
            if (passedThrough) return TYPED_USE;
            if (!isFreshArrayExpression(parent.right)) partners.push(parent.right);
            return safe();
          }
          partners.push(parent.left);
          break;
        case ts.SyntaxKind.CommaToken:
          if (parent.left === use) return safe();
          break;
        case ts.SyntaxKind.AmpersandAmpersandToken:
          if (parent.left === use) return safe();
          break;
        case ts.SyntaxKind.BarBarToken:
        case ts.SyntaxKind.QuestionQuestionToken:
          break;
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsToken:
          return safe();
        case ts.SyntaxKind.InstanceOfKeyword:
          return parent.left === use ? safe() : TYPED_USE;
        default:
          return TYPED_USE;
      }
      use = parent;
      passedThrough = true;
      continue;
    }
    if (ts.isVariableDeclaration(parent)) {
      if (parent.initializer !== use || !ts.isIdentifier(parent.name)) return TYPED_USE;
      partners.push(parent.name);
      return safe();
    }
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
      return parent.expression === use ? safe() : TYPED_USE;
    }
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
      return parent.expression === use ? safe() : TYPED_USE;
    }
    if (
      ts.isTypeOfExpression(parent) ||
      ts.isVoidExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isExpressionStatement(parent) ||
      ts.isTypeQueryNode(parent) ||
      (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) ||
      ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
        parent.expression === use)
    ) {
      return safe();
    }
    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.arguments?.includes(use as ts.Expression)
    ) {
      const callee = parent.expression;
      // Stored into (or compared against) an `any` / `unknown` array's elements.
      if (ts.isPropertyAccessExpression(callee) && factIsDynamicArray(ctx.oracle.typeFactOf(callee.expression))) {
        return safe();
      }
      return escapeVerdict(use);
    }
    if (
      (ts.isReturnStatement(parent) && parent.expression === use) ||
      (ts.isArrowFunction(parent) && parent.body === use) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === use) ||
      ts.isArrayLiteralExpression(parent)
    ) {
      return escapeVerdict(use);
    }
    return TYPED_USE;
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

const groupVerdicts = new WeakMap<object, WeakMap<ts.VariableDeclaration, boolean>>();
const scopeIdentifiers = new WeakMap<ts.Node, Map<string, ts.Identifier[]>>();

/** Every identifier in `scope`, by name; one walk per scope. */
function identifiersNamed(scope: ts.Node, name: string): readonly ts.Identifier[] {
  let byName = scopeIdentifiers.get(scope);
  if (!byName) {
    const index = new Map<string, ts.Identifier[]>();
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const list = index.get(node.text);
        if (list) list.push(node);
        else index.set(node.text, [node]);
      }
      forEachChild(node, walk);
    };
    walk(scope);
    scopeIdentifiers.set(scope, index);
    byName = index;
  }
  return byName.get(name) ?? [];
}

/**
 * (#7154) The binding's share group needs the dynamic carrier. The group is
 * every binding reachable through shares (initializers and use sites, both
 * directions). It goes dynamic only when it shares at all, every member is an
 * `any` / `unknown` element local, every use of every member is positively
 * recognised by `classifyUse`, and every other share endpoint is an array
 * literal or has a static `any` / `unknown` array type. The verdict is
 * computed once per group and memoised for every member.
 */
function shareGroupIsDynamic(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  let verdicts = groupVerdicts.get(ctx.oracle);
  if (!verdicts) {
    verdicts = new WeakMap();
    groupVerdicts.set(ctx.oracle, verdicts);
  }
  const cached = verdicts.get(decl);
  if (cached !== undefined) return cached;

  const seen = new Set<ts.VariableDeclaration>([decl]);
  const queue = [decl];
  let shared = false;
  let dynamic = true;
  const leafIsDynamic = (leaf: ts.Node): boolean => {
    if (ts.isArrayLiteralExpression(leaf)) return true;
    const member = ts.isIdentifier(leaf) ? ctx.oracle.variableDeclarationOf(leaf) : undefined;
    if (member) {
      if (!seen.has(member)) {
        seen.add(member);
        queue.push(member);
      }
      return true; // judged as a member when it is dequeued
    }
    return factIsDynamicArray(ctx.oracle.typeFactOf(leaf));
  };
  for (let member = queue.pop(); member; member = queue.pop()) {
    const name = member.name;
    if (!ts.isIdentifier(name) || !declaredElementIsDynamic(ctx, member) || isExported(member)) {
      dynamic = false;
      continue;
    }
    const partners: ts.Node[] = [];
    if (member.initializer && !isFreshArrayExpression(member.initializer)) partners.push(member.initializer);
    for (const id of identifiersNamed(enclosingScope(member), name.text)) {
      if (id === name) continue;
      const target = ctx.oracle.variableDeclarationOf(id);
      if (target !== member) {
        // `{ xs }` resolves to the property, not the binding: unclassified.
        if (target === undefined && ts.isShorthandPropertyAssignment(id.parent)) dynamic = false;
        continue;
      }
      const verdict = classifyUse(ctx, id);
      if (verdict.typed) dynamic = false;
      partners.push(...verdict.partners);
    }
    for (const partner of partners) {
      shared = true;
      if (!partnerLeavesAreDynamic(ctx, partner, leafIsDynamic)) dynamic = false;
    }
  }
  const result = shared && dynamic;
  for (const member of seen) verdicts.set(member, result);
  return result;
}

function isExported(decl: ts.VariableDeclaration): boolean {
  const statement = decl.parent?.parent;
  return (
    statement !== undefined &&
    ts.isVariableStatement(statement) &&
    (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

/** The function or source file that holds every use of a local binding. */
function enclosingScope(decl: ts.VariableDeclaration): ts.Node {
  let scope: ts.Node = decl;
  while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  return scope;
}
