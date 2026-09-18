// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6504) The spill continuation for an `await` in a CALL ARGUMENT.
 *
 * `planLinearAwaits`' pre-existing nested-await arm (`replaySafeNestedCallAwait`)
 * resumes by RECOMPILING the containing statement with the delivered value
 * substituted for the await. That is sound only because everything it admits
 * evaluated nothing before the suspension except one immutable `const` binding
 * read, which re-reading reproduces exactly.
 *
 * `o.m(await x)` — the shape of #6504's five rows and #6502's three — is not in
 * that class: recompiling re-reads `o` and `o.m` AFTER the suspension, and the
 * awaited thenable's `then` runs arbitrary code in between. Declining instead
 * (what happened until now) falls to the legacy synchronous pass-through, which
 * compiles `await` as a NO-OP: `assert.sameValue(await thenable, 42)` compared
 * the THENABLE against 42. Both options are silent miscompiles; the fix is the
 * continuation the module's own doc named — "explicit pre-await operand spills
 * rather than continuation recompilation":
 *
 *   before the suspension, in source order
 *     1. evaluate the receiver `o`                     -> spill `…recv@p`
 *     2. read the callee `o.m` FROM THAT VALUE         -> spill `…callee@p`
 *     3. evaluate each argument preceding the await    -> spill `…arg<i>@p`
 *   suspend on `x`
 *   on resume
 *     4. call the SPILLED callee with the SPILLED receiver, the SPILLED
 *        preceding arguments, the delivered value, then the remaining
 *        arguments — which are evaluated here, after the resume, because that
 *        is where source order puts them.
 *
 * Step 2 is why the receiver is spilled separately rather than the callee
 * expression simply being compiled whole: compiling `o.m` would evaluate `o` a
 * second time. Reading the property off the already-evaluated receiver value
 * (`__extern_get`) keeps `o` to exactly one evaluation, which is what makes
 * `getObj().m(await x)` and a getter-valued `.m` correct rather than merely
 * usually-correct.
 *
 * HOST LANE ONLY. The resume-side call goes through `__call_function_<n>`, a
 * host import; `--target wasi` / `--target standalone` have no host to satisfy
 * it and keep their existing decline. The planner gate mirrors that.
 */
import ts from "typescript";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { compileExpression } from "./shared.js";
import { coerceType } from "./type-coercion.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * The maximum number of user arguments a spilled call carries. `__call_function_<n>`
 * exists as a fixed-arity import for n ≤ 4; wider calls take the JS-array
 * builder ABI, whose extra imports and per-call array construction are not worth
 * it for a shape the corpus exercises at n ≤ 2. Beyond this the planner declines
 * and the pre-existing behaviour is unchanged.
 */
const MAX_SPILLED_CALL_ARITY = 4;

/**
 * One `await` sitting in an argument list, lowered as spills + a resume-side
 * dynamic call. Produced by {@link planSpilledCallAwait} (pure, AST only) and
 * consumed by {@link emitSpilledCallPreSuspend} / {@link emitSpilledCallResume}.
 */
export interface SpilledCallPlan {
  /** `o` in `o.m(…)`; `null` for a bare identifier/expression callee. */
  readonly receiver: ts.Expression | null;
  /** Property name when `receiver` is set — read off the spilled receiver. */
  readonly propertyName: string | null;
  /** Callee expression, used only when `receiver` is null (evaluated whole). */
  readonly calleeExpr: ts.Expression | null;
  /** Arguments left of the await, in source order. Evaluated pre-suspension. */
  readonly before: readonly ts.Expression[];
  /** Arguments right of the await. Evaluated AFTER the resume. */
  readonly after: readonly ts.Expression[];
  /**
   * (round 31) The argument that CONTAINS the await, when the await is not the
   * argument itself (`f(1 + await x)`, `f(o?.[await k])`). `null` when the
   * await IS the argument, which is round 29's shape and stays byte-identical.
   *
   * On resume this expression is RECOMPILED with two substitutions installed:
   * every entry of `operands` reads its spill local instead of re-evaluating,
   * and the await reads the delivered value. Recompiling is therefore
   * side-effect-free — which is the whole reason the operands are spilled.
   */
  readonly argRoot: ts.Expression | null;
  /**
   * Sub-expressions of `argRoot` that source order evaluates BEFORE the await,
   * in that order. Each is evaluated once pre-suspension into its own spill.
   */
  readonly operands: readonly ts.Expression[];
  /**
   * (round 31) An optional-chain base whose nullish check must be decided
   * BEFORE the suspension, so a short-circuited chain never evaluates the
   * awaited operand at all: `undefined?.[await Promise.reject(…)]` must not
   * create that rejection. Always one of `operands`.
   */
  readonly shortCircuitBase: ts.Expression | null;
  /** The await node, used as the substitution key when `argRoot` is recompiled. */
  readonly awaitTarget: ts.AwaitExpression;
  /** Stable suffix (the await's source position) for this call's spill names. */
  readonly key: string;
}

