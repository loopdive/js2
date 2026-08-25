// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure static-analysis predicates over `ts.*` loop AST nodes.
 *
 * Extracted verbatim from `loops.ts` (#3269). None of these take a
 * CodegenContext / FunctionContext or emit any Wasm — they are side-effect-free
 * queries returning booleans / Sets / string[] / small records, used by the
 * loop drivers to pick a lowering strategy. Keeping them here decouples the
 * "should we take the fast path?" reasoning from the emit-heavy drivers.
 *
 * (#4601 route 1) Moved from `src/codegen/statements/loop-analysis.ts` to here,
 * BELOW the IR. Five `src/ir/` modules (`from-ast`, `char-read-loop`,
 * `i32-pure-bitwise`, `fixed-literal-loop-proof`, `analysis/i32-slots`) reuse
 * these proofs, and while the file sat under `src/codegen/` each of those was an
 * inverted `ir -> codegen` import edge in the `check:ir-layering` ratchet — an
 * edge that would block deleting the legacy front-end (#3518 R10). The move was
 * only possible once the file's own two dependencies
 * (`collectReferencedIdentifiers`, `collectPatternBindingNames`) were lifted out
 * of their `CodegenContext`-typed homes into `ir/analysis/ast-scope.ts`; the
 * closure is now a genuine leaf (`ts-api` + `ast-scope`). `statements/loops.ts`
 * and `statements/exceptions.ts` import it back down-stack, which is the
 * intended `emit <- ir <- codegen` direction.
 */
import { forEachChild, ts } from "../../ts-api.js";
import { collectPatternBindingNames, collectReferencedIdentifiers } from "./ast-scope.js";

/**
 * Detect integer loop counter pattern: for (let i = INT; i < EXPR; i++)
 * Returns the variable name and initial integer value if the pattern matches,
 * or null if it doesn't match.
 */
export function detectI32LoopVar(stmt: ts.ForStatement): { name: string; initValue: number } | null {
  // 1. Check initializer: must be a single variable declaration with an integer literal
  if (!stmt.initializer || !ts.isVariableDeclarationList(stmt.initializer)) return null;
  const decls = stmt.initializer.declarations;
  if (decls.length !== 1) return null;
  const decl = decls[0];
  if (!ts.isIdentifier(decl.name)) return null;
  const name = decl.name.text;
  if (!decl.initializer || !ts.isNumericLiteral(decl.initializer)) return null;
  const initValue = Number(decl.initializer.text.replace(/_/g, ""));
  if (!Number.isInteger(initValue) || initValue < -2147483648 || initValue > 2147483647) return null;

  // 2. Check condition: the loop condition must BOUND `i` against a comparison
  //    operand, in either direction.
  //
  //    Bounded ABOVE (ascending):  i < EXPR, i <= EXPR, EXPR > i, EXPR >= i
  //    Bounded BELOW (descending): i > EXPR, i >= EXPR, EXPR < i, EXPR <= i
  //
  // (#3907) The descending forms were missing, which made this function's OWN
  // incrementor arm — it has accepted `i--`, `--i` and `i -= <lit>` since it
  // was written — unreachable for any real program: a decrementing loop that
  // terminates is conditioned on `i > EXPR` / `i >= EXPR`, and that was
  // rejected here before the incrementor was ever consulted. The proof is
  // exactly symmetric and no harder: the counter starts at an integer literal
  // in i32 range, steps by a compile-time integer constant, and the condition
  // bounds it. For a descending counter the literal init is the UPPER bound and
  // the condition supplies the lower one, which is the mirror image of the
  // ascending case the function already trusts. Widening this was a gap in the
  // analysis, not a soundness boundary — before #3907 fast mode narrowed every
  // `number` regardless, so no descending loop ever exercised the gap.
  if (!stmt.condition || !ts.isBinaryExpression(stmt.condition)) return null;
  const cond = stmt.condition;
  const op = cond.operatorToken.kind;
  const isRelational =
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken;
  const nameIsOperand =
    (ts.isIdentifier(cond.left) && cond.left.text === name) ||
    (ts.isIdentifier(cond.right) && cond.right.text === name);
  if (!isRelational || !nameIsOperand) return null;

  // 3. Check incrementor: must be i++, ++i, i--, --i, i += INT, or i -= INT
  if (!stmt.incrementor) return null;
  const incr = stmt.incrementor;
  if (ts.isPostfixUnaryExpression(incr)) {
    if (!ts.isIdentifier(incr.operand) || incr.operand.text !== name) return null;
    if (incr.operator !== ts.SyntaxKind.PlusPlusToken && incr.operator !== ts.SyntaxKind.MinusMinusToken) return null;
  } else if (ts.isPrefixUnaryExpression(incr)) {
    if (!ts.isIdentifier(incr.operand) || incr.operand.text !== name) return null;
    if (incr.operator !== ts.SyntaxKind.PlusPlusToken && incr.operator !== ts.SyntaxKind.MinusMinusToken) return null;
  } else if (ts.isBinaryExpression(incr)) {
    if (!ts.isIdentifier(incr.left) || incr.left.text !== name) return null;
    const incrOp = incr.operatorToken.kind;
    if (
      incrOp !== ts.SyntaxKind.PlusEqualsToken &&
      incrOp !== ts.SyntaxKind.MinusEqualsToken &&
      incrOp !== ts.SyntaxKind.EqualsToken
    )
      return null;
    // (#3907) `i = i + <int literal>` / `i = i - <int literal>` is the SAME
    // step as `i += <int literal>`, just spelled out — and it is the spelling
    // the benchmark suite and a lot of real code actually use
    // (`for (let i = 0; i < n; i = i + 1)`). Nothing in the proof this function
    // carries (integer-literal init in i32 range, condition bounds `i`, step is
    // a compile-time integer constant) depends on the spelling. Before #3907
    // fast mode narrowed every `number` regardless, so the gap was invisible;
    // with the blanket narrowing gone this form was demoting the counter — and
    // its array/vec element specialisation with it — to f64.
    let stepExpr: ts.Expression = incr.right;
    if (incrOp === ts.SyntaxKind.EqualsToken) {
      const rhs = incr.right;
      if (!ts.isBinaryExpression(rhs)) return null;
      const rhsOp = rhs.operatorToken.kind;
      if (rhsOp !== ts.SyntaxKind.PlusToken && rhsOp !== ts.SyntaxKind.MinusToken) return null;
      if (!ts.isIdentifier(rhs.left) || rhs.left.text !== name) return null;
      stepExpr = rhs.right;
    }
    // The step must be an integer literal.
    if (!ts.isNumericLiteral(stepExpr)) return null;
    const stepVal = Number(stepExpr.text.replace(/_/g, ""));
    if (!Number.isInteger(stepVal)) return null;
  } else {
    return null;
  }

  return { name, initValue };
}

/** Innermost var-scope root for `node`: enclosing function-like body, class
 * static block body, or the SourceFile. `var` declarations hoist to this scope,
 * so redeclaration analysis must cover exactly this subtree. */
function enclosingVarScope(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isSourceFile(cur)) return cur;
    if (ts.isClassStaticBlockDeclaration(cur)) return cur.body;
    if (ts.isFunctionLike(cur)) {
      const body = (cur as ts.FunctionLikeDeclaration).body;
      if (body) return body;
    }
    cur = cur.parent;
  }
  return node;
}

/**
 * (#3419) True when promoting the `var`-declared counter of `stmt` to i32 would
 * be unsound because ANOTHER `var <name>` declaration in the same var scope is
 * not an identically-promotable counter head. `var` redeclarations share ONE
 * function-scoped binding (one Wasm local): if a first loop promotes it to i32
 * and a later `for (var i = arr.length - 1; …)` head re-initializes it with an
 * f64 expression, one of the two loops ends up emitting ops against the wrong
 * local type — the exact invalid-wasm class hit by test262's
 * `testWithAllTypedArrayConstructors` (duplicate `var i` across three loops).
 * When this returns true the counter stays f64 everywhere — slower, but every
 * redeclaration then agrees on the local's type.
 *
 * `let`/`const` counters are block-scoped per loop head and never share the
 * local, so callers only need this for `var` heads.
 */
export function varCounterRedeclarationBlocksI32(stmt: ts.ForStatement, name: string): boolean {
  const scope = enclosingVarScope(stmt);
  let blocked = false;
  const visit = (node: ts.Node): void => {
    if (blocked) return;
    // Do not cross into nested var scopes — their `var <name>` is a different binding.
    if (node !== scope && (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node))) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const list = node.parent;
      if (
        ts.isVariableDeclarationList(list) &&
        (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) === 0
      ) {
        // Another `var <name>`. Our own head is fine; a sibling for-head that
        // is itself the same i32-promotable counter shape is fine (both loops
        // agree on i32); anything else forces the shared local to stay f64.
        const parentFor = ts.isForStatement(list.parent) && list.parent.initializer === list ? list.parent : null;
        if (parentFor !== stmt) {
          const info = parentFor ? detectI32LoopVar(parentFor) : null;
          if (!info || info.name !== name) blocked = true;
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(scope);
  return blocked;
}

/**
 * Shared compound-assignment operator classifier: is `kind` one of the
 * assignment / compound-assignment tokens (`=`, `+=`, … `||=`)? Extracted from
 * the two inline copies inside {@link loopBodyMutatesIndexOrArray} and
 * {@link loopBodyMutatesStringReadInvariants} (#3269 DRY).
 */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken
  );
}

/**
 * #1196: Detect mutations of the loop index or array binding inside a for-loop
 * body. Used by the bounds-check elimination pass — we can only elide bounds
 * checks for `arr[i]` if both `i` and `arr` are stable across every iteration.
 *
 * Returns `true` if the body contains anything that could mutate either
 * binding:
 *   - Direct assignment / compound assignment to `i` or `arr`
 *     (`i = …`, `i += …`, `arr = …`, etc.)
 *   - `i++ / ++i / i-- / --i` or the same on `arr`
 *   - Method calls on `arr` (`arr.push()`, `arr.length = …`, etc.)
 *   - `arr.length = …` assignment
 *   - Any nested function / arrow / class — closures could capture and mutate
 *     either binding outside our static view (conservative).
 *
 * Notes:
 *   - `arr[k] = v` writes through the array but does not change the binding
 *     itself or `arr.length` (when `k < arr.length`), so element writes are
 *     allowed — they're the whole point of the optimisation.
 */
// #2766 — exported so the IR `lowerForStatement` (src/ir/from-ast.ts) can reuse
// the exact same counted-loop non-mutation proof when porting the
// `safeIndexedArrays` in-bounds proof into the IR.
export function loopBodyMutatesIndexOrArray(body: ts.Statement, indexName: string, arrayName: string): boolean {
  let mutates = false;

  function visit(node: ts.Node): void {
    if (mutates) return;

    // Direct assignment to index / array binding, or to arr.length
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const lhs = node.left;
      if (ts.isIdentifier(lhs) && (lhs.text === indexName || lhs.text === arrayName)) {
        mutates = true;
        return;
      }
      // arr.length = …
      if (
        ts.isPropertyAccessExpression(lhs) &&
        ts.isIdentifier(lhs.expression) &&
        lhs.expression.text === arrayName &&
        lhs.name.text === "length"
      ) {
        mutates = true;
        return;
      }
    }

    // Pre/post-fix increment/decrement: i++, ++i, i--, --i, arr++, etc.
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const op = node.operand;
      if (ts.isIdentifier(op) && (op.text === indexName || op.text === arrayName)) {
        mutates = true;
        return;
      }
    }

    // Any method call on `arr` — conservatively assume it could mutate length
    // (push/pop/shift/unshift/splice/sort/reverse/copyWithin/fill, etc.). Pure
    // reads via element access (`arr[i]`) and `.length` reads are property
    // accesses, not call expressions — so they don't trigger here.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === arrayName
    ) {
      mutates = true;
      return;
    }

    // Any nested function / arrow / class — could capture and mutate either
    // binding via a runtime call we can't statically reason about. Conservative.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      mutates = true;
      return;
    }

    forEachChild(node, visit);
  }

  visit(body);
  return mutates;
}

