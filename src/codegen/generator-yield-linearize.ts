// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster A, slice A4) A `yield` nested inside a destructuring-ASSIGNMENT
 * pattern, planned as explicit micro-operations over generator-frame
 * temporaries.
 *
 * WHY. The native generator lowering (`generators-native.ts`) models a body as
 * a state machine whose suspension points are statement-level yields; every
 * expression-position yield it admits (#680 / #2864) is an UNCONDITIONAL
 * suspension that the successor state satisfies by re-compiling the original
 * statement with the yield read from a spill. A pattern cannot be re-compiled
 * after a resume: its GetIterator / `next()` / `Get` / IteratorClose are all
 * observable (the `*-iter-rtrn-close*` rows assert `nextCount === 1` and exactly
 * one `return()`), and a yield in a DEFAULT is conditional (§13.15.5.5 step 4 —
 * the Initializer runs only when the stepped value is `undefined`). So the
 * pattern is lowered the other way round: every step the spec performs becomes
 * one op in source/spec order, every intermediate value (the rval, the iterator
 * record, its [[Done]] flag, each stepped value, a member target's base and
 * key) is a generator-frame spill, and each yield becomes its own suspension
 * between two ops:
 *
 *     result = [ x = yield ] = vals;
 *
 *     S0  t0 = vals; it = GetIterator(t0); done = 0
 *     S1  v = IteratorStep(it); f = (v === undefined)   → branch f ? S2 : S3
 *     S2  yield                                            (resume → sent)
 *     S2' v = sent                                          → jump S3
 *     S3  x = v; IteratorClose(it) if !done; result = t0
 *
 * This is G1's spec-ordered drive (`dstr-assign-iterator-drive.ts`) with the
 * drive's wasm locals promoted to frame spills so it can be split at a yield,
 * the same way A2 split `for-of` at its step terminator. The iterator record
 * that crosses the suspension is closed on every abrupt path:
 *  - a runtime throw from an op (`next()`, a default, a PutValue): each op is
 *    wrapped in a try that closes every still-open iterator, innermost first,
 *    with the close's own completion suppressed (§7.4.9 step 5), then rethrows;
 *  - a `.return(v)` / `.throw(e)` delivered at a yield inside the pattern: a
 *    `dstr-close` entry in the generator's unwind chain closes the record —
 *    for a RETURN completion the close's throw and its non-Object result are
 *    observable (§7.4.9 steps 6-7, the `*-rtrn-close-err` / `-null` rows), for
 *    a THROW completion they are discarded.
 *
 * The same planner lowers a `for (<pattern> of <iterable>)` head: the loop's
 * own iterator is a spill driven by `__iterator_next` (arrays included — the
 * A2 `for-of-step` terminator rides `__gen_delegate_*`, which traps on a vec),
 * and it is the OUTER entry of the close stack while the head's pattern runs.
 *
 * SCOPE — only generators whose body holds such a pattern are touched
 * (`bodyHasPatternYield`, which also moves them to the boxed-any carrier: a
 * resumed value lands in a PATTERN TARGET, so it must keep its JS identity —
 * `iter.next('prop')` keys `x[yield]` by a string). Every other generator
 * compiles byte-identically; the planner is only reached from the statement
 * arm those generators used to bail on.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { buildStandardTryTable } from "../ir/try-table.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildDestructureNullThrow } from "./destructuring-params.js";
import {
  emitResolvedIdentifierWriteFromStack,
  resolveModuleAwareIdentifierWriteTarget,
} from "./expressions/identifier-assignment.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { isFunctionLikeScope, nodeContainsYield } from "./generators-native-ast-scan.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { coerceType, compileExpression } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** An iterator record a pattern drive holds open: the spills of its record and [[Done]]. */
export interface LinearCloseEntry {
  iter: string;
  done: string;
}

/** One spec step. Every operand is a spill NAME (a resume-function local). */
type LinearOp =
  | { kind: "eval"; expr: ts.Expression; to: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "get-iter"; src: string; iter: string; done: string }
  | { kind: "step"; iter: string; done: string; to: string }
  | { kind: "rest"; iter: string; done: string; to: string }
  | { kind: "is-undef"; value: string; flag: string }
  | { kind: "default"; value: string; init: ts.Expression; forceVec: boolean }
  | { kind: "coercible"; value: string }
  | { kind: "key-const"; name: string; to: string }
  | { kind: "get-prop"; obj: string; key: string; to: string }
  | { kind: "put-ident"; target: ts.Identifier; value: string }
  | { kind: "put-member"; obj: string; key: string; value: string }
  | { kind: "close"; iter: string; done: string };

interface LinearOpRecord {
  op: LinearOp;
  /** Iterators open while this op runs, outermost first. */
  closeStack: readonly LinearCloseEntry[];
}

/**
 * Ops ride the state's ordinary statement list as inert marker statements, so
 * they keep their position relative to the source statements around them (a
 * state's prelude, its captures and its terminator are emitted in that order).
 * Keyed by node identity; a plan rebuild mints fresh markers.
 */
const LINEAR_OPS = new WeakMap<ts.Statement, LinearOpRecord>();

/** The planner's view of `buildNativeGeneratorPlan`'s state cursor. */
export interface LinearizeHost<U> {
  /** Allocate a frame spill of the given type. */
  spill(type: ValType, tag: string): string;
  /** Append a statement to the state being filled. */
  push(stmt: ts.Statement): void;
  /** Suspend at `yieldExpr`; the resumed value lands in the returned spill (null = refuse). */
  suspend(yieldExpr: ts.YieldExpression, unwind: readonly U[]): string | null;
  reserve(): number;
  /** Continue filling an already-reserved state. */
  enter(id: number): void;
  /** Finish the current state: `flag` (an i32 spill) ? thenState : elseState. */
  branch(flag: string, thenState: number, elseState: number): void;
  /** Finish the current state with a non-suspending jump. */
  jump(next: number): void;
  lowerBody(statements: readonly ts.Statement[], unwind: readonly U[]): boolean;
  /** The unwind-chain entry that closes `entry` on an abrupt resume. */
  closeEntry(entry: LinearCloseEntry): U;
}

export type LinearizeAttempt = "lowered" | "not-applicable" | "failed";

function unwrapParens(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

/** `expr` is, or holds, a yield of THIS function (nested functions own theirs). */
function hasYield(expr: ts.Node): boolean {
  return ts.isYieldExpression(expr) || nodeContainsYield(expr);
}

function isAssignPattern(node: ts.Expression): node is ts.ArrayLiteralExpression | ts.ObjectLiteralExpression {
  return ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node);
}

function isPlainAssign(node: ts.Expression): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/**
 * The generator-level gate. True when the body (outside nested functions)
 * holds an assignment whose PATTERN contains a yield, or a `for-of` whose
 * pattern HEAD does — exactly the shapes every other lowering refuses, so a
 * generator this answers `true` for had no native plan before this slice.
 */
export function bodyHasPatternYield(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isFunctionLikeScope(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrapParens(node.left);
      if (isAssignPattern(left) && hasYield(left)) {
        found = true;
        return;
      }
    }
    if (ts.isForOfStatement(node) && !ts.isVariableDeclarationList(node.initializer)) {
      const head = unwrapParens(node.initializer);
      if (isAssignPattern(head) && hasYield(head)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

// ---------------------------------------------------------------------------
// Planning

interface Planner<U> {
  host: LinearizeHost<U>;
  fail: boolean;
}

function pushOp<U>(p: Planner<U>, op: LinearOp, closeStack: readonly LinearCloseEntry[]): void {
  const marker = ts.factory.createEmptyStatement();
  LINEAR_OPS.set(marker, { op, closeStack: [...closeStack] });
  p.host.push(marker);
}

/** A yield this planner can suspend on: `yield` / `yield <yield-free operand>`. */
function directYield(expr: ts.Expression): ts.YieldExpression | undefined {
  const inner = unwrapParens(expr);
  if (!ts.isYieldExpression(inner) || inner.asteriskToken) return undefined;
  if (inner.expression && hasYield(inner.expression)) return undefined;
  return inner;
}

/**
 * Evaluate `expr` into a fresh externref spill. A direct yield suspends and
 * hands back its resume spill; any other yield-bearing expression is refused.
 */
function evalToSpill<U>(
  p: Planner<U>,
  expr: ts.Expression,
  stack: readonly LinearCloseEntry[],
  unwind: readonly U[],
  tag: string,
): string | undefined {
  const y = directYield(expr);
  if (y) {
    const sent = p.host.suspend(y, unwind);
    if (sent === null) p.fail = true;
    return sent ?? undefined;
  }
  if (hasYield(expr)) {
    p.fail = true;
    return undefined;
  }
  const to = p.host.spill(EXTERNREF, tag);
  pushOp(p, { kind: "eval", expr, to }, stack);
  return to;
}

type MemberRef = { obj: string; key: string };

/**
 * §13.15.5.5 step 1 / §13.15.5.3 — a member DestructuringAssignmentTarget's
 * Reference, evaluated BEFORE the step / Get it receives a value from. The base
 * is evaluated first, then the key; a yield in the key (`x[yield]`) suspends
 * between the two. ToPropertyKey is left to the PutValue (`__extern_set_strict`).
 */
function planMemberRef<U>(
  p: Planner<U>,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  stack: readonly LinearCloseEntry[],
  unwind: readonly U[],
): MemberRef | undefined {
  if (ts.isPropertyAccessExpression(target) && ts.isPrivateIdentifier(target.name)) {
    p.fail = true;
    return undefined;
  }
  if (hasYield(target.expression)) {
    p.fail = true;
    return undefined;
  }
  const obj = evalToSpill(p, target.expression, stack, unwind, "obj");
  if (obj === undefined) return undefined;
  if (ts.isPropertyAccessExpression(target)) {
    const key = p.host.spill(EXTERNREF, "key");
    pushOp(p, { kind: "key-const", name: target.name.text, to: key }, stack);
    return { obj, key };
  }
  const key = evalToSpill(p, target.argumentExpression, stack, unwind, "key");
  return key === undefined ? undefined : { obj, key };
}

/** A non-pattern target, resolved before its value is produced. */
type SimpleTarget = { kind: "ident"; id: ts.Identifier } | { kind: "member"; ref: MemberRef };

function planSimpleTarget<U>(
  p: Planner<U>,
  target: ts.Expression,
  stack: readonly LinearCloseEntry[],
  unwind: readonly U[],
): SimpleTarget | undefined {
  const t = unwrapParens(target);
  if (ts.isIdentifier(t)) return { kind: "ident", id: t };
  if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) {
    const ref = planMemberRef(p, t, stack, unwind);
    return ref ? { kind: "member", ref } : undefined;
  }
  p.fail = true;
  return undefined;
}

function putSimple<U>(p: Planner<U>, target: SimpleTarget, value: string, stack: readonly LinearCloseEntry[]): void {
  if (target.kind === "ident") pushOp(p, { kind: "put-ident", target: target.id, value }, stack);
  else pushOp(p, { kind: "put-member", obj: target.ref.obj, key: target.ref.key, value }, stack);
}

/**
 * §13.15.5.5 step 4 — replace `value` by the Initializer's value when it is
 * `undefined`. A yield-free Initializer is one op; a DIRECT yield is the
 * conditional suspension:
 *
 *     f = IsUndefined(value)  → branch f ? S_yield : S_join
 *     S_yield: yield …; value = sent → jump S_join
 */
function planDefault<U>(
  p: Planner<U>,
  value: string,
  init: ts.Expression,
  forceVec: boolean,
  stack: readonly LinearCloseEntry[],
  unwind: readonly U[],
): void {
  if (!hasYield(init)) {
    pushOp(p, { kind: "default", value, init, forceVec }, stack);
    return;
  }
  const y = directYield(init);
  if (!y) {
    p.fail = true;
    return;
  }
  const flag = p.host.spill(I32, "undef");
  pushOp(p, { kind: "is-undef", value, flag }, stack);
  const yieldState = p.host.reserve();
  const join = p.host.reserve();
  p.host.branch(flag, yieldState, join);
  p.host.enter(yieldState);
  const sent = p.host.suspend(y, unwind);
  if (sent === null) {
    p.fail = true;
    return;
  }
  pushOp(p, { kind: "copy", from: sent, to: value }, stack);
  p.host.jump(join);
  p.host.enter(join);
}

/** Assign `value` to a DestructuringAssignmentTarget that may itself be a pattern. */
function planAssignTarget<U>(
  p: Planner<U>,
  target: ts.Expression,
  simple: SimpleTarget | undefined,
  value: string,
  stack: readonly LinearCloseEntry[],
  unwind: readonly U[],
): void {
  if (simple) {
    putSimple(p, simple, value, stack);
    return;
  }
  const t = unwrapParens(target);
  if (ts.isArrayLiteralExpression(t)) planArrayPattern(p, t, value, stack, unwind);
  else if (ts.isObjectLiteralExpression(t)) planObjectPattern(p, t, value, stack, unwind);
  else p.fail = true;
}

/** §13.15.5.2 ArrayAssignmentPattern over the value in spill `src`. */
function planArrayPattern<U>(
  p: Planner<U>,
  pattern: ts.ArrayLiteralExpression,
  src: string,
  stack: readonly LinearCloseEntry[],
  unwind: readonly U[],
): void {
  const iter = p.host.spill(EXTERNREF, "iter");
  const done = p.host.spill(I32, "done");
  // GetIterator (and its RequireObjectCoercible) run with only the OUTER
  // iterators open — this pattern has nothing to close yet.
  pushOp(p, { kind: "get-iter", src, iter, done }, stack);
  const entry: LinearCloseEntry = { iter, done };
  const inner = [...stack, entry];
  const innerUnwind = [...unwind, p.host.closeEntry(entry)];
  const elements = pattern.elements;
  for (let i = 0; i < elements.length && !p.fail; i++) {
    const el = elements[i]!;
    if (ts.isOmittedExpression(el)) {
      pushOp(p, { kind: "step", iter, done, to: p.host.spill(EXTERNREF, "hole") }, inner);
      continue;
    }
    if (ts.isSpreadElement(el)) {
      if (i !== elements.length - 1) {
        p.fail = true;
        return;
      }
      const target = unwrapParens(el.expression);
      const simple = isAssignPattern(target) ? undefined : planSimpleTarget(p, target, inner, innerUnwind);
      if (p.fail) return;
      const rest = p.host.spill(EXTERNREF, "rest");
      pushOp(p, { kind: "rest", iter, done, to: rest }, inner);
      planAssignTarget(p, target, simple, rest, inner, innerUnwind);
      continue;
    }
    const isDefault = isPlainAssign(el);
    const target = unwrapParens(isDefault ? el.left : el);
    const init = isDefault ? el.right : undefined;
    // §13.15.5.5 step 1: a non-pattern target's Reference comes FIRST.
    const simple = isAssignPattern(target) ? undefined : planSimpleTarget(p, target, inner, innerUnwind);
    if (p.fail) return;
    const value = p.host.spill(EXTERNREF, "val");
    pushOp(p, { kind: "step", iter, done, to: value }, inner);
    if (init) {
      planDefault(
        p,
        value,
        init,
        ts.isArrayLiteralExpression(target) && ts.isArrayLiteralExpression(unwrapParens(init)),
        inner,
        innerUnwind,
      );
      if (p.fail) return;
    }
    planAssignTarget(p, target, simple, value, inner, innerUnwind);
  }
  if (p.fail) return;
  // §13.15.5.2 step 5 on a normal completion — the close's own throw is the
  // statement's completion, so only the OUTER iterators guard it.
  pushOp(p, { kind: "close", iter, done }, stack);
}

/** §13.15.5.3 ObjectAssignmentPattern over the value in spill `src`. */
function planObjectPattern<U>(
  p: Planner<U>,
  pattern: ts.ObjectLiteralExpression,
  src: string,
  stack: readonly LinearCloseEntry[],
  unwind: readonly U[],
): void {
  pushOp(p, { kind: "coercible", value: src }, stack);
  for (const prop of pattern.properties) {
    if (p.fail) return;
    let key: string | undefined;
    let target: ts.Expression;
    let init: ts.Expression | undefined;
    if (ts.isShorthandPropertyAssignment(prop)) {
      key = p.host.spill(EXTERNREF, "key");
      pushOp(p, { kind: "key-const", name: prop.name.text, to: key }, stack);
      target = prop.name;
      init = prop.objectAssignmentInitializer;
    } else if (ts.isPropertyAssignment(prop)) {
      const name = prop.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        key = p.host.spill(EXTERNREF, "key");
        const text = ts.isNumericLiteral(name) ? String(Number(name.text)) : name.text;
        pushOp(p, { kind: "key-const", name: text, to: key }, stack);
      } else if (ts.isComputedPropertyName(name)) {
        key = evalToSpill(p, name.expression, stack, unwind, "key");
      } else {
        p.fail = true;
        return;
      }
      if (key === undefined) return;
      const el = prop.initializer;
      const isDefault = isPlainAssign(el);
      target = isDefault ? el.left : el;
      init = isDefault ? el.right : undefined;
    } else {
      // `...rest` (CopyDataProperties) and accessor/method members are not modelled.
      p.fail = true;
      return;
    }
    const t = unwrapParens(target);
    // §13.15.5.6 KeyedDestructuringAssignmentEvaluation step 1: the target's
    // Reference precedes the Get.
    const simple = isAssignPattern(t) ? undefined : planSimpleTarget(p, t, stack, unwind);
    if (p.fail) return;
    const value = p.host.spill(EXTERNREF, "val");
    pushOp(p, { kind: "get-prop", obj: src, key: key!, to: value }, stack);
    if (init) {
      planDefault(
        p,
        value,
        init,
        ts.isArrayLiteralExpression(t) && ts.isArrayLiteralExpression(unwrapParens(init)),
        stack,
        unwind,
      );
      if (p.fail) return;
    }
    planAssignTarget(p, t, simple, value, stack, unwind);
  }
}

/**
 * `P = rhs;` / `(P = rhs);` / `a = b = P = rhs;` where `P` holds a yield and
 * `rhs` does not. The rval is evaluated FIRST (§13.15.2 step 2 — the pattern is
 * not evaluated until a value exists), then the pattern runs over it, then each
 * outer identifier target receives the same rval (an assignment expression's
 * value). Outer targets are identifiers only: a member target's Reference is
 * evaluated before the rval and is not modelled here.
 */
function planAssignmentStatement<U>(
  p: Planner<U>,
  stmt: ts.ExpressionStatement,
  unwind: readonly U[],
): LinearizeAttempt {
  let expr = unwrapParens(stmt.expression);
  const outer: ts.Identifier[] = [];
  while (isPlainAssign(expr) && ts.isIdentifier(unwrapParens(expr.left))) {
    outer.push(unwrapParens(expr.left) as ts.Identifier);
    expr = unwrapParens(expr.right);
  }
  if (!isPlainAssign(expr)) return "not-applicable";
  const pattern = unwrapParens(expr.left);
  if (!isAssignPattern(pattern) || !hasYield(pattern) || hasYield(expr.right)) return "not-applicable";
  const src = evalToSpill(p, expr.right, [], unwind, "rval");
  if (src === undefined) return "failed";
  if (ts.isArrayLiteralExpression(pattern)) planArrayPattern(p, pattern, src, [], unwind);
  else planObjectPattern(p, pattern, src, [], unwind);
  if (p.fail) return "failed";
  for (let i = outer.length - 1; i >= 0; i--) {
    pushOp(p, { kind: "put-ident", target: outer[i]!, value: src }, []);
  }
  return "lowered";
}

/** A `return` in THIS function (nested functions own theirs). */
function containsReturn(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || isFunctionLikeScope(n)) return;
    if (ts.isReturnStatement(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** A `yield*` in THIS function. */
function containsDelegation(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || isFunctionLikeScope(n)) return;
    if (ts.isYieldExpression(n) && n.asteriskToken) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * `for (<pattern> of <iterable>) body` — §14.7.5.6/§14.7.5.7 with the head's
 * DestructuringAssignmentEvaluation able to suspend:
 *
 *     [cur]    s = <iterable>; li = GetIterator(s); ld = 0     → jump header
 *     [header] v = IteratorStep(li)                            → branch ld ? exit : body
 *     [body]   <pattern drive over v>; <body statements>        → jump header
 *     [exit]
 *
 * The loop's record is the OUTER close entry for the head and the body, so a
 * throw from the head, or an abrupt resume anywhere inside, closes it.
 * Refused (the same reasons A2's `lowerForOf` records): a `return` or `yield*`
 * in the body (neither path walks this chain), `break`/`continue`, `for await`.
 */
function planForOfPatternHead<U>(
  p: Planner<U>,
  stmt: ts.ForOfStatement,
  unwind: readonly U[],
  bodyJumpOk: (body: ts.Statement) => boolean,
): LinearizeAttempt {
  if (ts.isVariableDeclarationList(stmt.initializer)) return "not-applicable";
  const head = unwrapParens(stmt.initializer);
  if (!isAssignPattern(head) || !hasYield(head)) return "not-applicable";
  if (stmt.awaitModifier || hasYield(stmt.expression)) return "failed";
  if (!bodyJumpOk(stmt.statement) || containsReturn(stmt.statement) || containsDelegation(stmt.statement)) {
    return "failed";
  }
  const subject = evalToSpill(p, stmt.expression, [], unwind, "subj");
  if (subject === undefined) return "failed";
  const iter = p.host.spill(EXTERNREF, "loopiter");
  const done = p.host.spill(I32, "loopdone");
  pushOp(p, { kind: "get-iter", src: subject, iter, done }, []);
  const entry: LinearCloseEntry = { iter, done };
  const stack = [entry];
  const loopUnwind = [...unwind, p.host.closeEntry(entry)];

  const header = p.host.reserve();
  const bodyEntry = p.host.reserve();
  const exit = p.host.reserve();
  p.host.jump(header);
  p.host.enter(header);
  const value = p.host.spill(EXTERNREF, "item");
  // A throwing `next()` leaves [[Done]] true, so the wrapper's close is inert
  // there; the op still carries the stack for uniformity.
  pushOp(p, { kind: "step", iter, done, to: value }, stack);
  p.host.branch(done, exit, bodyEntry);

  p.host.enter(bodyEntry);
  if (ts.isArrayLiteralExpression(head)) planArrayPattern(p, head, value, stack, loopUnwind);
  else planObjectPattern(p, head, value, stack, loopUnwind);
  if (p.fail) return "failed";
  const body = ts.isBlock(stmt.statement) ? stmt.statement.statements : [stmt.statement];
  if (!p.host.lowerBody(body, loopUnwind)) return "failed";
  p.host.jump(header);
  p.host.enter(exit);
  return "lowered";
}

/**
 * Entry point from `lowerStatements`. `not-applicable` leaves the statement to
 * the caller's remaining arms (ultimately its generic refusal).
 */
export function lowerLinearizedStatement<U>(
  host: LinearizeHost<U>,
  stmt: ts.Statement,
  unwind: readonly U[],
  bodyJumpOk: (body: ts.Statement) => boolean,
): LinearizeAttempt {
  const p: Planner<U> = { host, fail: false };
  if (ts.isExpressionStatement(stmt)) return planAssignmentStatement(p, stmt, unwind);
  if (ts.isForOfStatement(stmt)) return planForOfPatternHead(p, stmt, unwind, bodyJumpOk);
  return "not-applicable";
}

// ---------------------------------------------------------------------------
// Emission

/**
 * Every runtime op the emitter calls. Ensured once per op and then looked up BY
 * NAME at each call site (never cached as an index): compiling an Initializer
 * or a member base is arbitrary code that can add a late import.
 */
const LINEAR_RUNTIME = [
  ["__iterator", [EXTERNREF], [EXTERNREF]],
  ["__iterator_next", [EXTERNREF], [I32, EXTERNREF]],
  ["__iterator_return", [EXTERNREF], []],
  ["__iterator_rest", [EXTERNREF], [EXTERNREF]],
  ["__array_from_iter_n", [EXTERNREF, { kind: "f64" }], [EXTERNREF]],
  ["__extern_is_undefined", [EXTERNREF], [I32]],
  ["__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]],
  ["__extern_set_strict", [EXTERNREF, EXTERNREF, EXTERNREF], []],
] as const satisfies readonly (readonly [string, readonly ValType[], readonly ValType[]])[];
type LinearRuntimeName = (typeof LINEAR_RUNTIME)[number][0];

function ensureLinearRuntime(ctx: CodegenContext, fctx: FunctionContext): void {
  for (const [name, params, results] of LINEAR_RUNTIME) ensureLateImport(ctx, name, [...params], [...results]);
  flushLateImportShifts(ctx, fctx);
}

function call(ctx: CodegenContext, name: LinearRuntimeName): Instr {
  const funcIdx = ctx.funcMap.get(name);
  if (funcIdx === undefined) throw new Error(`generator-yield-linearize: runtime op ${name} is unavailable`);
  return { op: "call", funcIdx };
}

function local(fctx: FunctionContext, name: string): number {
  const idx = fctx.localMap.get(name);
  if (idx === undefined) throw new Error(`generator-yield-linearize: spill ${name} has no resume local`);
  return idx;
}

/** Throw a TypeError when the externref in `idx` is `null` or `undefined`. */
function emitNullishGuard(ctx: CodegenContext, fctx: FunctionContext, idx: number): void {
  fctx.body.push({ op: "local.get", index: idx }, { op: "ref.is_null" });
  fctx.body.push({ op: "local.get", index: idx }, call(ctx, "__extern_is_undefined"), { op: "i32.or" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: buildDestructureNullThrow(ctx, fctx), else: [] });
}

/** Compile `expr` to an externref on the stack (`undefined` for a valueless one). */
function emitExternref(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression, forceVec = false): void {
  const flags = ctx as unknown as { _arrayLiteralForceVec?: boolean };
  const previous = flags._arrayLiteralForceVec;
  if (forceVec) flags._arrayLiteralForceVec = true;
  let t: ValType | null;
  try {
    t = compileExpression(ctx, fctx, expr, EXTERNREF);
  } finally {
    flags._arrayLiteralForceVec = previous;
  }
  if (!t) emitUndefined(ctx, fctx);
  else coerceType(ctx, fctx, t, EXTERNREF);
}

function emitOpBody(ctx: CodegenContext, fctx: FunctionContext, op: LinearOp): void {
  const b = fctx.body;
  switch (op.kind) {
    case "eval":
      emitExternref(ctx, fctx, op.expr);
      fctx.body.push({ op: "local.set", index: local(fctx, op.to) });
      return;
    case "copy":
      b.push({ op: "local.get", index: local(fctx, op.from) }, { op: "local.set", index: local(fctx, op.to) });
      return;
    case "get-iter": {
      const src = local(fctx, op.src);
      emitNullishGuard(ctx, fctx, src);
      b.push({ op: "local.get", index: src }, call(ctx, "__iterator"), {
        op: "local.set",
        index: local(fctx, op.iter),
      });
      b.push({ op: "i32.const", value: 0 }, { op: "local.set", index: local(fctx, op.done) });
      return;
    }
    case "step": {
      // §7.4.6: [[Done]] is raised BEFORE `next()` runs, so a throwing `next()`
      // leaves it true and the close wrapper does not call `return()`.
      const done = local(fctx, op.done);
      const to = local(fctx, op.to);
      b.push({ op: "local.get", index: done }, { op: "i32.eqz" });
      b.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: done },
          { op: "local.get", index: local(fctx, op.iter) },
          call(ctx, "__iterator_next"),
          { op: "local.set", index: to },
          { op: "local.set", index: done },
        ],
        else: [],
      });
      const saved = pushBody(fctx);
      emitUndefined(ctx, fctx);
      const undef = fctx.body;
      popBody(fctx, saved);
      b.push({ op: "local.get", index: done });
      b.push({
        op: "if",
        blockType: { kind: "val", type: EXTERNREF },
        then: undef,
        else: [{ op: "local.get", index: to }],
      });
      b.push({ op: "local.set", index: to });
      return;
    }
    case "rest": {
      // §13.15.5.6 — drain what is left; an already-done iterator yields `[]`.
      const done = local(fctx, op.done);
      const to = local(fctx, op.to);
      b.push({ op: "local.get", index: done }, { op: "i32.eqz" });
      b.push({ op: "i32.const", value: 1 }, { op: "local.set", index: done });
      b.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: local(fctx, op.iter) },
          call(ctx, "__iterator_rest"),
          { op: "local.set", index: to },
        ],
        else: [
          { op: "ref.null.extern" },
          { op: "f64.const", value: -1 },
          call(ctx, "__array_from_iter_n"),
          { op: "local.set", index: to },
        ],
      });
      return;
    }
    case "is-undef":
      b.push({ op: "local.get", index: local(fctx, op.value) }, call(ctx, "__extern_is_undefined"));
      b.push({ op: "local.set", index: local(fctx, op.flag) });
      return;
    case "default": {
      const value = local(fctx, op.value);
      const saved = pushBody(fctx);
      emitExternref(ctx, fctx, op.init, op.forceVec);
      const dflt = fctx.body;
      popBody(fctx, saved);
      fctx.body.push({ op: "local.get", index: value }, call(ctx, "__extern_is_undefined"));
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: EXTERNREF },
        then: dflt,
        else: [{ op: "local.get", index: value }],
      });
      fctx.body.push({ op: "local.set", index: value });
      return;
    }
    case "coercible":
      emitNullishGuard(ctx, fctx, local(fctx, op.value));
      return;
    case "key-const":
      addStringConstantGlobal(ctx, op.name);
      b.push(...stringConstantExternrefInstrs(ctx, op.name), { op: "local.set", index: local(fctx, op.to) });
      return;
    case "get-prop":
      b.push({ op: "local.get", index: local(fctx, op.obj) }, { op: "local.get", index: local(fctx, op.key) });
      b.push(call(ctx, "__extern_get"), { op: "local.set", index: local(fctx, op.to) });
      return;
    case "put-ident": {
      fctx.body.push({ op: "local.get", index: local(fctx, op.value) });
      const { localIdx, moduleGlobalIdx } = resolveModuleAwareIdentifierWriteTarget(ctx, fctx, op.target, EXTERNREF);
      emitResolvedIdentifierWriteFromStack(ctx, fctx, op.target, EXTERNREF, localIdx, moduleGlobalIdx);
      return;
    }
    case "put-member":
      b.push({ op: "local.get", index: local(fctx, op.obj) }, { op: "local.get", index: local(fctx, op.key) });
      b.push({ op: "local.get", index: local(fctx, op.value) }, call(ctx, "__extern_set_strict"));
      return;
    case "close": {
      // Normal-completion IteratorClose: its throw / non-Object result is the
      // statement's completion. [[Done]] goes up first so no wrapper re-closes.
      const done = local(fctx, op.done);
      b.push({ op: "local.get", index: done }, { op: "i32.eqz" });
      b.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: done },
          { op: "local.get", index: local(fctx, op.iter) },
          call(ctx, "__iterator_return"),
        ],
        else: [],
      });
      return;
    }
  }
}

