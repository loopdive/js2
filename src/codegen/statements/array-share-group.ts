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

/** (#7164) A non-empty array literal. */
function isSeedLiteral(expression: ts.Expression): boolean {
  const literal = skipValueWrappers(expression);
  return ts.isArrayLiteralExpression(literal) && literal.elements.length > 0;
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
function classifyUse(ctx: CodegenContext, identifier: ts.Identifier, container: boolean, reads = false): UseVerdict {
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
    if (reads && isPureReadUse(ctx, use, parent, container)) return safe();
    if (ts.isVariableDeclaration(parent)) {
      if (parent.initializer !== use || !ts.isIdentifier(parent.name)) return TYPED_USE;
      partners.push(parent.name);
      return safe();
    }
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
      if (parent.expression !== use) return TYPED_USE;
      const member = memberUse(parent);
      if (reads) {
        // (#7164) The grow verdict decides whether a binding switches carrier, so
        // here a member use is safe only in an allowlisted shape; any other may
        // hand the vec to code whose length stores are not the switched binding's.
        if (member.kind === "escape") return safe({ escapesDynamic: true });
        if (member.kind === "returnsReceiver") {
          use = member.call; // `xs.reverse()` is `xs`: keep following the result.
          passedThrough = true;
          continue;
        }
        if (member.kind === "call" && !container && callbackSeesArray(member.name, member.call))
          return safe({ escapesDynamic: true });
      } else if (ts.isPropertyAccessExpression(parent) && member.kind === "returnsReceiver" && member.direct) {
        use = member.call;
        passedThrough = true;
        continue;
      }
      if (ts.isElementAccessExpression(parent)) return !container || elementReadIsSafe(parent) ? safe() : TYPED_USE;
      return !container || CONTAINER_SAFE_MEMBERS.has(parent.name.text) ? safe() : TYPED_USE;
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

/** (#7164) A share group's facts: `shared`, `dynamic` as in {@link shareGroupIsDynamic}; `grows` = a member's growing `length` store. */
interface GroupVerdict {
  readonly shared: boolean;
  readonly dynamic: boolean;
  readonly grows: boolean;
  /** (#7164) A member is seeded by a non-empty array literal (`['a', 'b']`). */
  readonly seeded: boolean;
  /** (#7164) The vec reaches only member bindings: no parameter, field, container or other endpoint. */
  readonly local: boolean;
  readonly members: ReadonlySet<ts.VariableDeclaration>;
}
const groupVerdicts = new WeakMap<object, WeakMap<ts.VariableDeclaration, GroupVerdict>>();
const growVerdicts = new WeakMap<object, WeakMap<ts.VariableDeclaration, GroupVerdict>>();
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
  const verdict = groupVerdict(ctx, decl, false);
  return verdict.shared && verdict.dynamic;
}

/**
 * (#7164) A growing `x.length = n` store on any member of the binding's share
 * group creates holes, which only the dynamic carrier represents. Switching
 * one member alone would split the group (a typed alias then holds a COPY and
 * loses the other's pushes), so the answer is for the whole group:
 *
 * - `group`: the group shares and every member, use and endpoint admits the
 *   dynamic carrier — every member takes it;
 * - `alone`: the binding shares with nothing and every use is recognised —
 *   only it takes the dynamic carrier (the caller keeps an f64 vec, which has
 *   its own hole marker);
 * - `undefined`: no growing store, or a use that may reach a typed place —
 *   every member keeps the layout it infers.
 *
 * Uses are classified as for {@link shareGroupIsDynamic}, plus the pure reads
 * of {@link isPureReadUse}, which cannot leak the vec to another layout.
 */
export function growingLengthStoreCarrier(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
): "group" | "alone" | undefined {
  const verdict = groupVerdict(ctx, decl, true);
  // A literal-seeded group keeps origin/main's layout: there `k in g` after a grow is already right.
  // A vec that reaches a parameter, a field or another endpoint keeps origin/main's layout too:
  // the length stores there are not the switched binding's.
  if (!verdict.grows || !verdict.dynamic || verdict.seeded || !verdict.local || lengthUpdateMayMeetFrozenArray(ctx))
    return undefined;
  return verdict.shared ? "group" : "alone";
}

function groupVerdict(ctx: CodegenContext, decl: ts.VariableDeclaration, reads: boolean): GroupVerdict {
  const store = reads ? growVerdicts : groupVerdicts;
  let verdicts = store.get(ctx.oracle);
  if (!verdicts) {
    verdicts = new WeakMap();
    store.set(ctx.oracle, verdicts);
  }
  const cached = verdicts.get(decl);
  if (cached !== undefined) return cached;

  const seen = new Set<ts.VariableDeclaration>([decl]);
  const queue = [decl];
  const memberUses: ts.Identifier[] = [];
  let shared = false;
  let dynamic = true;
  let container = false;
  let grows = false;
  let seeded = false;
  let local = true;
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
    local = false;
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
    if (member.initializer && isSeedLiteral(member.initializer)) seeded = true;
    for (const id of uses) {
      memberUses.push(id);
      if (reads && isGrowingLengthStore(id)) grows = true;
      const store = id.parent;
      if (
        ts.isBinaryExpression(store) &&
        store.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        store.left === id &&
        isSeedLiteral(store.right)
      )
        seeded = true;
      const verdict = classifyUse(ctx, id, false, reads);
      if (verdict.typed) dynamic = false;
      if (verdict.escapesDynamic) {
        shared = true;
        local = false;
      }
      if (verdict.storedInto) {
        const receiver = skipValueWrappers(verdict.storedInto);
        const holder = ts.isIdentifier(receiver) ? ctx.oracle.variableDeclarationOf(receiver) : undefined;
        if (holder) {
          container = true;
          local = false;
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
    for (const id of memberUses) if (classifyUse(ctx, id, true, reads).typed) dynamic = false;
  }
  const result: GroupVerdict = { shared, dynamic, grows, seeded, local, members: seen };
  for (const member of seen) verdicts.set(member, result);
  return result;
}

/** Callback methods whose callback receives the array itself (index of that parameter). */
const CALLBACK_ARRAY_PARAM = new Map<string, number>([
  ...["forEach", "map", "filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "flatMap"].map(
    (name) => [name, 2] as const,
  ),
  ["reduce", 3],
  ["reduceRight", 3],
]);

/**
 * (#7164) `xs.<method>(cb)`: the callback's array parameter is another name
 * for the vec, outside the share group. True when the callback can see it — it
 * declares that parameter or a rest, uses `arguments`, or is not an inline
 * function.
 */
function callbackSeesArray(method: string, call: ts.CallExpression): boolean {
  const arrayParam = CALLBACK_ARRAY_PARAM.get(method);
  if (arrayParam === undefined) return false;
  let callback: ts.Expression | undefined = call.arguments[0];
  while (callback && ts.isParenthesizedExpression(callback)) callback = callback.expression;
  if (!callback) return false;
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return true;
  if (callback.parameters.length > arrayParam || callback.parameters.some((p) => p.dotDotDotToken)) return true;
  if (!ts.isFunctionExpression(callback)) return false;
  let usesArguments = false;
  const visit = (node: ts.Node): void => {
    if (usesArguments) return;
    if (ts.isIdentifier(node) && node.text === "arguments") usesArguments = true;
    else forEachChild(node, visit);
  };
  visit(callback.body);
  return usesArguments;
}

/**
 * (#7164) What a member access on a group member does, for the grow verdict's
 * allowlist:
 * - `call`: a method called directly — the access (through parentheses, `as`,
 *   `<T>`, `!`, `satisfies`) is the callee of a call, the name a property name
 *   or a string-literal key;
 * - `returnsReceiver`: the same for `reverse` / `sort` / `fill` / `copyWithin`,
 *   whose result is the receiver;
 * - `element`: `xs[i]` read or written, or `xs.length`;
 * - `escape`: anything else — a method value taken off the vec
 *   (`(0, xs.forEach)`, `const f = xs.reverse`), a computed key in a call, any
 *   other property.
 * `direct` marks a call whose callee is the bare access, the only shape the
 * share-group verdict (non-grow) followed before #7164.
 */
type MemberUse =
  | { kind: "call" | "returnsReceiver"; name: string; call: ts.CallExpression; direct: boolean }
  | { kind: "element" | "escape" };
function memberUse(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): MemberUse {
  let callee: ts.Node = access;
  while (
    callee.parent &&
    skipValueWrappers(callee.parent) !== callee.parent &&
    (callee.parent as { expression?: ts.Node }).expression === callee
  )
    callee = callee.parent;
  const call =
    callee.parent && ts.isCallExpression(callee.parent) && callee.parent.expression === callee
      ? callee.parent
      : undefined;
  let name: string | undefined;
  if (ts.isPropertyAccessExpression(access)) name = access.name.text;
  else {
    const key = skipValueWrappers(access.argumentExpression);
    if (ts.isStringLiteralLike(key)) name = key.text;
    else if (!call) return elementUse(access, callee); // `xs[i]`
  }
  if (name === undefined) return { kind: "escape" }; // `xs[k](…)`
  if (call) {
    const direct = callee === access;
    return { kind: RECEIVER_RETURNING.has(name) ? "returnsReceiver" : "call", name, call, direct };
  }
  if (name === "length" || (ts.isElementAccessExpression(access) && /^\d+$/.test(name)))
    return elementUse(access, callee);
  return { kind: "escape" };
}

/**
 * (#7164) `xs[i]` / `xs.length` is safe only as an rvalue or as the direct
 * target of a plain `=`, a compound assignment or `++` / `--` on the bare
 * binding — the stores the length / element store paths handle. A for-of /
 * for-in target, a destructuring-pattern position, a wrapped (`as`, `!`, …)
 * target, or a store through another receiver (`xs.reverse().length += 7`)
 * escapes.
 */
function elementUse(access: ts.PropertyAccessExpression | ts.ElementAccessExpression, top: ts.Node): MemberUse {
  const parent = top.parent;
  if (!parent) return { kind: "element" };
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === top)
    return { kind: "escape" };
  if (isPatternElement(top)) return { kind: "escape" };
  // `[xs.length = 9] = []`: the target of a default inside a pattern.
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === top &&
    isPatternElement(parent)
  )
    return { kind: "escape" };
  const written =
    (ts.isBinaryExpression(parent) &&
      parent.left === top &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken));
  if (written && (top !== access || !ts.isIdentifier(skipValueWrappers(access.expression)))) return { kind: "escape" };
  return { kind: "element" };
}