/** Frame spill name for the evaluated receiver (`undefined` when there is none). */
export const spilledCallRecvName = (key: string): string => `__async_call_recv@${key}`;
/** Frame spill name for the evaluated callee value. */
export const spilledCallCalleeName = (key: string): string => `__async_call_callee@${key}`;
/** Frame spill name for the i-th pre-suspension argument. */
export const spilledCallArgName = (key: string, i: number): string => `__async_call_arg${i}@${key}`;

/**
 * Every frame spill name this plan needs, in layout order. `computeAsyncSpills`
 * appends these (all externref) so the fields exist, `initializeSpillLocals`
 * allocates + hydrates the matching resume-fn locals, and `storeSpills` writes
 * them back at the suspension — the plan itself adds no new frame machinery.
 */
export function spilledCallSpillNames(plan: SpilledCallPlan): string[] {
  const names: string[] = [];
  if (plan.receiver !== null) names.push(spilledCallRecvName(plan.key));
  names.push(spilledCallCalleeName(plan.key));
  for (let i = 0; i < plan.before.length; i++) names.push(spilledCallArgName(plan.key, i));
  for (let i = 0; i < plan.operands.length; i++) names.push(spilledCallOperandName(plan.key, i));
  return names;
}

/** Frame spill name for the i-th pre-await operand of the awaited argument. */
export const spilledCallOperandName = (key: string, i: number): string => `__async_call_op${i}@${key}`;

/**
 * Sub-expressions of `root` that evaluation order reaches strictly BEFORE
 * `awaitTarget`, in order — or `null` when the shape is outside this slice.
 *
 * The admitted structures are exactly those whose remaining work after the
 * await is a pure re-combination of already-computed values: an element/property
 * GET, an arithmetic or relational operator, or building an array literal. Each
 * of those is correct to perform on resume because the spec performs it after
 * the awaited operand settles too.
 *
 * Deliberately NOT admitted: `&&`/`||`/`??`/`?:` and comma (conditional
 * evaluation — the await may or may not run), assignment (a store whose target
 * reference is evaluated early), and a nested CALL containing the await (its
 * own callee/receiver would need spilling, which is the enclosing plan's job,
 * not an operand's).
 */
function collectPreAwaitOperands(root: ts.Expression, awaitTarget: ts.AwaitExpression): ts.Expression[] | null {
  const out: ts.Expression[] = [];
  const contains = (node: ts.Node): boolean => {
    if (node === awaitTarget) return true;
    let found = false;
    node.forEachChild((child) => {
      if (!found && contains(child)) found = true;
    });
    return found;
  };
  const walk = (node: ts.Expression): boolean => {
    if (node === awaitTarget) return true;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      return walk(node.expression);
    }
    if (ts.isElementAccessExpression(node)) {
      if (contains(node.argumentExpression)) {
        out.push(node.expression); // the base is fully evaluated before the index
        return walk(node.argumentExpression);
      }
      return walk(node.expression);
    }
    if (ts.isPropertyAccessExpression(node)) {
      return contains(node.expression) ? walk(node.expression) : false;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.CommaToken ||
        op >= ts.SyntaxKind.FirstAssignment
      ) {
        return false;
      }
      if (contains(node.right)) {
        out.push(node.left);
        return walk(node.right);
      }
      return walk(node.left);
    }
    if (ts.isArrayLiteralExpression(node)) {
      let seen = false;
      for (const element of node.elements) {
        if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return false;
        if (seen) continue; // elements after the await are recompiled on resume
        if (contains(element)) {
          seen = true;
          if (!walk(element)) return false;
          continue;
        }
        out.push(element);
      }
      return seen;
    }
    return false;
  };
  return walk(root) ? out : null;
}

