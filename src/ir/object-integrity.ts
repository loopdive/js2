// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { isUnshadowedUndefined } from "../shared/ambient-intrinsics.js";
import { isStoreTarget } from "../shared/binding-writes.js";
import {
  sourceMayPatchPrototype,
  sourceNamesReflectiveRoute,
  sourceWritesMemberNamed,
} from "../shared/intrinsic-prototype-writes.js";
import { isEqualityOperator } from "./analysis/operand-admissibility.js";
import type { OwnPropertyTest } from "./nodes.js";
import { forEachChild, ts } from "../ts-api.js";

const ES5_INTRINSIC_OBJECTS: ReadonlySet<string> = new Set([
  "Object",
  "Function",
  "Array",
  "String",
  "Boolean",
  "Number",
  "Math",
  "Date",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "JSON",
]);

const ES5_INTRINSIC_PROTOTYPES: ReadonlySet<string> = new Set([
  "Object",
  "Function",
  "Array",
  "String",
  "Boolean",
  "Number",
  "Date",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const INTEGRITY_MUTATORS: ReadonlySet<string> = new Set(["freeze", "seal", "preventExtensions"]);

/**
 * Names that reach `Object` (or `Function`) without spelling it:
 * `({}).constructor`, `Object.getPrototypeOf(x).constructor`, `o.__proto__`,
 * `Reflect.set(…)`, `[].constructor.constructor("…")`. Any mention refuses.
 */
const REFLECTIVE_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "getPrototypeOf",
  "setPrototypeOf",
  "__proto__",
  "Reflect",
]);

/**
 * (#7106 lever O) The six ES5 integrity statics, keyed by name. A `test`
 * answers a constant for the two operand classes whose answer is fixed at
 * compile time: an intrinsic of the pristine ES5 realm (extensible, neither
 * sealed nor frozen) and a primitive (§20.1.2.12–14: a non-Object is frozen
 * and sealed, and not extensible). A `mutator` returns a primitive operand
 * unchanged (§20.1.2.6, .19, .21 step 1). Every other operand keeps legacy's
 * runtime arm.
 */
type IntegrityStatic =
  | { readonly kind: "test"; readonly intrinsic: boolean; readonly primitive: boolean }
  | { readonly kind: "mutator" };

const INTEGRITY_STATICS: ReadonlyMap<string, IntegrityStatic> = new Map<string, IntegrityStatic>([
  ["isFrozen", { kind: "test", intrinsic: false, primitive: true }],
  ["isSealed", { kind: "test", intrinsic: false, primitive: true }],
  ["isExtensible", { kind: "test", intrinsic: true, primitive: false }],
  ...[...INTEGRITY_MUTATORS].map((name): [string, IntegrityStatic] => [name, { kind: "mutator" }]),
]);

interface SourceIntegrityFacts {
  /** Some source text names an integrity mutator, so no intrinsic is known to be pristine. */
  readonly mayMutate: boolean;
  /**
   * The source shows no syntactic route to `Object` or its statics: every
   * occurrence of the identifier `Object` is `Object.<name>` read as a value
   * or called ({@link isStaticRead}) or an integrity test's operand
   * ({@link isIntegrityTestOperand}); no member is named `Object`
   * (`this.Object`, `$262.global["Object"]`); no `globalThis`, `with` or
   * {@link REFLECTIVE_NAMES} route ({@link isObservedConstructor} aside).
   * Paths the source does not expose are trusted, as #3776's fold trusts them.
   */
  readonly objectStaticsPristine: boolean;
  /** #3776's narrower rule, kept for legacy's adapter: `Object` or `Object.isFrozen` is assigned. */
  readonly isFrozenRebound: boolean;
  /**
   * (#7339) The own-property test names the source spells other than as a
   * member read's name (`"hasOwnProperty"`, `{ hasOwnProperty: f }`, a
   * binding of that name): each could install an own method of that name.
   */
  readonly ownPropertyTestsSpelled: ReadonlySet<string>;
  /**
   * (#7339) An object could carry a member the source does not spell, or have
   * no `%Object.prototype%` on its chain: a store through `x[e]` or an
   * `Object.defineProperty(x, e, …)` whose key `e` is no constant, a mention of
   * `Proxy`, `fromEntries` or `JSON` other than `typeof JSON` / `JSON.stringify`
   * (built-ins that make keys from data, or an exotic object), or an
   * `Object.create` whose prototype is not an object
   * literal, `X.prototype`, a `new` expression or a function.
   */
  readonly unspelledMembersMayExist: boolean;
}

const sourceIntegrityFactsCache = new WeakMap<ts.SourceFile, SourceIntegrityFacts>();

type ExpressionWrapper =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression
  | ts.NonNullExpression;

