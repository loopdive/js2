// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Pure, stateless predicate / collection helpers for ES early-error detection
// (#1931). Extracted verbatim from detectEarlyErrors in validation.ts so each
// is individually unit-testable. None of these mutate shared state — they are
// pure functions of the AST.
import { ts, forEachChild } from "../../ts-api.js";

export function findInnermostNodeAtPosition(node: ts.Node, position: number): ts.Node {
  let best: ts.Node = node;
  function visit(current: ts.Node): void {
    if (position < current.getFullStart() || position >= current.getEnd()) return;
    best = current;
    forEachChild(current, visit);
  }
  visit(node);
  return best;
}

/**
 * Check if a node is in strict mode context.
 * A node is in strict mode if:
 * - The source file has a "use strict" directive prologue
 * - It's inside a class body (class bodies are always strict)
 * - It's inside a function with a "use strict" directive prologue
 *
 * Note: being a module does NOT imply strict here. test262 `noStrict` tests are
 * sloppy-mode scripts, so we deliberately do not treat module = strict (see the
 * SourceFile branch below, which returns false).
 */
// Strictness of a node is a pure function of its ancestor chain, and the
// per-node walk was ~20% of detectEarlyErrors CPU (#4431) — four checks call
// this on every Identifier/literal. Memoize per node: walk up only until a
// cached ancestor or a terminal (SourceFile/class/strict function), then
// backfill the whole visited chain, so repeated queries are O(1) amortized.
const strictModeCache = new WeakMap<ts.Node, boolean>();

/** Leading "use strict" directive scan (directives must be at the top). */
function hasUseStrictDirective(stmts: readonly ts.Statement[]): boolean {
  for (const stmt of stmts) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      if (stmt.expression.text === "use strict") return true;
    } else {
      break; // Directives must be at the top
    }
  }
  return false;
}

export function isStrictMode(node: ts.Node): boolean {
  // Check for "use strict" directives and class context
  const chain: ts.Node[] = [];
  let result: boolean | undefined;
  let current: ts.Node | undefined = node;
  while (current) {
    const cached = strictModeCache.get(current);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    chain.push(current);
    if (ts.isSourceFile(current)) {
      // Don't assume module = strict. We add export {} synthetically for TS,
      // but the source may be a sloppy-mode script (test262 noStrict tests).
      result = hasUseStrictDirective(current.statements);
      break;
    }
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      result = true;
      break;
    }
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)) &&
      current.body &&
      ts.isBlock(current.body) &&
      hasUseStrictDirective(current.body.statements)
    ) {
      result = true;
      break;
    }
    current = current.parent;
  }
  const final = result ?? false;
  for (const n of chain) strictModeCache.set(n, final);
  return final;
}

export function isArgumentsOrEval(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) {
    if (node.text === "arguments" || node.text === "eval") {
      return node.text;
    }
  }
  // Also check parenthesized: (arguments), ((eval))
  if (ts.isParenthesizedExpression(node)) {
    return isArgumentsOrEval(node.expression);
  }
  return null;
}

/**
 * Check if an expression is a "simple assignment target" per ES spec.
 * Only identifiers and property accesses are valid assignment targets.
 */
export function isSimpleAssignmentTarget(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return true;
  if (ts.isPropertyAccessExpression(node)) return true;
  if (ts.isElementAccessExpression(node)) return true;
  if (ts.isParenthesizedExpression(node)) {
    return isSimpleAssignmentTarget(node.expression);
  }
  return false;
}

/** Collect binding names and report duplicates. */
export function collectBindingNamesWithDuplicateCheck(
  name: ts.BindingName,
  out: Set<string>,
  dupes: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    if (out.has(name.text)) dupes.add(name.text);
    out.add(name.text);
  } else if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      collectBindingNamesWithDuplicateCheck(el.name, out, dupes);
    }
  } else if (ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) {
        collectBindingNamesWithDuplicateCheck(el.name, out, dupes);
      }
    }
  }
}

/** Collect all identifier names from a binding pattern (identifier, array, object destructuring). */
export function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
  } else if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      collectBindingNames(el.name, out);
    }
  } else if (ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) {
        collectBindingNames(el.name, out);
      }
    }
  }
}

