// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 L0c) The bindings a function body creates at entry on the Prepared lane (FunctionDeclarationInstantiation,
 * §10.2.11), where from-ast's scope would otherwise bind them later or in a narrower place. from-ast binds each one to
 * the dynamic value at entry, and the provenance counts every `var` of such a name as the dynamic value, so both ask
 * here.
 */
import { ts } from "../ts-api.js";
import { isStrictContext } from "../shared/is-strict-function.js";
import { isVarDeclarationList } from "../shared/var-declaration-lists.js";
import { collectPatternBindingNames } from "./analysis/ast-scope.js";
import { enclosingFunctionBody } from "./function-declaration-values.js";

/**
 * Where a hoisted name lives: a cell when a function inside the body names it (a capture needs the cell), else a slot
 * of the function.
 */
export type HoistedStorage = "cell" | "slot";

/** A binding of a function that a function inside it may share: a `var`, a `let` statement's or a parameter. */
export type CapturedBinding = ts.VariableDeclaration | ts.ParameterDeclaration;

interface BodyBindings {
  readonly names: ReadonlyMap<string, HoistedStorage>;
  readonly captured: ReadonlySet<CapturedBinding>;
}

const analysed = new WeakMap<ts.Block, BodyBindings>();

/**
 * The names `body` binds at entry besides its top-level function declarations: a `var` that a function inside the
 * body reads or writes (one cell per activation, wherever the function is created), or that code reaches outside the
 * statement declaring it or before its declaration (from-ast binds a declaration where it stands), and the var binding
 * of each Annex B function (B.3.3.1). A `var` also declared by a `for-in`/`for-of` head is left out: the loop binds its
 * own slot. Analysed once per body.
 */
export function hoistedBodyNames(body: ts.Block, checker: ts.TypeChecker): ReadonlyMap<string, HoistedStorage> {
  return bodyBindings(body, checker).names;
}

/**
 * Whether a function inside `declaration`'s function reads or writes it, so it lives in one cell that function shares:
 * a parameter's made at entry, a `let` statement's where it is bound (per iteration in a loop body). A `const` (never
 * written) and a loop head's `let` (whose per-iteration copies are not modelled) have none: a closure writing such a
 * binding refuses. A `var`'s cell is a hoisted name (`hoistedBodyNames`).
 */
export function sharesCell(declaration: CapturedBinding, checker: ts.TypeChecker): boolean {
  const body = enclosingFunctionBody(declaration);
  return body !== undefined && ts.isBlock(body) && bodyBindings(body, checker).captured.has(declaration);
}

function bodyBindings(body: ts.Block, checker: ts.TypeChecker): BodyBindings {
  const known = analysed.get(body);
  if (known !== undefined) return known;
  const declarations = new Map<ts.Symbol, ts.VariableDeclaration[]>();
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const readByFunction = new Set<ts.Symbol>();
  const namedInFunction = new Set<string>();
  const hoisted = new Set<string>();
  const add = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
  };
  const visit = (node: ts.Node, inFunction: boolean): void => {
    const symbol = ts.isIdentifier(node) ? bindingSymbol(node, checker) : undefined;
    if (symbol !== undefined) {
      add(references, symbol, node as ts.Identifier);
      if (inFunction) readByFunction.add(symbol);
    }
    if (ts.isIdentifier(node) && inFunction && !isOwnName(node)) namedInFunction.add(node.text);
    // The checker gives a `var` in a `with` body no symbol: it keeps its own lowering.
    const own = isBodyVar(node, body) ? checker.getSymbolAtLocation(node.name) : undefined;
    if (own !== undefined) add(declarations, own, node as ts.VariableDeclaration);
    if (ts.isFunctionDeclaration(node) && enclosingFunctionBody(node) === body && annexBApplies(node))
      hoisted.add(node.name!.text);
    ts.forEachChild(node, (child) => visit(child, inFunction || ts.isFunctionLike(node)));
  };
  ts.forEachChild(body, (child) => visit(child, false));
  const loopHeads: string[] = [];
  for (const [symbol, declared] of declarations) {
    if (declared.some((d) => ts.isForInStatement(d.parent.parent) || ts.isForOfStatement(d.parent.parent)))
      loopHeads.push(symbol.name);
    else if (readByFunction.has(symbol) || references.get(symbol)!.some((r) => declared.some((d) => outside(r, d))))
      hoisted.add(symbol.name);
  }
  for (const name of loopHeads) hoisted.delete(name);
  const names = new Map([...hoisted].map((name) => [name, namedInFunction.has(name) ? "cell" : "slot"] as const));
  const captured = new Set(
    [...readByFunction].flatMap((symbol) => (symbol.declarations ?? []).filter((d) => isCellBinding(d, body))),
  );
  const bindings = { names, captured };
  analysed.set(body, bindings);
  return bindings;
}

/** The binding an identifier names; a shorthand property (`{ x }`) names its value's. */
function bindingSymbol(identifier: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  const { parent } = identifier;
  return ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
    ? checker.getShorthandAssignmentValueSymbol(parent)
    : checker.getSymbolAtLocation(identifier);
}

