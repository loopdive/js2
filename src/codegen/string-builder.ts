// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1210 — string-builder rewrite for `let s = ""; for (...) s += <expr>` patterns.
 *
 * Why: each `s += <expr>` in nativeStrings mode allocates one (and sometimes
 * two) WasmGC structs — a fresh `$ConsString` (via `__str_concat`) and the
 * implicit array allocations from the eventual flatten. A 60 000-iteration
 * `s += charAt(...)` loop allocates ≈60 000 cons nodes plus assorted i16
 * arrays, and the cumulative GC time exceeds 20s under wasmtime's reference
 * GC. Pre-allocating a doubling i16 buffer reduces allocations from O(N) to
 * O(log N) and keeps the working set tiny.
 *
 * The optimization runs only in `nativeStrings` mode. The js-string `+=`
 * path uses host-provided imports and is not subject to the same pressure.
 *
 * Detector preconditions for a `let s = ""` to qualify:
 *   1. Single VariableDeclaration, identifier name, initializer is the empty
 *      string literal `""`. `var`/`const` are excluded (let only).
 *   2. The very next statement in the same block is a single iteration
 *      statement (for / while / do-while).
 *   3. Inside the loop body, every reference to `s` is the LHS of `s += <expr>`.
 *      No reads (`s.length`, `s[i]`, etc.) — those would force a flatten and
 *      defeat the speed-up.
 *   4. `s` is not mutated again after the loop (only read).
 *   5. `s` is not captured by any closure inside the function.
 *
 * Bail safely on any uncertainty — losing the optimization is correct;
 * a wrong optimization corrupts results.
 */
import { ts, forEachChild } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import {
  STRING_BUILDER_INITIAL_CAP,
  stringBuilderAppendCodeUnitInstrs,
  stringBuilderAppendStringInstrs,
  stringBuilderInitInstrs,
  stringBuilderPresizedAllocInstrs,
  stringBuilderReadInstrs,
  stringBuilderResetInstrs,
  type StringBuilderSlots,
  type StringBuilderTypes,
} from "../ir/backend/wasm-string-builder.js";
import { collectReferencedIdentifiers } from "./closures.js";
import { allocLocal } from "./context/locals.js";
import { snapshotSpeculative, rollbackSpeculative } from "./context/speculative.js";
import { compileExpression } from "./shared.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { nativeStrHelperHandle } from "./func-space.js";
import { readEnv } from "../env.js";

/**
 * #1761 — presize info for a string-builder whose final length is provably a
 * runtime-known linear function of a loop bound. When the build loop is a
 * canonical `for (let i = 0; i < BOUND; i++)` (step +1) whose body appends a
 * statically-fixed number of code units per iteration and never exits early,
 * the final buffer length is exactly `BOUND * unitsPerIter`. Presizing the
 * WasmGC i16 buffer to that length up front eliminates every doubling
 * reallocation AND lets the per-append `len+1 > cap` cap-check be removed
 * (the capacity is proven sufficient for all appends). See #1746 lever #3.
 */
export interface StringBuilderPresizeInfo {
  /** Loop-invariant bound expression, evaluated once at buffer-init time. */
  boundExpr: ts.Expression;
  /** Constant code-unit count appended per loop iteration (the exact total
   *  is `boundExpr * unitsPerIter`). */
  unitsPerIter: number;
}

/**
 * Scan a function body for `let s = ""; for (...) s += <expr>` patterns and
 * return the set of qualifying VariableDeclaration nodes. Caller stores this
 * as `fctx.pendingStringBuilders` so `compileVariableStatement` can detect
 * the rewrite when it reaches the matching declarator.
 *
 * When `presizeOut` is provided, any builder whose final length is provably a
 * runtime-known linear function of a loop bound (#1761) is additionally
 * recorded there keyed by its declaration, so the init site can presize the
 * buffer and the append sites can drop the cap-check.
 *
 * Only scans `nativeStrings` mode — caller should gate on `ctx.nativeStrings`.
 */
