// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster A, slice A5) A `yield` nested inside a COMPUTED PROPERTY NAME —
 * `{ [yield 9]: 9 }`, `class { get [yield]() {} }` — and, inside the same
 * generators, a yield nested in call arguments or a member-assignment target
 * (`assert.sameValue(o[yield 9], 9)`, `c[yield 9] = 9`).
 *
 * WHY. The #680 continuation (`generators-native.ts`) already defers a statement
 * past its suspensions: the successor state recompiles the ORIGINAL statement
 * with each yield read from its resume spill (the replacement map), and every
 * value the spec evaluates BEFORE the yield is captured into a spill first. It
 * proves that order per SYNTACTIC ROOT (an array / object literal, a comma, a
 * binary, a template), and none of its roots admits a computed key, a class, or
 * a call. This module makes the same order proof per STATEMENT instead: the
 * statement is walked in spec evaluation order into EVENTS —
 *
 *   - `yield`  a suspension (non-delegating, yield-free operand);
 *   - `value`  a yield-free operand, evaluated as a whole where it stands;
 *   - `fn`     a closure creation (a method / accessor / function value);
 *   - `callee` a yield-free call / `new` target;
 *   - `op`     an observable operation whose operands hold a yield (a Get, a
 *              call, a PutValue, ToNumber, a spread, a heritage lookup, …).
 *
 * — and the statement may be deferred only when every event BEFORE ITS LAST
 * YIELD is one the successor can reproduce: a yield (it suspends there, in
 * order); a REPLAYABLE value (a literal, `this`, a closure, or a binding of this
 * generator that no closure mentions and the statement does not write — it
 * cannot change while suspended, so reading it later reads the same value); or
 * a value CAPTURED once into a spill through the existing
 * `captureContinuationOperand`. An `op` before the last yield refuses: its
 * effect would move across a resume boundary. Events after the last yield run
 * in the successor exactly where the spec puts them.
 *
 * The walk orders are the spec's: §13.2.5.5 key then value for object literals;
 * §15.7.14 heritage, then each element's computed key in element order, for
 * classes; callee then arguments (§13.3.6.1); base, key, then RHS for a member
 * assignment (§13.15.2 step 1.a).
 *
 * Two approximations, both documented where they are taken:
 *   - a CALLEE before a yield cannot be captured without losing its `this`, so
 *     it is replayed when it is a module-scope function / class declaration, an
 *     ambient library global, or `<such>.name` — observable only if the caller
 *     rebinds that name or rewrites that property while the generator is
 *     suspended. Any other callee refuses.
 *   - ToPropertyKey of a computed key runs in the successor, after the later
 *     keys' suspensions. It is observable only when the key is an object whose
 *     `toString` / `valueOf` / `@@toPrimitive` has a side effect.
 *
 * A class FIELD keyed by a yield refuses on purpose: the class lowering skips
 * runtime-keyed fields ("dynamic computed name — skip"), so admitting one would
 * trade the loud #680 refusal for a class silently missing the field (measured
 * on the four `cpn-class-*-fields-*` rows).
 *
 * SCOPE — only generators whose body holds a yield inside a computed property
 * name are touched (`bodyHasComputedKeyYield`, standalone / WASI only); every
 * one of them was a #680 refusal before, and they move to the boxed-any carrier
 * because the resumed value becomes a KEY (`iter.next('first')` names an
 * accessor). Every other generator compiles byte-identically.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { isFunctionLikeScope, nodeContainsYield } from "./generators-native-ast-scan.js";

/** A source node the successor state reads from a spill instead of re-evaluating. */
export type NestedYieldReplacement =
  | { kind: "yield"; expression: ts.YieldExpression; spillName: string }
  | { kind: "operand"; expression: ts.Expression; spillName: string };