/**
 * #2682: the increment must strictly INCREASE `i` so that, combined with a
 * non-negative init and the strict `i < recv.length` condition, `0 <= i < len`
 * holds at every body point. `i++`/`++i` and `i += <positive int literal>`
 * qualify; `i--`/`i -= k`/`i += <non-positive>` do NOT (would break the proof).
 * Narrower than `detectI32LoopVar`'s incrementor check, which also accepts the
 * decreasing forms.
 */
// #2766 — exported so the IR `lowerForStatement` reuses the same strictly-
// increasing-step check when discharging the counted-loop in-bounds proof.
export function isIncreasingStep(incr: ts.Expression | undefined, name: string): boolean {
  if (!incr) return false;
  if (ts.isPostfixUnaryExpression(incr) || ts.isPrefixUnaryExpression(incr)) {
    return ts.isIdentifier(incr.operand) && incr.operand.text === name && incr.operator === ts.SyntaxKind.PlusPlusToken;
  }
  if (ts.isBinaryExpression(incr)) {
    if (!ts.isIdentifier(incr.left) || incr.left.text !== name) return false;
    if (incr.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken) return false;
    if (!ts.isNumericLiteral(incr.right)) return false;
    const step = Number(incr.right.text.replace(/_/g, ""));
    return Number.isInteger(step) && step > 0;
  }
  return false;
}

