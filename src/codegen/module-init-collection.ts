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

/**
 * Test262 top-level-await bodies are currently compiled synchronously (#1612).
 * In that parse mode, a source-level `await` followed by a template literal is
 * represented as a tagged-template call whose tag is the identifier `await`.
 * It is parser recovery, not a call to a user binding, and compiling it traps
 * while building the QuickJS eval provider.
 */
export function isSynchronousTopLevelAwaitRecovery(expr: ts.Expression): boolean {
  return ts.isTaggedTemplateExpression(expr) && ts.isIdentifier(expr.tag) && expr.tag.text === "await";
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
 * One node kind is deliberately NOT effectful here, on measurement rather than
 * principle — it remains a residual recorded in the issue file:
 *
 *   • `AwaitExpression` / `YieldExpression`. A CALL inside one still counts, via
 *     the CallExpression node; the bare `await x;` form does not.
 * Tagged templates invoke user code and are retained by the collector,
 * including when the tag is an inline function expression and the result is
 * discarded. The sole exception is the synchronous top-level-await recovery
 * shape described by `isSynchronousTopLevelAwaitRecovery`.
 */
/**
 * (#5270 step 8) Binary operators whose evaluation reaches ToPrimitive
 * (§7.1.1) and can therefore run a user `valueOf` / `toString` /
 * `@@toPrimitive` method. `===`/`!==` are absent on purpose: strict equality
 * never coerces. So are `&&`/`||`/`??`/`,` (no coercion of their own) and the
 * bitwise/shift operators, which reach ToNumeric on an object — those are a
 * larger surface and no row in this wave needs them.
 *
 * `==`/`!=` are here but are NOT sufficient on their own — see
 * `looseEqualityCoercesAnOperand`, which the caller ANDs in (#5270 review R3-F1).
 */
function binaryOperatorReachesToPrimitive(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.PlusToken:
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.PercentToken:
    case ts.SyntaxKind.AsteriskAsteriskToken:
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return true;
    default:
      return false;
  }
}

/**
 * (#5270 review R3-F1) §7.2.15 IsLooselyEqual performs NO coercion when BOTH
 * operands are Objects — it compares references and returns. This compiler's
 * `==` lowering calls ToPrimitive on both regardless (a PRE-EXISTING defect:
 * base coerces too once the same statement is wrapped in `if (true) { … }`), so
 * retaining a bare `objA == objB;` statement newly EXPOSED it — with a poisoned
 * `valueOf` the throw killed `__module_init` and every later top-level statement
 * where base ran on. Same shape for `null`/`undefined`, which §7.2.15 answers
 * without coercing either.
 *
 * So a bare loose-equality statement is retained only when one operand is a
 * LITERAL non-nullish primitive — the `0 == y;` shape the wave actually needs
 * (`expressions/equals/coerce-symbol-to-prim-invocation`), where ToPrimitive on
 * the object operand is exactly what the spec requires. Everything else keeps
 * base's drop. `statements.ts` carries the identical guard for the lowering
 * half; the two must agree or the statement is retained and then compiled on a
 * carrier that never coerces.
 *
 * Remove this guard only when the loose-equality lowering itself grows
 * §7.2.15's Object-vs-Object early exit — tracked in the R3-F1 follow-up note
 * in plan/issues/5270-es2015-standalone-expressions-r2.md.
 */
export function looseEqualityCoercesAnOperand(expr: ts.BinaryExpression): boolean {
  const kind = expr.operatorToken.kind;
  if (kind !== ts.SyntaxKind.EqualsEqualsToken && kind !== ts.SyntaxKind.ExclamationEqualsToken) return true;
  return isNonNullishPrimitiveLiteral(expr.left) || isNonNullishPrimitiveLiteral(expr.right);
}

/** Syntactically a primitive that is neither `null` nor `undefined`. */
function isNonNullishPrimitiveLiteral(operand: ts.Expression): boolean {
  switch (operand.kind) {
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.TypeOfExpression:
      return true;
    default:
      return false;
  }
}

/**
 * (#5270 step 8) SYNTACTIC "this operand is not provably a primitive". Used
 * only to keep `1 + 2;`-shaped statements on their existing drop; this module
 * runs before any type information is available, so anything that is not a
 * literal primitive counts as possibly-object.
 */
function operandMayBeObject(operand: ts.Expression): boolean {
  switch (operand.kind) {
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return false;
    case ts.SyntaxKind.TypeOfExpression:
    case ts.SyntaxKind.VoidExpression:
      return false;
    default:
      return true;
  }
}

export function expressionRunsUserCode(rawExpr: ts.Expression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // Creating a closure runs no body — do not descend. (A CALL to the closure
    // is a CallExpression node OUTSIDE the body and is still seen.)
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node)) return;
    if (ts.isTaggedTemplateExpression(node)) {
      if (!isSynchronousTopLevelAwaitRecovery(node)) found = true;
      return;
    }
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
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) ||
      // (#5140) `in` / `instanceof` are METHOD-INVOKING relational operators, not
      // inert comparisons: `k in proxy` runs the Proxy `has` trap (§10.5.7) and
      // `v instanceof C` runs `C[Symbol.hasInstance]` (§7.3.20). A bare
      // `"attr" in p;` statement therefore observably runs user code, and
      // dropping it made every `Proxy/has/call-*` test a vacuous pass.
      (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.InKeyword ||
          node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)) ||
      // (#5270 step 8) The SAME argument for the ToPrimitive-reaching
      // operators. `left + right;` and `0 == y;` run `valueOf` / `toString` /
      // `@@toPrimitive` on any object operand (§7.1.1), so a bare statement of
      // that shape is observable — measured on HEAD, both were dropped whole
      // and the two `coerce-symbol-to-prim-invocation` rows counted ZERO
      // invocations. Restricted to operands that are not SYNTACTICALLY
      // primitive, so `1 + 2;` keeps its previous drop.
      (ts.isBinaryExpression(node) &&
        binaryOperatorReachesToPrimitive(node.operatorToken.kind) &&
        looseEqualityCoercesAnOperand(node) &&
        (operandMayBeObject(node.left) || operandMayBeObject(node.right)))
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
  if (ts.isTaggedTemplateExpression(expr)) {
    if (isSynchronousTopLevelAwaitRecovery(expr)) {
      return {
        disposition: "unhandled",
        shape,
        reason: "not provably inert: synchronous top-level-await parse recovery is not a tag call",
      };
    }
    return { disposition: "keep", shape, reason: "invokes the tagged function" };
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