/**
 * Recognise `<callee>(…, await x, …)` as an expression statement and describe
 * its spill continuation, or return `null` to leave the caller's behaviour
 * unchanged.
 *
 * Deliberately NOT required (unlike the replay arm, which needs them because it
 * re-executes the callee expression): an immutable callee binding, an `any`
 * first parameter, or a literals-only prefix. Nothing here is re-executed, so a
 * mutable/global/member callee and arbitrary preceding arguments are all fine —
 * they are evaluated once, before the suspension, and their VALUES are what the
 * resume calls. That is the whole point of the spill ABI.
 */
export function planSpilledCallAwait(stmt: ts.Statement, awaitTarget: ts.AwaitExpression): SpilledCallPlan | null {
  if (!ts.isExpressionStatement(stmt)) return null;
  // The call must BE the statement — an awaited call nested inside a larger
  // expression has more continuation than this plan restores. Keying off the
  // STATEMENT rather than off `awaitTarget.parent` is what admits the round-31
  // nested-operand shapes, where the await's parent is the operand structure
  // (an element access, an operator) and not the call at all.
  //
  // `new C(await x)` is excluded by this same test: `__call_function_<n>`
  // performs a [[Call]], not a [[Construct]], so it would silently build the
  // wrong thing. Construction needs its own resume-side op (#6504 follow-up).
  const call = stmt.expression;
  if (!ts.isCallExpression(call)) return null;
  if (call.questionDotToken !== undefined) return null; // optional call — own semantics
  const args = call.arguments;
  if (args.length > MAX_SPILLED_CALL_ARITY) return null;
  for (const arg of args) if (ts.isSpreadElement(arg)) return null; // spread — arity not static

  // The await is either an argument itself (round 29) or nested inside exactly
  // one argument (round 31). `awaitsHere > 1` is rejected upstream, so at most
  // one argument can contain it.
  let awaitIndex = args.indexOf(awaitTarget);
  let argRoot: ts.Expression | null = null;
  let operands: ts.Expression[] = [];
  let shortCircuitBase: ts.Expression | null = null;
  if (awaitIndex < 0) {
    const containing = args.findIndex((arg) => nodeContains(arg, awaitTarget));
    if (containing < 0) return null;
    const root = args[containing]!;
    const collected = collectPreAwaitOperands(root, awaitTarget);
    if (collected === null) return null;
    awaitIndex = containing;
    argRoot = root;
    operands = collected;
    shortCircuitBase = optionalChainBaseBeforeAwait(root, awaitTarget);
    // A short-circuiting base must be one of the spilled operands, or the
    // pre-suspension nullish test would evaluate it a second time.
    if (shortCircuitBase !== null && !operands.includes(shortCircuitBase)) return null;
    // An optional link is admitted ONLY when the base is non-nullish BY SYNTAX.
    //
    // The short-circuit machinery works: measured with a runtime-nullish base
    // the awaited operand is never evaluated and the result is `undefined`.
    // But when the base's static TYPE is `undefined` (`var b = undefined;
    // b?.[await x]`) the chain is constant-folded ahead of the operand
    // substitution and the result lowers as f64 `0` — a WRONG VALUE, where the
    // pre-round-31 behaviour was a (differently wrong) silent decline. That
    // fold is upstream of this plan and deciding it properly needs the base's
    // type, which this pure AST planner does not have.
    //
    // So the whitelist is the inverse: admit only bases that cannot be nullish
    // (an array/object literal, `this`, `new`), which covers the corpus shape
    // `[22, 33]?.[await p]`, and refuse every base whose nullishness is not
    // syntactically settled. Conservative in the safe direction — a refused
    // shape keeps exactly the behaviour it had before this round.
    if (shortCircuitBase !== null && !isSyntacticallyNonNullish(shortCircuitBase)) return null;
  }

  const key = String(awaitTarget.pos);
  const before = args.slice(0, awaitIndex);
  const after = args.slice(awaitIndex + 1);

  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.questionDotToken !== undefined) return null;
    if (ts.isPrivateIdentifier(callee.name)) return null; // #priv — not an __extern_get key
    // `super.m()` has a bound receiver the spill would not reproduce.
    if (callee.expression.kind === ts.SyntaxKind.SuperKeyword) return null;
    return {
      receiver: callee.expression,
      propertyName: callee.name.text,
      calleeExpr: null,
      before,
      after,
      argRoot,
      operands,
      shortCircuitBase,
      awaitTarget,
      key,
    };
  }
  if (ts.isIdentifier(callee)) {
    // A plain identifier callee. The replay arm already owns the single-`const`
    // case byte-identically; everything else (let/var/global/import) lands here,
    // where the binding is READ ONCE before the suspension instead of re-read
    // after it.
    return {
      receiver: null,
      propertyName: null,
      calleeExpr: callee,
      before,
      after,
      argRoot,
      operands,
      shortCircuitBase,
      awaitTarget,
      key,
    };
  }
  // ElementAccess (`o[k]()`), parenthesized, call-returning-callee, etc. all
  // need the receiver/key evaluation order spelled out separately.
  return null;
}