/**
 * #2682: string-specific variant of {@link loopBodyMutatesIndexOrArray} for the
 * canonical read-loop hoist. Returns true if the body could invalidate the
 * loop-invariance of `recvName` or the in-bounds invariant of `indexName`.
 *
 * Strings are IMMUTABLE, so — unlike the #1196 array helper — method calls on
 * the receiver (notably `recv.charCodeAt(i)`, the whole point) are SAFE and must
 * NOT disqualify. Only these break the invariants:
 *   - assignment / compound-assignment / `++`/`--` to `recvName` or `indexName`;
 *   - a body-local declaration that SHADOWS `recvName` or `indexName` — the
 *     downstream `recv.charCodeAt(i)` match keys on identifier TEXT, so a shadow
 *     (`for (…) { let recv = other; … recv.charCodeAt(i) … }`) would wrongly read
 *     the hoisted OUTER descriptor. Reject any such shadow (sound, conservative);
 *   - any nested function / arrow / class (could capture and reassign either
 *     binding via a call we can't statically see — conservative, matches #1196).
 */
export function loopBodyMutatesStringReadInvariants(body: ts.Statement, indexName: string, recvName: string): boolean {
  let mutates = false;
  const declaresShadow = (name: ts.BindingName | undefined): boolean => {
    if (!name) return false;
    for (const n of collectPatternBindingNames(name)) {
      if (n === indexName || n === recvName) return true;
    }
    return false;
  };
  function visit(node: ts.Node): void {
    if (mutates) return;
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const lhs = node.left;
      if (ts.isIdentifier(lhs) && (lhs.text === indexName || lhs.text === recvName)) {
        mutates = true;
        return;
      }
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      (node.operand.text === indexName || node.operand.text === recvName)
    ) {
      mutates = true;
      return;
    }
    // Body-local declaration shadowing recv/i — see the doc comment.
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      declaresShadow(node.name)
    ) {
      mutates = true;
      return;
    }
    if (ts.isCatchClause(node) && declaresShadow(node.variableDeclaration?.name)) {
      mutates = true;
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      mutates = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(body);
  return mutates;
}