/**
 * Check if an expression is NOT a valid assignment target per ES spec.
 * For simple assignment (=): identifiers, property/element access, and
 * destructuring patterns (object/array literals) are valid.
 * For update (++/--) and compound (+=, etc.): only identifiers and
 * property/element access are valid — no destructuring patterns.
 */
export function isInvalidAssignmentTarget(node: ts.Expression, allowDestructuring = false): boolean {
  // (#1722) A destructuring AssignmentPattern is only a valid target when it
  // appears *directly* as the LHS — a parenthesized object/array literal
  // (`({}) = 1`, `({a:1}) = 1`) is NOT a valid target and is an early
  // SyntaxError per §13.15.1 (CoverParenthesizedExpression cannot be
  // refined to an AssignmentPattern). So test the destructuring forms on
  // the un-unwrapped node before stripping parens. Note `({} = 1)` is fine
  // because there the parens wrap the whole assignment, not the pattern.
  if (allowDestructuring) {
    if (ts.isObjectLiteralExpression(node)) return false;
    if (ts.isArrayLiteralExpression(node)) return false;
  }
  let expr: ts.Node = node;
  // (#4417) `!` is a TYPE-LEVEL assertion that erases at emit, so `o.n! = 1`
  // and `arr[i]!++` are ordinary property/element assignments and must be
  // accepted. Unwrapping only parens rejected both — 62 sites across the
  // compiler's own source, including 16 `fctx.breakStack[i]!++` in
  // codegen/statements/control-flow.ts.
  //
  // Deliberately unwrapped HERE, after the destructuring test above and not
  // before it: that test must see the un-unwrapped node so `({}) = 1` stays
  // the SyntaxError it is.
  while (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
  // Valid: identifiers, property access, element access (parens are
  // transparent for these — `(x) = 1` / `(o.p) = 1` are valid).
  if (ts.isIdentifier(expr)) return false;
  if (ts.isPropertyAccessExpression(expr)) return false;
  if (ts.isElementAccessExpression(expr)) return false;
  // Everything else (incl. parenthesized object/array literals) is invalid.
  return true;
}

/**
 * Check if an expression is a call expression (not a valid simple assignment target).
 * CallExpression assignment targets are SyntaxErrors in strict mode per ES spec.
 */
export function isCallExpressionTarget(node: ts.Node): boolean {
  let expr: ts.Node = node;
  while (ts.isParenthesizedExpression(expr)) expr = (expr as ts.ParenthesizedExpression).expression;
  return (
    ts.isCallExpression(expr) &&
    expr.expression.kind !== ts.SyntaxKind.ImportKeyword &&
    expr.expression.kind !== ts.SyntaxKind.SuperKeyword
  );
}

/** Check if an expression involves optional chaining (?.) */
export function hasOptionalChain(node: ts.Expression): boolean {
  let expr: ts.Node = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  // TS models optional chains with questionDotToken
  if (
    (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr) || ts.isCallExpression(expr)) &&
    (expr as any).questionDotToken
  ) {
    return true;
  }
  // Check parent chain for optional chaining context
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    return hasOptionalChain(expr.expression);
  }
  return false;
}

export function isUsingDeclarationStatement(node: ts.Node): node is ts.VariableStatement {
  if (!ts.isVariableStatement(node)) return false;
  return (node.declarationList.flags & ts.NodeFlags.Using) !== 0;
}

// Each of the three predicates below is a pure function of a node's ancestor
// chain and is queried per await/yield token (#4432, ~3.4% of in-block time).
// They are memoized with the strictModeCache pattern from #4431, with one
// difference: the walk starts at `node.parent`, so the cache is keyed by the
// ANCESTOR the walk starts from and holds "the answer for a walk beginning at
// this node (inclusive)". The terminal node is part of the backfilled chain —
// its own answer is the terminal value — while the queried node itself is not
// a key, since its answer is the value stored for its parent.
const insideClassStaticBlockCache = new WeakMap<ts.Node, boolean>();
const insideAsyncFunctionCache = new WeakMap<ts.Node, boolean>();
const insideGeneratorFunctionCache = new WeakMap<ts.Node, boolean>();