/**
 * Expressions whose value cannot be `null`/`undefined`, decided from syntax
 * alone. Used only to ADMIT an optional-chain short-circuit, so anything not
 * listed here is simply refused.
 */
function isSyntacticallyNonNullish(expr: ts.Expression): boolean {
  let node: ts.Expression = expr;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isTemplateExpression(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword
  );
}

/** True when `node` is, or lexically contains, `target`. */
function nodeContains(node: ts.Node, target: ts.Node): boolean {
  if (node === target) return true;
  let found = false;
  node.forEachChild((child) => {
    if (!found && nodeContains(child, target)) found = true;
  });
  return found;
}

/**
 * The base of an OPTIONAL link (`b?.[i]` / `b?.x`) on the path from `root` down
 * to `awaitTarget`, when the awaited operand sits on the short-circuited side —
 * i.e. when a nullish base means the await must never run at all. `null` when
 * no such link exists, which is every non-optional shape.
 *
 * Only the FIRST such link is reported: one nullish test decides the whole
 * chain, and this slice admits a single one (two optional links either side of
 * the await would need two pre-suspension tests and is refused by the caller
 * through `operands.includes`).
 */
function optionalChainBaseBeforeAwait(root: ts.Expression, awaitTarget: ts.AwaitExpression): ts.Expression | null {
  let found: ts.Expression | null = null;
  const walk = (node: ts.Expression): void => {
    if (node === awaitTarget || found !== null) return;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      walk(node.expression);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      if (node.questionDotToken !== undefined && nodeContains(node.argumentExpression, awaitTarget)) {
        found = node.expression;
        return;
      }
      walk(nodeContains(node.argumentExpression, awaitTarget) ? node.argumentExpression : node.expression);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      walk(node.expression);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      walk(nodeContains(node.right, awaitTarget) ? node.right : node.left);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!ts.isOmittedExpression(element) && nodeContains(element, awaitTarget)) walk(element as ts.Expression);
      }
    }
  };
  walk(root);
  return found;
}

/** True when this lane can satisfy the resume-side `__call_function_<n>` import. */
export function spilledCallLaneSupported(ctx: CodegenContext): boolean {
  return ctx.standalone !== true && ctx.wasi !== true && ctx.strictNoHostImports !== true;
}

/** Compile `expr` and leave exactly one externref on the stack. */
function pushAsExternref(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): void {
  const type = compileExpression(ctx, fctx, expr, EXTERNREF);
  if (type === null) fctx.body.push({ op: "ref.null.extern" });
  else if (type.kind !== "externref") coerceType(ctx, fctx, type, EXTERNREF);
}