/**
 * #2682: true iff the body contains at least one `recvName.charCodeAt(indexName)`
 * read (exact receiver + induction identifier). Gating the hoist on this keeps
 * codegen byte-identical for string loops that never read a char by the
 * induction var, and avoids emitting a dead `__str_flatten` + descriptor hoist.
 */
export function bodyHasMatchingCharRead(body: ts.Statement, recvName: string, indexName: string): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "charCodeAt" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === recvName &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]!) &&
      (node.arguments[0] as ts.Identifier).text === indexName
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(body);
  return found;
}

/**
 * #1453: Per-iteration fresh binding detection for `for (let X = …; …; …)`.
 *
 * Per ECMA-262 §14.7.4.4 (CreatePerIterationEnvironment), each iteration of
 * a `for` with let/const head bindings runs against a freshly-allocated
 * binding initialised from the previous iteration's value. Closures captured
 * inside the body therefore see distinct bindings.
 *
 * Detect which head-binding names are referenced from a nested closure (arrow,
 * function expression/declaration, method, class) anywhere in the loop's
 * condition, incrementor, or body. Names with no closure capture keep the
 * single-local fast path; captured names get boxed as ref-cells and the
 * codegen allocates a fresh cell at the iteration boundary.
 *
 * `collectReferencedIdentifiers` is scope-aware (tracks shadowing across
 * nested function boundaries), so a reference to `i` inside a nested
 * function that re-binds `i` is correctly ignored.
 */
