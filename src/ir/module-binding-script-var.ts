// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The source facts a write-certified SCRIPT `var` home rests on, shared by
 * every certifier of one (#7252's class instance, #7292's string vec, #7274's
 * native buffers, #7354's IR-owned typed home): where the binding is written,
 * and whether a use reads a slot that has been written.
 *
 * (#7354 H2) On the Prepared path a script binding (a top-level `var` or function declaration) is written only by
 * the identifier writes {@link preparedBindingRewritten} sees. The binding is a property of the global object
 * (§9.1.1.4, §16.1.7), so other routes reach it too, and on this path each refuses or aborts at its own site:
 *   - the global object as a value: script or sloppy-function `this`, `globalThis`, `Object.defineProperty(this, …)`;
 *   - dynamic code: `eval`, `Function`, `x.constructor(…)`;
 *   - `with`: the checker resolves no symbol for a name in its body, so a write there is invisible to the query;
 *   - an Annex B block function (§B.3.3.2) of the binding's name (`annexb-block-function-values.ts` gives a block
 *     function its own homes only where no other declaration binds the name), and `delete`;
 *   - a parameter initializer (`function w(a = (f = v)) { var f; }`): the checker resolves `f` to the body's `var`,
 *     but the write hits the outer binding (§10.2.11).
 * A slice that admits one of these routes writes the binding's home or refuses;
 * tests/issue-7354-h2-script-binding-routes.test.ts holds a program for each. The ordinary pipeline has no such
 * invariant (a host `eval` runs there), so {@link scriptVarWrites}, which its certifiers share, still declines under
 * `with` / direct `eval`.
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

const identifierWritesCache = new WeakMap<ts.Identifier, readonly IdentifierWrite[]>();

/**
 * Every write of the script var `declaration` anywhere in its source (its own initializer included), or `undefined`
 * when its name is a pattern or a `with` / direct `eval` could write it outside checker identity.
 */
export function scriptVarWrites(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
): readonly IdentifierWrite[] | undefined {
  const { name } = declaration;
  if (!ts.isIdentifier(name) || hasDynamicScope(declaration.getSourceFile())) return undefined;
  return identifierWrites(checker, name);
}

/**
 * (#7354 H2) Whether anything but its own declaration stores into the binding `name` declares (a `var`'s or a
 * function declaration's name), on the Prepared path (module doc).
 */
export function preparedBindingRewritten(checker: ts.TypeChecker, name: ts.Identifier): boolean {
  return identifierWrites(checker, name).some((write) => write.target !== name);
}

/**
 * The identifier writes of the binding `name` declares, by checker identity. A shorthand target (`({ f } = o)`)
 * resolves to its property, so its binding is the shorthand's value symbol.
 */
function identifierWrites(checker: ts.TypeChecker, name: ts.Identifier): readonly IdentifierWrite[] {
  let writes = identifierWritesCache.get(name);
  if (writes === undefined) {
    const binding = checker.getSymbolAtLocation(name);
    const found: IdentifierWrite[] = [];
    const visit = (node: ts.Node): void => {
      for (const write of identifierWritesOf(node)) {
        const { parent } = write.target;
        const symbol = ts.isShorthandPropertyAssignment(parent)
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(write.target);
        if (symbol === binding) found.push(write);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(name.getSourceFile(), visit);
    identifierWritesCache.set(name, (writes = found));
  }
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