/** A wrapper that forwards its operand's value unchanged: parentheses and the type-only forms. */
function isExpressionWrapper(node: ts.Node): node is ExpressionWrapper {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (isExpressionWrapper(current)) current = current.expression;
  return current;
}

function propertyNameText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

/** The pure `Object` occurrence: `Object.<name>` read or called, never written, deleted or computed. */
function isStaticRead(object: ts.Identifier): boolean {
  const access = object.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== object || !ts.isIdentifier(access.name)) {
    return false;
  }
  return !isStoreTarget(access) && !ts.isDeleteExpression(unwrapExpressionParent(access).parent);
}

/** `node` with every parenthesis / type wrapper around it: the position its value is used in. */
function unwrapExpressionParent(node: ts.Node): ts.Node {
  while (isExpressionWrapper(node.parent)) node = node.parent;
  return node;
}

/**
 * `x.constructor` used only as an identity (`x.constructor !== C`) or for its
 * `name` (`x.constructor.name`, assert.js's `assert.throws`): neither use can
 * reach a static of the constructor it reads.
 */
function isObservedConstructor(name: ts.Node): boolean {
  const access = name.parent;
  if (!ts.isIdentifier(name) || name.text !== "constructor" || !ts.isPropertyAccessExpression(access)) return false;
  if (access.name !== name) return false;
  const use = unwrapExpressionParent(access);
  const parent = use.parent;
  if (ts.isBinaryExpression(parent)) return isEqualityOperator(parent.operatorToken.kind);
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === use &&
    parent.name.text === "name" &&
    !isStoreTarget(parent) &&
    !ts.isDeleteExpression(unwrapExpressionParent(parent).parent)
  );
}

const OWN_PROPERTY_TESTS: ReadonlySet<string> = new Set<OwnPropertyTest>(["hasOwnProperty", "propertyIsEnumerable"]);

/** Names of built-ins that make keys from data or an exotic object: any mention distrusts the own-property tests. */
const KEY_MAKING_NAMES: ReadonlySet<string> = new Set(["Proxy", "fromEntries"]);

/**
 * A mention of `JSON` that makes no object: `typeof JSON` and `JSON.stringify`
 * (assert.js's value formatter). `JSON.parse` makes keys from data.
 */
function isObjectFreeJsonMention(node: ts.Identifier): boolean {
  const use = unwrapExpressionParent(node);
  const parent = use.parent;
  return (
    ts.isTypeOfExpression(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.expression === use && parent.name.text === "stringify")
  );
}

