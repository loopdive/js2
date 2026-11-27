// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-AST scope + free-variable walks, lifted BELOW the IR (#4601 route 1).
 *
 * ## Why this module exists
 *
 * These four walks — "which nodes open a function scope?", "what does this
 * function declare?", "which identifiers does this subtree reference?", "what
 * names does this binding pattern bind?" — are shared vocabulary: the legacy
 * codegen path and the IR front-end both need them, and neither of them is
 * codegen. They lived in `src/codegen/closures.ts` (3,984 LOC, `CodegenContext`
 * throughout) purely for historical reasons, which made every IR-side consumer
 * of a predicate built on top of them an inverted `ir -> codegen` import edge.
 *
 * `src/codegen/statements/loop-analysis.ts` was the concrete blocker: it is
 * pure-AST from top to bottom and five `src/ir/` modules import it, but it
 * could not move below the IR while its own two dependencies
 * (`collectReferencedIdentifiers` here, `collectPatternBindingNames` from
 * `codegen/statements/tdz.ts`) sat in `CodegenContext`-typed homes. Lifting
 * that leaf closure is what this file is.
 *
 * ## What is (and is not) here
 *
 * Nothing takes a `CodegenContext` / `FunctionContext` / `ts.TypeChecker`,
 * nothing emits Wasm: a `ts.Node` in, names or scopes out. The old homes
 * re-export the lifted names, so every existing codegen consumer keeps
 * importing exactly what it imported before. The lexical resolution walk below
 * them (`resolvesToSourceBinding`, `argumentsObjectOwner`) is IR-only.
 *
 * Same precedent as `src/ir/js-tag.ts` (#3113 slice 1) and
 * `src/ir/async-static.ts` / `src/ir/regexp-runtime-contract.ts` (#3113 S2):
 * move the shared vocabulary below the IR rather than routing a new edge
 * through the bridge.
 */
import { forEachChild, ts } from "../../ts-api.js";
import { addFunctionOwnLocals, registerOwnLocalsCollector } from "./binding-info.js";

/** True for nodes that introduce a new function scope (params + body locals). */
export function isFunctionScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** Collect every identifier a binding pattern binds, at any depth, into `names`. */
export function collectBindingPatternNames(pattern: ts.BindingPattern, names: Set<string>): void {
  for (const name of collectPatternBindingNames(pattern)) names.add(name);
}

/**
 * #1452 — Walk a binding pattern (array / object / nested / rest) and yield
 * every identifier name that the pattern binds. `{a: y}` introduces `y`,
 * not `a`. `[...rest]` introduces `rest`. Used to drive the bulk TDZ-flip
 * step that runs after a binding-pattern destructure completes.
 */
export function* collectPatternBindingNames(name: ts.BindingName): Iterable<string> {
  if (ts.isIdentifier(name)) {
    yield name.text;
    return;
  }
  if (ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      yield* collectPatternBindingNames(el.name);
    }
    return;
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      // For `{a: y}` el.name is `y`; for `{a}` el.name is also `a`.
      // For `{...rest}` el.name is the rest identifier. Either way
      // walking el.name covers every introduced binding.
      yield* collectPatternBindingNames(el.name);
    }
  }
}

/**
 * Collect names that are LOCALLY DECLARED inside a function-like node's scope.
 * Used to compute the shadow set for free-variable analysis.
 *
 * Includes:
 *   - parameter binding identifiers (function-scoped)
 *   - `var` declarations anywhere in the body (function-scoped)
 *   - top-level `function`/`class` declarations in the body
 *
 * Does NOT cross nested function boundaries.
 *
 * Conservatively excludes block-scoped `let`/`const` since they only shadow
 * within their block, and adding them to the function-wide shadow set would
 * incorrectly mask legitimate outer captures.
 */
export function collectFunctionOwnLocals(funcLike: ts.Node, out: Set<string>): void {
  if (!isFunctionScopeBoundary(funcLike)) return;
  const decl = funcLike as ts.SignatureDeclaration;
  // Params (including destructuring binding identifiers)
  for (const p of decl.parameters ?? []) addBindingNames(p.name, out);
  // Body var/function/class decls. Concise arrow bodies are expressions — no decls.
  const body = (decl as { body?: ts.Node | undefined }).body;
  if (body && ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectVarAndTopLevelDecls(stmt, out, /*atTopLevel=*/ true);
    }
  }
}

// (#2103) Back the shared binding-info oracle with the own-locals collector
// above. Registered once at module load; the oracle memoizes per function node
// so the repeated per-scope-boundary calls inside the identifier walks below
// (and across all other lowerings) reuse a single computed set.
registerOwnLocalsCollector(collectFunctionOwnLocals);