/** Check if a node is inside a class static initializer block. */
export function isInsideClassStaticBlock(node: ts.Node): boolean {
  const chain: ts.Node[] = [];
  let result: boolean | undefined;
  let current: ts.Node | undefined = node.parent;
  while (current) {
    const cached = insideClassStaticBlockCache.get(current);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    chain.push(current);
    if (ts.isClassStaticBlockDeclaration(current)) {
      result = true;
      break;
    }
    // ALL function boundaries stop the search, including arrow functions.
    // ES spec: ContainsAwait returns false for ArrowFunction, meaning
    // `await` as an identifier inside an arrow within a static block is valid.
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      result = false;
      break;
    }
    current = current.parent;
  }
  const final = result ?? false;
  for (const n of chain) insideClassStaticBlockCache.set(n, final);
  return final;
}

/** Check if a node is inside any function (for return statement validation). */
export function isInsideFunction(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Check if a node is inside any function (sync or async, including arrow, method, etc.)
 * Used to detect AwaitExpression in non-async function (a SyntaxError in module context).
 */
export function isInsideAnyFunction(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Returns true if the node is inside a function that is itself inside another function
 * (i.e., the function depth is >= 2 from SourceFile).
 *
 * Used instead of isInsideAnyFunction for the await-in-non-async-function check because
 * the test262 runner wraps all module code in `export function test() { ... }`.
 * Top-level-await tests have `await` directly inside test() (depth 1) — these should
 * not be flagged. Negative tests like `function fn() { await 0; }` have `await` inside
 * fn() inside test() (depth 2) — these should be flagged.
 */
export function isInsideNestedFunction(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  let depth = 0;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      depth++;
      if (depth >= 2) return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Check if an expression tree contains `arguments` identifier reference.
 * Used for ES spec ContainsArguments check in class field initializers.
 * Does NOT cross function boundaries (arguments is valid inside nested functions).
 */
export function containsArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") {
    // Check it's not a property name
    const parent = node.parent;
    if (
      parent &&
      ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node))
    ) {
      return false;
    }
    return true;
  }
  // Don't cross function boundaries — arguments IS valid inside nested functions
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return false;
  }
  // Arrow functions don't bind arguments — keep searching
  let found = false;
  forEachChild(node, (child) => {
    if (!found && containsArguments(child)) {
      found = true;
    }
  });
  return found;
}

/** Get the computed name of a class member, if it's a simple string. */
export function getMemberName(member: ts.ClassElement): string | null {
  if (!member.name) return null;
  if (ts.isIdentifier(member.name)) return member.name.text;
  if (ts.isStringLiteral(member.name)) return member.name.text;
  if (ts.isComputedPropertyName(member.name)) {
    const expr = member.name.expression;
    if (ts.isStringLiteral(expr)) return expr.text;
  }
  return null;
}

/** Check if a node is inside a class constructor. Arrow functions inherit super() context. */
export function isInsideClassConstructor(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isConstructorDeclaration(current)) return true;
    // Arrow functions inherit super context — don't stop
    if (ts.isArrowFunction(current)) {
      current = current.parent;
      continue;
    }
    // Other function boundaries break super() context
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/** Check if a node is inside a method (class or object). Arrow functions inherit super property context. */
export function isInsideMethod(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return true;
    }
    // Class property declarations (field initializers) inherit super context
    // e.g. class C extends B { func = () => { super.prop; } }
    if (ts.isPropertyDeclaration(current) && ts.isClassDeclaration(current.parent)) {
      return true;
    }
    if (ts.isPropertyDeclaration(current) && ts.isClassExpression(current.parent)) {
      return true;
    }
    // Arrow functions inherit super property context — don't stop
    if (ts.isArrowFunction(current)) {
      current = current.parent;
      continue;
    }
    // Other function boundaries break super property context
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/** Check if a node is an iteration statement. */
export function isIterationStatement(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

/** Check if `continue` is inside a valid iteration statement. Respects labels and function boundaries. */
export function isInsideIteration(node: ts.Node, label?: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    // Function and class static block boundaries stop the search
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isClassStaticBlockDeclaration(current)
    ) {
      return false;
    }
    if (label) {
      // continue LABEL: the label must be on an iteration statement
      if (ts.isLabeledStatement(current) && current.label.text === label) {
        return isIterationStatement(current.statement);
      }
    } else {
      // continue (no label): any enclosing iteration statement
      if (isIterationStatement(current)) return true;
    }
    current = current.parent;
  }
  return false;
}

