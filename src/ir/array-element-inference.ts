// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { TypeFact, TypeOracle } from "../checker/oracle.js";
import { forEachChild, ts } from "../ts-api.js";
import type { ValType } from "./types.js";

type SupportedElementKind = "number";
type ConcreteElementKind =
  | SupportedElementKind
  | "boolean"
  | "string"
  | "bigint"
  | "symbol"
  | "undefined"
  | "null"
  | "void"
  | "function"
  | "object";

export type EmptyArrayInferenceRejection = "mixed" | "escaping" | "unresolved";

export type EmptyArrayInferenceResult =
  | {
      readonly kind: "resolved";
      readonly elementKind: SupportedElementKind;
      readonly elementValType: ValType;
      /**
       * (#3734) True when every value that can ever be stored into this
       * may-alias group is provably an exact signed int32, so the vector may
       * be laid out with `i32` elements (half the memory traffic of `f64`)
       * while reads widen back to `f64`. `elementValType` is `i32` iff set.
       */
      readonly int32Narrowed: boolean;
      readonly aliases: readonly string[];
      readonly evidence: readonly ConcreteElementKind[];
    }
  | {
      readonly kind: "rejected";
      readonly reason: EmptyArrayInferenceRejection;
      readonly aliases: readonly string[];
      readonly evidence: readonly ConcreteElementKind[];
    };

type FunctionWithBody =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

interface GroupEvidence {
  readonly aliases: Set<string>;
  readonly concrete: Set<ConcreteElementKind>;
  escaped: boolean;
  invalidJoin: boolean;
  /**
   * (#3734) Cleared the moment ANY store into this group cannot be proven to
   * write an exact signed int32, or any use site is a shape whose stored value
   * this pass does not model (compound element assignment, `++`/`--` on an
   * element, a destructuring target, a non-empty literal joined in, …).
   * Starts `true` and only ever goes false — fail-closed by construction.
   */
  int32Stores: boolean;
}

/**
 * (#3734) "Is the VALUE of this expression always exactly a signed int32?"
 *
 * Supplied by the caller (`ir/from-ast.ts` passes `isCanonI32Lowerable` bound
 * to a plan-time i32-slot probe) so this module stays free of lowering
 * concerns. Absent ⇒ nothing is provable ⇒ no group is ever narrowed.
 */
export type ExactInt32Proof = (expression: ts.Expression) => boolean;

/**
 * Function-local, path-insensitive evidence for empty array literals.
 *
 * TypeScript assigns `never[]` to `[]`, then evolves the binding through later
 * indexed writes/reads. AST lowering visits the initializer before those use
 * sites, so querying only the literal can never recover the final element
 * type. This pass first closes the may-alias graph (including conditional
 * joins), then gathers element facts from every alias. A path-insensitive
 * may-alias graph is deliberately conservative: a conflicting branch,
 * reassignment, or escape rejects the narrow vector instead of guessing.
 *
 * The result carries only the one vector element representation supported by
 * this slice (`number` -> f64). Allocation and layout stay outside this pass;
 * `from-ast` still creates the ordinary `vec.new_fixed` allocation through the
 * shared allocation registry and LinearMemoryPlan.
 */
export class EmptyArrayElementInference {
  private readonly resultByLiteral = new WeakMap<ts.ArrayLiteralExpression, EmptyArrayInferenceResult>();
  private readonly resultByRoot = new Map<string, EmptyArrayInferenceResult>();

  constructor(
    private readonly aliases: AliasGraph,
    results: ReadonlyMap<string, EmptyArrayInferenceResult>,
    emptyLiterals: readonly ts.ArrayLiteralExpression[],
  ) {
    for (const [root, result] of results) this.resultByRoot.set(root, result);
    for (const literal of emptyLiterals) {
      const result = this.resultByRoot.get(aliases.root(aliases.keyForArray(literal)));
      if (result) this.resultByLiteral.set(literal, result);
    }
  }