function isVarList(list: ts.VariableDeclarationList): boolean {
  return !(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
}

function addBindingNames(name: ts.BindingName, out: Set<string>): void {
  for (const bound of collectPatternBindingNames(name)) out.add(bound);
}

/** Every name a declaration list binds, through its binding patterns. */
function addDeclaratorNames(list: ts.VariableDeclarationList, out: Set<string>): void {
  for (const declaration of list.declarations) addBindingNames(declaration.name, out);
}

/**
 * Recursively collect `var` declarations (function-scoped) and top-level
 * `function`/`class` declarations from a node tree, without crossing nested
 * function scope boundaries.
 */
function collectVarAndTopLevelDecls(node: ts.Node, out: Set<string>, atTopLevel: boolean): void {
  if (isFunctionScopeBoundary(node)) return; // do not cross
  if (ts.isVariableStatement(node)) {
    if (isVarList(node.declarationList)) addDeclaratorNames(node.declarationList, out);
    // Initializers may contain nested functions — keep walking but we won't
    // descend into their bodies (boundary check above).
    for (const d of node.declarationList.declarations) {
      if (d.initializer) collectVarAndTopLevelDecls(d.initializer, out, false);
    }
    return;
  }
  if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
    if (isVarList(node.initializer)) addDeclaratorNames(node.initializer, out);
  }
  if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
    if (isVarList(node.initializer)) addDeclaratorNames(node.initializer, out);
  }
  if (ts.isFunctionDeclaration(node) && node.name && atTopLevel) {
    out.add(node.name.text);
    return; // do not recurse into nested function body
  }
  if (ts.isClassDeclaration(node) && node.name && atTopLevel) {
    out.add(node.name.text);
    return;
  }
  forEachChild(node, (c) => collectVarAndTopLevelDecls(c, out, false));
}

/**
 * Collect all identifiers referenced in a node.
 *
 * If `shadowed` is provided, identifiers in that set are NOT collected. The
 * walker also detects nested function scopes and augments the shadow set with
 * each nested function's own locals so that references inside them to names
 * shadowed by nested var/param decls aren't incorrectly attributed to the
 * outer scope.
 *
 * Callers analyzing free variables of a function-like body should compute the
 * function's own locals via `collectFunctionOwnLocals` and pass them as the
 * initial `shadowed` set, since the walker enters the body without crossing
 * the boundary itself.
 */
export function collectReferencedIdentifiers(node: ts.Node, names: Set<string>, shadowed?: ReadonlySet<string>): void {
  if (ts.isIdentifier(node)) {
    if (!shadowed || !shadowed.has(node.text)) names.add(node.text);
    return;
  }
  // Track `this` keyword references so arrow functions can capture the
  // enclosing scope's `this` through the normal closure mechanism.
  if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
    if (!shadowed || !shadowed.has("this")) names.add("this");
    return;
  }
  // (#3378) A non-computed MEMBER/PROPERTY NAME is never a free-variable
  // reference — `a.join`, the key of `{ join: x }`, or `ns.Type` name a
  // property, not a binding. The generic `forEachChild` walk below would
  // otherwise collect the `.name` Identifier and, if it collides with an
  // outer local (e.g. `parts.join('')` vs. a module-scope `let join`), record
  // a SPURIOUS capture. That capture's `outerLocalIdx` is valid only in the
  // declaring frame, so baking it into a differently-framed nested closure
  // emits a `local.get` past the closure's local count ("local index out of
  // range" — the deepEqual.js `__closure_NN` crash). Recurse only into the
  // reference-bearing children (the object/expression, the initializer, and
  // any computed key), skipping the member NAME. Optional chaining
  // (`a?.b`, `a?.[k]`) shares the same node kinds.
  if (ts.isPropertyAccessExpression(node)) {
    collectReferencedIdentifiers(node.expression, names, shadowed);
    return;
  }
  if (ts.isQualifiedName(node)) {
    collectReferencedIdentifiers(node.left, names, shadowed);
    return;
  }
  if (ts.isPropertyAssignment(node)) {
    // A computed key (`{ [k]: v }`) IS a reference; a plain identifier / string
    // / numeric key is a property name. Always recurse the initializer.
    if (ts.isComputedPropertyName(node.name)) {
      collectReferencedIdentifiers(node.name, names, shadowed);
    }
    collectReferencedIdentifiers(node.initializer, names, shadowed);
    return;
  }
  if (isFunctionScopeBoundary(node)) {
    // Augment shadow set with this nested function's own locals before
    // recursing into its body. Function/method names declared by nested
    // FunctionExpressions/ArrowFunctions don't leak out, so we don't add the
    // node's own name to the OUTER shadow set; we add it (the named func
    // expr's own name) to the inner shadow so self-references aren't treated
    // as outer captures.
    const merged = new Set<string>(shadowed ?? []);
    addFunctionOwnLocals(node, merged); // (#2103) memoized own-locals
    if (ts.isFunctionExpression(node) && node.name) merged.add(node.name.text);
    forEachChild(node, (child) => collectReferencedIdentifiers(child, names, merged));
    return;
  }
  forEachChild(node, (child) => collectReferencedIdentifiers(child, names, shadowed));
}

