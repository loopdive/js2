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
  return names;
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
  const call = awaitTarget.parent;
  // `new C(await x)` is deliberately excluded: `__call_function_<n>` performs a
  // [[Call]], not a [[Construct]], so it would silently build the wrong thing.
  // Construction needs its own resume-side op (#6504 follow-up).
  if (!ts.isCallExpression(call)) return null;
  // The call must BE the statement — an awaited call nested inside a larger
  // expression has more continuation than this plan restores.
  if (call !== stmt.expression) return null;
  if (call.questionDotToken !== undefined) return null; // optional call — own semantics
  const args = call.arguments;
  if (args.length > MAX_SPILLED_CALL_ARITY) return null;
  const awaitIndex = args.indexOf(awaitTarget);
  if (awaitIndex < 0) return null; // await is nested INSIDE an argument, not one itself
  for (const arg of args) if (ts.isSpreadElement(arg)) return null; // spread — arity not static

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
      key,
    };
  }
  if (ts.isIdentifier(callee)) {
    // A plain identifier callee. The replay arm already owns the single-`const`
    // case byte-identically; everything else (let/var/global/import) lands here,
    // where the binding is READ ONCE before the suspension instead of re-read
    // after it.
    return { receiver: null, propertyName: null, calleeExpr: callee, before, after, key };
  }
  // ElementAccess (`o[k]()`), parenthesized, call-returning-callee, etc. all
  // need the receiver/key evaluation order spelled out separately.
  return null;
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
  if (deliveredLocal === undefined) fctx.body.push({ op: "ref.null.extern" });
  else {
    fctx.body.push({ op: "local.get", index: deliveredLocal });
    const deliveredType = fctx.locals[deliveredLocal]?.type;
    if (deliveredType !== undefined && deliveredType.kind !== "externref") {
      coerceType(ctx, fctx, deliveredType, EXTERNREF);
    }
  }

  // Arguments to the RIGHT of the await are evaluated here, after the resume —
  // source order puts them after the awaited operand settles.
  for (const arg of plan.after) pushAsExternref(ctx, fctx, arg);

  fctx.body.push({ op: "call", funcIdx: callIdx } as Instr);
  fctx.body.push({ op: "drop" });
}