export function detectStringBuilders(
  ctx: CodegenContext,
  fnBody: ts.Block | ts.SourceFile | undefined,
  presizeOut?: Map<ts.VariableDeclaration, StringBuilderPresizeInfo>,
): Set<ts.VariableDeclaration> {
  const out = new Set<ts.VariableDeclaration>();
  if (!fnBody) return out;

  const candidates: {
    decl: ts.VariableDeclaration;
    name: string;
    loop: ts.IterationStatement;
    declStmt: ts.VariableStatement;
  }[] = [];

  // Phase 1: find adjacent (let s = ""; loop) pairs in every block of the
  // function body. Don't recurse into nested function scopes.
  function scanStatements(stmts: readonly ts.Statement[]): void {
    for (let i = 0; i + 1 < stmts.length; i++) {
      const cand = matchStringBuilderHead(stmts[i]!, stmts[i + 1]!);
      if (cand) candidates.push(cand);
    }
  }
  walkBlocksInScope(fnBody, scanStatements);

  if (candidates.length === 0) return out;

  // Phase 2: for each candidate, validate that the loop body uses `s` only
  // as a `+=` LHS, and that `s` is not captured or rewritten outside the
  // loop. Use TS symbol identity to be tolerant of shadowing.
  for (const cand of candidates) {
    if (!validateLoopBody(ctx, cand)) continue;
    if (!validateNoOtherWrites(ctx, cand, fnBody)) continue;
    if (isCapturedByClosure(ctx, cand, fnBody)) continue;
    out.add(cand.decl);
    // #1761: if the final length is provably `bound * unitsPerIter`, record
    // presize info. This is an additive optimisation — a builder that
    // qualifies for the buffer rewrite but not for presize still benefits
    // from the doubling buffer (unchanged behaviour).
    if (presizeOut) {
      const presize = computePresizeInfo(ctx, cand, fnBody);
      if (presize) presizeOut.set(cand.decl, presize);
    }
  }
  return out;
}

/**
 * #1761 — try to prove the builder's final length is `bound * unitsPerIter`.
 *
 * Preconditions (all required; any failure → no presize, keep doubling buffer):
 *   1. The loop is `for (let i = INIT; i < BOUND; i++)` with INIT a constant
 *      and the step a `i++` / `i += 1` over the same counter. (`<=` is
 *      rejected here for simplicity — it changes the trip count by one.)
 *   2. INIT === 0. (A non-zero start would make the count `BOUND - INIT`; we
 *      keep the common case and bail otherwise.)
 *   3. BOUND is loop-invariant: a numeric literal, or an identifier whose
 *      binding is never written inside the loop body. Evaluating it once at
 *      buffer-init time (before the loop) yields the same value the loop sees.
 *   4. The loop body contains NO `break` / `continue` / `return` / `throw`
 *      (which could cut the iteration count short) — though a short run only
 *      *under*-fills the presized buffer, we reject to keep the bound exact
 *      and the analysis simple.
 *   5. Every `s += <expr>` in the body appends a statically-fixed code-unit
 *      count (a 1-char literal → 1, a k-char literal → k, `X.charAt(i)` → 1),
 *      and the appends are unconditional (not nested under an `if`/loop).
 *      Then per-iteration units is the constant sum, identical every pass.
 */
