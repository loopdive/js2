// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7014) Syntactic write-to-`const` detection for the IR lowerer.
 *
 * A write to a `const` binding is a TypeScript error that still emits code, and
 * at run time it must throw a TypeError, which only the legacy lowering raises.
 * The selector therefore refuses a subject that writes a const
 * (`firstConstBindingWrite`), and (#7106) a destructuring declaration whose leaf
 * is written at all (`declarationBindingWritten`).
 */
import { ts, forEachChild } from "../ts-api.js";
import { isLexicalBindingWrite, varDeclaratorWrittenNames } from "../shared/binding-writes.js";
import { collectPatternBindingNames, isFunctionScopeBoundary } from "./analysis/ast-scope.js";
import { getFunctionOwnLocals } from "./analysis/binding-info.js";

/**
 * The first identifier in `root` that writes a `const` binding: any assignment,
 * `++`/`--`, destructuring or loop-head target, nested functions included. The
 * selector refuses such a subject whole (`constBindingWriteRefused`).
 */
export function firstConstBindingWrite(root: ts.Node): ts.Identifier | undefined {
  let write: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (write) return;
    if (ts.isIdentifier(node) && isLexicalBindingWrite(node) && isWriteToConstDeclaration(node)) write = node;
    else forEachChild(node, visit);
  };
  visit(root);
  return write;
}

/**
 * (#7014) Does the write target `id` resolve to a `const` binding? Syntactic:
 * the nearest enclosing declaration of the name wins — a block's (a whole
 * `switch` body's) `let`/`const`/`var` (pattern leaves included), function or
 * class; a loop head; a catch parameter; a function's own locals (parameters,
 * hoisted `var`s). A named function expression's own name, and a class's name
 * inside its body, are immutable bindings, so they count as `const`.
 */
function isWriteToConstDeclaration(id: ts.Identifier): boolean {
  const binds = (name: ts.BindingName): boolean => [...collectPatternBindingNames(name)].includes(id.text);
  const declares = (list: ts.VariableDeclarationList): boolean => list.declarations.some((d) => binds(d.name));
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      const declaredConst = blockDeclarations(n).get(id.text);
      if (declaredConst !== undefined) return declaredConst;
    }
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n)) && n.initializer) {
      const init = n.initializer;
      if (ts.isVariableDeclarationList(init) && declares(init)) return (init.flags & ts.NodeFlags.Const) !== 0;
    }
    if (ts.isCatchClause(n) && n.variableDeclaration && binds(n.variableDeclaration.name)) return false;
    if (isFunctionScopeBoundary(n) && getFunctionOwnLocals(n).has(id.text)) return false;
    if ((ts.isFunctionExpression(n) || ts.isClassLike(n)) && n.name?.text === id.text) return true;
  }
  return false;
}

/**
 * (#7106) Is a name `declaration` binds written anywhere in its scope — an
 * assignment, update, destructuring or for-in/of target, or a later `var`
 * re-declaration, nested functions included? The scope is the enclosing block,
 * `switch` case block or `for` statement of a `let`/`const`, the function or
 * script of a `var`. Syntactic, so a write to a same-named inner binding counts
 * too.
 */
export function declarationBindingWritten(declaration: ts.VariableDeclaration): boolean {
  const writes = scopeWrites(bindingScopeOf(declaration));
  return [...collectPatternBindingNames(declaration.name)].some(
    (name) => writes.targets.has(name) || writes.declarators.get(name)?.some((other) => other !== declaration),
  );
}

function bindingScopeOf(declaration: ts.VariableDeclaration): ts.Node {
  const list = declaration.parent;
  if (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) {
    return ts.isVariableStatement(list.parent) ? blockScopeOf(list.parent.parent) : list.parent;
  }
  let scope: ts.Node = list;
  while (scope.parent && !isFunctionScopeBoundary(scope)) scope = scope.parent;
  return scope;
}

/** The scope of a block-level declaration in `statements`: a `case` clause's is its whole `switch` body. */
function blockScopeOf(statements: ts.Node): ts.Node {
  return ts.isCaseClause(statements) || ts.isDefaultClause(statements) ? statements.parent : statements;
}

/**
 * What one scope declares and writes, each table built the first time it is
 * asked for, so a query looks a name up instead of rescanning the scope. Keyed
 * by the scope node in a `WeakMap`: parsed nodes are immutable for a compile
 * and the entries go with the AST, as `ownLocalsCache` (`binding-info.ts`)
 * holds own-locals.
 */
interface ScopeTables {
  declared?: ReadonlyMap<string, boolean>;
  writes?: ScopeWrites;
}

/** The writes in a scope, nested functions included: plain targets, and each `var` declarator's own. */
interface ScopeWrites {
  readonly targets: ReadonlySet<string>;
  readonly declarators: ReadonlyMap<string, readonly ts.VariableDeclaration[]>;
}

const tablesByScope = new WeakMap<ts.Node, ScopeTables>();

function tablesOf(scope: ts.Node): ScopeTables {
  let tables = tablesByScope.get(scope);
  if (!tables) tablesByScope.set(scope, (tables = {}));
  return tables;
}

/**
 * Each name the block-level scope of `statements` declares, mapped to whether
 * its first declaration there is `const`: a `let`/`const`/`var` (pattern leaves
 * included), or a function or class, which is mutable.
 */
function blockDeclarations(
  statements: ts.Block | ts.SourceFile | ts.ModuleBlock | ts.CaseOrDefaultClause,
): ReadonlyMap<string, boolean> {
  const scope = blockScopeOf(statements);
  return (tablesOf(scope).declared ??= collectBlockDeclarations(
    ts.isCaseBlock(scope) ? scope.clauses.flatMap((clause) => clause.statements) : statements.statements,
  ));
}

function collectBlockDeclarations(statements: readonly ts.Statement[]): ReadonlyMap<string, boolean> {
  const table = new Map<string, boolean>();
  const declare = (name: string, isConst: boolean): void => {
    if (!table.has(name)) table.set(name, isConst);
  };
  for (const st of statements) {
    if (ts.isVariableStatement(st)) {
      const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const d of st.declarationList.declarations) {
        for (const name of collectPatternBindingNames(d.name)) declare(name, isConst);
      }
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
      declare(st.name.text, false);
    }
  }
  return table;
}

function scopeWrites(scope: ts.Node): ScopeWrites {
  return (tablesOf(scope).writes ??= collectScopeWrites(scope));
}

function collectScopeWrites(scope: ts.Node): ScopeWrites {
  const targets = new Set<string>();
  const declarators = new Map<string, ts.VariableDeclaration[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isLexicalBindingWrite(node)) targets.add(node.text);
    if (ts.isVariableDeclaration(node)) {
      for (const id of varDeclaratorWrittenNames(node)) {
        const writers = declarators.get(id.text);
        if (writers) writers.push(node);
        else declarators.set(id.text, [node]);
      }
    }
    forEachChild(node, visit);
  };
  visit(scope);
  return { targets, declarators };
}