/** (#7164) `node` sits in an array / object destructuring pattern (`[xs[0]] = …`, `({ a: xs.length } = …)`, `for ([xs[0]] of …)`). */
function isPatternElement(node: ts.Node): boolean {
  const literalPart = (n: ts.Node, child: ts.Node): boolean =>
    ts.isArrayLiteralExpression(n) ||
    ts.isObjectLiteralExpression(n) ||
    ts.isSpreadElement(n) ||
    ts.isSpreadAssignment(n) ||
    ts.isShorthandPropertyAssignment(n) ||
    (ts.isPropertyAssignment(n) && n.initializer === child) ||
    ts.isParenthesizedExpression(n);
  let child: ts.Node = node;
  let parent = node.parent;
  let inLiteral = false;
  while (parent) {
    const isAssign =
      ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === child;
    if (isAssign) {
      if (!inLiteral) return false;
      // A default inside the pattern (`[xs.length = 9] = []`) keeps climbing; the outer `=` ends it.
      const holder = parent.parent;
      if (
        holder &&
        (ts.isArrayLiteralExpression(holder) || (ts.isPropertyAssignment(holder) && holder.initializer === parent))
      ) {
        child = parent;
        parent = parent.parent;
        continue;
      }
      return true;
    }
    if (!literalPart(parent, child)) break;
    if (ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent)) inLiteral = true;
    child = parent;
    parent = parent.parent;
  }
  if (!inLiteral || !parent) return false;
  return (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === child;
}