function computePresizeInfo(ctx: CodegenContext, cand: CandidateHead, scope: ts.Node): StringBuilderPresizeInfo | null {
  // Escape hatch / A-B harness: disable the presize to compare against the
  // doubling-buffer baseline (used by the #1760 warm benchmark and as a
  // safety valve if a regression is ever traced here).
  if (readEnv("JS2WASM_DISABLE_STRING_PRESIZE") === "1") return null;
  // (1) canonical for-loop shape.
  if (!ts.isForStatement(cand.loop)) return null;
  const loop = cand.loop;
  if (!loop.initializer || !loop.condition || !loop.incrementor) return null;

  // Counter binding from `let i = <const>`.
  if (!ts.isVariableDeclarationList(loop.initializer)) return null;
  if (loop.initializer.declarations.length !== 1) return null;
  const counterDecl = loop.initializer.declarations[0]!;
  if (!ts.isIdentifier(counterDecl.name)) return null;
  if (!counterDecl.initializer || !ts.isNumericLiteral(counterDecl.initializer)) return null;
  if (Number(counterDecl.initializer.text) !== 0) return null; // (2) INIT === 0
  const counterSym = ctx.checker.getSymbolAtLocation(counterDecl.name);
  if (!counterSym) return null;

  // (1) condition `i < BOUND`.
  if (!ts.isBinaryExpression(loop.condition)) return null;
  if (loop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null;
  if (!ts.isIdentifier(loop.condition.left)) return null;
  if (ctx.checker.getSymbolAtLocation(loop.condition.left) !== counterSym) return null;
  const boundExpr = loop.condition.right;

  // (1) incrementor `i++` / `++i` / `i += 1`.
  if (!isUnitIncrementOf(ctx, loop.incrementor, counterSym)) return null;

  // (3) BOUND is loop-invariant.
  if (!isLoopInvariantBound(ctx, boundExpr, loop.statement, counterSym)) return null;

  // (4) + (5): walk the body once, summing per-iteration units and rejecting
  // early-exit / conditional appends.
  const units = sumUnconditionalAppendUnits(ctx, cand, loop.statement);
  if (units === null) return null;
  if (units <= 0) return null; // nothing to presize (or unknown) → keep doubling

  void scope;
  return { boundExpr, unitsPerIter: units };
}

/** True if `incr` is `i++`, `++i`, or `i += 1` for the counter symbol. */
function isUnitIncrementOf(ctx: CodegenContext, incr: ts.Expression, counterSym: ts.Symbol): boolean {
  if (ts.isPostfixUnaryExpression(incr) || ts.isPrefixUnaryExpression(incr)) {
    if (incr.operator !== ts.SyntaxKind.PlusPlusToken) return false;
    if (!ts.isIdentifier(incr.operand)) return false;
    return ctx.checker.getSymbolAtLocation(incr.operand) === counterSym;
  }
  if (ts.isBinaryExpression(incr) && incr.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
    if (!ts.isIdentifier(incr.left)) return false;
    if (ctx.checker.getSymbolAtLocation(incr.left) !== counterSym) return false;
    return ts.isNumericLiteral(incr.right) && Number(incr.right.text) === 1;
  }
  return false;
}

/**
 * True if `boundExpr` is loop-invariant and safe to evaluate once before the
 * loop: a numeric literal, or an identifier whose binding is the loop counter
 * (rejected — that would not be invariant) excluded, or an identifier whose
 * binding is never assigned within `body`. Conservative: anything else → false.
 */
function isLoopInvariantBound(
  ctx: CodegenContext,
  boundExpr: ts.Expression,
  body: ts.Node,
  counterSym: ts.Symbol,
): boolean {
  if (ts.isNumericLiteral(boundExpr)) return true;
  if (!ts.isIdentifier(boundExpr)) return false;
  const boundSym = ctx.checker.getSymbolAtLocation(boundExpr);
  if (!boundSym) return false;
  if (boundSym === counterSym) return false; // `i < i` is degenerate
  // Reject if `boundExpr`'s binding is written anywhere inside the body.
  let written = false;
  function visit(node: ts.Node): void {
    if (written) return;
    if (isFunctionScopeBoundary(node)) return;
    // Assignment LHS.
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const isAssign =
        op === ts.SyntaxKind.EqualsToken ||
        op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.MinusEqualsToken ||
        op === ts.SyntaxKind.AsteriskEqualsToken ||
        op === ts.SyntaxKind.SlashEqualsToken ||
        op === ts.SyntaxKind.PercentEqualsToken;
      if (isAssign && ts.isIdentifier(node.left) && ctx.checker.getSymbolAtLocation(node.left) === boundSym) {
        written = true;
        return;
      }
    }
    // ++/-- on the bound.
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      ctx.checker.getSymbolAtLocation(node.operand) === boundSym
    ) {
      written = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(body);
  return !written;
}

/**
 * Walk the loop body and return the constant number of code units appended to
 * the builder per iteration, or `null` if the count is not statically fixed
 * (conditional/looped append, variable-length RHS) or if the body contains a
 * control-flow construct that could change the iteration count
 * (`break`/`continue`/`return`/`throw`). The appends must be unconditional —
 * direct statements of the loop body (or its top-level block), never nested
 * inside an inner `if`/loop/try.
 */
function sumUnconditionalAppendUnits(ctx: CodegenContext, cand: CandidateHead, body: ts.Node): number | null {
  const declSym = ctx.checker.getSymbolAtLocation(cand.decl.name);
  if (!declSym) return null;

  // Flatten the body into its top-level statement list. A single statement
  // body (`for (...) s += "x";`) is treated as a one-element list.
  const stmts: readonly ts.Statement[] = ts.isBlock(body) ? body.statements : [body as ts.Statement];

  let total = 0;
  for (const stmt of stmts) {
    // Any nested control-flow that can short-circuit the trip count or make an
    // append conditional disqualifies the loop. We only admit
    // ExpressionStatements and plain `const`/`let` decls with no `s` append.
    if (
      ts.isBreakStatement(stmt) ||
      ts.isContinueStatement(stmt) ||
      ts.isReturnStatement(stmt) ||
      ts.isThrowStatement(stmt)
    ) {
      return null;
    }
    // A nested statement that might *contain* an `s` append under a branch, or
    // a break/continue/return/throw, disqualifies. Detect by checking whether
    // the statement references the builder or contains abrupt control flow.
    if (
      ts.isIfStatement(stmt) ||
      ts.isIterationStatement(stmt, /*lookInLabeledStatements*/ true) ||
      ts.isSwitchStatement(stmt) ||
      ts.isTryStatement(stmt) ||
      ts.isLabeledStatement(stmt) ||
      ts.isBlock(stmt)
    ) {
      if (statementMutatesBuilderOrExitsLoop(ctx, stmt, declSym)) return null;
      // Otherwise the nested statement is irrelevant to the builder (e.g. a
      // bookkeeping `if`) and contributes 0 units.
      continue;
    }
    if (ts.isExpressionStatement(stmt)) {
      const units = appendUnitsOfExpression(ctx, stmt.expression, declSym);
      if (units === null) return null; // an `s += <variable-length>` → bail
      total += units;
      continue;
    }
    // `const a = ...;` style bookkeeping decls are fine as long as they don't
    // reference the builder (they can't append to it). Reject if they do.
    if (ts.isVariableStatement(stmt)) {
      if (referencesSymbol(ctx, stmt, declSym)) return null;
      continue;
    }
    // Anything else (e.g. nested function decl) — be conservative.
    if (referencesSymbol(ctx, stmt, declSym)) return null;
  }
  return total;
}

/**
 * For an ExpressionStatement's expression, return the code-unit count it
 * appends to the builder, 0 if it doesn't touch the builder, or `null` if it
 * appends a variable-length value (so the per-iteration count is not fixed).
 */
function appendUnitsOfExpression(ctx: CodegenContext, expr: ts.Expression, declSym: ts.Symbol): number | null {
  // Comma expression: sum each operand.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    const l = appendUnitsOfExpression(ctx, expr.left, declSym);
    if (l === null) return null;
    const r = appendUnitsOfExpression(ctx, expr.right, declSym);
    if (r === null) return null;
    return l + r;
  }
  // `s += <rhs>` where `s` is the builder.
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    ts.isIdentifier(expr.left) &&
    ctx.checker.getSymbolAtLocation(expr.left) === declSym
  ) {
    return staticAppendUnitsOfRhs(ctx, expr.right);
  }
  // An expression that doesn't append to the builder but still references it
  // (e.g. reads `s.length`) — a read forces materialisation and is fine for
  // correctness, but reading mid-build means the presize length still holds.
  // It contributes 0 appended units.
  if (referencesSymbol(ctx, expr, declSym)) {
    // Only allow READS — any write/`+=`/assignment was handled above. A
    // postfix/prefix on `s` (nonsensical for strings) → bail.
    if (
      (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) &&
      ts.isIdentifier(expr.operand) &&
      ctx.checker.getSymbolAtLocation(expr.operand) === declSym
    ) {
      return null;
    }
    // A bare `s = ...` assignment (handled separately by validateNoOtherWrites
    // which would have rejected the builder) — but defensively bail here too.
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(expr.left) &&
      ctx.checker.getSymbolAtLocation(expr.left) === declSym
    ) {
      return null;
    }
    return 0;
  }
  return 0;
}