/**
 * (#7363) Whether `identifier` resolves to a binding that its own source declares in an enclosing scope. The
 * question is lexical and needs no checker: it covers the JavaScript declaration forms, with hoisting. False means
 * the name is read from the global environment, whatever that holds at run time.
 *
 * Where hoisting depends on strictness the answer leans to yes: a function declaration in a block counts for its
 * whole function or file, because Annex B.3.3 makes it a `var` there in sloppy code.
 */
export function resolvesToSourceBinding(identifier: ts.Identifier): boolean {
  return bindingScope(identifier, false) !== undefined;
}

/**
 * (#7562) The function whose own arguments object the `arguments` identifier `reference` names, or `undefined` when
 * a declaration binds the name first or none does (a global read). The walk ends at a declaring scope or at the
 * first non-arrow function, which owns the object unless its parameters or function declarations bind the name.
 */
export function argumentsObjectOwner(reference: ts.Identifier): ts.SignatureDeclaration | undefined {
  const scope = bindingScope(reference, true);
  return scope && !scopeNames(scope, true).has("arguments") ? (scope as ts.SignatureDeclaration) : undefined;
}

/**
 * The nearest scope around `identifier` that binds its name, or `undefined` for none. With `argumentsObject` the
 * name is `arguments`, which every non-arrow function binds itself (§10.2.11): the walk ends there.
 */
function bindingScope(identifier: ts.Identifier, argumentsObject: boolean): ts.Node | undefined {
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (argumentsObject && ownsArgumentsObject(scope)) return scope;
    if (scopeNames(scope, argumentsObject).has(identifier.text)) return scope;
  }
  return undefined;
}

function ownsArgumentsObject(scope: ts.Node): boolean {
  return isFunctionScopeBoundary(scope) && !ts.isArrowFunction(scope);
}

/**
 * The names `scope` binds itself; empty for a node that opens no scope. A function, a class static block or the file
 * binds its `var`s and function declarations (`declaredFunctionNames` adds block-nested ones by name); a block,
 * switch, loop head or catch binds its lexical declarations. With `argumentsObject`, a function that owns an
 * arguments object leaves out its `var`s and its own name: neither keeps the object from being created.
 */
function scopeNames(scope: ts.Node, argumentsObject: boolean): ReadonlySet<string> {
  const names = new Set<string>();
  if (argumentsObject && ownsArgumentsObject(scope)) {
    for (const parameter of (scope as ts.SignatureDeclaration).parameters) addBindingNames(parameter.name, names);
  } else {
    if (isFunctionScopeBoundary(scope)) collectFunctionOwnLocals(scope, names);
    if ((ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) && scope.name) names.add(scope.name.text);
  }
  if (ts.isSourceFile(scope) || ts.isClassStaticBlockDeclaration(scope))
    for (const statement of statementsOf(scope)) collectVarAndTopLevelDecls(statement, names, true);
  for (const declaration of lexicalDeclarations(scope)) addLexicalNames(declaration, names);
  if (isFunctionScopeBoundary(scope) || ts.isSourceFile(scope)) declaredFunctionNames(scope, names);
  return names;
}

function statementsOf(scope: ts.SourceFile | ts.ClassStaticBlockDeclaration): readonly ts.Statement[] {
  return ts.isSourceFile(scope) ? scope.statements : scope.body.statements;
}

/** The declarations whose bindings belong to `scope` itself: a block's, a switch's, a loop head's, a catch's. */
function lexicalDeclarations(scope: ts.Node): readonly ts.Node[] {
  if (ts.isBlock(scope) || ts.isSourceFile(scope)) return scope.statements;
  if (ts.isCaseBlock(scope)) return scope.clauses.flatMap((clause) => clause.statements);
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    return scope.initializer ? [scope.initializer] : [];
  }
  if (ts.isCatchClause(scope)) return scope.variableDeclaration ? [scope.variableDeclaration] : [];
  return [];
}