/**
 * (#7164) `xs.length = n` with `n` not the literal `0` (a clear cannot grow).
 * Compound stores (`+=`, `++`) are not counted: the static store fills holes
 * only for a plain assignment.
 */
function isGrowingLengthStore(id: ts.Identifier): boolean {
  const access = id.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== id || access.name.text !== "length") return false;
  const store = access.parent;
  if (
    !ts.isBinaryExpression(store) ||
    store.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    store.left !== access
  ) {
    return false;
  }
  const value = skipValueWrappers(store.right);
  return !(ts.isNumericLiteral(value) && Number(value.text) === 0);
}

/** Global functions that only read an array argument. */
const PURE_READ_GLOBALS = new Set(["JSON.stringify", "Object.keys", "Object.getOwnPropertyNames", "Array.isArray"]);

/**
 * (#7164) Reads that cannot hand the vec to another layout: `k in xs`, an
 * argument of `String` / `JSON.stringify` / `Object.keys` /
 * `Object.getOwnPropertyNames` / `Array.isArray`, and (outside a container
 * group, whose elements are member vecs) `[...xs]`, which copies element
 * values, or a spread into a library call (`Array.of(...xs)`). A user
 * `f(...xs)` is not one: a rest parameter receives `xs` itself.
 */
function isPureReadUse(ctx: CodegenContext, use: ts.Node, parent: ts.Node, container: boolean): boolean {
  if (ts.isBinaryExpression(parent))
    return parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === use;
  // `[...xs]` copies; `f(...xs)` may hand xs itself to a rest parameter (aliased).
  if (ts.isSpreadElement(parent)) {
    if (container) return false;
    const site = parent.parent;
    if (ts.isArrayLiteralExpression(site)) return true;
    // `Array.of(...xs)` / `Math.max(...xs)`: a library callee only reads the arguments.
    if (!ts.isCallExpression(site) && !ts.isNewExpression(site)) return false;
    const callee = skipValueWrappers(site.expression);
    const root = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
    return ts.isIdentifier(root) && isLibGlobal(ctx, root);
  }
  if (!ts.isCallExpression(parent) || !parent.arguments.includes(use as ts.Expression)) return false;
  const callee = skipValueWrappers(parent.expression);
  if (ts.isIdentifier(callee)) return callee.text === "String" && isLibGlobal(ctx, callee);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    PURE_READ_GLOBALS.has(`${callee.expression.text}.${callee.name.text}`) &&
    isLibGlobal(ctx, callee.expression)
  );
}