/** Check if `break` is inside a valid breakable statement. Respects labels and function boundaries. */
export function isInsideBreakable(node: ts.Node, label?: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    // Function and class static block boundaries stop the search
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isClassStaticBlockDeclaration(current)
    ) {
      return false;
    }
    if (label) {
      // break LABEL: any labeled statement (not just iteration/switch)
      if (ts.isLabeledStatement(current) && current.label.text === label) {
        return true;
      }
    } else {
      // break (no label): iteration or switch
      if (isIterationStatement(current) || ts.isSwitchStatement(current)) return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Collect the lexically-declared names of a switch CaseBlock (#1805).
 * Per ES spec, the LexicallyDeclaredNames of a CaseBlock are the let/const,
 * class, and function declarations directly inside its case/default clauses.
 * These names are scoped to the switch block and must not leak to the
 * enclosing scope. We do not descend into nested blocks/functions — only the
 * top level of each clause contributes to the CaseBlock's lexical scope.
 */
export function collectSwitchClauseLexicalNames(caseBlock: ts.CaseBlock): Set<string> {
  const names = new Set<string>();
  for (const clause of caseBlock.clauses) {
    for (const stmt of clause.statements) {
      if (ts.isVariableStatement(stmt)) {
        const flags = stmt.declarationList.flags;
        if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        names.add(stmt.name.text);
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        names.add(stmt.name.text);
      }
    }
  }
  return names;
}

/**
 * Collect names bound in the enclosing statement list (var/let/const,
 * function, class, import). Used to decide whether a reference to a
 * switch-scoped name is actually shadowed by an outer binding (in which
 * case the reference is legal and must not be flagged).
 */
export function collectStatementListBoundNames(stmts: ts.NodeArray<ts.Statement>): Set<string> {
  const names = new Set<string>();
  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
    } else {
      // Destructuring pattern — collect each bound identifier.
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) addBindingName(el.name);
      }
    }
  };
  for (const stmt of stmts) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) addBindingName(decl.name);
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const ic = stmt.importClause;
      if (ic.name) names.add(ic.name.text);
      if (ic.namedBindings) {
        if (ts.isNamespaceImport(ic.namedBindings)) {
          names.add(ic.namedBindings.name.text);
        } else {
          for (const el of ic.namedBindings.elements) names.add(el.name.text);
        }
      }
    }
  }
  return names;
}

/**
 * Detect a reference to a name within `node` (and its descendants),
 * not crossing nested function/class scopes. Returns the first matching
 * identifier reference, or undefined.
 */
export function findNameReference(node: ts.Node, name: string): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const walk = (n: ts.Node): void => {
    if (found) return;
    // Don't descend into nested function/class scopes — they create their
    // own binding environments and may legitimately shadow or re-introduce
    // the name. (A closure capturing an out-of-scope name is itself an
    // error, but we keep this check narrow to avoid false positives.)
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isClassDeclaration(n) ||
      ts.isClassExpression(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n)
    ) {
      return;
    }
    if (ts.isIdentifier(n) && n.text === name) {
      const parent = n.parent;
      // Skip property names (obj.x), property-assignment keys ({ x: ... }),
      // and binding positions — only count value references.
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === n) return;
      if (parent && ts.isPropertyAssignment(parent) && parent.name === n) return;
      if (parent && ts.isQualifiedName(parent) && parent.right === n) return;
      if (parent && ts.isBindingElement(parent) && parent.propertyName === n) return;
      found = n;
      return;
    }
    forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/**
 * Check if a node is inside the formal parameters of a generator function.
 * ES spec: FormalParameters of generators use [+Yield] but YieldExpression
 * is forbidden — "It is a Syntax Error if FormalParameters Contains YieldExpression".
 */
export function isInsideGeneratorParams(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isParameter(current)) {
      const func = current.parent;
      if ((ts.isFunctionDeclaration(func) || ts.isFunctionExpression(func)) && func.asteriskToken) {
        return true;
      }
      if (ts.isMethodDeclaration(func) && func.asteriskToken) {
        return true;
      }
      return false;
    }
    // Stop at function boundaries
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Check if a node is inside the formal parameters of an async function.
 * ES spec: "It is a Syntax Error if FormalParameters Contains AwaitExpression".
 */