export function findHeadBindingsCapturedByClosures(stmt: ts.ForStatement, headNames: ReadonlySet<string>): Set<string> {
  const captured = new Set<string>();
  if (headNames.size === 0) return captured;
  function visit(node: ts.Node | undefined): void {
    if (!node) return;
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      // Scope-aware reference collection over the entire nested subtree.
      const refs = new Set<string>();
      collectReferencedIdentifiers(node, refs);
      for (const n of headNames) {
        if (refs.has(n)) captured.add(n);
      }
      return; // collectReferencedIdentifiers already walked deeper closures.
    }
    forEachChild(node, visit);
  }
  // Walk condition + incrementor + body. Closures may appear in any of them
  // (e.g. `for (let i=0; (f = () => i, true); i++) {}`).
  visit(stmt.condition);
  visit(stmt.incrementor);
  visit(stmt.statement);
  return captured;
}

/**
 * #1589: Find every identifier name that appears inside a nested closure
 * anywhere in the for-loop's condition/incrementor/body. Used to pre-emptively
 * box outer-scope (`var`-declared or enclosing-function) variables before
 * compiling the loop condition.
 *
 * Without this pre-pass, the closure-construction codegen promotes the
 * variable to a ref-cell mid-loop. The loop condition (compiled first) reads
 * the original unboxed slot, while the incrementor (compiled after the body)
 * writes through the ref cell — so the condition's view never updates and the
 * loop spins forever.
 */
export function findAllNamesCapturedByClosuresInForLoop(stmt: ts.ForStatement): Set<string> {
  const captured = new Set<string>();
  function visit(node: ts.Node | undefined): void {
    if (!node) return;
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      const refs = new Set<string>();
      collectReferencedIdentifiers(node, refs);
      for (const n of refs) captured.add(n);
      return;
    }
    forEachChild(node, visit);
  }
  visit(stmt.condition);
  visit(stmt.incrementor);
  visit(stmt.statement);
  return captured;
}

/**
 * Collect names that are lexically declared (`let`/`const`/`using`, class,
 * or function) at the top level of the loop body — i.e. block-scoped bindings
 * that belong to each iteration's environment rather than to an outer scope.
 *
 * The #1589 pre-box pass is only meant for `var`-declared or enclosing-function
 * variables. A body-local `let`/`const` captured by a closure already gets a
 * fresh per-iteration cell via the body declaration + closure-construction
 * path; pre-boxing it at the loop head is semantically wrong (the binding does
 * not exist yet) and conflates the hoisted value slot with the ref cell,
 * emitting `ref.is_null` over an f64 local (invalid wasm). We exclude these.
 *
 * We do NOT descend into nested closures or nested blocks/loops: only bindings
 * whose scope is the loop body's own lexical environment matter here.
 */
export function findBodyLocalLexicalNames(stmt: ts.ForStatement): Set<string> {
  const names = new Set<string>();
  const body = stmt.statement;
  const statements = ts.isBlock(body) ? body.statements : [body];
  for (const s of statements) {
    if (ts.isVariableStatement(s)) {
      const isLexical =
        (s.declarationList.flags &
          (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !==
        0;
      if (!isLexical) continue;
      for (const decl of s.declarationList.declarations) {
        for (const n of collectPatternBindingNames(decl.name)) names.add(n);
      }
    } else if (ts.isFunctionDeclaration(s) && s.name) {
      names.add(s.name.text);
    } else if (ts.isClassDeclaration(s) && s.name) {
      names.add(s.name.text);
    }
  }
  return names;
}

/** Collect all identifier names from a binding pattern (ObjectBindingPattern or ArrayBindingPattern) */
export function collectBindingNames(pattern: ts.BindingPattern): string[] {
  const names: string[] = [];
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isBindingElement(element)) {
      if (ts.isIdentifier(element.name)) {
        names.push(element.name.text);
      } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        names.push(...collectBindingNames(element.name));
      }
    }
  }
  return names;
}

