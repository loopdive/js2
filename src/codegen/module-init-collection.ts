// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3623) THE MODULE-INIT COLLECTION CLASSIFIER — making a silent drop loud.
//
// The defect class this exists to end
// -----------------------------------
// `collectDeclarations` decides which top-level ExpressionStatements reach
// `__module_init` using an ALLOW-LIST. Anything the list does not name is
// dropped — silently, with no diagnostic. A dropped statement does not fail;
// it simply never happens, so the program produces a SILENT WRONG ANSWER and
// any test covering it becomes a VACUOUS PASS.
//
// That has now happened at least SIX times, each fixed by adding one more arm:
//
//   | #     | shape that was silently dropped              | consequence                          |
//   | ----- | ------------------------------------------- | ------------------------------------ |
//   | #1268 | `d["x"] ??= 42` (logical assignment)        | LHS uninitialised, reads NaN         |
//   | #2671 | `F.prop = …` on a top-level function        | static silently never existed        |
//   | #2992 | `delete o.k`                                | property survived; `"k" in o` true   |
//   | #3366 | destructuring assignment `[a,b] = …`        | whole statement dropped              |
//   | #3468 | `assert.sameValue = function(){…}` (SA)     | EVERY assertion a vacuous pass       |
//   | #3592 | top-level `throw`                           | program exited 0 instead of throwing |
//   | #3615 | bare `o.p;` property read                   | accessor never ran                   |
//
// Adding a seventh arm does not stop the eighth. The mechanism is a vacuity
// GENERATOR by construction — and its sharpest instance is #3592 RC1, where the
// dropped top-level `throw` broke the throw-probe technique used to DETECT
// vacuous passes. The mechanism disabled its own detector.
//
// What this module changes
// ------------------------
// The fall-through stops being silent. Every top-level ExpressionStatement is
// classified TOTALLY into one of three dispositions, and the default is never
// "drop quietly":
//
//   • `keep`       — observable; collect it into `__module_init`.
//   • `inert`      — provably no observable effect, with the reason recorded.
//                    This is an explicit DENY-LIST, not a fall-through.
//   • `unhandled`  — everything else: observable (or not provably inert) but not
//                    yet collected. Reported through the diagnostic channel
//                    instead of vanishing.
//
// The point is the DEFAULT. A shape nobody has thought about lands in
// `unhandled` and announces itself, rather than becoming the eighth silent
// wrong answer.
//
// Deliberately NOT decided here: whether `unhandled` should be compiled
// (semantically correct) or refused. Flipping it to "compile" changes behaviour
// for ~10k statements across ~500 corpus files and needs its own measured
// landing — the population is enumerated in plan/issues/3623-*.md so that
// landing starts from numbers rather than guesses.

import ts from "typescript";

/** What should happen to a top-level ExpressionStatement. */
export type ModuleInitDisposition = "keep" | "inert" | "unhandled";

export interface ModuleInitClassification {
  disposition: ModuleInitDisposition;
  /** Stable label for diagnostics/telemetry, e.g. `TaggedTemplateExpression`. */
  shape: string;
  /** Why — required for `inert`, since an inert claim is a correctness claim. */
  reason: string;
}

/**
 * Unwrap the wrappers that are transparent in statement position. `void x`
 * evaluates its operand and discards the result, and parentheses are pure
 * grouping — so `void (delete o.k)` must still delete, and `(o.p)` must still
 * read. Mirrors the unwrap loop in `collectDeclarations`.
 */
export function unwrapStatementExpression(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isVoidExpression(e)) e = e.expression;
  return e;
}

/**
 * The explicit INERT deny-list: expression kinds whose evaluation runs no user
 * code and cannot throw, so dropping them is genuinely unobservable.
 *
 * Each entry is a correctness claim, so each carries its reason. Note what is
 * deliberately ABSENT:
 *   • `Identifier` — `x;` throws ReferenceError when `x` is undeclared, and a
 *     TDZ ReferenceError for a `let`/`const` read before initialisation.
 *   • `ObjectLiteralExpression` / `ArrayLiteralExpression` — a computed key
 *     (`{[k()]: 1}`), a spread (`{...o}` invokes getters) or an element
 *     (`[f()]`) all run user code.
 *   • `ClassExpression` — a `static { … }` block runs at class-definition time.
 *   • `TypeOfExpression` — `typeof x` throws on a TDZ binding.
 *   • `TaggedTemplateExpression` — calls the tag function.
 */
