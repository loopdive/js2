// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) Whether an identifier reads the global built-in its name names, unchanged: the checker's symbol is
 * declared in lib files only (#7350: or by an expando statement on it), no source declares a binding of that name at
 * any level (a `var`, `let`, `const`, `function`, `class`, parameter, pattern element, import, enum, namespace, …:
 * the checker resolves a script's top-level `function Object(){}` reference to the lib's symbol, so the declaration is
 * looked for by name), and no source assigns the name:
 * `Object = …`, a compound assignment, `++` / `--`, `delete`, a destructuring target, or a write through a
 * global-object alias (`globalThis.Object = …`).
 * The one answer for "this is the global `Object`" of the native statics' call form and of the flow rule beside it.
 * (#7350) Its second answer is the member rule ({@link foldsBuiltinMember}): whether a fold of a writable member of
 * the name still reads the built-in's.
 */
import { ts } from "../ts-api.js";
import { makeIrAmbientBindingPredicate } from "./module-bindings.js";
import {
  isNonReferenceName,
  occurrenceIsWriteTarget,
  outermostParenthesized,
  skipOuterExpressions,
} from "../shared/binding-writes.js";
import {
  memberWrites,
  objectCreateCallee,
  realmWrittenKeys,
  type MemberWrite,
  type NameBinding,
} from "./realm-member-writes.js";
import { REALM_GLOBAL_NAMES } from "./program/builtin-prototype-keys.js";

/** The names a global-object alias reaches the global bindings through. */
export const GLOBAL_ALIASES: ReadonlySet<string> = new Set(["globalThis", "global", "window", "self"]);

const isAssignment = (kind: ts.SyntaxKind): boolean =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

/** The names an assignment target writes: identifiers of a destructuring pattern, a global alias's member. */
function targetNames(written: ts.Expression, into: Set<string>): void {
  // (#7350 B3a) A type assertion (`(String as any) = …`) writes what it asserts, like a parenthesis.
  const target = skipOuterExpressions(written);
  if (ts.isIdentifier(target)) into.add(target.text);
  else if (ts.isPropertyAccessExpression(target)) {
    const object = skipOuterExpressions(target.expression);
    if (object.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(object) && GLOBAL_ALIASES.has(object.text)))
      into.add(target.name.text);
  } else if (ts.isArrayLiteralExpression(target))
    target.elements.forEach((element) => targetNames(ts.isSpreadElement(element) ? element.expression : element, into));
  else if (ts.isObjectLiteralExpression(target))
    for (const property of target.properties) {
      if (ts.isShorthandPropertyAssignment(property)) into.add(property.name.text);
      else if (ts.isPropertyAssignment(property)) targetNames(property.initializer, into);
      else if (ts.isSpreadAssignment(property)) targetNames(property.expression, into);
    }
  else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    targetNames(target.left, into);
}

const FRESH: NameBinding = { kind: "fresh" };
const ANY: NameBinding = { kind: "any" };

/**
 * The declarations whose `name` binds no value: a member key, a type, an export name, a meta property. Soundness rests
 * on one invariant: the list never holds a kind that binds a value. A kind missing from it only costs precision (its
 * name records `any`); a value-binding kind added to it would let that name hold a value the scan never sees. An enum
 * member is not listed: inside its enum's body it is a bare-name binding (`enum E { A = …, B = o[A] }`). In
 * `tests/issue-7350-slice1-expando-escape.test.ts`, the #7628 stop rows of an enum, an enum member, a namespace and
 * `import p = require(…)` fail when their kind is listed here (the guard of the invariant), and the CTL row of an
 * interface and a type alias fails when those leave it (the list's precision).
 */
const BINDS_NO_VALUE: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.ExportSpecifier,
  ts.SyntaxKind.NamespaceExport,
  ts.SyntaxKind.MetaProperty,
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.ImportAttribute,
]);

/** A variable of a for-in / for-of head: it holds the loop's values, whatever its (Annex B) initializer. */
function isLoopHeadVariable(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  return (ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent)) && list.parent.initializer === list;
}

/**
 * The binding `name` declares, or `undefined` when it declares none. A function or class name is `fresh`, a variable
 * with an initializer outside a loop head stores it, and every other declaration (a parameter, a pattern element, a
 * `catch` variable, an import, an enum, a namespace, …) may hold any value.
 */
function declaredBinding(name: ts.Identifier): NameBinding | undefined {
  const declaration = name.parent;
  if (!("name" in declaration) || declaration.name !== name || BINDS_NO_VALUE.has(declaration.kind)) return undefined;
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isClassExpression(declaration)
  )
    return FRESH;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer && !isLoopHeadVariable(declaration))
    return { kind: "initializer", value: declaration.initializer };
  return ANY;
}