  resultForLiteral(literal: ts.ArrayLiteralExpression): EmptyArrayInferenceResult | undefined {
    return this.resultByLiteral.get(literal);
  }

  resultForExpression(expression: ts.Expression): EmptyArrayInferenceResult | undefined {
    const roots = expressionAliasKeys(expression, this.aliases).map((key) => this.aliases.root(key));
    if (roots.length === 0) return undefined;
    const unique = new Set(roots);
    if (unique.size !== 1) return undefined;
    return this.resultByRoot.get(roots[0]!);
  }

  isResolvedVectorExpression(expression: ts.Expression): boolean {
    return this.resultForExpression(expression)?.kind === "resolved";
  }

  /**
   * (#3734) True when `expression` denotes a may-alias group whose element
   * representation was narrowed to `i32`. Read/store sites consult THIS rather
   * than the vec's element ValType alone: a narrowed `number[]` and a genuine
   * `boolean[]` share one `$__vec_i32` registry entry, and only the former may
   * widen on read / narrow on write.
   */
  isInt32NarrowedVectorExpression(expression: ts.Expression): boolean {
    const result = this.resultForExpression(expression);
    return result?.kind === "resolved" && result.int32Narrowed;
  }
}

/** Analyze one function body without rewriting or annotating its source AST. */
export function inferEmptyArrayElementTypes(
  fn: FunctionWithBody,
  oracle?: Pick<TypeOracle, "typeFactOf" | "elementFactOf" | "contextualFactOf">,
  isExactInt32?: ExactInt32Proof,
): EmptyArrayElementInference {
  // (#3734) Absent proof ⇒ nothing narrows. Bound once so the two use sites
  // below need no non-null assertion.
  const proveInt32: ExactInt32Proof = isExactInt32 ?? (() => false);
  const aliases = new AliasGraph();
  const emptyLiterals: ts.ArrayLiteralExpression[] = [];
  const allArrays: ts.ArrayLiteralExpression[] = [];
  const localNames = new Set<string>();

  const collectAliases = (node: ts.Node): void => {
    if (node !== fn && isFunctionLikeBoundary(node)) return;
    if (ts.isArrayLiteralExpression(node)) {
      aliases.keyForArray(node);
      allArrays.push(node);
      if (node.elements.length === 0) emptyLiterals.push(node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      localNames.add(node.name.text);
      connectAliasAssignment(aliases.keyForName(node.name.text), node.initializer, aliases);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      connectAliasAssignment(aliases.keyForName(node.left.text), node.right, aliases);
    }
    forEachChild(node, collectAliases);
  };
  collectAliases(fn.body!);

  const candidateRoots = new Set(emptyLiterals.map((literal) => aliases.root(aliases.keyForArray(literal))));
  const groups = new Map<string, GroupEvidence>();
  for (const root of candidateRoots) {
    groups.set(root, {
      aliases: new Set(),
      concrete: new Set(),
      escaped: false,
      invalidJoin: false,
      int32Stores: isExactInt32 !== undefined,
    });
  }
  for (const name of aliases.names()) {
    const group = groups.get(aliases.root(aliases.keyForName(name)));
    if (group) {
      group.aliases.add(name);
      // A parameter/global/otherwise external binding can point at an
      // unrelated array on some path. Joining it to a fresh literal is not a
      // proof that the fresh allocation's element representation is closed.
      if (!localNames.has(name)) group.invalidJoin = true;
    }
  }

  const groupForExpression = (expression: ts.Expression): GroupEvidence | undefined => {
    const roots = new Set(expressionAliasKeys(expression, aliases).map((key) => aliases.root(key)));
    if (roots.size !== 1) return undefined;
    return groups.get([...roots][0]!);
  };
  const addFact = (group: GroupEvidence | undefined, fact: TypeFact | undefined, fallback?: ts.Expression): void => {
    if (!group) return;
    const before = group.concrete.size;
    if (fact) collectConcreteKinds(fact, group.concrete);
    if (group.concrete.size === before && fallback) {
      const kind = syntacticElementKind(fallback);
      if (kind) group.concrete.add(kind);
    }
  };

  // Non-empty array literals joined to an empty literal are element evidence
  // for the same may-alias group.
  for (const literal of allArrays) {
    const group = groupForExpression(literal);
    if (!group) continue;
    // (#3734) An i32-narrowed group must be able to account for EVERY value
    // that reaches its backing storage. A non-empty literal joined into the
    // group seeds elements this pass would have to prove one by one; the
    // narrowing payoff is on the empty-literal-then-fill shape, so simply
    // refuse the narrow layout instead of growing the proof surface.
    if (literal.elements.length > 0) group.int32Stores = false;
    for (const element of literal.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        group.invalidJoin = true;
        continue;
      }
      addFact(group, oracle?.typeFactOf(element), element);
    }
    addFact(group, oracle?.contextualFactOf(literal));
  }

  const visitEvidence = (node: ts.Node, nested = false): void => {
    const entersNested = node !== fn && isFunctionLikeBoundary(node);
    const inNested = nested || entersNested;

    if (ts.isIdentifier(node) && isValueIdentifier(node)) {
      const group = groups.get(aliases.root(aliases.keyForName(node.text)));
      if (group) {
        addFact(group, oracle?.elementFactOf(node));
        if (inNested || !isSafeAliasUse(node)) group.escaped = true;
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      const group = groupForExpression(node);
      if (group && (inNested || !isSafeAliasUse(node))) group.escaped = true;
    }

    if (!inNested && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const group = groups.get(aliases.root(aliases.keyForName(node.name.text)));
      if (group && expressionAliasKeys(node.initializer, aliases).length === 0) group.invalidJoin = true;
    }

    if (!inNested && ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
      const group = groups.get(aliases.root(aliases.keyForName(node.left.text)));
      if (
        group &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        expressionAliasKeys(node.right, aliases).length === 0
      ) {
        group.invalidJoin = true;
      }
    }

    if (!inNested && ts.isElementAccessExpression(node)) {
      const group = groupForExpression(node.expression);
      if (group) {
        // (#3734) Classify this element access as read / plain store / neither
        // BEFORE the evidence arms below (which are only about the element's
        // TS type, not about what a narrowed layout can hold).
        if (group.int32Stores && !elementAccessKeepsInt32Layout(node, proveInt32)) {
          group.int32Stores = false;
        }
        const parent = node.parent;
        if (ts.isBinaryExpression(parent) && parent.left === node) {
          if (parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
            addFact(group, oracle?.typeFactOf(node), node);
          }
          addFact(group, oracle?.typeFactOf(parent.right), parent.right);
        } else if (
          (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
          parent.operand === node
        ) {
          group.concrete.add("number");
        } else {
          addFact(group, oracle?.typeFactOf(node), node);
          addFact(group, oracle?.elementFactOf(node.expression));
        }
      }
    }

    if (
      !inNested &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push"
    ) {
      const group = groupForExpression(node.expression.expression);
      if (group) {
        for (const argument of node.arguments) {
          if (ts.isSpreadElement(argument)) {
            group.invalidJoin = true;
            group.int32Stores = false;
          } else {
            addFact(group, oracle?.typeFactOf(argument), argument);
            // (#3734) Every pushed value is a store into the backing array.
            if (group.int32Stores && !proveInt32(argument)) group.int32Stores = false;
          }
        }
      }
    }

    forEachChild(node, (child) => visitEvidence(child, inNested));
  };
  visitEvidence(fn.body!);

  const results = new Map<string, EmptyArrayInferenceResult>();
  for (const [root, group] of groups) {
    const evidence = [...group.concrete].sort();
    const aliasNames = [...group.aliases];
    const result: EmptyArrayInferenceResult = group.escaped
      ? { kind: "rejected", reason: "escaping", aliases: aliasNames, evidence }
      : group.concrete.size > 1
        ? { kind: "rejected", reason: "mixed", aliases: aliasNames, evidence }
        : group.invalidJoin || group.concrete.size !== 1 || !group.concrete.has("number")
          ? { kind: "rejected", reason: "unresolved", aliases: aliasNames, evidence }
          : {
              kind: "resolved",
              elementKind: "number",
              // (#3734) `int32Stores` survives only when the escape closure
              // above ALSO held, so a narrowed group is one whose complete set
              // of stores is visible in this function body and individually
              // proven exact-int32.
              elementValType: group.int32Stores ? { kind: "i32" } : { kind: "f64" },
              int32Narrowed: group.int32Stores,
              aliases: aliasNames,
              evidence,
            };
    results.set(root, result);
  }

  return new EmptyArrayElementInference(aliases, results, emptyLiterals);
}

export function emptyArrayInferenceDiagnostic(result: EmptyArrayInferenceResult, funcName: string): string {
  if (result.kind === "resolved") throw new Error("resolved empty-array inference has no diagnostic");
  const binding = result.aliases[0] ? `'${result.aliases[0]}'` : "literal";
  if (result.reason === "escaping") {
    return `ir/from-ast: empty array ${binding} escapes before its element type is closed (${funcName})`;
  }
  if (result.reason === "mixed") {
    return `ir/from-ast: empty array ${binding} has mixed element evidence [${result.evidence.join(", ")}] (${funcName})`;
  }
  const suffix = result.evidence.length > 0 ? ` [${result.evidence.join(", ")}]` : "";
  return `ir/from-ast: empty array ${binding} has unresolved supported element evidence${suffix} (${funcName})`;
}

class AliasGraph {
  private readonly parent = new Map<string, string>();
  private readonly arrayKeys = new WeakMap<ts.ArrayLiteralExpression, string>();
  private readonly knownNames = new Set<string>();
  private nextArray = 0;

  keyForName(name: string): string {
    this.knownNames.add(name);
    return this.ensure(`name:${name}`);
  }

  keyForArray(array: ts.ArrayLiteralExpression): string {
    let key = this.arrayKeys.get(array);
    if (!key) {
      key = this.ensure(`array:${this.nextArray++}`);
      this.arrayKeys.set(array, key);
    }
    return key;
  }

  names(): Iterable<string> {
    return this.knownNames;
  }

  root(key: string): string {
    const parent = this.parent.get(key);
    if (!parent) return this.ensure(key);
    if (parent === key) return key;
    const root = this.root(parent);
    this.parent.set(key, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.root(left);
    const rightRoot = this.root(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }

  private ensure(key: string): string {
    if (!this.parent.has(key)) this.parent.set(key, key);
    return key;
  }
}

function connectAliasAssignment(target: string, source: ts.Expression, aliases: AliasGraph): void {
  for (const sourceKey of expressionAliasKeys(source, aliases)) aliases.union(target, sourceKey);
}

function expressionAliasKeys(expression: ts.Expression, aliases: AliasGraph): string[] {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return [aliases.keyForName(unwrapped.text)];
  if (ts.isArrayLiteralExpression(unwrapped)) return [aliases.keyForArray(unwrapped)];
  if (ts.isConditionalExpression(unwrapped)) {
    return [...expressionAliasKeys(unwrapped.whenTrue, aliases), ...expressionAliasKeys(unwrapped.whenFalse, aliases)];
  }
  return [];
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function collectConcreteKinds(fact: TypeFact, out: Set<ConcreteElementKind>): void {
  switch (fact.kind) {
    case "number":
    case "boolean":
    case "string":
    case "bigint":
    case "symbol":
    case "undefined":
    case "null":
    case "void":
      out.add(fact.kind);
      return;
    case "array":
      collectConcreteKinds(fact.element, out);
      return;
    case "tuple":
      for (const element of fact.elements) collectConcreteKinds(element, out);
      return;
    case "union":
      for (const part of fact.parts) collectConcreteKinds(part, out);
      return;
    case "function":
      out.add("function");
      return;
    case "class":
    case "builtin":
    case "object":
      out.add("object");
      return;
    case "any":
    case "unknown":
    case "unresolvable":
      return;
  }
}

function syntacticElementKind(expression: ts.Expression): ConcreteElementKind | undefined {
  const value = unwrapExpression(expression);
  if (ts.isNumericLiteral(value)) return "number";
  if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) return "string";
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (value.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isPostfixUnaryExpression(value)) return "number";
  if (ts.isPrefixUnaryExpression(value)) {
    if (value.operator === ts.SyntaxKind.ExclamationToken) return "boolean";
    if (
      value.operator === ts.SyntaxKind.PlusToken ||
      value.operator === ts.SyntaxKind.MinusToken ||
      value.operator === ts.SyntaxKind.TildeToken ||
      value.operator === ts.SyntaxKind.PlusPlusToken ||
      value.operator === ts.SyntaxKind.MinusMinusToken
    ) {
      return "number";
    }
    return undefined;
  }
  if (ts.isBinaryExpression(value)) {
    switch (value.operatorToken.kind) {
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
        return "number";
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return "boolean";
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * `=` and every compound-assignment token. The kinds are contiguous between
 * `FirstAssignment` and `LastAssignment`, which is how TypeScript's own
 * (non-public) `isAssignmentOperator` decides. Needed because "binary
 * expression whose LEFT operand is the element access" is NOT the same as
 * "store": `arr[i] * 2` also matches that shape and is a plain read.
 */
function isAssignmentOperatorKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * (#3734) May an `arr[i]` use site keep the group's i32 element layout?
 *
 * Answered by WHITELIST, not blacklist: an element access is either
 *   - a plain store `arr[i] = v` whose `v` is a proven exact int32, or
 *   - a plain READ (which the lowering widens back to f64, so it is
 *     representation-transparent),
 * and anything else — a compound store `arr[i] += v` / `arr[i] >>>= v`, an
 * `arr[i]++` / `--arr[i]`, a destructuring target (`[arr[0]] = xs`,
 * `({p: arr[0]} = o)`, `for (arr[0] of xs)`), a `delete arr[i]` — is refused.
 * The refused shapes are not necessarily unsound; they are simply shapes whose
 * STORED VALUE this pass does not model, and a wrong element representation is
 * a silent wrong answer, so the conservative branch is the only safe default.
 */
function elementAccessKeepsInt32Layout(node: ts.ElementAccessExpression, isExactInt32: ExactInt32Proof): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node && isAssignmentOperatorKind(parent.operatorToken.kind)) {
    // Only a plain `=` is modelled; every compound form derives the stored
    // value from the CURRENT element, which can leave int32 range (`arr[i] *= 3`).
    if (parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
    return isExactInt32(parent.right);
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === node &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return false;
  }
  if (ts.isDeleteExpression(parent)) return false;
  // Assignment-target positions that are not BinaryExpression-shaped.
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) return false;
  // An element access nested directly inside an array/object literal may be a
  // destructuring assignment target (`[arr[0]] = xs`), which the walk above
  // cannot distinguish from an ordinary read without resolving the literal's
  // role. Refuse rather than guess.
  if (
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent)
  ) {
    return false;
  }
  return true;
}

function isFunctionLikeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isValueIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === identifier && parent.initializer !== identifier) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) return true;
  if (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) &&
    parent.name === identifier
  ) {
    return false;
  }
  return true;
}

function isSafeAliasUse(expression: ts.Expression): boolean {
  let current: ts.Expression = expression;
  for (;;) {
    const parent = current.parent;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    if (ts.isConditionalExpression(parent) && (parent.whenTrue === current || parent.whenFalse === current)) {
      current = parent;
      continue;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name)) return true;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (parent.left === current) return ts.isIdentifier(parent.left);
      return parent.right === current && ts.isIdentifier(parent.left);
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === current) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      if (parent.name.text === "length") return true;
      return parent.name.text === "push" && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
    }
    return false;
  }
}