/**
 * Constant code-unit count of a `+=` RHS, or `null` if not statically fixed.
 *   - string literal `"abc"` → its `.length` (UTF-16 code units)
 *   - `X.charAt(i)` on a string receiver → exactly 1 code unit
 * Anything else (numbers, variables, concatenations, `X.substring(...)`, etc.)
 * → `null`.
 */
function staticAppendUnitsOfRhs(ctx: CodegenContext, rhs: ts.Expression): number | null {
  if (ts.isStringLiteral(rhs)) {
    // `.length` is the UTF-16 code-unit count, which is exactly what the
    // builder appends. `rhs.text` is the decoded value, so its JS `.length`
    // (code units) is correct including surrogate pairs.
    return rhs.text.length;
  }
  if (ts.isNoSubstitutionTemplateLiteral(rhs)) {
    return rhs.text.length;
  }
  // `X.charAt(i)` on a static-string receiver appends exactly one code unit.
  if (
    ts.isCallExpression(rhs) &&
    ts.isPropertyAccessExpression(rhs.expression) &&
    rhs.expression.name.text === "charAt" &&
    rhs.arguments.length <= 1
  ) {
    const recvType = ctx.checker.getTypeAtLocation(rhs.expression.expression);
    if ((recvType.flags & ts.TypeFlags.StringLike) !== 0) return 1;
  }
  return null;
}