export function isInsideAsyncParams(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isParameter(current)) {
      const func = current.parent;
      if (
        (ts.isFunctionDeclaration(func) ||
          ts.isFunctionExpression(func) ||
          ts.isArrowFunction(func) ||
          ts.isMethodDeclaration(func)) &&
        func.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        return true;
      }
      return false;
    }
    // Stop at function boundaries
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/** Check if a node is inside an async function (including async generators). */
export function isInsideAsyncFunction(node: ts.Node): boolean {
  const chain: ts.Node[] = [];
  let result: boolean | undefined;
  let current: ts.Node | undefined = node.parent;
  while (current) {
    const cached = insideAsyncFunctionCache.get(current);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    chain.push(current);
    // Class static blocks create a new scope — stop searching
    if (ts.isClassStaticBlockDeclaration(current)) {
      result = false;
      break;
    }
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isMethodDeclaration(current)) {
      result = current.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      break;
    }
    if (ts.isArrowFunction(current)) {
      result = current.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      break;
    }
    current = current.parent;
  }
  const final = result ?? false;
  for (const n of chain) insideAsyncFunctionCache.set(n, final);
  return final;
}

/** Check if a node is inside a generator function (including async generators). */
export function isInsideGeneratorFunction(node: ts.Node): boolean {
  const chain: ts.Node[] = [];
  let result: boolean | undefined;
  let current: ts.Node | undefined = node.parent;
  while (current) {
    const cached = insideGeneratorFunctionCache.get(current);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    chain.push(current);
    // Class static blocks create a new scope — stop searching
    if (ts.isClassStaticBlockDeclaration(current)) {
      result = false;
      break;
    }
    if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) && current.asteriskToken) {
      result = true;
      break;
    }
    if (ts.isMethodDeclaration(current) && current.asteriskToken) {
      result = true;
      break;
    }
    // Arrow functions are never generators, but they don't create a new yield scope
    // If we hit an arrow, keep going up — arrows inherit the generator context
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isMethodDeclaration(current)) {
      result = false; // Found a non-generator function boundary
      break;
    }
    current = current.parent;
  }
  const final = result ?? false;
  for (const n of chain) insideGeneratorFunctionCache.set(n, final);
  return final;
}

/** Check if a function declaration is in a single-statement position (not a block). */
export function isStatementPosition(parent: ts.Node, child: ts.Node): boolean {
  // If the parent is a block/source file, this is a normal declaration — allowed
  if (ts.isBlock(parent) || ts.isSourceFile(parent)) return false;
  // If/else, while, do-while, for, for-in, for-of bodies that are not blocks
  if (ts.isIfStatement(parent)) {
    return parent.thenStatement === child || parent.elseStatement === child;
  }
  if (ts.isWhileStatement(parent)) return parent.statement === child;
  if (ts.isDoStatement(parent)) return parent.statement === child;
  if (ts.isForStatement(parent)) return parent.statement === child;
  if (ts.isForInStatement(parent)) return parent.statement === child;
  if (ts.isForOfStatement(parent)) return parent.statement === child;
  if (ts.isLabeledStatement(parent)) return parent.statement === child;
  if (ts.isWithStatement(parent)) return parent.statement === child;
  return false;
}

/** Check if a node has the 'async' modifier. */
export function hasAsyncModifier(node: ts.FunctionDeclaration): boolean {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

/** Check if a private identifier is inside a class that declares it. */
// The per-reference member scan was the single hottest early-error cost
// (~34% of in-block CPU, #4431): every PrivateIdentifier re-walked every
// member of every enclosing class. The declared private names of a class are
// immutable per AST, so compute them once per class and cache.
const classPrivateNamesCache = new WeakMap<ts.ClassLikeDeclaration, ReadonlySet<string>>();

function privateNamesOf(cls: ts.ClassLikeDeclaration): ReadonlySet<string> {
  let names = classPrivateNamesCache.get(cls);
  if (names === undefined) {
    const set = new Set<string>();
    for (const member of cls.members) {
      if (member.name && ts.isPrivateIdentifier(member.name)) {
        set.add(member.name.escapedText as string);
      }
    }
    names = set;
    classPrivateNamesCache.set(cls, names);
  }
  return names;
}

export function isInsideClassWithPrivateName(node: ts.Node, privateName: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      // §15.7.14 ClassDefinitionEvaluation: the ClassHeritage (the `extends`
      // clause) is evaluated with the OUTER PrivateEnvironment — the class's own
      // private names are NOT yet in scope there. So a private reference that
      // lives inside this class's heritage clause must NOT resolve against this
      // class's private members (it is an early SyntaxError unless an *enclosing*
      // class declares the name). Only count this class's members when the
      // reference is reached via its BODY, not its heritage.
      const inHeritage = current.heritageClauses?.some((hc) => isNodeWithin(node, hc)) ?? false;
      if (!inHeritage) {
        // Check if this class declares the private name
        if (privateNamesOf(current).has(privateName)) {
          return true;
        }
      }
      // Also check parent classes (super), but we can't easily resolve inheritance
      // at the AST level. For now, just check the immediate class.
      // Continue searching outer classes.
    }
    current = current.parent;
  }
  return false;
}