/** The value an assignment `x op= e` stores in `x`: `e` through a chain of `=`, `e` for a logical assignment. */
function assignedValue(assignment: ts.BinaryExpression): ts.Expression {
  switch (assignment.operatorToken.kind) {
    case ts.SyntaxKind.EqualsToken: {
      const right = skipOuterExpressions(assignment.right);
      return ts.isBinaryExpression(right) && right.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ? assignedValue(right)
        : assignment.right;
    }
    case ts.SyntaxKind.BarBarEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
      return assignment.right;
    default:
      return assignment;
  }
}

/**
 * (#7350) `reference`, a reference to a name, keeps the value inside the name: it is a callee (`X(v)`, `new X(v)`), the
 * object of a member read that is no store target (`X.k`, `X.k(…)`; not `X.k = …`, `X.k++`, `delete X.k`,
 * `[X.k] = …`, `for (X.k in o)`), a `typeof` operand or the right side of `instanceof`. Anything else (an argument, an
 * initializer, an element access, a property value, an export) lets the value escape.
 */
function keepsValue(reference: ts.Identifier): boolean {
  const use = outermostParenthesized(reference);
  const parent = use.parent;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isTypeOfExpression(parent))
    return parent.expression === use;
  if (ts.isBinaryExpression(parent))
    return parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === use;
  return ts.isPropertyAccessExpression(parent) && !occurrenceIsWriteTarget(parent);
}

/**
 * One walk over `sourceFiles`: `bindings`, every binding and assignment of a name, by text ({@link declaredBinding},
 * the implicit `arguments` of every function that is no arrow function, assignments, `++` / `--`, `delete` and for-in /
 * for-of targets); (#7350) `escaped`, every name some reference of which lets its value escape ({@link keepsValue});
 * `writes`, the stores and definitions they make (`memberWrites`); `createCallees`, the `Object` of every
 * `Object.create(…)` call.
 */
function bindingFacts(sourceFiles: readonly ts.SourceFile[]): {
  readonly bindings: ReadonlyMap<string, readonly NameBinding[]>;
  readonly escaped: ReadonlySet<string>;
  readonly writes: readonly MemberWrite[];
  readonly createCallees: readonly ts.Identifier[];
} {
  const bindings = new Map<string, NameBinding[]>();
  const escaped = new Set<string>();
  const writes: MemberWrite[] = [];
  const createCallees: ts.Identifier[] = [];
  const bind = (name: string, binding: NameBinding): void => {
    const list = bindings.get(name);
    if (list) list.push(binding);
    else bindings.set(name, [binding]);
  };
  const targetsAny = (target: ts.Expression): void => {
    const names = new Set<string>();
    targetNames(target, names);
    names.forEach((name) => bind(name, ANY));
  };
  const assigns = (target: ts.Expression, value: ts.Expression): void => {
    const name = skipOuterExpressions(target);
    if (ts.isIdentifier(name)) bind(name.text, { kind: "assigned", value });
    else targetsAny(target);
  };
  const visit = (node: ts.Node): void => {
    // A type names no value; `extends X` is an expression and is visited.
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isIdentifier(node)) {
      const binding = declaredBinding(node);
      if (binding) bind(node.text, binding);
      if (!isNonReferenceName(node) && !keepsValue(node)) escaped.add(node.text);
    }
    memberWrites(node, (write) => writes.push(write));
    const createCallee = ts.isCallExpression(node) ? objectCreateCallee(node) : undefined;
    if (createCallee) createCallees.push(createCallee);
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node) && "body" in node && node.body) bind("arguments", ANY);
    if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) assigns(node.left, assignedValue(node));
    else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      assigns(node.operand, node);
    else if (ts.isDeleteExpression(node)) targetsAny(node.expression);
    else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    )
      targetsAny(node.initializer);
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  return { bindings, escaped, writes, createCallees };
}

interface BuiltinGlobalFacts {
  readonly pristine: (identifier: ts.Identifier) => boolean;
  readonly foldsBuiltinMember: (identifier: ts.Identifier) => boolean;
}

const programFacts = new WeakMap<readonly ts.SourceFile[], BuiltinGlobalFacts>();

/**
 * The facts for the program of `sourceFiles`, built once per source list. An expando statement on the name
 * (`X.k = v;`, `Object.defineProperty(X, "k", d);`) binds nothing, so the name stays pristine
 * (`makeIrAmbientBindingPredicate`'s `"every-but-expando"`); it lets `X` escape and writes `k`, so `X.k` does not fold.
 */