/** Does `node`'s subtree reference the symbol (any identifier resolving to it)? */
function referencesSymbol(ctx: CodegenContext, node: ts.Node, sym: ts.Symbol): boolean {
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(n) && ctx.checker.getSymbolAtLocation(n) === sym) {
      found = true;
      return;
    }
    forEachChild(n, visit);
  }
  visit(node);
  return found;
}

/**
 * For a nested statement (if/loop/switch/try/block/labeled), return true if it
 * either mutates the builder (`s += ...`, `s = ...`, `s++`) or contains a
 * loop-exiting construct (`break`/`continue`/`return`/`throw`) for the BUILDER
 * loop. Either condition disqualifies the exact-length presize.
 */
function statementMutatesBuilderOrExitsLoop(ctx: CodegenContext, stmt: ts.Node, declSym: ts.Symbol): boolean {
  let bad = false;
  function visit(n: ts.Node): void {
    if (bad) return;
    if (isFunctionScopeBoundary(n)) return; // closures handled separately
    // Loop-exiting / function-exiting control flow inside the body.
    if (ts.isBreakStatement(n) || ts.isContinueStatement(n) || ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
      bad = true;
      return;
    }
    // Builder mutation: `s += ...` / `s = ...` / `s++`.
    if (
      ts.isBinaryExpression(n) &&
      ts.isIdentifier(n.left) &&
      ctx.checker.getSymbolAtLocation(n.left) === declSym &&
      (n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || n.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    ) {
      bad = true;
      return;
    }
    if (
      (ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) &&
      ts.isIdentifier(n.operand) &&
      ctx.checker.getSymbolAtLocation(n.operand) === declSym
    ) {
      bad = true;
      return;
    }
    forEachChild(n, visit);
  }
  visit(stmt);
  return bad;
}

function walkBlocksInScope(scope: ts.Node, visit: (stmts: readonly ts.Statement[]) => void): void {
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
    visit(scope.statements);
  }
  forEachChild(scope, (child) => {
    if (isFunctionScopeBoundary(child)) return; // don't cross fn boundaries
    if (ts.isBlock(child) || ts.isModuleBlock(child)) {
      visit(child.statements);
      forEachChild(child, (cc) => walkBlocksInScope(cc, visit));
      return;
    }
    walkBlocksInScope(child, visit);
  });
}

function isFunctionScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isLoopStatement(node: ts.Node): node is ts.IterationStatement {
  return ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
}

interface CandidateHead {
  decl: ts.VariableDeclaration;
  name: string;
  loop: ts.IterationStatement;
  declStmt: ts.VariableStatement;
}

function matchStringBuilderHead(stmt: ts.Statement, next: ts.Statement): CandidateHead | null {
  if (!ts.isVariableStatement(stmt)) return null;
  // Only `let` (block-scoped, fresh per scope).
  if (!(stmt.declarationList.flags & ts.NodeFlags.Let)) return null;
  if (stmt.declarationList.declarations.length !== 1) return null;
  const decl = stmt.declarationList.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) return null;
  if (!decl.initializer) return null;
  if (!ts.isStringLiteral(decl.initializer)) return null;
  if (decl.initializer.text !== "") return null;
  if (!isLoopStatement(next)) return null;
  return {
    decl,
    name: decl.name.text,
    loop: next,
    declStmt: stmt,
  };
}