/** The planner's view of `buildNativeGeneratorPlan`'s state cursor. */
export interface NestedYieldHost<U> {
  /** Suspend at `yieldExpr`; the resumed value lands in the returned spill (null = refuse). */
  suspend(yieldExpr: ts.YieldExpression, unwind: readonly U[]): string | null;
  /** True when `expr` can be evaluated once, now, into a typed spill. */
  canCapture(expr: ts.Expression): boolean;
  /** Evaluate `expr` once in the current state, into a spill (null = refuse). */
  capture(expr: ts.Expression): string | null;
  /** Append `stmt` to the current state, reading every replaced node from its spill. */
  finish(stmt: ts.Statement, replacements: readonly NestedYieldReplacement[]): boolean;
}

export type NestedYieldAttempt = "lowered" | "not-applicable" | "failed";

type NestedEvent =
  | { kind: "yield"; node: ts.YieldExpression }
  | { kind: "value"; node: ts.Expression; shorthand: boolean }
  | { kind: "fn" }
  | { kind: "callee"; node: ts.Expression }
  | { kind: "op" };

/** `expr` is, or holds, a yield of THIS function (computed names included). */
function holdsYield(node: ts.Node): boolean {
  return ts.isYieldExpression(node) || nodeContainsYield(node);
}

function skipOuterExpressions(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * The generator-level gate: the body (outside nested function scopes) holds a
 * yield inside a computed property name — of an object-literal member, a class
 * element, or a method / accessor whose NAME is evaluated here even though its
 * body is a scope of its own.
 */
export function bodyHasComputedKeyYield(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isComputedPropertyName(node)) {
      if (holdsYield(node.expression)) found = true;
      return;
    }
    if (isFunctionLikeScope(node)) {
      const name = (node as { name?: ts.PropertyName }).name;
      if (name !== undefined && ts.isComputedPropertyName(name)) visit(name);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/** Every yield of THIS function in `root`, in source order (computed names included). */
function collectYields(root: ts.Node): ts.YieldExpression[] {
  const out: ts.YieldExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isYieldExpression(node)) {
      out.push(node);
      if (node.expression) visit(node.expression);
      return;
    }
    if (isFunctionLikeScope(node)) {
      const name = (node as { name?: ts.PropertyName }).name;
      if (name !== undefined && ts.isComputedPropertyName(name)) visit(name);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** Walks one statement into spec-ordered events. `failed` = a shape it does not model. */
class EvaluationOrderWalk {
  readonly events: NestedEvent[] = [];
  failed = false;

  private push(event: NestedEvent): void {
    this.events.push(event);
  }

  expression(expr: ts.Expression): void {
    if (this.failed) return;
    if (!holdsYield(expr)) {
      this.push({ kind: "value", node: expr, shorthand: false });
      return;
    }
    const e = skipOuterExpressions(expr);
    if (ts.isYieldExpression(e)) {
      if (e.asteriskToken || (e.expression !== undefined && holdsYield(e.expression))) this.failed = true;
      else this.push({ kind: "yield", node: e });
      return;
    }
    if (ts.isObjectLiteralExpression(e)) {
      this.objectLiteral(e);
      return;
    }
    if (ts.isArrayLiteralExpression(e)) {
      for (const element of e.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (ts.isSpreadElement(element)) {
          // The spread's iteration is observable.
          this.expression(element.expression);
          this.push({ kind: "op" });
        } else {
          this.expression(element);
        }
      }
      return;
    }
    if (ts.isClassExpression(e)) {
      this.classLike(e);
      return;
    }
    if (ts.isCallExpression(e)) {
      this.call(e);
      return;
    }
    if (ts.isNewExpression(e)) {
      if (holdsYield(e.expression)) {
        this.failed = true;
        return;
      }
      this.push({ kind: "callee", node: e.expression });
      this.arguments(e.arguments ?? []);
      this.push({ kind: "op" });
      return;
    }
    if (ts.isElementAccessExpression(e) || ts.isPropertyAccessExpression(e)) {
      if (!this.memberReference(e)) return;
      this.push({ kind: "op" }); // the [[Get]]
      return;
    }
    if (ts.isBinaryExpression(e)) {
      this.binary(e);
      return;
    }
    if (ts.isConditionalExpression(e)) {
      // Only the test is unconditional; a yield in a branch is a conditional suspension.
      if (holdsYield(e.whenTrue) || holdsYield(e.whenFalse)) {
        this.failed = true;
        return;
      }
      this.expression(e.condition);
      this.push({ kind: "op" }); // the branch evaluated after the test
      return;
    }
    if (ts.isPrefixUnaryExpression(e)) {
      if (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken) {
        this.failed = true;
        return;
      }
      this.expression(e.operand);
      // `!` is ToBoolean, which never runs user code; `+` / `-` / `~` call valueOf.
      if (e.operator !== ts.SyntaxKind.ExclamationToken) this.push({ kind: "op" });
      return;
    }
    if (ts.isTypeOfExpression(e) || ts.isVoidExpression(e)) {
      this.expression(e.expression);
      return;
    }
    if (ts.isTemplateExpression(e)) {
      for (const span of e.templateSpans) {
        this.expression(span.expression);
        this.push({ kind: "op" }); // ToString of the substitution
      }
      return;
    }
    this.failed = true;
  }

  /** §13.2.5.5: each member's key, then its value, in source order. */
  private objectLiteral(e: ts.ObjectLiteralExpression): void {
    for (const property of e.properties) {
      if (this.failed) return;
      if (ts.isPropertyAssignment(property)) {
        if (ts.isComputedPropertyName(property.name)) this.expression(property.name.expression);
        this.expression(property.initializer);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        this.push({ kind: "value", node: property.name, shorthand: true });
      } else if (
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      ) {
        if (ts.isComputedPropertyName(property.name)) this.expression(property.name.expression);
        this.push({ kind: "fn" });
      } else if (ts.isSpreadAssignment(property)) {
        this.expression(property.expression);
        this.push({ kind: "op" }); // CopyDataProperties runs getters
      } else {
        this.failed = true;
      }
    }
  }

  /**
   * §15.7.14 ClassDefinitionEvaluation: the heritage (and its `prototype` Get),
   * then each ClassElement's computed key in element order. Field initializers,
   * static blocks and static field initializers run after every key — i.e. after
   * the last yield a key can hold — so they are not events here.
   */
  classLike(cls: ts.ClassLikeDeclaration): void {
    if (ts.canHaveDecorators(cls) && (ts.getDecorators(cls)?.length ?? 0) > 0) {
      this.failed = true;
      return;
    }
    for (const clause of cls.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      const superclass = clause.types[0]?.expression;
      if (superclass === undefined) continue;
      this.expression(superclass);
      this.push({ kind: "op" }); // Get(superclass, "prototype")
    }
    for (const member of cls.members) {
      if (this.failed) return;
      if (ts.canHaveDecorators(member) && (ts.getDecorators(member)?.length ?? 0) > 0) {
        this.failed = true;
        return;
      }
      const name = (member as { name?: ts.PropertyName }).name;
      const computed = name !== undefined && ts.isComputedPropertyName(name) ? name.expression : undefined;
      if (ts.isPropertyDeclaration(member)) {
        // A yield-keyed FIELD: the class lowering skips runtime-keyed fields, so
        // admitting it would drop the field silently — refused (see header).
        if (computed !== undefined && holdsYield(computed)) {
          this.failed = true;
          return;
        }
        if (computed !== undefined) this.expression(computed);
        continue;
      }
      if (
        ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)
      ) {
        if (computed !== undefined) this.expression(computed);
        this.push({ kind: "fn" });
        continue;
      }
      if (
        ts.isConstructorDeclaration(member) ||
        ts.isClassStaticBlockDeclaration(member) ||
        ts.isSemicolonClassElement(member) ||
        ts.isIndexSignatureDeclaration(member)
      ) {
        continue;
      }
      this.failed = true;
    }
  }

  /** §13.3.6.1: the callee Reference (and its Get), the arguments, then the call. */
  private call(e: ts.CallExpression): void {
    if (e.questionDotToken || e.expression.kind === ts.SyntaxKind.SuperKeyword) {
      this.failed = true;
      return;
    }
    const callee = skipOuterExpressions(e.expression);
    if (!holdsYield(callee)) {
      this.push({ kind: "callee", node: callee });
    } else if (ts.isElementAccessExpression(callee) || ts.isPropertyAccessExpression(callee)) {
      if (!this.memberReference(callee)) return;
      this.push({ kind: "op" }); // the method Get
    } else {
      this.failed = true;
      return;
    }
    this.arguments(e.arguments);
    this.push({ kind: "op" }); // the call
  }

  private arguments(args: readonly ts.Expression[]): void {
    for (const arg of args) {
      if (this.failed) return;
      if (ts.isSpreadElement(arg)) {
        this.expression(arg.expression);
        this.push({ kind: "op" });
      } else {
        this.expression(arg);
      }
    }
  }

  /** A member Reference: its base, then (for `[]`) its key. False = refused. */
  private memberReference(e: ts.ElementAccessExpression | ts.PropertyAccessExpression): boolean {
    if (e.questionDotToken || e.expression.kind === ts.SyntaxKind.SuperKeyword) {
      this.failed = true;
      return false;
    }
    if (ts.isPropertyAccessExpression(e) && ts.isPrivateIdentifier(e.name)) {
      this.failed = true;
      return false;
    }
    this.expression(e.expression);
    if (ts.isElementAccessExpression(e)) this.expression(e.argumentExpression);
    return !this.failed;
  }

  private binary(e: ts.BinaryExpression): void {
    const kind = e.operatorToken.kind;
    if (kind === ts.SyntaxKind.EqualsToken) {
      // §13.15.2: a member target's Reference (base, key) precedes the RHS; an
      // identifier target resolves unobservably; a pattern target is evaluated
      // after the RHS (A4 owns a yield inside one).
      const left = skipOuterExpressions(e.left);
      if (ts.isElementAccessExpression(left) || ts.isPropertyAccessExpression(left)) {
        if (!this.memberReference(left)) return;
      } else if (ts.isIdentifier(left)) {
        // no event
      } else if (ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left)) {
        if (holdsYield(left)) {
          this.failed = true;
          return;
        }
      } else {
        this.failed = true;
        return;
      }
      this.expression(e.right);
      this.push({ kind: "op" }); // PutValue
      return;
    }
    if (kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment) {
      // A compound assignment reads its target BEFORE the RHS; not modeled.
      this.failed = true;
      return;
    }
    if (kind === ts.SyntaxKind.CommaToken) {
      this.expression(e.left);
      this.expression(e.right);
      return;
    }
    if (
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      if (holdsYield(e.right)) {
        this.failed = true;
        return;
      }
      this.expression(e.left);
      this.push({ kind: "op" }); // the conditionally evaluated right operand
      return;
    }
    this.expression(e.left);
    this.expression(e.right);
    // Strict (in)equality never runs user code; every other operator can.
    if (kind !== ts.SyntaxKind.EqualsEqualsEqualsToken && kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      this.push({ kind: "op" });
    }
  }
}

/** Replay / write facts about the generator the statement belongs to. */
class ReplayFacts {
  private readonly closureNames = new Set<string>();
  private readonly mentionsArguments: boolean;

  constructor(
    private readonly ctx: CodegenContext,
    private readonly decl: ts.SignatureDeclaration & { body?: ts.Node },
    private readonly stmt: ts.Statement,
  ) {
    let usesArguments = false;
    // Every identifier text a nested closure (or a class field initializer,
    // which is one) mentions: such a binding can change while suspended.
    const inClosure = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) this.closureNames.add(node.text);
      ts.forEachChild(node, inClosure);
    };
    const scan = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "arguments") usesArguments = true;
      if (isFunctionLikeScope(node) || (ts.isPropertyDeclaration(node) && node.initializer !== undefined)) {
        inClosure(node);
        return;
      }
      ts.forEachChild(node, scan);
    };
    if (decl.body) scan(decl.body);
    this.mentionsArguments = usesArguments;
  }

  /** The statement assigns, updates or declares `name` (text match — conservative). */
  private statementWrites(name: string): boolean {
    let found = false;
    const isName = (n: ts.Node): boolean => {
      const inner = ts.isExpression(n) ? skipOuterExpressions(n) : n;
      return ts.isIdentifier(inner) && inner.text === name;
    };
    const patternBinds = (n: ts.Node): boolean => {
      let hit = false;
      const v = (c: ts.Node): void => {
        if (hit) return;
        if (ts.isIdentifier(c) && c.text === name) hit = true;
        else ts.forEachChild(c, v);
      };
      v(n);
      return hit;
    };
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = skipOuterExpressions(node.left);
        if (
          isName(left) ||
          ((ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left)) && patternBinds(left))
        ) {
          found = true;
          return;
        }
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        isName(node.operand)
      ) {
        found = true;
        return;
      }
      if ((ts.isVariableDeclaration(node) || ts.isClassDeclaration(node)) && node.name && patternBinds(node.name)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(this.stmt);
    return found;
  }

  /** The innermost function-like node enclosing `node` (itself excluded). */
  private static enclosingFunction(node: ts.Node): ts.Node | undefined {
    let cur = node.parent;
    while (cur !== undefined && !ts.isSourceFile(cur)) {
      if (isFunctionLikeScope(cur)) return cur;
      cur = cur.parent;
    }
    return undefined;
  }

  /**
   * A binding of THIS generator that cannot change while it is suspended: a
   * parameter or a body declaration no closure mentions, which the statement
   * itself does not write. Reading it after the resume reads the same value.
   */
  binding(id: ts.Identifier): boolean {
    const declaration = this.ctx.oracle.valueDeclarationOf(id);
    if (declaration === undefined) return false;
    if (ts.isParameter(declaration)) {
      // A sloppy simple-parameter list aliases `arguments`.
      if (declaration.parent !== this.decl || this.mentionsArguments || !ts.isIdentifier(declaration.name))
        return false;
    } else if (
      ts.isVariableDeclaration(declaration) ||
      ts.isClassDeclaration(declaration) ||
      ts.isFunctionDeclaration(declaration)
    ) {
      if (ReplayFacts.enclosingFunction(declaration) !== this.decl) return false;
    } else {
      return false;
    }
    if (this.closureNames.has(id.text)) return false;
    return !this.statementWrites(id.text);
  }

  /** A yield-free operand whose evaluation may move past a resume unobservably. */
  value(expr: ts.Expression): boolean {
    const e = skipOuterExpressions(expr);
    switch (e.kind) {
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.BigIntLiteral:
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
      case ts.SyntaxKind.NullKeyword:
      case ts.SyntaxKind.ThisKeyword:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
        return true;
    }
    if (!ts.isIdentifier(e)) return false;
    if (e.text === "undefined") return this.ambientOnly(e);
    return this.binding(e);
  }

  /** Only library (declaration-file) declarations: an ambient global like `String`. */
  private ambientOnly(id: ts.Identifier): boolean {
    const declarations = this.ctx.oracle.declarationsOf(id);
    return declarations.every((d) => d.getSourceFile().isDeclarationFile);
  }

  /**
   * A callee replayed after the resume (the documented approximation — see the
   * module header): a module-scope function / class declaration, an ambient
   * library global, a replayable generator binding, or `<such>.name`.
   */
  callee(expr: ts.Expression): boolean {
    const e = skipOuterExpressions(expr);
    if (ts.isPropertyAccessExpression(e)) {
      if (e.questionDotToken || !ts.isIdentifier(e.name)) return false;
      const base = skipOuterExpressions(e.expression);
      return ts.isIdentifier(base) && this.moduleScopeOrAmbient(base);
    }
    if (!ts.isIdentifier(e)) return false;
    return this.binding(e) || this.moduleScopeOrAmbient(e);
  }

  private moduleScopeOrAmbient(id: ts.Identifier): boolean {
    const declarations = this.ctx.oracle.declarationsOf(id);
    if (declarations.length === 0) return false;
    if (declarations.every((d) => d.getSourceFile().isDeclarationFile)) return true;
    return declarations.every(
      (d) =>
        (ts.isFunctionDeclaration(d) || ts.isClassDeclaration(d)) &&
        d.parent !== undefined &&
        ts.isSourceFile(d.parent),
    );
  }
}