function builtinGlobalFacts(checker: ts.TypeChecker, sourceFiles: readonly ts.SourceFile[]): BuiltinGlobalFacts {
  const known = programFacts.get(sourceFiles);
  if (known) return known;
  const libOnly = makeIrAmbientBindingPredicate(checker, "every-but-expando");
  const { bindings, escaped, writes, createCallees } = bindingFacts(sourceFiles);
  const pristine = (identifier: ts.Identifier) => !bindings.has(identifier.text) && libOnly(identifier);
  // An `Object.create(…)` result is fresh while `create` folds: `Object` pristine and never escaping, `create` unwritten.
  const createIsBuiltin = !escaped.has("Object") && createCallees.every(pristine);
  const writtenKeys = realmWrittenKeys(writes, bindings, createIsBuiltin);
  const facts: BuiltinGlobalFacts = {
    pristine,
    foldsBuiltinMember: (identifier) => {
      const member = identifier.parent;
      return (
        ts.isPropertyAccessExpression(member) &&
        member.expression === identifier &&
        writtenKeys?.has(member.name.text) === false &&
        !escaped.has(identifier.text) &&
        pristine(identifier)
      );
    },
  };
  programFacts.set(sourceFiles, facts);
  return facts;
}

/** The predicate for the program of `sourceFiles`: the identifier reads the unchanged built-in of its name. */
export function pristineBuiltinGlobal(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
): (identifier: ts.Identifier) => boolean {
  return builtinGlobalFacts(checker, sourceFiles).pristine;
}

/**
 * (#7350) The member rule, for the program of `sourceFiles`: `identifier`, the object of a member access `X.k`, is
 * pristine, no reference of `X` lets its value escape ({@link keepsValue}), and no write in the sources may store or
 * define the key `k` on a realm object (`realm-member-writes.ts`). The writes counted, by key unless their receiver is a
 * fresh value (a literal, a function or class expression, an `Object.create(…)` result while `create` folds) or a name
 * only ever bound to one:
 * - a store target `o.k` / `o["k"]` (assignment, compound, `++` / `--`, `delete`, destructuring, for-in / for-of);
 * - a call of `defineProperty`, `defineProperties`, `assign`, `__defineGetter__` or `__defineSetter__` as a member, by
 *   its literal key operands (a computed one is every key);
 * - a call of `getOwnPropertyDescriptors`, `values`, `entries`, or `getOwnPropertyDescriptor` by a key that is no
 *   literal, as a member: as every key of its operand (it hands out a key writer's value).
 * Counted as a write of every key on any object: any other spelling of those names (`var d = Object.defineProperty`,
 * `.call`, a string), `with`, any spelling of `Reflect` (`globalThis.Reflect`, `this["Reflect"]`), and (#7628) a read
 * by a key that is no literal (`Object["define" + "Property"]`, `` Object[`define${p}`] ``, `var {[k]: d} = Object`,
 * `Object[n]` over `getOwnPropertyNames(Object)`) unless its key's values are known and name no key writer
 * (`key-values.ts`; a name is known when every binding of it stores a value the evaluator reads). So no write of `X.k`
 * escapes the count by a route that never spells `X` (`X.prototype.constructor`, `(1).constructor`, `this` in a method
 * `X` inherits, a re-export), and a fold of a writable member (an `Object` static's call form, `Number.isNaN`, a `Math`
 * method, …) reads the built-in, except by the routes below. A non-writable, non-configurable constant
 * (`Number.MAX_VALUE`) folds wherever the name is pristine: a write of it fails.
 * Not yet seen: code the runtime-eval provider or the `Function` constructor runs (#7503); a literal eval site's text
 * (#7363) is a program source and is seen. Not counted: built-ins that write an object's index keys, `length` or
 * `lastIndex` (`Array.prototype.push.call(X, v)`, an array method's species result): no folded member is one, and a
 * constructor's `length` is not writable.
 */
export function foldsBuiltinMember(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
): (identifier: ts.Identifier) => boolean {
  return builtinGlobalFacts(checker, sourceFiles).foldsBuiltinMember;
}

/**
 * (#7354 G1) The first script-level `var` without an initializer declaring a global the realm serves a built-in for
 * (`REALM_GLOBAL_NAMES`): such a `var` binds the global object's existing property (§16.1.7
 * GlobalDeclarationInstantiation), so the name keeps reading the built-in, while this path gives a script `var` its
 * own home starting at `undefined`. The name is no pristine global either (`bindingFacts`); the Prepared path
 * refuses the program by this declaration rather than read either value. A `var` with an initializer replaces the
 * built-in where it runs (a read before it still sees the home's `undefined`: not handled here, as before G1); a `var`
 * inside a function binds a local.
 */
export function scriptVarOfRealmGlobal(sourceFiles: readonly ts.SourceFile[]): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.BlockScoped) === 0 &&
      node.initializer === undefined &&
      REALM_GLOBAL_NAMES.has(node.name.text)
    )
      found = node;
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  return found;
}