function validateLoopBody(ctx: CodegenContext, cand: CandidateHead): boolean {
  const declSym = ctx.checker.getSymbolAtLocation(cand.decl.name);
  if (!declSym) return false;

  let ok = true;
  function visit(node: ts.Node): void {
    if (!ok) return;
    // Don't cross function boundaries — closure capture is rejected separately
    // by isCapturedByClosure (which is conservative).
    if (isFunctionScopeBoundary(node)) {
      const refs = new Set<string>();
      collectReferencedIdentifiers(node, refs);
      if (refs.has(cand.name)) ok = false;
      return;
    }
    if (ts.isIdentifier(node) && node.text === cand.name) {
      // Resolve the binding via TS symbol identity to tolerate shadowing
      // (a `let s` redeclared inside the loop body is a different symbol).
      const sym = ctx.checker.getSymbolAtLocation(node);
      if (sym !== declSym) return; // different binding → ignore
      // Identifier must be the LHS of `name += <expr>`.
      const parent = node.parent;
      if (
        !parent ||
        !ts.isBinaryExpression(parent) ||
        parent.left !== node ||
        parent.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken
      ) {
        ok = false;
        return;
      }
      return;
    }
    forEachChild(node, visit);
  }
  visit(cand.loop.statement);

  // Reject `for (...; cond; incr)` whose condition or incrementor reads `s`.
  if (ok && ts.isForStatement(cand.loop)) {
    const subParts: ts.Node[] = [];
    if (cand.loop.condition) subParts.push(cand.loop.condition);
    if (cand.loop.incrementor) subParts.push(cand.loop.incrementor);
    for (const part of subParts) {
      visit(part);
      if (!ok) break;
    }
  }
  // Reject `while (cond)` whose cond reads `s`.
  if (ok && ts.isWhileStatement(cand.loop)) {
    visit(cand.loop.expression);
  }
  if (ok && ts.isDoStatement(cand.loop)) {
    visit(cand.loop.expression);
  }

  return ok;
}

/**
 * Reject if `s` is written (assigned or `+=`-d) anywhere in the function
 * outside of the matched loop body. Tolerates the original `let s = ""`
 * declaration and reads after the loop.
 *
 * Conservative: any AssignmentExpression / postfix or prefix UnaryExpression
 * targeting an identifier whose symbol matches `decl.name`'s symbol triggers
 * a reject. This catches `s = "reset"`, `s += "x"` after the loop, `s++`
 * (nonsensical for strings but safe to reject).
 */
function validateNoOtherWrites(ctx: CodegenContext, cand: CandidateHead, scope: ts.Node): boolean {
  const declSym = ctx.checker.getSymbolAtLocation(cand.decl.name);
  if (!declSym) return false;

  let ok = true;
  function visit(node: ts.Node): void {
    if (!ok) return;
    if (node === cand.loop) return; // skip the matched loop body
    if (isFunctionScopeBoundary(node)) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const isAssignOp =
        op === ts.SyntaxKind.EqualsToken ||
        op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.MinusEqualsToken ||
        op === ts.SyntaxKind.AsteriskEqualsToken ||
        op === ts.SyntaxKind.SlashEqualsToken ||
        op === ts.SyntaxKind.PercentEqualsToken ||
        op === ts.SyntaxKind.AmpersandEqualsToken ||
        op === ts.SyntaxKind.BarEqualsToken ||
        op === ts.SyntaxKind.CaretEqualsToken ||
        op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
        op === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
        op === ts.SyntaxKind.BarBarEqualsToken ||
        op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
        op === ts.SyntaxKind.QuestionQuestionEqualsToken;
      if (isAssignOp && ts.isIdentifier(node.left) && node.left.text === cand.name) {
        const sym = ctx.checker.getSymbolAtLocation(node.left);
        if (sym === declSym) {
          ok = false;
          return;
        }
      }
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === cand.name
    ) {
      const sym = ctx.checker.getSymbolAtLocation(node.operand);
      if (sym === declSym) {
        const op = node.operator;
        if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
          ok = false;
          return;
        }
      }
    }
    forEachChild(node, visit);
  }
  visit(scope);
  return ok;
}

function isCapturedByClosure(ctx: CodegenContext, cand: CandidateHead, scope: ts.Node): boolean {
  const declSym = ctx.checker.getSymbolAtLocation(cand.decl.name);
  if (!declSym) return true; // safe default
  let captured = false;
  function visit(node: ts.Node): void {
    if (captured) return;
    if (isFunctionScopeBoundary(node)) {
      // Skip the enclosing function itself — the scan only inspects nested
      // functions/arrows. The outer function is `scope`.
      const refs = new Set<string>();
      collectReferencedIdentifiers(node, refs);
      if (refs.has(cand.name)) {
        // Could be a nested fn that references a different binding with the
        // same name. Verify via symbol identity by walking the nested fn.
        let found = false;
        function inner(n: ts.Node): void {
          if (found) return;
          if (ts.isIdentifier(n) && n.text === cand.name) {
            const sym = ctx.checker.getSymbolAtLocation(n);
            if (sym === declSym) {
              found = true;
              return;
            }
          }
          forEachChild(n, inner);
        }
        inner(node);
        if (found) captured = true;
      }
      return;
    }
    forEachChild(node, visit);
  }
  forEachChild(scope, visit);
  return captured;
}