/** A property key fixed by the source: a literal, a signed number, or the global `undefined` / `NaN` / `Infinity`. */
function isConstantKey(key: ts.Expression): boolean {
  const k = unwrapExpression(key);
  if (ts.isStringLiteralLike(k) || ts.isNumericLiteral(k) || isUnshadowedUndefined(k)) return true;
  if (k.kind === ts.SyntaxKind.TrueKeyword || k.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (k.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(k)) return k.text === "NaN" || k.text === "Infinity";
  return (
    ts.isPrefixUnaryExpression(k) &&
    (k.operator === ts.SyntaxKind.MinusToken || k.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(k.operand)
  );
}

/** A prototype operand of `Object.create` that has `%Object.prototype%` on its chain. */
function hasObjectPrototypeChain(proto: ts.Expression | undefined): boolean {
  const p = proto && unwrapExpression(proto);
  return (
    p !== undefined &&
    (ts.isObjectLiteralExpression(p) ||
      ts.isNewExpression(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      (ts.isPropertyAccessExpression(p) && p.name.text === "prototype"))
  );
}

/** `Object.<name>(…)` with that callee spelled directly. */
function isObjectCall(node: ts.Node, name: string): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrapExpression(node.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    callee.name.text === name
  );
}

/** `Object` passed to an integrity test (`Object.isFrozen(Object)`): a test reads its operand and nothing else. */
function isIntegrityTestOperand(object: ts.Identifier): boolean {
  const call = object.parent;
  if (!ts.isCallExpression(call) || call.arguments.length !== 1 || call.arguments[0] !== object) return false;
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    INTEGRITY_STATICS.get(callee.name.text)?.kind === "test"
  );
}

function sourceIntegrityFacts(sourceFile: ts.SourceFile): SourceIntegrityFacts {
  const cached = sourceIntegrityFactsCache.get(sourceFile);
  if (cached !== undefined) return cached;

  let mayMutate = false;
  let objectStaticsPristine = true;
  let isFrozenRebound = false;
  const ownPropertyTestsSpelled = new Set<string>();
  let unspelledMembersMayExist = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteralLike(node) ||
        (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))) &&
      OWN_PROPERTY_TESTS.has(node.text)
    ) {
      ownPropertyTestsSpelled.add(node.text);
    }
    unspelledMembersMayExist ||=
      ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && KEY_MAKING_NAMES.has(node.text)) ||
      (ts.isIdentifier(node) && node.text === "JSON" && !isObjectFreeJsonMention(node)) ||
      (ts.isElementAccessExpression(node) && isStoreTarget(node) && !isConstantKey(node.argumentExpression)) ||
      (isObjectCall(node, "defineProperty") && node.arguments[1] !== undefined && !isConstantKey(node.arguments[1])) ||
      (isObjectCall(node, "create") && !hasObjectPrototypeChain(node.arguments[0]));

    // Treat even taking a reference to an integrity mutator as unsafe. This
    // covers aliases such as `const freeze = Object.freeze; freeze(Boolean)`.
    if (
      (ts.isPropertyAccessExpression(node) && INTEGRITY_MUTATORS.has(node.name.text)) ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        INTEGRITY_MUTATORS.has(propertyNameText(node.argumentExpression) ?? "")) ||
      (ts.isIdentifier(node) && INTEGRITY_MUTATORS.has(node.text))
    ) {
      mayMutate = true;
    }

    if (
      ts.isWithStatement(node) ||
      (REFLECTIVE_NAMES.has(propertyNameText(node) ?? "") && !isObservedConstructor(node))
    ) {
      objectStaticsPristine = false;
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isObjectKey = ts.isPropertyAssignment(parent) && parent.name === node;
      if (node.text === "globalThis") objectStaticsPristine = false;
      else if (node.text === "Object" && !isObjectKey && !isStaticRead(node) && !isIntegrityTestOperand(node)) {
        objectStaticsPristine = false;
      }
    }
    // A computed key (`o["constr" + "uctor"]`) is outside the trust boundary: assert.js itself uses them.
    if (
      ts.isElementAccessExpression(node) &&
      propertyNameText(unwrapExpression(node.argumentExpression)) === "Object"
    ) {
      objectStaticsPristine = false;
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const left = unwrapExpression(node.left as ts.Expression);
      isFrozenRebound ||=
        (ts.isIdentifier(left) && left.text === "Object") ||
        (ts.isPropertyAccessExpression(left) &&
          ts.isIdentifier(left.expression) &&
          left.expression.text === "Object" &&
          left.name.text === "isFrozen");
    }

    forEachChild(node, visit);
  };
  visit(sourceFile);
  const facts = {
    mayMutate,
    objectStaticsPristine,
    isFrozenRebound,
    ownPropertyTestsSpelled,
    unspelledMembersMayExist,
  };
  sourceIntegrityFactsCache.set(sourceFile, facts);
  return facts;
}

/** The source shows no route to `Object` or its statics ({@link SourceIntegrityFacts.objectStaticsPristine}). */
export function objectStaticsArePristine(sourceFile: ts.SourceFile): boolean {
  return sourceIntegrityFacts(sourceFile).objectStaticsPristine;
}

/**
 * (#7339) No object in the program can carry an own `method` other than the
 * realm's `Object.prototype` one, so the native test (which ignores an own
 * method) answers as `R.<method>(k)` does: the name is spelled only as a member
 * read's name, never stored, deleted or defined; no member is installed under a
 * name the source does not spell; `Object.prototype` is not patched; there is
 * no reflective route to a prototype; and every object has
 * `%Object.prototype%` on its chain (see the facts above). Dynamic code is the
 * realm's question, asked by the plan.
 */
export function ownPropertyTestIsPristine(sourceFile: ts.SourceFile, method: OwnPropertyTest): boolean {
  const facts = sourceIntegrityFacts(sourceFile);
  return (
    !facts.ownPropertyTestsSpelled.has(method) &&
    !facts.unspelledMembersMayExist &&
    !sourceWritesMemberNamed(sourceFile, method) &&
    !sourceMayPatchPrototype(sourceFile, "Object") &&
    !sourceNamesReflectiveRoute(sourceFile)
  );
}

function isEs5IntrinsicObject(expr: ts.Expression, isAmbientBinding: (node: ts.Identifier) => boolean): boolean {
  const target = unwrapExpression(expr);
  if (ts.isIdentifier(target)) {
    return ES5_INTRINSIC_OBJECTS.has(target.text) && isAmbientBinding(target);
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === "prototype" && ts.isIdentifier(target.expression)) {
    return ES5_INTRINSIC_PROTOTYPES.has(target.expression.text) && isAmbientBinding(target.expression);
  }
  return false;
}

/** A literal primitive operand's family; the IR value a mutator returns has this type. */
type IntegrityLiteralFamily = "number" | "string" | "boolean";
type OperandClass = IntegrityLiteralFamily | "nullish" | "intrinsic";

