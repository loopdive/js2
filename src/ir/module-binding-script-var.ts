// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The source facts a write-certified SCRIPT `var` home rests on, shared by
 * every certifier of one (#7252's class instance, #7292's string vec, #7274's
 * native buffers, #7354's IR-owned typed home): where the binding is written,
 * and whether a use reads a slot that has been written.
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
import { isTopLevelStatementDeclaration } from "../shared/var-declaration-lists.js";

const scriptVarWritesCache = new WeakMap<ts.VariableDeclaration, readonly IdentifierWrite[] | null>();

/**
 * Every write of the script var `declaration` anywhere in its source (the
 * declaration's own included), or `undefined` when a `with` / direct `eval`
 * could write it outside checker identity.
 */
export function scriptVarWrites(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
): readonly IdentifierWrite[] | undefined {
  let cached = scriptVarWritesCache.get(declaration);
  if (cached === undefined) {
    cached = collectScriptVarWrites(checker, declaration) ?? null;
    scriptVarWritesCache.set(declaration, cached);
  }
  return cached ?? undefined;
}

function collectScriptVarWrites(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
): IdentifierWrite[] | undefined {
  const sourceFile = declaration.getSourceFile();
  if (!ts.isIdentifier(declaration.name) || hasDynamicScope(sourceFile)) return undefined;
  const bindingSymbol = checker.getSymbolAtLocation(declaration.name);
  const writes: IdentifierWrite[] = [];
  const visit = (node: ts.Node): void => {
    for (const write of identifierWritesOf(node)) {
      if (checker.getSymbolAtLocation(write.target) === bindingSymbol) writes.push(write);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
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
  if (statement === undefined || node.pos < statement.end) return false;
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return false;
  }
  return true;
}

/**
 * (#7354 V) True when no read of the script var `declaration` can run before its initializer: a typed slot has
 * no `undefined`, so a read of the hoisted binding would answer the slot's zero. The declaration is a top-level
 * statement's, initialized, and every read either runs after the statement (`runsAfter`) or sits in a top-level
 * function declaration nothing before the statement can call (`callableBefore`). Name-based, like
 * `isAlwaysUndefinedVar`: every reference spelled with the name is a read unless the checker binds it to another
 * declaration of the program, a plain `=` target only writes, and code the walk cannot see (`eval`, `Function`)
 * declines.
 */
export function scriptVarReadsFollowInitializer(checker: ts.TypeChecker, declaration: ts.VariableDeclaration): boolean {
  const { name, initializer } = declaration;
  if (!ts.isIdentifier(name) || !initializer || !isTopLevelStatementDeclaration(declaration)) return false;
  const sourceFile = declaration.getSourceFile();
  if (sourceRunsDynamicCode(sourceFile)) return false;
  const statementEnd = declaration.parent.parent.end;
  const binding = checker.getSymbolAtLocation(name);
  const isRead = (node: ts.Identifier): boolean => {
    if (node.text !== name.text || !isValueReference(node)) return false;
    const user = outermostParenthesized(node);
    if (ts.isBinaryExpression(user.parent) && user.parent.left === user && isPlainAssignment(user.parent)) return false;
    const symbol = checker.getSymbolAtLocation(node);
    return symbol === binding || !symbol?.declarations?.some((other) => !other.getSourceFile().isDeclarationFile);
  };
  return spellings(sourceFile, (node) => ts.isIdentifier(node) && isRead(node)).every((read) => {
    const owner = outermostCallableOwner(read);
    return owner && isHoistedFunction(owner) ? !callableBefore(owner, statementEnd) : runsAfter(read, statementEnd);
  });
}

/** A module-init node after `statementEnd`, or one inside a function or class created there. */
function runsAfter(node: ts.Node, statementEnd: number): boolean {
  const owner = outermostCallableOwner(node);
  if (owner && isHoistedFunction(owner)) return false;
  return (owner ?? node).pos >= statementEnd;
}

/**
 * Whether code before `statementEnd` may call the top-level function `fn`: the global object escapes (a computed
 * member of it may be `fn`), or its name is spelled (a reference, a member name, a string) outside `fn` anywhere
 * but module-init after the statement or a function or class created there.
 */
function callableBefore(fn: ts.FunctionDeclaration, statementEnd: number): boolean {
  const name = fn.name?.text;
  const sourceFile = fn.getSourceFile();
  if (name === undefined || sourceMayWriteGlobalObject(sourceFile)) return true;
  const spelled = (node: ts.Node) => (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === name;
  return spellings(sourceFile, spelled).some((node) => !isDescendantOf(node, fn) && !runsAfter(node, statementEnd));
}

/** Every node of `sourceFile` that `matches`, in source order. */
function spellings(sourceFile: ts.SourceFile, matches: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (matches(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/** The outermost function or class `node` sits in: the code that may run it later than its position. */
function outermostCallableOwner(node: ts.Node): ts.Node | undefined {
  let owner: ts.Node | undefined;
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent)
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) owner = current;
  return owner;
}

/** A top-level function declaration: its function exists before the first statement runs. */
function isHoistedFunction(node: ts.Node): node is ts.FunctionDeclaration {
  return ts.isFunctionDeclaration(node) && ts.isSourceFile(node.parent);
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