const INERT_KINDS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.NumericLiteral, "a numeric literal evaluates to itself; no user code runs"],
  [ts.SyntaxKind.BigIntLiteral, "a BigInt literal evaluates to itself; no user code runs"],
  [ts.SyntaxKind.StringLiteral, "a string literal evaluates to itself; no user code runs"],
  [ts.SyntaxKind.NoSubstitutionTemplateLiteral, "a template with no substitutions evaluates no expressions"],
  [ts.SyntaxKind.RegularExpressionLiteral, "constructs a RegExp; no user code runs"],
  [ts.SyntaxKind.NullKeyword, "the null literal; no user code runs"],
  [ts.SyntaxKind.TrueKeyword, "a boolean literal; no user code runs"],
  [ts.SyntaxKind.FalseKeyword, "a boolean literal; no user code runs"],
  [ts.SyntaxKind.ThisKeyword, "`this` resolution cannot throw or run user code at module top level"],
  [ts.SyntaxKind.FunctionExpression, "creating a closure runs no body"],
  [ts.SyntaxKind.ArrowFunction, "creating a closure runs no body"],
]);

/** Assignment operators — every one performs an observable PutValue. */
const ASSIGNMENT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return ASSIGNMENT_OPERATORS.has(kind);
}

/** Strip parens / casts / non-null assertions from an assignment target. */
function unwrapTarget(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * (#3956) True when a TOP-LEVEL assignment target creates a property on the
 * realm's global object — the eighth and ninth shapes this allow-list dropped
 * silently. `collectDeclarations`' terminal arm only recognises a root
 * identifier of `globalThis` or a module global, so both of these fell off the
 * end and emitted NO CODE AT ALL:
 *
 *   this.p1 = 1;   §9.4.2 — at script top level `this` IS the global object,
 *                  but the root unwraps to a ThisKeyword, which is not an
 *                  Identifier, so the root-name lookup returned undefined.
 *   p1 = 1;        §6.2.5.6 PutValue on an unresolvable reference in sloppy
 *                  code creates a configurable global-object property, but a
 *                  bare undeclared identifier is not a module global.
 *
 * The read side was already correct for the second form — the pre-scan put
 * `p1` in `sloppyImplicitGlobals`, so the read emitted its `__hasOwnProperty`
 * guard against a global object the dropped write never populated. That
 * asymmetry produced the whole `ReferenceError: p1 is not defined` cluster.
 * Both assignments have always worked INSIDE a function body; only the
 * top-level collection dropped them.
 *
 * `sloppyImplicitGlobals` is the `recordSloppyImplicitGlobalNames` pre-scan
 * set, which admits only non-strict, genuinely unresolvable bare-identifier
 * `=` targets — so strict code, where the same assignment must throw a
 * ReferenceError rather than create a global, is excluded by construction.
 */
export function createsGlobalObjectBinding(
  target: ts.Expression,
  sloppyImplicitGlobals: ReadonlySet<string> | undefined,
): boolean {
  const lhs = unwrapTarget(target);
  if (ts.isIdentifier(lhs)) return sloppyImplicitGlobals?.has(lhs.text) === true;
  // A `this`-rooted member chain: require at least one member step (`this = v`
  // is not a valid target) and walk to the root the same way the caller's
  // root-identifier helper does.
  if (!ts.isPropertyAccessExpression(lhs) && !ts.isElementAccessExpression(lhs)) return false;
  let cur: ts.Expression = lhs;
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = unwrapTarget(cur.expression);
  }
  return cur.kind === ts.SyntaxKind.ThisKeyword;
}

/**
 * (#4433) Does evaluating this expression PROVABLY run user code or mutate
 * state? — the predicate that turns the `unhandled` disposition from "recorded
 * and dropped" into "collected into `__module_init`".
 *
 * The allow-list above names WHOLE-STATEMENT shapes, so a composition like
 * `f() + g();`, `f() instanceof Object;`, `f(), g();` or `[f(), g()];` matched
 * nothing and was dropped **whole** — neither operand evaluated. The identical
 * statement inside a function body has always compiled its operands and
 * `drop`ped the result, which is what makes this a collection gap rather than a
 * lowering gap.
 *
 * The rule is deliberately one-directional: it only ever ADDS statements, and
 * only when an effectful node is actually present in the tree. It answers false
 * for the shapes whose observability is a *runtime* fact this compiler does not
 * model — a bare `Identifier` (a ReferenceError for an undeclared binding, a TDZ
 * error for a `let`/`const` read) and the `PrivateIdentifier` / `MetaProperty`
 * atoms of negative *syntax* fixtures. Collecting those would convert ~18k
 * currently-silent statements in test262's negative corpus into compile errors,
 * which is a worse trade than an honest residual; they stay in
 * `ctx.droppedModuleInitShapes`.
 *
 * Function and arrow BODIES are not descended into: creating a closure runs no
 * body, so `(function () { f(); });` is genuinely inert. Everything reachable
 * without invoking a closure is descended — including computed keys, spreads,
 * template substitutions, `extends` clauses and class `static { … }` blocks.
 *
 * Two node kinds are deliberately NOT effectful here, both on measurement
 * rather than principle — each is a residual recorded in the issue file:
 *
 *   • `AwaitExpression` / `YieldExpression`. A CALL inside one still counts, via
 *     the CallExpression node; the bare `await x;` form does not.
 *   • `TaggedTemplateExpression`, which really does invoke its tag. Over the
 *     whole `test/language` + `test/built-ins` corpus, collecting it changed
 *     the status of ZERO of the 77 top-level tagged-template statements — and
 *     cost three files. The test262 runner compiles a `top-level-await` body
 *     SYNCHRONOUSLY (#1612), so `await` parses as an ordinary identifier and
 *     ``await `` ;`` becomes a TaggedTemplateExpression tagged `await`.
 *     Collecting that compiles a call to a binding that does not exist.
 *
 * Both should be revisited — the second once TLA is compiled asynchronously, at
 * which point the misparse disappears and the tag call becomes a real one.
 */
export function expressionRunsUserCode(rawExpr: ts.Expression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // Creating a closure runs no body — do not descend. (A CALL to the closure
    // is a CallExpression node OUTSIDE the body and is still seen.)
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node)) return;
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isDeleteExpression(node) ||
      // A property/element READ invokes an accessor and throws on a nullish
      // base — the #3615 keep, applied to a nested position.
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isSpreadElement(node) ||
      ts.isSpreadAssignment(node) ||
      // `++`/`--` perform a PutValue.
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(unwrapStatementExpression(rawExpr));
  return found;
}

