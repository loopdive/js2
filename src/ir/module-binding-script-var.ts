// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The source facts a write-certified SCRIPT `var` home rests on, shared by
 * every certifier of one (#7252's class instance, #7292's string vec, #7274's
 * native buffers, #7354's IR-owned typed home): where the binding is written,
 * and whether a use reads a slot that has been written.
 *
 * (#7354 H2) A script binding (a top-level `var` or function declaration) is a property of the global object
 * (§9.1.1.4, §16.1.7), so besides an identifier reference it is reached by the global object as a value (script or
 * sloppy-function `this`, `globalThis`, `Object.defineProperty(this, …)`), by dynamic code (`eval`, `Function`,
 * `x.constructor(…)`), by `with`, by an Annex B block function (§B.3.3.2) and by `delete`. On the Prepared path
 * every one of those refuses or aborts at its own site, so {@link scriptVarWrites} — the identifier writes, by
 * checker identity — are all the writes there are. A slice that admits one of those routes writes the binding's
 * home or refuses; tests/issue-7354-h2-script-binding-routes.test.ts holds a program for each route.
 */
import { ts } from "../ts-api.js";
import {
  hasDynamicScope,
  identifierWritesOf,
  outermostParenthesized,
  type IdentifierWrite,
} from "../shared/binding-writes.js";
import {
  isValueReference,
  sourceMayWriteGlobalObject,
  sourceRunsDynamicCode,
} from "../shared/intrinsic-prototype-writes.js";
import { isTopLevelStatementDeclaration, isTopLevelVarList } from "../shared/var-declaration-lists.js";

type ScriptBindingDeclaration = ts.VariableDeclaration | ts.FunctionDeclaration;

const identifierWritesCache = new WeakMap<ScriptBindingDeclaration, readonly IdentifierWrite[] | null>();

/**
 * Every write of the script binding `declaration` anywhere in its source (a `var`'s own initializer included; a
 * function declaration writes none), or `undefined` when a `with` / direct `eval` could write it outside checker
 * identity.
 */
export function scriptVarWrites(
  checker: ts.TypeChecker,
  declaration: ScriptBindingDeclaration,
): readonly IdentifierWrite[] | undefined {
  return hasDynamicScope(declaration.getSourceFile()) ? undefined : identifierWrites(checker, declaration);
}

/**
 * (#7354 H2) Whether anything but `declaration` itself stores into its binding on the Prepared path, where the
 * identifier writes are all the writes (above): `with` and `eval` refuse or abort at their own sites.
 */
export function scriptBindingRewritten(checker: ts.TypeChecker, declaration: ScriptBindingDeclaration): boolean {
  return identifierWrites(checker, declaration)?.some((write) => write.target !== declaration.name) ?? true;
}

/** The identifier writes of `declaration`'s binding, by checker identity; `undefined` for a pattern or a nameless declaration. */
function identifierWrites(
  checker: ts.TypeChecker,
  declaration: ScriptBindingDeclaration,
): readonly IdentifierWrite[] | undefined {
  let cached = identifierWritesCache.get(declaration);
  if (cached === undefined) {
    cached = collectIdentifierWrites(checker, declaration) ?? null;
    identifierWritesCache.set(declaration, cached);
  }
  return cached ?? undefined;
}

function collectIdentifierWrites(
  checker: ts.TypeChecker,
  declaration: ScriptBindingDeclaration,
): IdentifierWrite[] | undefined {
  if (!declaration.name || !ts.isIdentifier(declaration.name)) return undefined;
  const bindingSymbol = checker.getSymbolAtLocation(declaration.name);
  const writes: IdentifierWrite[] = [];
  const visit = (node: ts.Node): void => {
    for (const write of identifierWritesOf(node)) {
      if (checker.getSymbolAtLocation(write.target) === bindingSymbol) writes.push(write);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration.getSourceFile(), visit);
  return writes;
}

/**
 * True when `node` is the declaration itself or a module-init use that runs
 * after it, so the script var's slot has been written: a top-level statement
 * after it, outside every function and class body. Which operators a home
 * lets read the slot is the home's own rule: the class-instance, capability,
 * vec and native-buffer homes refuse a `typeof` / `delete` operand
 * (`isTypeofOrDeleteOperand`); the string home (#7346) reads `typeof`'s.
 */
export function scriptVarUseFollowsDeclaration(
  node: ts.Identifier,
  declaration: ts.VariableDeclaration | ts.BindingElement,
): boolean {
  if (node === declaration.name) return true;
  const statement = ts.findAncestor(declaration, ts.isVariableStatement);
  return statement !== undefined && placedAfter(node, statement.end, isCallable);
}

/**
 * `node` sits after `statementEnd` and no enclosing node `defers` may run it from earlier code. A certified home
 * defers every function and class (`isCallable`); the typed home only a hoisted function (`isHoistedFunction`),
 * since any other one is created where it stands.
 */
function placedAfter(node: ts.Node, statementEnd: number, defers: (enclosing: ts.Node) => boolean): boolean {
  return node.pos >= statementEnd && ts.findAncestor(node.parent, defers) === undefined;
}

function isCallable(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isClassLike(node);
}

/** A `var` declarator binding one name, the only shape a script var's typed home can be. */
export type NamedVariableDeclaration = ts.VariableDeclaration & { readonly name: ts.Identifier };

/**
 * (#7354 V) True when no read of the script var `declaration` can run before its initializer: a typed slot has
 * no `undefined`, so a read of the hoisted binding would answer the slot's zero. The declaration is a top-level
 * statement's or (#7372) a top-level `for (;;)` head's, initialized, and every read either is placed after its
 * list outside every hoisted function, or sits in a hoisted function nothing before the list can call
 * (`callableBefore`). Name-based, like
 * `isAlwaysUndefinedVar`: every reference spelled with the name is a read unless the checker binds it to another
 * symbol, a plain `=` target only writes, and code the walk cannot see (`eval`, `Function`) declines. Only the
 * declaration's own file is walked: the caller answers for the program's other scripts, which share its global.
 */
export function scriptVarReadsFollowInitializer(
  checker: ts.TypeChecker,
  declaration: NamedVariableDeclaration,
): boolean {
  const { name, initializer } = declaration;
  if (!initializer || !runsBeforeLaterTopLevelCode(declaration)) return false;
  const sourceFile = declaration.getSourceFile();
  if (sourceRunsDynamicCode(sourceFile)) return false;
  const statementEnd = declaration.parent.end;
  const binding = checker.getSymbolAtLocation(name);
  const isRead = (node: ts.Identifier): boolean => {
    if (!isValueReference(node)) return false;
    const user = outermostParenthesized(node);
    if (ts.isBinaryExpression(user.parent) && user.parent.left === user && isPlainAssignment(user.parent)) return false;
    // A shorthand property's name resolves to the property; the binding it reads is its value symbol.
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    // An unresolved name (inside `with`, the checker binds none) may be this binding.
    return symbol === binding || symbol === undefined;
  };
  return spellingsOf(sourceFile, name.text).every((node) => {
    if (!ts.isIdentifier(node) || !isRead(node)) return true;
    const fn = ts.findAncestor(node.parent, isHoistedFunction);
    return fn ? !callableBefore(fn, statementEnd) : node.pos >= statementEnd;
  });
}

/**
 * (#7372) Whether the declarator's list is a top-level statement's or a top-level `for (;;)` head's: either runs
 * once, before every later top-level statement and, for a head, before the loop's test, body and update.
 */
function runsBeforeLaterTopLevelCode(declaration: ts.VariableDeclaration): boolean {
  if (isTopLevelStatementDeclaration(declaration)) return true;
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list) && ts.isForStatement(list.parent) && isTopLevelVarList(list);
}

/**
 * Whether code before `statementEnd` may call the hoisted function `fn`: the global object escapes (a computed
 * member of it may be `fn`), or its name is spelled (a reference, a member name, a string) outside `fn` anywhere
 * but where `placedAfter` the statement.
 */
function callableBefore(fn: ts.FunctionDeclaration, statementEnd: number): boolean {
  const sourceFile = fn.getSourceFile();
  // Nameless only as a module's `export default function () {}`, which an importer in a cycle runs first.
  if (fn.name === undefined || sourceMayWriteGlobalObject(sourceFile)) return true;
  return spellingsOf(sourceFile, fn.name.text).some(
    (node) => !isDescendantOf(node, fn) && !placedAfter(node, statementEnd, isHoistedFunction),
  );
}

const spellingIndexCache = new WeakMap<ts.SourceFile, ReadonlyMap<string, readonly ts.Node[]>>();

/** Every identifier and string literal of `sourceFile` spelled `text`, in source order; the file is indexed once. */
function spellingsOf(sourceFile: ts.SourceFile, text: string): readonly ts.Node[] {
  let index = spellingIndexCache.get(sourceFile);
  if (index === undefined) {
    const built = new Map<string, ts.Node[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
        const found = built.get(node.text);
        if (found) found.push(node);
        else built.set(node.text, [node]);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    spellingIndexCache.set(sourceFile, (index = built));
  }
  return index.get(text) ?? [];
}

/**
 * A function declaration that is a top-level statement, labelled or not: its function exists before the first
 * statement runs. A nested one is created where its enclosing code runs.
 */
function isHoistedFunction(node: ts.Node): node is ts.FunctionDeclaration {
  if (!ts.isFunctionDeclaration(node)) return false;
  let statement: ts.Node = node;
  while (ts.isLabeledStatement(statement.parent)) statement = statement.parent;
  return ts.isSourceFile(statement.parent);
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  return ts.findAncestor(node, (current) => current === ancestor) !== undefined;
}

function isPlainAssignment(expression: ts.BinaryExpression): boolean {
  return expression.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/** True when `node` is the operand of `typeof` / `delete`. */
export function isTypeofOrDeleteOperand(node: ts.Identifier): boolean {
  const parent = outermostParenthesized(node).parent;
  return ts.isTypeOfExpression(parent) || ts.isDeleteExpression(parent);
}
