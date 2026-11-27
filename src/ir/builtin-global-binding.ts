// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) Whether an identifier reads the global built-in its name names, unchanged: the checker's symbol is
 * declared in lib files only (#7350: or by an expando statement on it), no source declares a binding of that name at
 * any level (a `var`, `let`, `const`, `function`, `class`, parameter or pattern element: the checker resolves a
 * script's top-level `function Object(){}` reference to the lib's symbol, so the declaration is looked for by name),
 * and no source assigns the name:
 * `Object = …`, a compound assignment, `++` / `--`, a destructuring target, or a write through a global-object alias
 * (`globalThis.Object = …`).
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
import { isFreshValue, memberWrites, realmWrittenKeys, type MemberWrite } from "./realm-member-writes.js";
import { REALM_GLOBAL_NAMES } from "./program/builtin-prototype-keys.js";

/** The names a global-object alias reaches the global bindings through. */
const GLOBAL_ALIASES = new Set(["globalThis", "global", "window", "self"]);

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

/** The names a binding pattern or name declares. */
function boundNames(name: ts.BindingName, bind: (name: string) => void): void {
  if (ts.isIdentifier(name)) bind(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) boundNames(element.name, bind);
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
 * One walk over `sourceFiles`: `taken`, every name they declare (at any level) or assign; (#7350) `escaped`, every
 * name some reference of which lets its value escape ({@link keepsValue}); `writtenKeys`, the keys their writes may
 * store or define on a realm object (`realmWrittenKeys`), `undefined` for every key.
 */
function bindingFacts(sourceFiles: readonly ts.SourceFile[]): {
  readonly taken: ReadonlySet<string>;
  readonly escaped: ReadonlySet<string>;
  readonly writtenKeys: ReadonlySet<string> | undefined;
} {
  const declared = new Set<string>();
  const assigned = new Set<string>();
  const mayHoldAny = new Set<string>();
  const escaped = new Set<string>();
  const writes: MemberWrite[] = [];
  const declare = (name: string, fresh: boolean): void => {
    declared.add(name);
    if (!fresh) mayHoldAny.add(name);
  };
  const declareAny = (name: string): void => declare(name, false);
  const visit = (node: ts.Node): void => {
    // A type names no value; `extends X` is an expression and is visited.
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isIdentifier(node) && !isNonReferenceName(node) && !keepsValue(node)) escaped.add(node.text);
    memberWrites(node, (write) => writes.push(write));
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) && node.name)
      declare(node.name.text, true);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
      declare(node.name.text, node.initializer !== undefined && isFreshValue(node.initializer));
    else if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
      boundNames(node.name, declareAny);
    else if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) targetNames(node.left, assigned);
    else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      targetNames(node.operand, assigned);
    else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    )
      targetNames(node.initializer, assigned);
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  const freshNames = new Set([...declared].filter((name) => !mayHoldAny.has(name) && !assigned.has(name)));
  return {
    taken: new Set([...declared, ...assigned]),
    escaped,
    writtenKeys: realmWrittenKeys(writes, freshNames),
  };
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
  const { taken, escaped, writtenKeys } = bindingFacts(sourceFiles);
  const pristine = (identifier: ts.Identifier) => !taken.has(identifier.text) && libOnly(identifier);
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
 * define the key `k` on a realm object (`realm-member-writes.ts`): every store, definition or key writer that names
 * `k`, or names no key it spells, has a receiver that is a fresh value or a name only ever bound to one. That rules
 * out a write of `X.k` by any route, including the ones that never spell `X` (`X.prototype.constructor`,
 * `(1).constructor`, `this` in a method `X` inherits, a re-export), so a fold of a writable member (an `Object`
 * static's call form, `Number.isNaN`, a `Math` method, …) reads the built-in. A non-writable, non-configurable
 * constant (`Number.MAX_VALUE`) folds wherever the name is pristine: a write of it fails.
 * Not yet seen: code eval or the `Function` constructor runs (#7503; both refuse on the Prepared path today).
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