/** The names a lexical declaration binds; a `var` list binds none here: its names belong to the enclosing var scope. */
function addLexicalNames(declaration: ts.Node, names: Set<string>): void {
  const list = ts.isVariableStatement(declaration) ? declaration.declarationList : declaration;
  if (ts.isVariableDeclarationList(list)) {
    if (!isVarList(list)) addDeclaratorNames(list, names);
  } else if (ts.isVariableDeclaration(declaration)) addBindingNames(declaration.name, names);
  else if (ts.isClassDeclaration(declaration) && declaration.name) names.add(declaration.name.text);
  else if (ts.isImportDeclaration(declaration) && declaration.importClause) {
    const { name, namedBindings } = declaration.importClause;
    if (name) names.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) names.add(namedBindings.name.text);
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) names.add(element.name.text);
    }
  }
}

/**
 * Every function declaration under `scope` at any block depth, outside nested functions: Annex B.3.3 makes a sloppy
 * block function a `var` of its function or file, so the walk leans to "bound".
 */
function declaredFunctionNames(scope: ts.Node, names: Set<string>): void {
  forEachChild(scope, (child) => {
    if (ts.isFunctionDeclaration(child) && child.name) names.add(child.name.text);
    else if (!isFunctionScopeBoundary(child)) declaredFunctionNames(child, names);
  });
}

/** How a function uses its own arguments object: not at all, only by reading `arguments.length`, or otherwise. */
type ArgumentsObjectUse = "none" | "length" | "other";

const argumentsObjectUses = new WeakMap<ts.SignatureDeclaration, ArgumentsObjectUse>();

/**
 * (#7562) How `fn` (its parameters and body, nested arrows included) uses its own arguments object. Anything but a
 * read of `arguments.length` is "other": the object as a value, an index, a write, a `var arguments`, a name inside
 * `with` (the object there may bind it).
 */
export function ownArgumentsObjectUse(fn: ts.SignatureDeclaration): ArgumentsObjectUse {
  const cached = argumentsObjectUses.get(fn);
  if (cached !== undefined) return cached;
  let use: ArgumentsObjectUse = "none";
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "arguments") {
      if (namesBinding(node) && argumentsObjectOwner(node) === fn)
        use = use !== "other" && readsLength(node) && !withinWith(node, fn) ? "length" : "other";
    } else if (!isFunctionScopeBoundary(node) || ts.isArrowFunction(node)) forEachChild(node, visit);
  };
  forEachChild(fn, visit);
  argumentsObjectUses.set(fn, use);
  return use;
}

/** Whether `identifier` names a binding: a reference or a declared name, not a property name or a label. */
function namesBinding(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isBindingElement(parent)) return parent.propertyName !== identifier;
  if (ts.isShorthandPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) return true;
  const named = parent as { name?: ts.Node; label?: ts.Node; propertyName?: ts.Node };
  return named.name !== identifier && named.label !== identifier && named.propertyName !== identifier;
}

/** Whether `reference` is the object of an `arguments.length` read, not of a write. */
function readsLength(reference: ts.Identifier): boolean {
  const access = reference.parent;
  return ts.isPropertyAccessExpression(access) && access.name.text === "length" && !isWriteTarget(access);
}

/**
 * Whether `expression` is written: the target of an assignment, update, `delete` or for-in/of head, itself or
 * inside the array or object literal that such a target destructures.
 */
function isWriteTarget(expression: ts.Expression): boolean {
  let target: ts.Node = expression;
  while (isTargetContainer(target.parent)) target = target.parent;
  const user = target.parent;
  if (ts.isBinaryExpression(user))
    return (
      user.left === target &&
      user.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      user.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  if (ts.isPrefixUnaryExpression(user) || ts.isPostfixUnaryExpression(user))
    return user.operator === ts.SyntaxKind.PlusPlusToken || user.operator === ts.SyntaxKind.MinusMinusToken;
  if (ts.isForInStatement(user) || ts.isForOfStatement(user)) return user.initializer === target;
  return ts.isDeleteExpression(user);
}

/** A node that passes a target through to its own parent: parentheses, or a literal that may be a destructuring. */
function isTargetContainer(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isSpreadElement(node) ||
    ts.isSpreadAssignment(node)
  );
}

function withinWith(node: ts.Node, fn: ts.Node): boolean {
  for (let current = node.parent; current !== fn; current = current.parent)
    if (ts.isWithStatement(current)) return true;
  return false;
}
