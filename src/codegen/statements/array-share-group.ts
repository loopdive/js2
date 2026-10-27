// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7154) Share groups for `any[]` / `unknown[]` bindings: when may every
// binding that shares one vec take the dynamic (externref-element) carrier?
//
// A pinned slot whose representation differs from another place that holds
// the same vec converts by COPYING, so a push through one is lost on the
// other. The group therefore goes dynamic only when every place the vec can
// reach is positively known to hold the dynamic carrier too. Anything this
// pass does not recognise keeps the group on the layout each member infers
// from its own stores, which is the behaviour before #7154.
import type { TypeFact } from "../../checker/oracle.js";
import { forEachChild, ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

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

function declaredElementIsDynamic(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  return factIsDynamicArray(ctx.oracle.typeFactOf(decl.name));
}

/** Strip wrappers that pass their operand's value through unchanged. */
export function skipValueWrappers(node: ts.Node): ts.Node {
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

/** An array literal: a vec no other place can name yet. */
function isFreshArrayExpression(expression: ts.Expression): boolean {
  return ts.isArrayLiteralExpression(skipValueWrappers(expression));
}

/** `x as T` / `<T>x`: the value is classified by `T`. */
function isTypeAssertion(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

/** Array methods that return their receiver: the result is the same vec. */
const RECEIVER_RETURNING = new Set(["reverse", "sort", "fill", "copyWithin"]);
/** Array methods on an `any` / `unknown` array that build a new dynamic vec. */
const FRESH_DYNAMIC_RESULT = new Set(["slice", "concat", "map", "filter", "flat", "flatMap", "splice"]);
/** Array methods that only read their arguments. */
const PURE_READ_ARGS = new Set(["includes", "indexOf", "lastIndexOf"]);
/** Array methods that store their arguments as elements: (method, first stored arg). */
const STORING_METHODS = new Map([
  ["push", 0],
  ["unshift", 0],
  ["fill", 0],
  ["splice", 2],
]);
/** On a vec that holds group members, only these members keep elements in. */
const CONTAINER_SAFE_MEMBERS = new Set([
  "push",
  "unshift",
  "length",
  "join",
  "toString",
  "includes",
  "indexOf",
  "lastIndexOf",
]);

/**
 * (#7154) The single concrete function a call runs, when the callee is a plain
 * identifier bound to exactly one declaration: a function declaration with a
 * body and no overloads, or a `const` without a type annotation initialised to
 * an arrow / function expression. Function-typed variables, members (which an
 * interface, an abstract declaration or a subclass may implement), `.call` /
 * `.apply` / `.bind`, imports and anything else answer `undefined`.
 */
function concreteCallee(ctx: CodegenContext, callee: ts.Expression): ts.SignatureDeclaration | undefined {
  const inner = skipValueWrappers(callee);
  if (!ts.isIdentifier(inner)) return undefined;
  const decls = ctx.oracle.declarationsOf(inner);
  if (decls.length !== 1) return undefined;
  const decl = decls[0]!;
  if (ts.isFunctionDeclaration(decl)) return decl.body ? decl : undefined;
  if (
    ts.isVariableDeclaration(decl) &&
    !decl.type &&
    decl.initializer &&
    ts.isVariableDeclarationList(decl.parent) &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    const init = skipValueWrappers(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return undefined;
}

/** The concrete callee's own parameter at `index` is declared `any[]` / `unknown[]`. */
function concreteParameterIsDynamic(ctx: CodegenContext, call: ts.CallExpression, index: number): boolean {
  if (call.arguments.slice(0, index).some(ts.isSpreadElement)) return false;
  const fn = concreteCallee(ctx, call.expression);
  const param = fn?.parameters[index];
  if (!param || param.dotDotDotToken || !param.type) return false;
  return factIsDynamicArray(ctx.oracle.typeFactOf(param.type));
}

/**
 * (#7154) A share endpoint that is not a group binding holds the dynamic
 * carrier: an array literal, a parameter declared `any[]` / `unknown[]`,
 * `new Array` / `Array.from` / `Array.of`, a
 * new-array method on an `any` / `unknown` array, or a call to a concrete
 * function whose own return type is declared `any[]` / `unknown[]`. Fields,
 * elements, other calls and bare `any` values are typed.
 */
function endpointIsDynamic(ctx: CodegenContext, leaf: ts.Node): boolean {
  if (ts.isArrayLiteralExpression(leaf)) return true;
  if (ts.isIdentifier(leaf)) {
    // A parameter of the function that runs, declared `any[]` / `unknown[]`:
    // its slot is the dynamic carrier whatever the caller passed.
    const param = ctx.oracle.valueDeclarationOf(leaf);
    return (
      param !== undefined &&
      ts.isParameter(param) &&
      param.type !== undefined &&
      !param.dotDotDotToken &&
      factIsDynamicArray(ctx.oracle.typeFactOf(param.type))
    );
  }
  if (ts.isNewExpression(leaf) || ts.isCallExpression(leaf)) {
    const callee = skipValueWrappers(leaf.expression);
    if (ts.isIdentifier(callee) && callee.text === "Array") return factIsDynamicArray(ctx.oracle.typeFactOf(leaf));
    if (!ts.isCallExpression(leaf)) return false;
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = skipValueWrappers(callee.expression);
      if (
        ts.isIdentifier(receiver) &&
        receiver.text === "Array" &&
        (callee.name.text === "from" || callee.name.text === "of")
      ) {
        return factIsDynamicArray(ctx.oracle.typeFactOf(leaf));
      }
      return FRESH_DYNAMIC_RESULT.has(callee.name.text) && factIsDynamicArray(ctx.oracle.typeFactOf(callee.expression));
    }
    const fn = concreteCallee(ctx, leaf.expression);
    return fn?.type !== undefined && factIsDynamicArray(ctx.oracle.typeFactOf(fn.type));
  }
  return false;
}

/**
 * (#7154) Calls `leaf` for every value a share partner can yield, through
 * parens, `!`, `satisfies`, `,` / `&&` right sides, `=` / `||` / `??`
 * operands, `?:` branches and receiver-returning array methods
 * (`xs.reverse()` is `xs`); `x as T` / `<T>x` is typed unless `T` is an
 * `any` / `unknown` array. True when every leaf is dynamic.
 */
function partnerLeavesAreDynamic(ctx: CodegenContext, partner: ts.Node, leaf: (node: ts.Node) => boolean): boolean {
  const recurse = (node: ts.Node): boolean => partnerLeavesAreDynamic(ctx, node, leaf);
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
  if (
    ts.isCallExpression(partner) &&
    ts.isPropertyAccessExpression(partner.expression) &&
    RECEIVER_RETURNING.has(partner.expression.name.text)
  ) {
    return recurse(partner.expression.expression);
  }
  return leaf(partner);
}

/** (#7154) How one use of a share-group member treats the member's vec. */
interface UseVerdict {
  /** The vec reaches a place this pass cannot prove holds the dynamic carrier. */
  readonly typed: boolean;
  /** Places the vec is copied to or from (other side of `=` / a declaration). */
  readonly partners: readonly ts.Node[];
  /** The vec escapes into a concrete function's `any[]` / `unknown[]` parameter. */
  readonly escapesDynamic?: boolean;
  /** The vec is stored as an element of this receiver (`dyn.push(xs)`). */
  readonly storedInto?: ts.Expression;
}

const SAFE_USE: UseVerdict = { typed: false, partners: [] };
const TYPED_USE: UseVerdict = { typed: true, partners: [] };

/** A value read here is only inspected: truthiness, comparison, `typeof`, an untagged template, a discard. */
function isInspectingUse(use: ts.Node, parent: ts.Node): boolean {
  if (ts.isTemplateSpan(parent)) return !ts.isTaggedTemplateExpression(parent.parent.parent);
  if (ts.isConditionalExpression(parent)) return parent.condition === use;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken
    ) {
      return true;
    }
    if (op === ts.SyntaxKind.InstanceOfKeyword) return parent.left === use;
    return (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.AmpersandAmpersandToken) && parent.left === use;
  }
  return (
    ts.isTypeOfExpression(parent) ||
    ts.isVoidExpression(parent) ||
    ts.isExpressionStatement(parent) ||
    ts.isTypeQueryNode(parent) ||
    (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) ||
    ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === use)
  );
}

/**
 * (#7154) An element read from a vec that holds group members: safe only
 * when the element is inspected or used as a receiver of a member that keeps
 * elements in (`c[0].push(1)`, `c[0].length`). Anywhere else the element (a
 * member's vec) could reach a typed place.
 */
function elementReadIsSafe(read: ts.Node): boolean {
  let use = read;
  while (skipValueWrappers(use.parent) !== use.parent && !isTypeAssertion(use.parent)) use = use.parent;
  const parent = use.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === use) {
    return CONTAINER_SAFE_MEMBERS.has(parent.name.text);
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === use) {
    return true; // a write into the element slot
  }
  return isInspectingUse(use, parent);
}

