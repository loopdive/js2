// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4218 Phase 1) `InHouseOracle` — a `TypeOracle` backed by the in-house
 * binder (`binder.ts`) plus syntactic annotation propagation, with NO
 * `ts.TypeChecker`.
 *
 * ## Contract
 *
 * Same frozen surface as `TsCheckerOracle`, same three invariants (#1930):
 * registry-free, query-only, memoized. One ADDITIONAL invariant specific to
 * this backend:
 *
 *   **Never widen a guess into a fact.** Where the checker knows something we
 *   cannot derive syntactically, we answer `{ kind: "unresolvable" }` /
 *   `undefined`, which every consumer already handles as "use the dynamic
 *   representation". A wrong POSITIVE fact would mis-lower; a missing fact
 *   only costs a specialization. Divergence is therefore allowed in exactly
 *   one direction, and `DifferentialOracle` (`oracle-backend.ts`) measures it.
 *
 * ## What it answers today (JS-mode first, per the issue's phasing)
 *
 * | query                  | mechanism                                          |
 * | ---------------------- | -------------------------------------------------- |
 * | `valueDeclarationOf`   | binder scope-chain resolution                      |
 * | `variableDeclarationOf`| ditto, narrowed to `VariableDeclaration`           |
 * | `declarationsOf`       | ditto, all declarations of the binding             |
 * | `isUnresolvableIdentifier` | binder miss AND not a curated global           |
 * | `constInitializerOf` / `variableInitializerOf` | binder + decl syntax   |
 * | `typeFactOf`           | syntactic inference + annotation reading            |
 * | `staticJsTypeOf` / `isBooleanProducing` / `nullabilityOf` / `unionPartsOf` / `elementFactOf` / `builtinReceiverOf` | derived from `typeFactOf` |
 * | `declaredNameOf`       | binder + the curated global type-name table         |
 * | `signatureOf`          | the resolved function-like declaration's annotations|
 * | `propertyFactOf`       | class member annotations + builtin shape table      |
 * | `contextualFactOf`     | call-argument / annotated-initializer / return slot |
 * | `wellKnownSymbolMemberOf` | builtin + primitive tables (else `undefined`)    |
 * | `typeKeyOf`            | structural fact interning (see the method comment)  |
 *
 * Deliberately NOT answered (returns `unresolvable`): generics instantiation,
 * contextual typing beyond the three slots above, flow narrowing, cross-module
 * (imported) bindings, and `lib.d.ts` depth outside the curated table. Those
 * are the issue's Phase-2/3 scope.
 */
import { ts } from "../ts-api.js";
import { binderFor, isBindingReferencePosition, sourceFileOf, type Binding, type FileBinder } from "./binder.js";
import {
  BUILTIN_NAMES,
  jsTagOfFact,
  type JsTag,
  type OracleTypeKey,
  type SignatureFact,
  type TypeFact,
  type TypeOracle,
} from "./oracle.js";
import {
  ARRAY_METHOD_RETURNS,
  BUILTIN_WELL_KNOWN_SYMBOLS,
  GLOBAL_CALL_RETURNS,
  GLOBAL_VALUE_NAMES,
  GLOBAL_VALUE_TYPE_NAMES,
  NAMESPACE_CALL_RETURNS,
  NAMESPACE_GLOBALS,
  NAMESPACE_PROPERTY_FACTS,
  PRIMITIVE_WELL_KNOWN_SYMBOLS,
  STRING_METHOD_RETURNS,
} from "./inhouse-globals.js";

const UNRESOLVABLE: TypeFact = { kind: "unresolvable" };
const MAX_DEPTH = 8;

/** Stable structural digest of a fact — the join/intern key. */
export function factKey(fact: TypeFact): string {
  switch (fact.kind) {
    case "array":
      return `array<${factKey(fact.element)}>`;
    case "tuple":
      return `tuple<${fact.elements.map(factKey).join(",")}>`;
    case "class":
    case "builtin":
      return `${fact.kind}:${fact.name}`;
    case "union":
      return `union<${fact.parts.map(factKey).sort().join("|")}${fact.nullable ? "+null" : ""}${
        fact.undefinable ? "+undef" : ""
      }>`;
    default:
      return fact.kind;
  }
}

/** Join two facts: identical structure survives, anything else is unknown. */
function joinFacts(a: TypeFact, b: TypeFact): TypeFact {
  if (a.kind === "unresolvable" || b.kind === "unresolvable") return UNRESOLVABLE;
  return factKey(a) === factKey(b) ? a : UNRESOLVABLE;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let cur = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

export class InHouseOracle implements TypeOracle {
  private readonly factCache = new WeakMap<ts.Node, TypeFact>();
  private readonly inFlight = new Set<ts.Node>();
  private readonly keyCache = new Map<string, OracleTypeKey>();
  private readonly nodeKeyCache = new WeakMap<ts.Node, OracleTypeKey>();
  private keyCounter = 0;

  // ---------------------------------------------------------------- binding

  private binderOf(node: ts.Node): FileBinder | undefined {
    const sf = sourceFileOf(node);
    return sf ? binderFor(sf) : undefined;
  }

  private bindingOf(id: ts.Node): Binding | undefined {
    if (!ts.isIdentifier(id)) return undefined;
    return this.binderOf(id)?.resolve(id);
  }

  valueDeclarationOf(id: ts.Node): ts.Declaration | undefined {
    const binding = this.bindingOf(id);
    if (!binding) return undefined;
    return binding.valueDeclaration ?? binding.declarations[0];
  }

  variableDeclarationOf(id: ts.Node): ts.VariableDeclaration | undefined {
    const decl = this.valueDeclarationOf(id);
    if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return undefined;
    return decl;
  }

  declarationsOf(node: ts.Node): readonly ts.Declaration[] {
    return this.bindingOf(node)?.declarations ?? [];
  }

  constInitializerOf(id: ts.Node): ts.Expression | undefined {
    const binding = this.bindingOf(id);
    if (!binding || binding.kind !== "const" || binding.destructured) return undefined;
    const decl = binding.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isIdentifier(decl.name)) {
      return undefined;
    }
    return decl.initializer;
  }

  variableInitializerOf(id: ts.Node): ts.Expression | undefined {
    return this.variableDeclarationOf(id)?.initializer;
  }

  /**
   * A name is unresolvable only when the binder found NO binding for it AND it
   * is not a curated global. Answering `true` is the semantically load-bearing
   * direction (§13.5.1.2 `delete`, sloppy implicit globals), so the curated
   * global set is consulted first and errs toward "resolvable".
   */
  isUnresolvableIdentifier(id: ts.Identifier): boolean {
    if (!isBindingReferencePosition(id)) return false;
    if (this.bindingOf(id)) return false;
    return !GLOBAL_VALUE_NAMES.has(id.text);
  }

  // ------------------------------------------------------------- type facts

  typeFactOf(node: ts.Node): TypeFact {
    const cached = this.factCache.get(node);
    if (cached) return cached;
    if (this.inFlight.has(node)) return UNRESOLVABLE;
    this.inFlight.add(node);
    let fact: TypeFact;
    try {
      fact = this.computeFact(node, 0);
    } catch {
      fact = UNRESOLVABLE;
    } finally {
      this.inFlight.delete(node);
    }
    this.factCache.set(node, fact);
    return fact;
  }

  private factOf(node: ts.Node, depth: number): TypeFact {
    if (depth >= MAX_DEPTH) return UNRESOLVABLE;
    const cached = this.factCache.get(node);
    if (cached) return cached;
    if (this.inFlight.has(node)) return UNRESOLVABLE;
    this.inFlight.add(node);
    let fact: TypeFact;
    try {
      fact = this.computeFact(node, depth);
    } catch {
      fact = UNRESOLVABLE;
    } finally {
      this.inFlight.delete(node);
    }
    // Only depth-0 answers are memoized unconditionally; deeper answers are
    // identical (the computation is context-free) so caching them is sound.
    this.factCache.set(node, fact);
    return fact;
  }

  private computeFact(node: ts.Node, depth: number): TypeFact {
    if (ts.isTypeNode(node)) return this.factOfTypeNode(node, depth);
    const declFact = this.factOfDeclaration(node, depth);
    if (declFact) return declFact;
    return this.factOfExpression(node as ts.Expression, depth);
  }

  /** Declared type of a declaration node (annotation first, then initializer). */
  private factOfDeclaration(node: ts.Node, depth: number): TypeFact | undefined {
    if (ts.isParameter(node)) {
      if (node.dotDotDotToken) {
        const annotated = node.type ? this.factOfTypeNode(node.type, depth + 1) : UNRESOLVABLE;
        return annotated.kind === "array" ? annotated : { kind: "array", element: UNRESOLVABLE };
      }
      if (node.type) return this.factOfTypeNode(node.type, depth + 1);
      if (node.initializer) return this.factOf(node.initializer, depth + 1);
      return UNRESOLVABLE;
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.type) return this.factOfTypeNode(node.type, depth + 1);
      if (!ts.isIdentifier(node.name)) return UNRESOLVABLE;
      const binding = this.binderOf(node)?.resolveNameAt(node.name.text, node);
      return binding ? this.factOfBinding(binding, depth) : UNRESOLVABLE;
    }
    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      if (node.type) return this.factOfTypeNode(node.type, depth + 1);
      const initializer = ts.isPropertyDeclaration(node) ? node.initializer : undefined;
      return initializer ? this.factOf(initializer, depth + 1) : UNRESOLVABLE;
    }
    if (isFunctionLikeDeclaration(node)) {
      return { kind: "function", signature: this.signatureOfDeclaration(node, depth) };
    }
    if (ts.isClassDeclaration(node)) {
      return node.name ? { kind: "class", name: node.name.text } : { kind: "object" };
    }
    if (ts.isEnumMember(node)) return { kind: "number" };
    return undefined;
  }

  /** Type of the VALUE a binding holds. */
  private factOfBinding(binding: Binding, depth: number): TypeFact {
    switch (binding.kind) {
      case "function": {
        const decl = binding.valueDeclaration;
        return decl && isFunctionLikeDeclaration(decl)
          ? { kind: "function", signature: this.signatureOfDeclaration(decl, depth) }
          : { kind: "function" };
      }
      case "class":
        // A reference to a class NAME is its constructor — the checker
        // classifies that as `function` (construct signatures win over the
        // name branch in `factOfType`), so match it exactly.
        return { kind: "function" };
      case "parameter": {
        const decl = binding.valueDeclaration;
        return decl && ts.isParameter(decl) ? (this.factOfDeclaration(decl, depth) ?? UNRESOLVABLE) : UNRESOLVABLE;
      }
      case "import":
      case "implicit":
      case "catch":
      case "enum":
      case "namespace":
      case "type":
        return UNRESOLVABLE;
      case "var":
      case "let":
      case "const":
        break;
    }
    if (binding.destructured || binding.opaquelyWritten) return UNRESOLVABLE;
    const decl = binding.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl)) return UNRESOLVABLE;
    if (decl.type) return this.factOfTypeNode(decl.type, depth + 1);
    let fact = this.initializerFactOfVariable(decl, depth);
    if (fact.kind === "unresolvable") return UNRESOLVABLE;
    if (binding.incremented) fact = joinFacts(fact, { kind: "number" });
    for (const assigned of binding.assignedExpressions) {
      fact = joinFacts(fact, this.factOf(assigned, depth + 1));
      if (fact.kind === "unresolvable") return UNRESOLVABLE;
    }
    return fact;
  }

  /** Fact of the value a variable declaration binds at its declaration site. */
  private initializerFactOfVariable(decl: ts.VariableDeclaration, depth: number): TypeFact {
    if (decl.initializer) return this.factOf(decl.initializer, depth + 1);
    const list = decl.parent;
    const loop = list?.parent;
    if (loop && ts.isForOfStatement(loop) && loop.initializer === list) {
      const iterated = this.factOf(loop.expression, depth + 1);
      if (iterated.kind === "array") return iterated.element;
      if (iterated.kind === "string") return { kind: "string" };
      return UNRESOLVABLE;
    }
    if (loop && ts.isForInStatement(loop) && loop.initializer === list) return { kind: "string" };
    return UNRESOLVABLE;
  }

  private factOfExpression(expr: ts.Expression, depth: number): TypeFact {
    switch (expr.kind) {
      case ts.SyntaxKind.NumericLiteral:
        return { kind: "number" };
      case ts.SyntaxKind.BigIntLiteral:
        return { kind: "bigint" };
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateExpression:
        return { kind: "string" };
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
        return { kind: "boolean" };
      case ts.SyntaxKind.NullKeyword:
        return { kind: "null" };
      case ts.SyntaxKind.RegularExpressionLiteral:
        return { kind: "builtin", name: "RegExp" };
      case ts.SyntaxKind.TypeOfExpression:
        return { kind: "string" };
      case ts.SyntaxKind.VoidExpression:
        return { kind: "undefined" };
      case ts.SyntaxKind.DeleteExpression:
        return { kind: "boolean" };
      case ts.SyntaxKind.ObjectLiteralExpression:
        return { kind: "object" };
      case ts.SyntaxKind.ClassExpression:
        return { kind: "function" };
      default:
        break;
    }
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
      return this.factOf(expr.expression, depth + 1);
    }
    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
      return this.factOfTypeNode(expr.type, depth + 1);
    }
    if (ts.isSatisfiesExpression(expr)) return this.factOf(expr.expression, depth + 1);
    if (ts.isIdentifier(expr)) return this.factOfIdentifier(expr, depth);
    if (ts.isArrayLiteralExpression(expr)) return this.factOfArrayLiteral(expr, depth);
    if (isFunctionLikeDeclaration(expr)) {
      return { kind: "function", signature: this.signatureOfDeclaration(expr, depth) };
    }
    if (ts.isNewExpression(expr)) return this.factOfNew(expr);
    if (ts.isCallExpression(expr)) return this.factOfCall(expr, depth);
    if (ts.isBinaryExpression(expr)) return this.factOfBinary(expr, depth);
    if (ts.isPrefixUnaryExpression(expr)) return this.factOfPrefixUnary(expr, depth);
    if (ts.isPostfixUnaryExpression(expr)) return this.numericOrBigint(this.factOf(expr.operand, depth + 1));
    if (ts.isConditionalExpression(expr)) {
      return joinFacts(this.factOf(expr.whenTrue, depth + 1), this.factOf(expr.whenFalse, depth + 1));
    }
    if (ts.isPropertyAccessExpression(expr)) return this.factOfPropertyAccess(expr, depth);
    if (ts.isElementAccessExpression(expr)) {
      const receiver = this.factOf(expr.expression, depth + 1);
      if (receiver.kind === "array") return receiver.element;
      if (receiver.kind === "string") return { kind: "string" };
      return UNRESOLVABLE;
    }
    return UNRESOLVABLE;
  }

  private factOfIdentifier(id: ts.Identifier, depth: number): TypeFact {
    const binding = this.bindingOf(id);
    if (binding) return this.factOfBinding(binding, depth);
    switch (id.text) {
      case "undefined":
        return { kind: "undefined" };
      case "NaN":
      case "Infinity":
        return { kind: "number" };
      default:
        break;
    }
    // An unbound GLOBAL. A *value* reference to a constructor or a global
    // function is `function` — matching the checker, whose `factOfType`
    // classifies `ArrayConstructor` / `typeof parseInt` by their call and
    // construct signatures BEFORE the nominal-name branch. Only the
    // NAMESPACE-shaped globals (`Math`, `JSON`) — which carry no signatures —
    // reach the builtin branch there, so only they may reach it here.
    if (NAMESPACE_GLOBALS.has(id.text)) {
      return BUILTIN_NAMES.has(id.text) ? { kind: "builtin", name: id.text } : UNRESOLVABLE;
    }
    if (GLOBAL_VALUE_TYPE_NAMES.has(id.text) || GLOBAL_CALL_RETURNS.has(id.text)) return { kind: "function" };
    return UNRESOLVABLE;
  }

  private factOfArrayLiteral(expr: ts.ArrayLiteralExpression, depth: number): TypeFact {
    if (expr.elements.length === 0) return { kind: "array", element: { kind: "any" } };
    let element: TypeFact | undefined;
    for (const el of expr.elements) {
      if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) return UNRESOLVABLE;
      const fact = this.factOf(el, depth + 1);
      element = element ? joinFacts(element, fact) : fact;
      if (element.kind === "unresolvable") return UNRESOLVABLE;
    }
    return { kind: "array", element: element ?? UNRESOLVABLE };
  }

  private factOfNew(expr: ts.NewExpression): TypeFact {
    const callee = unwrapExpression(expr.expression);
    if (!ts.isIdentifier(callee)) return UNRESOLVABLE;
    const binding = this.bindingOf(callee);
    if (binding) {
      if (binding.kind !== "class") return UNRESOLVABLE;
      return { kind: "class", name: binding.name };
    }
    if (callee.text === "Array") return { kind: "array", element: { kind: "any" } };
    if (BUILTIN_NAMES.has(callee.text)) return { kind: "builtin", name: callee.text };
    return UNRESOLVABLE;
  }

  private factOfCall(expr: ts.CallExpression, depth: number): TypeFact {
    const callee = unwrapExpression(expr.expression);
    if (ts.isIdentifier(callee)) {
      const binding = this.bindingOf(callee);
      if (binding) {
        const decl = binding.valueDeclaration;
        if (decl && isFunctionLikeDeclaration(decl)) {
          return this.signatureOfDeclaration(decl, depth)?.returns ?? UNRESOLVABLE;
        }
        return UNRESOLVABLE;
      }
      return GLOBAL_CALL_RETURNS.get(callee.text) ?? UNRESOLVABLE;
    }
    if (!ts.isPropertyAccessExpression(callee)) return UNRESOLVABLE;
    const receiver = unwrapExpression(callee.expression);
    const member = callee.name.text;
    // `<Namespace>.<member>(…)` for un-shadowed curated globals.
    if (ts.isIdentifier(receiver) && !this.bindingOf(receiver)) {
      const nsFact = NAMESPACE_CALL_RETURNS.get(`${receiver.text}.${member}`);
      if (nsFact) return nsFact;
    }
    const receiverFact = this.factOf(receiver, depth + 1);
    if (receiverFact.kind === "string") return STRING_METHOD_RETURNS.get(member) ?? UNRESOLVABLE;
    if (receiverFact.kind === "array") {
      const known = ARRAY_METHOD_RETURNS.get(member);
      if (known) return known;
      if (member === "slice" || member === "filter" || member === "concat" || member === "reverse") return receiverFact;
      if (member === "pop" || member === "shift") return UNRESOLVABLE;
      return UNRESOLVABLE;
    }
    if (receiverFact.kind === "class") {
      const method = this.classMemberDeclaration(receiverFact.name, member, callee);
      if (method && isFunctionLikeDeclaration(method)) {
        return this.signatureOfDeclaration(method, depth)?.returns ?? UNRESOLVABLE;
      }
    }
    return UNRESOLVABLE;
  }

  private factOfPropertyAccess(expr: ts.PropertyAccessExpression, depth: number): TypeFact {
    const receiver = unwrapExpression(expr.expression);
    const name = expr.name.text;
    if (ts.isIdentifier(receiver) && !this.bindingOf(receiver)) {
      const known = NAMESPACE_PROPERTY_FACTS.get(`${receiver.text}.${name}`);
      if (known) return known;
    }
    const receiverFact = this.factOf(receiver, depth + 1);
    if (name === "length" && (receiverFact.kind === "array" || receiverFact.kind === "string")) {
      return { kind: "number" };
    }
    if (receiverFact.kind === "class") {
      const member = this.classMemberDeclaration(receiverFact.name, name, expr);
      if (member) return this.factOf(member, depth + 1);
    }
    return UNRESOLVABLE;
  }

  private factOfBinary(expr: ts.BinaryExpression, depth: number): TypeFact {
    const op = expr.operatorToken.kind;
    switch (op) {
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.InstanceOfKeyword:
      case ts.SyntaxKind.InKeyword:
        return { kind: "boolean" };
      case ts.SyntaxKind.CommaToken:
        return this.factOf(expr.right, depth + 1);
      case ts.SyntaxKind.EqualsToken:
        return this.factOf(expr.right, depth + 1);
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
        return joinFacts(this.factOf(expr.left, depth + 1), this.factOf(expr.right, depth + 1));
      case ts.SyntaxKind.PlusToken:
      case ts.SyntaxKind.PlusEqualsToken: {
        const left = this.factOf(expr.left, depth + 1);
        const right = this.factOf(expr.right, depth + 1);
        if (left.kind === "string" || right.kind === "string") return { kind: "string" };
        if (left.kind === "number" && right.kind === "number") return { kind: "number" };
        if (left.kind === "bigint" && right.kind === "bigint") return { kind: "bigint" };
        return UNRESOLVABLE;
      }
      default:
        break;
    }
    if (isArithmeticOperator(op)) {
      const left = this.factOf(expr.left, depth + 1);
      const right = this.factOf(expr.right, depth + 1);
      if (left.kind === "bigint" && right.kind === "bigint") return { kind: "bigint" };
      // Arithmetic is `number` UNLESS an operand is a BigInt, so both operands
      // must be provably non-BigInt before we may claim `number`.
      if (isProvablyNotBigint(left) && isProvablyNotBigint(right)) return { kind: "number" };
      return UNRESOLVABLE;
    }
    return UNRESOLVABLE;
  }

  private factOfPrefixUnary(expr: ts.PrefixUnaryExpression, depth: number): TypeFact {
    switch (expr.operator) {
      case ts.SyntaxKind.ExclamationToken:
        return { kind: "boolean" };
      case ts.SyntaxKind.PlusToken:
        return { kind: "number" };
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.TildeToken:
      case ts.SyntaxKind.PlusPlusToken:
      case ts.SyntaxKind.MinusMinusToken:
        return this.numericOrBigint(this.factOf(expr.operand, depth + 1));
      default:
        return UNRESOLVABLE;
    }
  }

  private numericOrBigint(operand: TypeFact): TypeFact {
    if (operand.kind === "bigint") return { kind: "bigint" };
    return isProvablyNotBigint(operand) ? { kind: "number" } : UNRESOLVABLE;
  }

  // ------------------------------------------------------------- type nodes

  private factOfTypeNode(node: ts.TypeNode, depth: number): TypeFact {
    if (depth >= MAX_DEPTH) return UNRESOLVABLE;
    switch (node.kind) {
      case ts.SyntaxKind.NumberKeyword:
        return { kind: "number" };
      case ts.SyntaxKind.StringKeyword:
        return { kind: "string" };
      case ts.SyntaxKind.BooleanKeyword:
        return { kind: "boolean" };
      case ts.SyntaxKind.BigIntKeyword:
        return { kind: "bigint" };
      case ts.SyntaxKind.SymbolKeyword:
        return { kind: "symbol" };
      case ts.SyntaxKind.VoidKeyword:
        return { kind: "void" };
      case ts.SyntaxKind.UndefinedKeyword:
        return { kind: "undefined" };
      case ts.SyntaxKind.AnyKeyword:
        return { kind: "any" };
      case ts.SyntaxKind.UnknownKeyword:
        return { kind: "unknown" };
      case ts.SyntaxKind.ObjectKeyword:
      case ts.SyntaxKind.TypeLiteral:
        return { kind: "object" };
      case ts.SyntaxKind.NullKeyword:
        return { kind: "null" };
      default:
        break;
    }
    if (ts.isParenthesizedTypeNode(node)) return this.factOfTypeNode(node.type, depth + 1);
    if (ts.isArrayTypeNode(node)) {
      return { kind: "array", element: this.factOfTypeNode(node.elementType, depth + 1) };
    }
    if (ts.isTupleTypeNode(node)) {
      return {
        kind: "tuple",
        elements: node.elements.map((el) =>
          this.factOfTypeNode(ts.isNamedTupleMember(el) ? el.type : (el as ts.TypeNode), depth + 1),
        ),
      };
    }
    if (ts.isFunctionTypeNode(node)) {
      return { kind: "function", signature: this.signatureOfDeclaration(node, depth) };
    }
    if (ts.isLiteralTypeNode(node)) {
      const literal = node.literal;
      switch (literal.kind) {
        case ts.SyntaxKind.StringLiteral:
          return { kind: "string" };
        case ts.SyntaxKind.NumericLiteral:
          return { kind: "number" };
        case ts.SyntaxKind.BigIntLiteral:
          return { kind: "bigint" };
        case ts.SyntaxKind.TrueKeyword:
        case ts.SyntaxKind.FalseKeyword:
          return { kind: "boolean" };
        case ts.SyntaxKind.NullKeyword:
          return { kind: "null" };
        default:
          return UNRESOLVABLE;
      }
    }
    if (ts.isUnionTypeNode(node)) {
      let nullable = false;
      let undefinable = false;
      const parts: TypeFact[] = [];
      for (const member of node.types) {
        const fact = this.factOfTypeNode(member, depth + 1);
        if (fact.kind === "null") {
          nullable = true;
          continue;
        }
        if (fact.kind === "undefined" || fact.kind === "void") {
          undefinable = true;
          continue;
        }
        parts.push(fact);
      }
      if (parts.length === 1 && !nullable && !undefinable) return parts[0]!;
      return { kind: "union", parts, nullable, undefinable };
    }
    if (ts.isTypeReferenceNode(node)) return this.factOfTypeReference(node, depth);
    return UNRESOLVABLE;
  }

  private factOfTypeReference(node: ts.TypeReferenceNode, depth: number): TypeFact {
    if (!ts.isIdentifier(node.typeName)) return UNRESOLVABLE;
    const name = node.typeName.text;
    const args = node.typeArguments;
    if (name === "Array" || name === "ReadonlyArray") {
      const element = args?.[0] ? this.factOfTypeNode(args[0], depth + 1) : { kind: "any" as const };
      return { kind: "array", element };
    }
    const binder = this.binderOf(node);
    const binding = binder?.resolveNameAt(name, node);
    if (binding) {
      const decl = binding.declarations[0];
      if (decl && ts.isTypeAliasDeclaration(decl)) return this.factOfTypeNode(decl.type, depth + 1);
      if (decl && (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl))) return { kind: "class", name };
      if (decl && ts.isEnumDeclaration(decl)) return { kind: "number" };
      return UNRESOLVABLE;
    }
    if (BUILTIN_NAMES.has(name)) return { kind: "builtin", name };
    return UNRESOLVABLE;
  }

  // ------------------------------------------------------------- signatures

  signatureOf(node: ts.Node): SignatureFact | undefined {
    const decl = this.functionLikeFor(node);
    return decl ? this.signatureOfDeclaration(decl, 0) : undefined;
  }

  private functionLikeFor(node: ts.Node): ts.SignatureDeclarationBase | undefined {
    if (isFunctionLikeDeclaration(node) || ts.isFunctionTypeNode(node)) return node;
    if (ts.isIdentifier(node)) {
      const decl = this.valueDeclarationOf(node);
      if (decl && isFunctionLikeDeclaration(decl)) return decl;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = unwrapExpression(decl.initializer);
        if (isFunctionLikeDeclaration(init)) return init;
        if (decl.type && ts.isFunctionTypeNode(decl.type)) return decl.type;
      }
      if (decl && ts.isVariableDeclaration(decl) && decl.type && ts.isFunctionTypeNode(decl.type)) return decl.type;
      return undefined;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const receiver = this.factOf(unwrapExpression(node.expression), 0);
      if (receiver.kind === "class") {
        const member = this.classMemberDeclaration(receiver.name, node.name.text, node);
        if (member && isFunctionLikeDeclaration(member)) return member;
      }
      return undefined;
    }
    if (isFunctionLikeDeclaration(node)) return node;
    return undefined;
  }

  private signatureOfDeclaration(decl: ts.SignatureDeclarationBase, depth: number): SignatureFact | undefined {
    if (depth >= MAX_DEPTH) return undefined;
    const params = decl.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this"));
    return {
      params: params.map((p) => this.factOfDeclaration(p, depth + 1) ?? UNRESOLVABLE),
      returns: decl.type ? this.factOfTypeNode(decl.type, depth + 1) : this.inferredReturnFact(decl, depth),
      declaredArity: params.length,
    };
  }

  /**
   * Return fact for an UNANNOTATED function. Only the two shapes we can prove
   * syntactically: a body with no `return <expr>` at all is `void`; every other
   * body is unresolvable (return-expression join is Phase 2 — it needs the
   * IR's propagation lattice, not a local walk). A concise-body arrow is the
   * one exception: its single expression IS the return value.
   */
  private inferredReturnFact(decl: ts.SignatureDeclarationBase, depth: number): TypeFact {
    const body = (decl as ts.FunctionLikeDeclaration).body;
    if (!body) return UNRESOLVABLE;
    if ((decl as ts.FunctionLikeDeclaration).asteriskToken) return UNRESOLVABLE;
    if (hasModifier(decl, ts.SyntaxKind.AsyncKeyword)) return UNRESOLVABLE;
    if (!ts.isBlock(body)) return this.factOf(body, depth + 1);
    if (hasModifier(decl, ts.SyntaxKind.AsyncKeyword)) return UNRESOLVABLE;
    let hasValueReturn = false;
    const walk = (node: ts.Node): void => {
      if (hasValueReturn) return;
      if (isFunctionLikeDeclaration(node) && node !== decl) return;
      if (ts.isReturnStatement(node) && node.expression) {
        hasValueReturn = true;
        return;
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
    return hasValueReturn ? UNRESOLVABLE : { kind: "void" };
  }

  // --------------------------------------------------------- class members

  private classMemberDeclaration(className: string, member: string, at: ts.Node): ts.Declaration | undefined {
    const binding = this.binderOf(at)?.resolveNameAt(className, at);
    const decl = binding?.declarations.find((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d));
    if (!decl) return undefined;
    for (const element of (decl as ts.ClassLikeDeclaration).members) {
      const name = element.name;
      if (!name || !ts.isIdentifier(name) || name.text !== member) continue;
      if (hasModifier(element, ts.SyntaxKind.StaticKeyword)) continue;
      return element;
    }
    return undefined;
  }

  // -------------------------------------------------------- derived queries

  staticJsTypeOf(expr: ts.Expression): JsTag | "mixed" {
    return jsTagOfFact(this.typeFactOf(expr)) ?? "mixed";
  }

  isBooleanProducing(expr: ts.Expression): boolean {
    return this.typeFactOf(expr).kind === "boolean";
  }

  nullabilityOf(node: ts.Node): { nullable: boolean; undefinable: boolean } {
    const fact = this.typeFactOf(node);
    if (fact.kind === "union") return { nullable: fact.nullable, undefinable: fact.undefinable };
    return {
      nullable: fact.kind === "null",
      undefinable: fact.kind === "undefined" || fact.kind === "void",
    };
  }

  unionPartsOf(node: ts.Node): TypeFact[] | undefined {
    const fact = this.typeFactOf(node);
    return fact.kind === "union" ? fact.parts : undefined;
  }

  elementFactOf(node: ts.Node): TypeFact {
    const fact = this.typeFactOf(node);
    if (fact.kind === "array") return fact.element;
    if (fact.kind === "tuple") return fact.elements[0] ?? UNRESOLVABLE;
    return UNRESOLVABLE;
  }

  builtinReceiverOf(node: ts.Node): string | undefined {
    const fact = this.typeFactOf(node);
    return fact.kind === "builtin" ? fact.name : undefined;
  }

  propertyFactOf(node: ts.Node, name: string): TypeFact {
    const fact = this.typeFactOf(node);
    if (name === "length" && (fact.kind === "array" || fact.kind === "string")) return { kind: "number" };
    if (fact.kind === "class") {
      const member = this.classMemberDeclaration(fact.name, name, node);
      if (member) return this.factOf(member, 1);
    }
    if (fact.kind === "object" && ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (!prop.name || !ts.isIdentifier(prop.name) || prop.name.text !== name) continue;
        if (ts.isPropertyAssignment(prop)) return this.factOf(prop.initializer, 1);
        if (ts.isShorthandPropertyAssignment(prop)) return this.factOf(prop.name, 1);
      }
    }
    return UNRESOLVABLE;
  }

  /**
   * Contextual (expected) type. Only the three slots a syntactic engine can
   * prove: a call argument against an annotated parameter, an annotated
   * variable/property initializer, and a `return` inside an annotated
   * function. Everything else is `undefined` — NOT `unresolvable`, matching
   * `TsCheckerOracle`'s "no contextual type here" answer.
   */
  contextualFactOf(expr: ts.Expression): TypeFact | undefined {
    const parent = expr.parent;
    if (!parent) return undefined;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const index = parent.arguments?.indexOf(expr) ?? -1;
      if (index < 0) return undefined;
      const decl = this.functionLikeFor(unwrapExpression(parent.expression));
      const param = decl?.parameters[index];
      if (!param?.type) return undefined;
      return this.factOfTypeNode(param.type, 1);
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === expr && parent.type) {
      return this.factOfTypeNode(parent.type, 1);
    }
    if (ts.isPropertyDeclaration(parent) && parent.initializer === expr && parent.type) {
      return this.factOfTypeNode(parent.type, 1);
    }
    if (ts.isReturnStatement(parent)) {
      for (let cur: ts.Node | undefined = parent; cur; cur = cur.parent) {
        if (isFunctionLikeDeclaration(cur)) {
          return cur.type ? this.factOfTypeNode(cur.type, 1) : undefined;
        }
      }
    }
    return undefined;
  }

  declaredNameOf(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node)) {
      const binding = this.bindingOf(node);
      if (binding) {
        if (binding.kind === "class" || binding.kind === "function") return binding.name;
      } else {
        const globalName = GLOBAL_VALUE_TYPE_NAMES.get(node.text);
        if (globalName) return globalName;
      }
    }
    const fact = this.typeFactOf(node);
    switch (fact.kind) {
      case "class":
      case "builtin":
        return fact.name;
      case "array":
        return "Array";
      default:
        return undefined;
    }
  }

  /**
   * (#4016) Tri-state well-known-symbol membership. The in-house backend can
   * PROVE `false` only for primitives and for curated builtins; every other
   * receiver answers `undefined` (unknowable), which consumers treat as "do
   * not take the shortcut" — the safe side of the three-valued contract.
   */
  wellKnownSymbolMemberOf(node: ts.Node, name: string): boolean | undefined {
    const fact = this.typeFactOf(node);
    const primitives = PRIMITIVE_WELL_KNOWN_SYMBOLS.get(fact.kind);
    if (primitives) return primitives.has(name);
    if (fact.kind === "builtin") {
      const members = BUILTIN_WELL_KNOWN_SYMBOLS.get(fact.name);
      return members ? members.has(name) : undefined;
    }
    return undefined;
  }

  /**
   * Type-identity token. The checker backend interns by `ts.Type` OBJECT
   * identity; with no type objects the in-house backend interns by the fact's
   * STRUCTURAL digest, which is coarser (two structurally identical anonymous
   * object types share a token). For structureless facts — bare `object`,
   * `any`/`unknown`/`unresolvable` — the digest carries no information, so the
   * token falls back to per-node identity rather than collapsing every unknown
   * type into one key.
   */
  typeKeyOf(node: ts.Node): OracleTypeKey {
    const fact = this.typeFactOf(node);
    if (fact.kind === "object" || fact.kind === "any" || fact.kind === "unknown" || fact.kind === "unresolvable") {
      let key = this.nodeKeyCache.get(node);
      if (!key) {
        key = Symbol(`inhouse-type-${this.keyCounter++}`) as OracleTypeKey;
        this.nodeKeyCache.set(node, key);
      }
      return key;
    }
    const digest = factKey(fact);
    let key = this.keyCache.get(digest);
    if (!key) {
      key = Symbol(`inhouse-type-${digest}`) as OracleTypeKey;
      this.keyCache.set(digest, key);
    }
    return key;
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as { modifiers?: readonly ts.ModifierLike[] }).modifiers;
  return !!modifiers?.some((m) => m.kind === kind);
}

function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclaration {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return true;
    default:
      return false;
  }
}

/** Facts that cannot be a BigInt at runtime — the guard for `number` results. */
function isProvablyNotBigint(fact: TypeFact): boolean {
  switch (fact.kind) {
    case "number":
    case "string":
    case "boolean":
    case "symbol":
    case "undefined":
    case "null":
    case "void":
    case "array":
    case "tuple":
    case "class":
      return true;
    default:
      return false;
  }
}

function isArithmeticOperator(op: ts.SyntaxKind): boolean {
  switch (op) {
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.AsteriskAsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.PercentToken:
    case ts.SyntaxKind.LessThanLessThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
    case ts.SyntaxKind.AmpersandToken:
    case ts.SyntaxKind.BarToken:
    case ts.SyntaxKind.CaretToken:
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.PercentEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
      return true;
    default:
      return false;
  }
}