/** True when `node` is `ancestor` or a descendant of it (walks `.parent`). */
function isNodeWithin(node: ts.Node, ancestor: ts.Node): boolean {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Check if an object literal is in a destructuring assignment context.
 * In that context, CoverInitializedName ({ x = 1 }) is valid.
 */
export function isAssignmentPatternContext(objLit: ts.ObjectLiteralExpression): boolean {
  const parent = objLit.parent;
  if (!parent) return false;
  // Direct destructuring: ({ x = 1 } = source)
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === objLit
  ) {
    return true;
  }
  // In for-of/for-in LHS
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
    return parent.initializer === objLit;
  }
  // Nested in another destructuring pattern (array element, object property value)
  if (ts.isArrayLiteralExpression(parent)) return isAssignmentPatternContext_expr(parent);
  if (ts.isPropertyAssignment(parent)) {
    const grandParent = parent.parent;
    if (ts.isObjectLiteralExpression(grandParent)) return isAssignmentPatternContext(grandParent);
  }
  if (ts.isSpreadElement(parent)) {
    const grandParent = parent.parent;
    if (ts.isArrayLiteralExpression(grandParent)) return isAssignmentPatternContext_expr(grandParent);
  }
  return false;
}

export function isAssignmentPatternContext_expr(arrLit: ts.ArrayLiteralExpression): boolean {
  const parent = arrLit.parent;
  if (!parent) return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === arrLit
  )
    return true;
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === arrLit;
  if (ts.isArrayLiteralExpression(parent)) return isAssignmentPatternContext_expr(parent);
  if (ts.isPropertyAssignment(parent)) {
    const gp = parent.parent;
    if (ts.isObjectLiteralExpression(gp)) return isAssignmentPatternContext(gp);
  }
  return false;
}

/**
 * TypeScript parses `let` followed by a LineTerminator and then an identifier
 * or `{` (e.g. `if (false) let\nx = 1;`) as a LexicalDeclaration, but per
 * ECMA-262 the ExpressionStatement lookahead restriction is only `let [`
 * (with NO `[no LineTerminator here]`). So `let` + newline + (anything but
 * `[`) is actually an ExpressionStatement (`let` identifier reference) closed
 * by ASI, which is valid in single-statement position. `let [` stays a
 * lexical declaration even across a newline, and `const` is always a reserved
 * word so it is never an expression statement.
 *
 * Takes the SourceFile explicitly (the original closed over it).
 */
export function isAsiLetExpressionStatement(
  sourceFile: ts.SourceFile,
  node: ts.VariableStatement,
  flags: ts.NodeFlags,
): boolean {
  if ((flags & ts.NodeFlags.Let) === 0) return false;
  const decls = node.declarationList.declarations;
  if (decls.length !== 1) return false;
  const binding = decls[0].name;
  // `let [` is a lexical declaration / array destructuring even after a newline.
  if (ts.isArrayBindingPattern(binding)) return false;
  // Source text between the `let` keyword and the first binding: a line
  // terminator there means ASI applies and `let` is an identifier reference.
  const declList = node.declarationList;
  const keywordEnd = declList.getStart(sourceFile) + "let".length;
  const between = sourceFile.text.slice(keywordEnd, binding.getStart(sourceFile));
  for (const ch of between) {
    const c = ch.charCodeAt(0);
    // LF, CR, LINE SEPARATOR (U+2028), PARAGRAPH SEPARATOR (U+2029)
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}