/** The resume-fn local backing a frame spill name (allocated by `initializeSpillLocals`). */
function spillLocal(fctx: FunctionContext, name: string): number {
  const existing = fctx.localMap.get(name);
  if (existing !== undefined) return existing;
  // Defensive: a plan whose names reached the emitter but not `computeAsyncSpills`
  // would otherwise write into a local nothing spills. Allocating keeps the
  // module valid; the value simply would not survive the suspension, so the
  // planner and `computeAsyncSpills` must stay in lockstep (asserted by the
  // #6504 regression test).
  return allocLocal(fctx, name, EXTERNREF);
}

/**
 * Pre-suspension half: evaluate receiver, callee and the preceding arguments
 * into their spill locals, in source order. Stack-neutral.
 *
 * Runs from the suspend state's `emit` hook — after that state's lead
 * statements and BEFORE the terminator evaluates the awaited operand, which is
 * exactly where JS evaluates them.
 */
export function emitSpilledCallPreSuspend(ctx: CodegenContext, fctx: FunctionContext, plan: SpilledCallPlan): void {
  if (plan.receiver !== null) {
    const recvLocal = spillLocal(fctx, spilledCallRecvName(plan.key));
    pushAsExternref(ctx, fctx, plan.receiver);
    fctx.body.push({ op: "local.set", index: recvLocal });

    // Read the method OFF the evaluated receiver, never by recompiling `o.m`:
    // one evaluation of `o`, and the property read happens here rather than
    // after the suspension.
    const externGetIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
    flushLateImportShifts(ctx, fctx);
    const calleeLocal = spillLocal(fctx, spilledCallCalleeName(plan.key));
    if (externGetIdx === undefined) {
      fctx.body.push({ op: "ref.null.extern" });
    } else {
      addStringConstantGlobal(ctx, plan.propertyName!);
      fctx.body.push({ op: "local.get", index: recvLocal });
      fctx.body.push(...stringConstantExternrefInstrs(ctx, plan.propertyName!));
      fctx.body.push({ op: "call", funcIdx: externGetIdx });
    }
    fctx.body.push({ op: "local.set", index: calleeLocal });
  } else {
    const calleeLocal = spillLocal(fctx, spilledCallCalleeName(plan.key));
    pushAsExternref(ctx, fctx, plan.calleeExpr!);
    fctx.body.push({ op: "local.set", index: calleeLocal });
  }

  for (let i = 0; i < plan.before.length; i++) {
    const argLocal = spillLocal(fctx, spilledCallArgName(plan.key, i));
    pushAsExternref(ctx, fctx, plan.before[i]!);
    fctx.body.push({ op: "local.set", index: argLocal });
  }

  // (round 31) Pre-await operands of the argument that CONTAINS the await, in
  // source order. These are the evaluations the resume must not repeat.
  for (let i = 0; i < plan.operands.length; i++) {
    const opLocal = spillLocal(fctx, spilledCallOperandName(plan.key, i));
    pushAsExternref(ctx, fctx, plan.operands[i]!);
    fctx.body.push({ op: "local.set", index: opLocal });
  }
}

/**
 * (round 31) The awaited operand, guarded by a short-circuiting optional-chain
 * base when there is one.
 *
 * `undefined?.[await P]` must not evaluate `P` at all, so the nullish test is
 * decided HERE — before the suspension — off the already-spilled base, and the
 * awaited value becomes a plain `undefined` on the short-circuit side. `P` sits
 * in the else arm and is never reached.
 *
 * KNOWN DEVIATION, deliberately taken: the short-circuit path still SUSPENDS
 * (on `undefined`), so it costs one extra microtask tick that the spec does not
 * have — the spec skips the await entirely. Nothing observable in the corpus
 * depends on it, and removing it means splitting the segment into two CFG
 * states so the suspension can be branched around; that is a state-graph
 * change, not an operand change. Recorded in #6504.
 */