/**
 * (#7154) Classifies one use of a group member. Recognised uses: receivers
 * (member / element access, `for-of`, `for-in`; on a vec holding members only
 * `CONTAINER_SAFE_MEMBERS` and safe element reads), inspections, pure-read
 * arguments (`includes` / `indexOf` / `lastIndexOf`), a store into another
 * array through `push` / `unshift` / `fill` / `splice` (the receiver joins
 * the group as a container), an argument to a concrete function's
 * `any[]` / `unknown[]` parameter, and shares (`other = xs`,
 * `const other = xs`, `xs = other`) seen through value wrappers, `,`, nested
 * `=`, `?:` branches, `||` / `??` / `&&` operands and receiver-returning
 * methods. Every other use is `typed`; unrecognised never means dynamic.
 */
function classifyUse(ctx: CodegenContext, identifier: ts.Identifier, container: boolean): UseVerdict {
  const partners: ts.Node[] = [];
  const safe = (extra?: Partial<UseVerdict>): UseVerdict =>
    partners.length === 0 && !extra ? SAFE_USE : { typed: false, partners, ...extra };
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
    if (ts.isConditionalExpression(parent) && parent.condition !== use) {
      use = parent;
      passedThrough = true;
      continue;
    }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) {
        if (parent.left === use) {
          if (passedThrough) return TYPED_USE;
          if (!isFreshArrayExpression(parent.right)) partners.push(parent.right);
          return safe();
        }
        partners.push(parent.left);
        use = parent;
        passedThrough = true;
        continue;
      }
      const passes =
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        ((op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.AmpersandAmpersandToken) && parent.right === use);
      if (passes) {
        use = parent;
        passedThrough = true;
        continue;
      }
    }
    if (isInspectingUse(use, parent)) return safe();
    if (ts.isVariableDeclaration(parent)) {
      if (parent.initializer !== use || !ts.isIdentifier(parent.name)) return TYPED_USE;
      partners.push(parent.name);
      return safe();
    }
    if (ts.isPropertyAccessExpression(parent)) {
      if (parent.expression !== use) return TYPED_USE;
      const name = parent.name.text;
      const call = parent.parent;
      if (RECEIVER_RETURNING.has(name) && ts.isCallExpression(call) && call.expression === parent) {
        // `xs.reverse()` is `xs`: keep following the result.
        use = call;
        passedThrough = true;
        continue;
      }
      return !container || CONTAINER_SAFE_MEMBERS.has(name) ? safe() : TYPED_USE;
    }
    if (ts.isElementAccessExpression(parent)) {
      if (parent.expression !== use) return TYPED_USE;
      return !container || elementReadIsSafe(parent) ? safe() : TYPED_USE;
    }
    if (ts.isForOfStatement(parent)) return parent.expression === use && !container ? safe() : TYPED_USE;
    if (ts.isForInStatement(parent)) return parent.expression === use ? safe() : TYPED_USE;
    if (ts.isCallExpression(parent) && parent.arguments.includes(use as ts.Expression)) {
      const index = parent.arguments.indexOf(use as ts.Expression);
      const callee = parent.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (PURE_READ_ARGS.has(method)) return safe();
        const firstStored = STORING_METHODS.get(method);
        if (firstStored !== undefined && index >= firstStored) {
          return factIsDynamicArray(ctx.oracle.typeFactOf(callee.expression))
            ? safe({ storedInto: callee.expression })
            : TYPED_USE;
        }
        return TYPED_USE;
      }
      return concreteParameterIsDynamic(ctx, parent, index) ? safe({ escapesDynamic: true }) : TYPED_USE;
    }
    return TYPED_USE;
  }
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