/** Close one open record with its completion suppressed (§7.4.9 step 5, a throw completion). */
function suppressedClose(ctx: CodegenContext, fctx: FunctionContext, entry: LinearCloseEntry): Instr[] {
  const iter = local(fctx, entry.iter);
  const done = local(fctx, entry.done);
  const swallow = buildStandardTryTable(
    { kind: "empty" },
    [{ op: "local.get", index: iter }, call(ctx, "__iterator_return")],
    [{ kind: "catch", tagIdx: ensureExnTag(ctx), payloadType: EXTERNREF, body: [{ op: "drop" }] }],
  );
  return [
    { op: "local.get", index: iter },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "local.get", index: done },
    { op: "i32.eqz" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "local.set", index: done }, swallow],
      else: [],
    },
  ];
}

/**
 * Emit a marker statement's op into `fctx.body`. Returns false when `stmt` is
 * not a marker (the caller compiles it as source).
 */
export function emitLinearOpStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): boolean {
  const rec = LINEAR_OPS.get(stmt);
  if (!rec) return false;
  ensureLinearRuntime(ctx, fctx);
  if (rec.closeStack.length === 0) {
    emitOpBody(ctx, fctx, rec.op);
    return true;
  }
  const saved = pushBody(fctx);
  emitOpBody(ctx, fctx, rec.op);
  const body = fctx.body;
  popBody(fctx, saved);
  const exn = allocLocal(fctx, `__gen_lin_exn_${fctx.locals.length}`, EXTERNREF);
  const tagIdx = ensureExnTag(ctx);
  const handler: Instr[] = [{ op: "local.set", index: exn }];
  for (let i = rec.closeStack.length - 1; i >= 0; i--) handler.push(...suppressedClose(ctx, fctx, rec.closeStack[i]!));
  handler.push({ op: "local.get", index: exn }, { op: "throw", tagIdx });
  fctx.body.push(
    buildStandardTryTable({ kind: "empty" }, body, [{ kind: "catch", tagIdx, payloadType: EXTERNREF, body: handler }]),
  );
  return true;
}