export function emitSpilledCallAwaitedOperand(
  ctx: CodegenContext,
  fctx: FunctionContext,
  plan: SpilledCallPlan,
  awaited: ts.Expression,
): ValType {
  if (plan.shortCircuitBase === null) {
    pushAsExternref(ctx, fctx, awaited);
    return EXTERNREF;
  }
  const baseIndex = plan.operands.indexOf(plan.shortCircuitBase);
  const baseLocal = spillLocal(fctx, spilledCallOperandName(plan.key, baseIndex));
  const isUndefinedIdx = ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (isUndefinedIdx === undefined) {
    pushAsExternref(ctx, fctx, awaited);
    return EXTERNREF;
  }

  const thenArm: Instr[] = [{ op: "ref.null.extern" }];
  const savedBody = fctx.body;
  const elseArm: Instr[] = [];
  fctx.body = elseArm;
  try {
    pushAsExternref(ctx, fctx, awaited);
  } finally {
    fctx.body = savedBody;
  }

  fctx.body.push({ op: "local.get", index: baseLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "local.get", index: baseLocal });
  fctx.body.push({ op: "call", funcIdx: isUndefinedIdx });
  fctx.body.push({ op: "i32.or" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: thenArm,
    else: elseArm,
  });
  return EXTERNREF;
}

/**
 * Resume half: call the spilled callee with the spilled receiver, the spilled
 * preceding arguments, the delivered value and the remaining arguments.
 * Stack-neutral (the statement is an expression statement, so the result is
 * dropped).
 *
 * Runs from the resume state's `postDeliverEmit` hook — after `emitDeliver` has
 * bound the settled value into `deliveredName`'s local and before the state's
 * lead statements, which are the statements that FOLLOW the call in source.
 */
export function emitSpilledCallResume(
  ctx: CodegenContext,
  fctx: FunctionContext,
  plan: SpilledCallPlan,
  deliveredName: string,
): void {
  const arity = plan.before.length + 1 + plan.after.length;
  const importName = `__call_function_${arity}`;
  const params: ValType[] = [EXTERNREF, EXTERNREF];
  for (let i = 0; i < arity; i++) params.push(EXTERNREF);
  const callIdx = ensureLateImport(ctx, importName, params, [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  if (callIdx === undefined) return;

  fctx.body.push({ op: "local.get", index: spillLocal(fctx, spilledCallCalleeName(plan.key)) });
  if (plan.receiver !== null) {
    fctx.body.push({ op: "local.get", index: spillLocal(fctx, spilledCallRecvName(plan.key)) });
  } else {
    fctx.body.push({ op: "ref.null.extern" }); // bare call — `this` is undefined
  }
  for (let i = 0; i < plan.before.length; i++) {
    fctx.body.push({ op: "local.get", index: spillLocal(fctx, spilledCallArgName(plan.key, i)) });
  }

  const deliveredLocal = fctx.localMap.get(deliveredName);
  if (deliveredLocal === undefined) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (plan.argRoot === null) {
    // Round 29 shape: the await IS the argument, so the delivered value is it.
    fctx.body.push({ op: "local.get", index: deliveredLocal });
    const deliveredType = fctx.locals[deliveredLocal]?.type;
    if (deliveredType !== undefined && deliveredType.kind !== "externref") {
      coerceType(ctx, fctx, deliveredType, EXTERNREF);
    }
  } else {
    // (round 31) Recompile the ARGUMENT expression with both substitutions
    // installed, so the only work it does is the re-combination that source
    // order puts after the await: the element/property GET, the operator, or
    // building the array literal.
    const savedOperands = fctx.asyncOperandValueLocals;
    const savedAwaits = fctx.asyncAwaitValueLocals;
    const operandMap = new Map(savedOperands);
    for (let i = 0; i < plan.operands.length; i++) {
      operandMap.set(plan.operands[i]!, spillLocal(fctx, spilledCallOperandName(plan.key, i)));
    }
    const awaitMap = new Map(savedAwaits);
    awaitMap.set(plan.awaitTarget, deliveredLocal);
    fctx.asyncOperandValueLocals = operandMap;
    fctx.asyncAwaitValueLocals = awaitMap;
    try {
      pushAsExternref(ctx, fctx, plan.argRoot);
    } finally {
      fctx.asyncOperandValueLocals = savedOperands;
      fctx.asyncAwaitValueLocals = savedAwaits;
    }
  }

  // Arguments to the RIGHT of the await are evaluated here, after the resume —
  // source order puts them after the awaited operand settles.
  for (const arg of plan.after) pushAsExternref(ctx, fctx, arg);

  fctx.body.push({ op: "call", funcIdx: callIdx } as Instr);
  fctx.body.push({ op: "drop" });
}