/**
 * Emit the buffer-init sequence for a string-builder binding. Allocates
 * `${name}$buf`, `${name}$len`, `${name}$cap`, `${name}$mat` locals,
 * registers them in `fctx.stringBuilders`, and emits initialization that
 * sets `buf := array.new_default 16`, `len := 0`, `cap := 16`, `mat := null`.
 *
 * #1761: when `presize` is supplied, the buffer is allocated once at the
 * provably-final length `bound * unitsPerIter` instead of the doubling
 * initial 16, the recorded capacity matches, and `sb.presized` is set so the
 * append sites drop the per-append `len+1 > cap` cap-check (the capacity is
 * proven sufficient for every append). `bound` is evaluated once here, before
 * the loop runs — sound because the analysis proved it loop-invariant. A
 * non-positive bound yields a 0-length buffer; the loop then runs 0 times and
 * appends nothing, so the empty buffer is correct (any later read of the
 * never-grown builder materialises a 0-length string).
 *
 * Caller is responsible for calling this from the variable-statement
 * dispatcher when it sees a decl present in `fctx.pendingStringBuilders`,
 * and for ensuring native string helpers have been emitted (so
 * `__str_buf_next_cap` is available when a later append needs it).
 */
export function compileStringBuilderInit(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  presize?: StringBuilderPresizeInfo,
): void {
  const slots = {
    buf: allocLocal(fctx, `${name}$buf`, { kind: "ref_null", typeIdx: ctx.nativeStrDataTypeIdx }),
    len: allocLocal(fctx, `${name}$len`, { kind: "i32" }),
    cap: allocLocal(fctx, `${name}$cap`, { kind: "i32" }),
    mat: allocLocal(fctx, `${name}$mat`, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx }),
  };
  const t = builderTypes(ctx);
  // #1761: presize when the bound compiles to a number, else keep doubling.
  const presized = presize !== undefined && emitPresizedBufferAlloc(ctx, fctx, presize, { ...slots, presized: true });
  const sb: StringBuilderInfo = { ...slots, presized };
  fctx.body.push(
    ...(presized ? stringBuilderResetInstrs(t, sb) : stringBuilderInitInstrs(t, sb, STRING_BUILDER_INITIAL_CAP)),
  );
  if (!fctx.stringBuilders) fctx.stringBuilders = new Map();
  fctx.stringBuilders.set(name, sb);
}

/**
 * #1761 — compile the loop bound to an i32 and emit the presized buffer.
 * Returns `false` when the bound does not compile to a number; the caller
 * then falls back to the doubling buffer.
 */