/**
 * The fixed-answer class of an integrity static's operand: a boolean, number
 * or string literal, `null` / the unshadowed `undefined` (no IR value without
 * a consumer's hint), or an ES5 intrinsic while the source names no mutator.
 */
function operandClass(
  expr: ts.Expression,
  isAmbientBinding: (node: ts.Identifier) => boolean,
  mayMutate: boolean,
): OperandClass | undefined {
  const operand = unwrapExpression(expr);
  if (ts.isNumericLiteral(operand)) return "number";
  if (ts.isStringLiteralLike(operand)) return "string";
  if (operand.kind === ts.SyntaxKind.TrueKeyword || operand.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (operand.kind === ts.SyntaxKind.NullKeyword || isUnshadowedUndefined(operand)) return "nullish";
  return !mayMutate && isEs5IntrinsicObject(operand, isAmbientBinding) ? "intrinsic" : undefined;
}

interface IntegrityCall {
  readonly name: string;
  readonly plan: IntegrityStatic;
  readonly operand: ts.Expression;
  readonly operandClass: OperandClass;
  readonly facts: SourceIntegrityFacts;
}

/** `Object.<integrity static>(<one operand>)` on the ambient `Object`, with an operand of a fixed-answer class; else undefined. */
function integrityCall(
  expr: ts.CallExpression,
  isAmbientBinding: (node: ts.Identifier) => boolean,
): IntegrityCall | undefined {
  const callee = expr.expression;
  if (
    expr.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object"
  ) {
    return undefined;
  }
  const name = callee.name.text;
  const plan = INTEGRITY_STATICS.get(name);
  const operand = expr.arguments[0]!;
  if (plan === undefined || ts.isSpreadElement(operand) || !isAmbientBinding(callee.expression)) return undefined;
  const facts = sourceIntegrityFacts(expr.getSourceFile());
  const fixed = operandClass(operand, isAmbientBinding, facts.mayMutate);
  return fixed === undefined ? undefined : { name, plan, operand, operandClass: fixed, facts };
}

/** What an admitted integrity call lowers to: a constant answer, or (a mutator's) its own operand. */
export type IrObjectIntegrityFold =
  | { readonly kind: "answer"; readonly value: boolean }
  | { readonly kind: "operand"; readonly operand: ts.Expression; readonly family: IntegrityLiteralFamily };

/** What the program lets the fold assume beyond its own source. */
export interface IrObjectIntegrityRealm {
  readonly isAmbientBinding: (node: ts.Identifier) => boolean;
  /**
   * The program has a runtime-eval site that may run (`eval`, `Function`,
   * `new Function`: the boundary plan's `providerMayExecute`), whose code the
   * source scan cannot see.
   */
  readonly dynamicCodeMayRun: boolean;
}

/**
 * (#7106 lever O) The ONE admission of an integrity static as a fold, read by
 * the selector and by from-ast:
 *   - a test of a pristine intrinsic or of a primitive (`null` and the global
 *     `undefined` included) is its constant answer; the operand is a literal
 *     or an intrinsic read, so leaving it unevaluated is unobservable;
 *   - a mutator of a boolean, number or string literal is that literal. A
 *     mutator of an intrinsic mutates it, and one of `null` / `undefined`
 *     would need its consumer's hint to lower: both keep legacy.
 * Only while the program shows no route to `Object` or its statics: no
 * dynamic code may run, and the source exposes none
 * ({@link SourceIntegrityFacts.objectStaticsPristine}).
 */
export function objectIntegrityCallFold(
  expr: ts.CallExpression,
  realm: IrObjectIntegrityRealm,
): IrObjectIntegrityFold | undefined {
  if (realm.dynamicCodeMayRun) return undefined;
  const call = integrityCall(expr, realm.isAmbientBinding);
  if (call === undefined || !call.facts.objectStaticsPristine) return undefined;
  const { plan, operand, operandClass } = call;
  if (plan.kind === "test") {
    return { kind: "answer", value: operandClass === "intrinsic" ? plan.intrinsic : plan.primitive };
  }
  return operandClass === "nullish" || operandClass === "intrinsic"
    ? undefined
    : { kind: "operand", operand, family: operandClass };
}

/**
 * Recognise the ES5 initial-realm invariant
 * `Object.isFrozen(%IntrinsicObject%) === false` under #3776's rule: legacy's
 * module-init adapter for the original harness folds exactly this call, and
 * keeps that rule so its bytes do not move. {@link objectIntegrityCallFold}
 * is the stricter IR admission.
 */
export function isPristineEs5IntrinsicIsFrozenCall(
  expr: ts.CallExpression,
  isAmbientBinding: (node: ts.Identifier) => boolean,
): boolean {
  const call = integrityCall(expr, isAmbientBinding);
  return call?.name === "isFrozen" && call.operandClass === "intrinsic" && !call.facts.isFrozenRebound;
}