/** A parameter of `body`'s function, or a `let` statement's binding in it. */
function isCellBinding(declaration: ts.Declaration, body: ts.Block): declaration is CapturedBinding {
  if (ts.isParameter(declaration)) return declaration.parent === body.parent;
  const list = declaration.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    enclosingFunctionBody(declaration) === body &&
    ts.isVariableDeclarationList(list) &&
    ts.isVariableStatement(list.parent) &&
    (list.flags & ts.NodeFlags.Let) !== 0
  );
}

/** A function's own name: no reference to the binding the function is assigned to. */
function isOwnName(identifier: ts.Identifier): boolean {
  return ts.isFunctionLike(identifier.parent) && identifier.parent.name === identifier;
}

/** A `var` declaration whose function body binds its name at entry: the provenance's dynamic local. */
export function isHoistedVar(declaration: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  const body = enclosingFunctionBody(declaration);
  return (
    body !== undefined &&
    ts.isBlock(body) &&
    isBodyVar(declaration, body) &&
    hoistedBodyNames(body, checker).has(declaration.name.text)
  );
}

/** A `var` declarator with a plain name whose function is `body`'s. */
function isBodyVar(node: ts.Node, body: ts.Block): node is ts.VariableDeclaration & { name: ts.Identifier } {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    ts.isVariableDeclarationList(node.parent) &&
    isVarDeclarationList(node.parent) &&
    enclosingFunctionBody(node) === body
  );
}

/**
 * Whether `reference` lies before `declaration` or outside the statement from-ast binds it in: its block, case block,
 * loop or `if` arm. A declaration that is a statement of the function body itself is bound for all the code after it.
 */
function outside(reference: ts.Identifier, declaration: ts.VariableDeclaration): boolean {
  if (reference.end <= declaration.pos) return true;
  const container = bindingContainer(declaration);
  return container !== undefined && ts.findAncestor(reference, (node) => node === container) === undefined;
}

function bindingContainer(declaration: ts.VariableDeclaration): ts.Node | undefined {
  const statement = declaration.parent.parent;
  if (ts.isForStatement(statement)) return statement;
  let container = statement.parent;
  while (ts.isLabeledStatement(container)) container = container.parent;
  if (ts.isCaseClause(container) || ts.isDefaultClause(container)) return container.parent;
  return container === enclosingFunctionBody(declaration) ? undefined : container;
}

/**
 * B.3.3.1: a function declaration in a block, a `case`/`default` clause or (B.3.4) an `if` arm of sloppy function code
 * also assigns a var binding of its name when it is evaluated, unless that `var` would be an early error (a
 * `let`/`const`/`class` or block function of the name in an enclosing scope, a `for` head or a destructuring catch
 * parameter; a plain catch parameter allows it, B.3.5) or the name is a parameter's.
 */
export function annexBApplies(declaration: ts.FunctionDeclaration): boolean {
  const body = enclosingFunctionBody(declaration);
  const name = declaration.name?.text;
  const { parent } = declaration;
  if (
    body === undefined ||
    name === undefined ||
    name === "arguments" ||
    declaration.asteriskToken !== undefined ||
    ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async ||
    !(ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent) || ts.isIfStatement(parent)) ||
    parent === body ||
    isStrictContext(parent)
  )
    return false;
  const parameters = (body.parent as ts.FunctionLikeDeclaration).parameters;
  if (parameters.some((parameter) => bindsName(parameter.name, name))) return false;
  for (let scope: ts.Node = parent; scope !== body.parent; scope = scope.parent)
    if (lexicallyDeclares(scope, name, scope === blockFunctionScope(declaration), body)) return false;
  return true;
}

/** The node whose entry binds a block function: its block, `if` arm, or the case block of its clause. */
export function blockFunctionScope(declaration: ts.FunctionDeclaration): ts.Node {
  const { parent } = declaration;
  return ts.isCaseClause(parent) || ts.isDefaultClause(parent) ? parent.parent : parent;
}

/**
 * Whether `scope` binds `name` lexically. A block function of the name is lexical in an enclosing block, not in the
 * declaration's own one (B.3.3.4 lets sloppy blocks repeat a function); the function body's own functions are vars.
 */
function lexicallyDeclares(scope: ts.Node, name: string, own: boolean, body: ts.Node): boolean {
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const head = scope.initializer;
    return head !== undefined && ts.isVariableDeclarationList(head) && !isVarDeclarationList(head) && binds(head, name);
  }
  if (ts.isCatchClause(scope)) {
    const parameter = scope.variableDeclaration?.name;
    return parameter !== undefined && !ts.isIdentifier(parameter) && bindsName(parameter, name);
  }
  const statements = ts.isBlock(scope)
    ? scope.statements
    : ts.isCaseBlock(scope)
      ? scope.clauses.flatMap((clause) => [...clause.statements])
      : [];
  return statements.some(
    (statement) =>
      (ts.isVariableStatement(statement) &&
        !isVarDeclarationList(statement.declarationList) &&
        binds(statement.declarationList, name)) ||
      (ts.isClassDeclaration(statement) && statement.name?.text === name) ||
      (ts.isFunctionDeclaration(statement) && statement.name?.text === name && !own && scope !== body),
  );
}

function binds(list: ts.VariableDeclarationList, name: string): boolean {
  return list.declarations.some((declaration) => bindsName(declaration.name, name));
}

function bindsName(binding: ts.BindingName, name: string): boolean {
  return [...collectPatternBindingNames(binding)].includes(name);
}