/** Every use of a local binding other than its own name. */
function usesOf(ctx: CodegenContext, member: ts.VariableDeclaration, name: ts.Identifier): ts.Identifier[] | undefined {
  const uses: ts.Identifier[] = [];
  for (const id of identifiersNamed(enclosingScope(member), name.text)) {
    if (id === name) continue;
    const target = ctx.oracle.variableDeclarationOf(id);
    if (target === member) uses.push(id);
    // `{ xs }` resolves to the property, not the binding: unclassified.
    else if (target === undefined && ts.isShorthandPropertyAssignment(id.parent)) return undefined;
  }
  return uses;
}

/**
 * (#7154) The binding's share group needs the dynamic carrier. The group is
 * every local reachable through shares and element stores (initializers and
 * use sites, both directions). It goes dynamic only when it shares at all
 * (another binding, or a concrete `any[]` parameter), every member is a
 * non-exported `any` / `unknown` element local, every use of every member is
 * recognised by `classifyUse` (with the container rules once any member holds
 * another), and every other share endpoint holds the dynamic carrier
 * (`endpointIsDynamic`). The verdict is computed once per group and memoised
 * for every member.
 */
export function shareGroupIsDynamic(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  let verdicts = groupVerdicts.get(ctx.oracle);
  if (!verdicts) {
    verdicts = new WeakMap();
    groupVerdicts.set(ctx.oracle, verdicts);
  }
  const cached = verdicts.get(decl);
  if (cached !== undefined) return cached;

  const seen = new Set<ts.VariableDeclaration>([decl]);
  const queue = [decl];
  const memberUses: ts.Identifier[] = [];
  let shared = false;
  let dynamic = true;
  let container = false;
  const join = (member: ts.VariableDeclaration): void => {
    if (!seen.has(member)) {
      seen.add(member);
      queue.push(member);
    }
  };
  const leafIsDynamic = (leaf: ts.Node): boolean => {
    const member = ts.isIdentifier(leaf) ? ctx.oracle.variableDeclarationOf(leaf) : undefined;
    if (member) {
      join(member);
      return true; // judged as a member when it is dequeued
    }
    return endpointIsDynamic(ctx, leaf);
  };
  for (let member = queue.pop(); member; member = queue.pop()) {
    const name = member.name;
    const uses = ts.isIdentifier(name) ? usesOf(ctx, member, name) : undefined;
    if (!uses || !declaredElementIsDynamic(ctx, member) || isExported(member)) {
      dynamic = false;
      continue;
    }
    const partners: ts.Node[] = [];
    if (member.initializer && !isFreshArrayExpression(member.initializer)) partners.push(member.initializer);
    for (const id of uses) {
      memberUses.push(id);
      const verdict = classifyUse(ctx, id, false);
      if (verdict.typed) dynamic = false;
      if (verdict.escapesDynamic) shared = true;
      if (verdict.storedInto) {
        const receiver = skipValueWrappers(verdict.storedInto);
        const holder = ts.isIdentifier(receiver) ? ctx.oracle.variableDeclarationOf(receiver) : undefined;
        if (holder) {
          container = true;
          join(holder);
        } else {
          dynamic = false;
        }
      }
      partners.push(...verdict.partners);
    }
    for (const partner of partners) {
      shared = true;
      if (!partnerLeavesAreDynamic(ctx, partner, leafIsDynamic)) dynamic = false;
    }
  }
  // A member stored into another: every member's vec may now be read back as
  // an element, so re-check every use under the container rules.
  if (dynamic && container) {
    for (const id of memberUses) if (classifyUse(ctx, id, true).typed) dynamic = false;
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