/**
 * TOTAL classification of a top-level ExpressionStatement's expression.
 *
 * The caller (`collectDeclarations`) keeps its existing, richer handling for
 * the `keep` shapes — in particular assignments, whose collection depends on
 * the assignment TARGET, not just the operator. This function's contract is the
 * DEFAULT: nothing reaches a silent drop.
 */
export function classifyTopLevelExpressionStatement(rawExpr: ts.Expression): ModuleInitClassification {
  const expr = unwrapStatementExpression(rawExpr);
  const shape = ts.SyntaxKind[expr.kind] ?? String(expr.kind);

  // ── Observable shapes the collector already handles ─────────────────────
  if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
    return { disposition: "keep", shape, reason: "invokes a function" };
  }
  if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) {
    return { disposition: "keep", shape, reason: "++/-- performs a PutValue" };
  }
  if (ts.isDeleteExpression(expr)) {
    return { disposition: "keep", shape, reason: "#2992 — delete mutates the object" };
  }
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    return { disposition: "keep", shape, reason: "#3615 — GetValue invokes an accessor and throws on a nullish base" };
  }
  if (ts.isBinaryExpression(expr) && isAssignmentOperator(expr.operatorToken.kind)) {
    return {
      disposition: "keep",
      shape: `${shape}(${ts.SyntaxKind[expr.operatorToken.kind]})`,
      reason: "performs a PutValue",
    };
  }

  // ── The explicit inert deny-list ────────────────────────────────────────
  const inertReason = INERT_KINDS.get(expr.kind);
  if (inertReason) return { disposition: "inert", shape, reason: inertReason };

  // ── Everything else is LOUD, not silent ─────────────────────────────────
  // This is the whole point of the module. A shape nobody anticipated arrives
  // here and announces itself instead of becoming the next silent wrong answer.
  const detail = ts.isBinaryExpression(expr) ? `${shape}(${ts.SyntaxKind[expr.operatorToken.kind]})` : shape;
  return {
    disposition: "unhandled",
    shape: detail,
    reason:
      "not provably inert and not collected into __module_init — its evaluation may run user code, throw, or mutate state",
  };
}

/** The subset of `CodegenContext` this module's collection decision touches. */
export interface ModuleInitCollectionSink {
  moduleInitStatements: ts.Statement[];
  droppedModuleInitShapes?: Map<string, number>;
}

/**
 * (#4433) The single exit for a top-level ExpressionStatement that
 * `collectDeclarations`' allow-list did NOT name. Two call sites reach it: the
 * non-assignment `BinaryExpression` early-`continue`, and the terminal
 * fall-through.
 *
 * Before this, both merely RECORDED the drop (#3623 telemetry) and the statement
 * was eliminated whole — `f() + g();`, `f() instanceof Object;`, `f(), g();`,
 * `[f(), g()];` evaluated NEITHER operand, so the calls, the getters and the
 * operator's own TypeError all vanished. The identical statement inside a
 * function body has always compiled its operands and `drop`ped the result.
 *
 * Now a statement that PROVABLY runs user code is collected and lowered by that
 * same ordinary compile-then-`drop` path. Statements that are not provably
 * effectful keep the previous behaviour and stay recorded — see
 * `expressionRunsUserCode` for why the bare-atom shapes are excluded.
 */
export function collectOrRecordUnnamedExpressionStatement(
  sink: ModuleInitCollectionSink,
  stmt: ts.ExpressionStatement,
): void {
  if (sink.moduleInitStatements.includes(stmt)) return;
  const c = classifyTopLevelExpressionStatement(stmt.expression);
  if (c.disposition !== "unhandled") return;
  if (expressionRunsUserCode(stmt.expression)) {
    sink.moduleInitStatements.push(stmt);
    return;
  }
  (sink.droppedModuleInitShapes ??= new Map()).set(c.shape, (sink.droppedModuleInitShapes.get(c.shape) ?? 0) + 1);
}