/** Resolves only to ambient library declarations, not to a user binding that shadows the global. */
function isLibGlobal(ctx: CodegenContext, id: ts.Identifier): boolean {
  const decls = ctx.oracle.declarationsOf(id);
  return decls.length > 0 && decls.every((decl) => decl.getSourceFile().isDeclarationFile);
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

/**
 * (#7164) Bindings whose carrier `growingLengthStoreCarrier` switched from a
 * typed vec to the dynamic one. On `origin/main` they held a typed vec (no
 * `$Hole`), so their length stores fill a grow with `undefined` and their
 * `++` / `--` / `+=` / `-=` share that store; a vec that was the dynamic
 * carrier anyway keeps its old length-update behaviour.
 */
const growthSwitched = new WeakMap<object, WeakSet<ts.VariableDeclaration>>();

export function noteGrowthSwitchedBinding(ctx: CodegenContext, decl: ts.VariableDeclaration): void {
  let set = growthSwitched.get(ctx);
  if (!set) {
    set = new WeakSet();
    growthSwitched.set(ctx, set);
  }
  // Every member of a local share group holds the same vec, so each one's length stores grow it.
  for (const member of groupVerdict(ctx, decl, true).members) set.add(member);
}

/** `expr` names a binding {@link noteGrowthSwitchedBinding} recorded. */
export function isGrowthSwitchedReceiver(ctx: CodegenContext, expr: ts.Expression): boolean {
  const inner = skipValueWrappers(expr);
  if (!ts.isIdentifier(inner)) return false;
  const decl = ctx.oracle.variableDeclarationOf(inner);
  return decl !== undefined && (growthSwitched.get(ctx)?.has(decl) ?? false);
}

/** Names that can make an array's `length` non-writable or an element non-configurable. */
const FREEZING_NAMES = new Set(["defineProperty", "defineProperties", "freeze", "seal", "preventExtensions"]);
const lengthUpdateRoots = new WeakMap<object, ts.Node[]>();
const frozenArrayRisk = new WeakMap<object, { roots: number; risky: boolean }>();

/** (#7164) Called by the `scanForArrayHoles` pre-scan for every root it walks. */
export function noteLengthUpdateRoot(ctx: CodegenContext, root: ts.Node): void {
  const roots = lengthUpdateRoots.get(ctx) ?? [];
  roots.push(root);
  lengthUpdateRoots.set(ctx, roots);
}

/**
 * Could the program make an array's `length` non-writable or an element
 * non-configurable? Any mention of `defineProperty` / `defineProperties` /
 * `freeze` / `seal` / `preventExtensions` (or no recorded roots) answers yes:
 * no binding switches carrier for a growing length store, and `arr.length++`
 * keeps its old, descriptor-aware route.
 */
export function lengthUpdateMayMeetFrozenArray(ctx: CodegenContext): boolean {
  const roots = lengthUpdateRoots.get(ctx);
  if (roots === undefined) return true; // not scanned yet: assume the worst, cache nothing
  const cached = frozenArrayRisk.get(ctx);
  if (cached !== undefined && cached.roots === roots.length) return cached.risky;
  let risky = false;
  const visit = (node: ts.Node): void => {
    if (risky) return;
    if (ts.isIdentifier(node) && FREEZING_NAMES.has(node.text)) risky = true;
    else ts.forEachChild(node, visit);
  };
  for (const root of roots) visit(root);
  frozenArrayRisk.set(ctx, { roots: roots.length, risky });
  return risky;
}

/** (#7164) `x.length++` / `--` (prefix or postfix) / `+= k` / `-= k`: the pre-scan arms hole-aware reads for these as for `x.length = n`. */
function isLengthUpdate(node: ts.Node): boolean {
  let target: ts.Node | undefined;
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      target = node.operand;
  } else if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken)
  ) {
    target = node.left;
  }
  while (target && ts.isParenthesizedExpression(target)) target = target.expression;
  return target !== undefined && ts.isPropertyAccessExpression(target) && target.name.text === "length";
}

/** (#7164) Pre-scan hook: a length update arms hole-aware reads, as `x.length = n` does. */
export function armForLengthUpdate(ctx: CodegenContext, node: ts.Node): void {
  if (!ctx.usesArrayHoles && isLengthUpdate(node)) ctx.usesArrayHoles = true;
}