function emitPresizedBufferAlloc(
  ctx: CodegenContext,
  fctx: FunctionContext,
  presize: StringBuilderPresizeInfo,
  sb: StringBuilderInfo,
): boolean {
  // #1919 — a failed bound compile rolls back the body, locals, late imports
  // and errors it leaked.
  const snap = snapshotSpeculative(ctx, fctx);
  const boundType = compileExpression(ctx, fctx, presize.boundExpr, { kind: "i32" });
  if (boundType?.kind === "f64") {
    // `i < bound` with an integer counter observes the truncated bound.
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else if (boundType?.kind !== "i32") {
    rollbackSpeculative(ctx, fctx, snap);
    return false;
  }
  const boundTmp = allocLocal(fctx, `__sb_bound_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(...stringBuilderPresizedAllocInstrs(builderTypes(ctx), sb, boundTmp, presize.unitsPerIter));
  return true;
}

/** The slots of a `let s = ""` builder; the instruction shapes live in `ir/backend/wasm-string-builder.ts`. */
export type StringBuilderInfo = StringBuilderSlots;

/**
 * Append the `ref $AnyString` on the stack to the builder. The detector
 * matches `s += <expr>` only as a statement, so nothing is left on the stack.
 */
export function compileStringBuilderAppend(ctx: CodegenContext, fctx: FunctionContext, sb: StringBuilderInfo): void {
  // Resolve at emit time: an earlier `addImport` may have moved the helpers (#3909).
  const flatten = lookupModuleFuncByName(ctx, "__str_flatten");
  const nextCap = lookupModuleFuncByName(ctx, "__str_buf_next_cap");
  // Both helpers are emitted with the native string runtime; validation
  // reports their absence.
  if (flatten < 0 || nextCap < 0) return;
  const rhs = allocLocal(fctx, `__sb_rhs_${fctx.locals.length}`, { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx });
  const rhsLen = allocLocal(fctx, `__sb_rhsLen_${fctx.locals.length}`, { kind: "i32" });
  const needed = allocLocal(fctx, `__sb_needed_${fctx.locals.length}`, { kind: "i32" });
  const oldBuf = sb.presized ? undefined : allocOldBuf(ctx, fctx, "__sb_oldBuf_");
  fctx.body.push(
    ...stringBuilderAppendStringInstrs(builderTypes(ctx), sb, { rhs, rhsLen, needed, oldBuf }, { flatten, nextCap }),
  );
}

/**
 * #1744 — append the i32 code unit on the stack without materialising a
 * one-unit `$NativeString`: the `s += x.charAt(i)` hot path. `charAt` is
 * code-unit indexed, so copying the raw unit is exact.
 */
export function emitStringBuilderAppendCodeUnit(
  ctx: CodegenContext,
  fctx: FunctionContext,
  sb: StringBuilderInfo,
): void {
  // #1761: a presized builder never grows and needs no growth helper.
  const nextCap = sb.presized ? 0 : lookupModuleFuncByName(ctx, "__str_buf_next_cap");
  if (nextCap < 0) {
    fctx.body.push({ op: "drop" });
    return;
  }
  const cu = allocLocal(fctx, `__sb_cu_${fctx.locals.length}`, { kind: "i32" });
  const needed = allocLocal(fctx, `__sb_needed1_${fctx.locals.length}`, { kind: "i32" });
  const oldBuf = sb.presized ? undefined : allocOldBuf(ctx, fctx, "__sb_oldBuf1_");
  fctx.body.push(...stringBuilderAppendCodeUnitInstrs(builderTypes(ctx), sb, { cu, needed, oldBuf }, nextCap));
}

/** #1580 — push the builder's contents as `ref $NativeString`, cached in `mat`. */
export function emitStringBuilderRead(ctx: CodegenContext, fctx: FunctionContext, sb: StringBuilderInfo): ValType {
  fctx.body.push(...stringBuilderReadInstrs(builderTypes(ctx), sb));
  return { kind: "ref", typeIdx: ctx.nativeStrTypeIdx };
}

function allocOldBuf(ctx: CodegenContext, fctx: FunctionContext, prefix: string): number {
  return allocLocal(fctx, `${prefix}${fctx.locals.length}`, { kind: "ref_null", typeIdx: ctx.nativeStrDataTypeIdx });
}

function builderTypes(ctx: CodegenContext): StringBuilderTypes {
  return { data: ctx.nativeStrDataTypeIdx, flat: ctx.nativeStrTypeIdx, any: ctx.anyStrTypeIdx };
}

/** Helper to look up an active builder by binding name. */
export function getBuilderInfo(fctx: FunctionContext, name: string): StringBuilderInfo | undefined {
  return fctx.stringBuilders?.get(name);
}

/**
 * Resolve a native-string helper to a function handle. Returns -1 when the
 * helper is not registered.
 *
 * Historically this deliberately bypassed `ctx.nativeStrHelpers` and
 * `ctx.funcMap` (both could hold stale indices when `addImport` bumped
 * `numImportFuncs` without shifting previously-registered entries) in favour of
 * a positional `numImportFuncs + i` scan.
 *
 * (#3909) That preference is now backwards: `nativeStrHelpers` holds
 * STABLE-regime handles that no shifter touches, while the positional scan
 * yields a LIVE index whose correctness depends on every later shifter — and
 * the shift guard stops tracking it once the import count climbs past it.
 * `nativeStrHelperHandle` prefers the stable handle and keeps the scan as the
 * fallback for helpers not yet on stable minting.
 */
function lookupModuleFuncByName(ctx: CodegenContext, name: string): number {
  return nativeStrHelperHandle(ctx, name) ?? -1;
}