/**
 * The abrupt-resume arm of a `dstr-close` unwind entry (§7.4.9 IteratorClose
 * with the resume's completion). `isThrow` pushes the i32 "completion is a
 * throw" test. A RETURN completion calls `return()` unguarded — its throw and
 * its non-Object-result TypeError replace the completion (steps 6-7); a THROW
 * completion discards both (step 5).
 */
export function emitLinearUnwindClose(
  ctx: CodegenContext,
  fctx: FunctionContext,
  entry: LinearCloseEntry,
  isThrow: () => Instr[],
): void {
  ensureLinearRuntime(ctx, fctx);
  const iter = local(fctx, entry.iter);
  const done = local(fctx, entry.done);
  const returnClose: Instr[] = [{ op: "local.get", index: iter }, call(ctx, "__iterator_return")];
  const throwClose = buildStandardTryTable(
    { kind: "empty" },
    [{ op: "local.get", index: iter }, call(ctx, "__iterator_return")],
    [{ kind: "catch", tagIdx: ensureExnTag(ctx), payloadType: EXTERNREF, body: [{ op: "drop" }] }],
  );
  fctx.body.push(
    { op: "local.get", index: iter },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "local.get", index: done },
    { op: "i32.eqz" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: done },
        ...isThrow(),
        { op: "if", blockType: { kind: "empty" }, then: [throwClose], else: returnClose },
      ],
      else: [],
    },
  );
}