export function forOfDstrNeedsInboundsUndef(stmt: ts.ForOfStatement): boolean {
  if (!ts.isArrayLiteralExpression(stmt.expression)) return false;
  // Extract the for-of binding pattern (declaration or assignment form).
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0];
    if (decl && (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name))) {
      return bindingPatternHasDefaultOrNested(decl.name);
    }
    return false;
  }
  if (ts.isArrayLiteralExpression(stmt.initializer) || ts.isObjectLiteralExpression(stmt.initializer)) {
    return assignPatternHasDefaultOrNested(stmt.initializer);
  }
  return false;
}

// Declaration-form binding pattern: any element with a default initializer
// (`[x = 23]`) or a nested array/object sub-pattern (`[[y]]` / `[{z}]`).
function bindingPatternHasDefaultOrNested(pattern: ts.ArrayBindingPattern | ts.ObjectBindingPattern): boolean {
  return pattern.elements.some((el) => {
    if (ts.isOmittedExpression(el)) return false;
    const be = el as ts.BindingElement;
    if (be.initializer) return true; // element default
    return ts.isArrayBindingPattern(be.name) || ts.isObjectBindingPattern(be.name); // nested sub-pattern
  });
}

// Assignment-form pattern (`for ([x = 23] of …)` / `for ({a = 1} of …)`): same
// predicate over the literal AST (`x = 23` is a BinaryExpression with `=`; a
// nested array/object literal is a sub-pattern).
function assignPatternHasDefaultOrNested(pattern: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression): boolean {
  if (ts.isArrayLiteralExpression(pattern)) {
    return pattern.elements.some((el) => {
      if (ts.isOmittedExpression(el)) return false;
      if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
      return ts.isArrayLiteralExpression(el) || ts.isObjectLiteralExpression(el);
    });
  }
  return pattern.properties.some((p) => {
    if (ts.isShorthandPropertyAssignment(p)) return !!p.objectAssignmentInitializer; // {a = 1}
    if (ts.isPropertyAssignment(p)) {
      const init = p.initializer;
      if (ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
      return ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init);
    }
    return false;
  });
}

export function isStaticNullishReceiver(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(expr) && expr.text === "undefined") return true;
  if (ts.isVoidExpression(expr)) return true;
  if (ts.isParenthesizedExpression(expr)) return isStaticNullishReceiver(expr.expression);
  return false;
}

/**
 * (#2705) Which of a `for (let/const <head> in …)` head's bound names are
 * referenced from a nested closure anywhere in the receiver, the ForDeclaration
 * (binding-pattern default initializers), or the body? Such names must be boxed
 * into a ref cell so the closure captures the binding by reference — for the
 * head TDZ environment (a closure built in the receiver captures the
 * never-initialized binding → `typeof x` throws) and the per-iteration
 * environment. Mirrors `findHeadBindingsCapturedByClosures` (the C-style-loop
 * analogue) but walks the for-in's receiver/ForDeclaration/body.
 */
export function collectForInHeadClosureCaptures(stmt: ts.ForInStatement, headNames: ReadonlySet<string>): Set<string> {
  const captured = new Set<string>();
  if (headNames.size === 0) return captured;
  function visit(node: ts.Node | undefined): void {
    if (!node) return;
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      const refs = new Set<string>();
      collectReferencedIdentifiers(node, refs);
      for (const n of headNames) if (refs.has(n)) captured.add(n);
      return; // collectReferencedIdentifiers already walked nested closures.
    }
    forEachChild(node, visit);
  }
  visit(stmt.expression); // receiver (head TDZ scope)
  visit(stmt.initializer); // ForDeclaration — binding-pattern default initializers
  visit(stmt.statement); // body
  return captured;
}