/**
 * Plan one statement holding nested yields: suspend at each yield in spec
 * order, capture what must be evaluated before a later yield, and defer the
 * statement itself to the state after its last suspension.
 */
export function lowerNestedYieldStatement<U>(
  ctx: CodegenContext,
  decl: ts.SignatureDeclaration & { body?: ts.Node },
  host: NestedYieldHost<U>,
  stmt: ts.Statement,
  unwind: readonly U[],
): NestedYieldAttempt {
  const walk = new EvaluationOrderWalk();
  if (ts.isExpressionStatement(stmt)) {
    walk.expression(stmt.expression);
  } else if (ts.isVariableStatement(stmt)) {
    if (stmt.declarationList.declarations.length !== 1) return "not-applicable";
    const declarator = stmt.declarationList.declarations[0]!;
    if (!ts.isIdentifier(declarator.name) || !declarator.initializer) return "not-applicable";
    walk.expression(declarator.initializer);
  } else if (ts.isClassDeclaration(stmt)) {
    walk.classLike(stmt);
  } else {
    return "not-applicable";
  }
  if (walk.failed) return "not-applicable";

  const yields = walk.events.filter((e): e is Extract<NestedEvent, { kind: "yield" }> => e.kind === "yield");
  // Every yield of the statement must be one the walk ordered — none hidden in a
  // shape it passed over as opaque.
  const all = collectYields(stmt);
  if (yields.length === 0 || all.length !== yields.length || all.some((y, i) => y !== yields[i]!.node)) {
    return "not-applicable";
  }

  let lastYield = -1;
  for (let i = 0; i < walk.events.length; i++) if (walk.events[i]!.kind === "yield") lastYield = i;

  const facts = new ReplayFacts(ctx, decl, stmt);
  const captureAt = new Set<number>();
  for (let i = 0; i < lastYield; i++) {
    const event = walk.events[i]!;
    switch (event.kind) {
      case "yield":
      case "fn":
        break;
      case "value":
        if (facts.value(event.node)) break;
        // A shorthand member reads its binding by NAME, not through the
        // expression compiler, so a spill could not stand in for it.
        if (event.shorthand || !host.canCapture(event.node)) return "not-applicable";
        captureAt.add(i);
        break;
      case "callee":
        if (!facts.callee(event.node)) return "not-applicable";
        break;
      case "op":
        return "not-applicable";
    }
  }

  // Emission: side effects on the host's state cursor start here.
  const replacements: NestedYieldReplacement[] = [];
  for (let i = 0; i <= lastYield; i++) {
    const event = walk.events[i]!;
    if (event.kind === "yield") {
      const sent = host.suspend(event.node, unwind);
      if (sent === null) return "failed";
      replacements.push({ kind: "yield", expression: event.node, spillName: sent });
    } else if (captureAt.has(i) && event.kind === "value") {
      const spill = host.capture(event.node);
      if (spill === null) return "failed";
      replacements.push({ kind: "operand", expression: event.node, spillName: spill });
    }
  }
  return host.finish(stmt, replacements) ? "lowered" : "failed";
}
