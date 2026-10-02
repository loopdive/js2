// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster D, slice D7) `Promise.prototype.finally` performs
 * `Invoke(promise, "then", «thenFinally, catchFinally»)` (§27.2.5.3 step 7)
 * under `--target standalone`.
 *
 * ## The defect, measured
 *
 * `emitStandalonePromiseFinally` (async-scheduler.ts) lowered `finally`
 * straight onto the native `$Promise` reaction list: it never read `then`. So
 * an OWN `p.then = f`, a replaced `Promise.prototype.then`, a poisoned `then`
 * getter, a non-callable `then`, and every non-`$Promise` receiver
 * (`Promise.prototype.finally.call(thenable)`, a Proxy) were unobservable —
 * the user `then` was never called, the TypeError never thrown, and the
 * non-promise receiver hit the body's `ref.cast`.
 *
 * ## The fix — Get first, then pick the arm
 *
 * At every standalone `finally` site this module evaluates the receiver and
 * the handler once, performs the spec's `Get(promise, "then")` through
 * `__extern_get` (which since D5 answers `%Promise.prototype%.then` for a
 * native `$Promise`, an own bag entry first, a D4 subclass chain second), and
 * then:
 *
 *  - receiver is a native `$Promise` AND the `then` read is the intrinsic
 *    `%Promise.prototype%.then` singleton: the existing native lowering runs
 *    verbatim. Unobservable either way (the intrinsic `then` has no user
 *    code), so the fast path and its reaction ordering are unchanged;
 *  - otherwise the GENERIC arm `__promise_finally_invoke(promise, then,
 *    onFinally)`: IsCallable(then) or TypeError (§7.3.14 Call step 2); when
 *    `onFinally` is callable, two fresh builtin function objects
 *    thenFinally / catchFinally (`length` 1, `name` "", no [[Construct]] —
 *    the same builtin-fn-meta carrier as the combinators' resolve-element
 *    functions); then `Call(then, promise, «thenFinally, catchFinally»)`,
 *    whose result is the result of `finally`.
 *
 * thenFinally(value) / catchFinally(reason) (§27.2.5.3.1/.2): call
 * `onFinally()`, `PromiseResolve(%Promise%, result)`, and
 * `Invoke(promise, "then", «valueThunk»)` where valueThunk (`length` 0,
 * `name` "") returns `value` or throws `reason`.
 *
 * ## Deliberate boundaries
 *
 *  - `SpeciesConstructor(promise, %Promise%)` is not performed: `C` is
 *    `%Promise%`, so `PromiseResolve(C, result)` returns a native `$Promise`
 *    `result` as is and wraps anything else in a fresh native promise. The
 *    species / subclass-count rows keep the native arm (their `then` is the
 *    intrinsic one) and are unchanged.
 *  - `--target wasi` keeps its zero-import unconditional lowering.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureBuiltinFnMetaType, pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import {
  closureBagInitInstr,
  getFuncRefWrapperRootTypeIdx,
  getOrCreateFuncRefWrapperTypes,
} from "./closures/funcref-wrapper-types.js";
import { addFuncType } from "./registry/types.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { ensureNativeStringHelpers, stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders, ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { ensurePromiseNativeProtoGlue } from "./array-object-proto.js";
import { ensureStandaloneNativeMethodClosure } from "./native-proto.js";
import { demandPromiseDynamicMember } from "./promise-dynamic-member-read.js";
import {
  PROMISE_STATE_PENDING,
  ensurePromiseSettleFunctions,
  getOrRegisterPromiseType,
  isStandalonePromiseActive,
  type StandalonePromiseThenCallback,
} from "./async-scheduler.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** §7.3.14 Call step 2 — `Invoke(promise, "then", …)` on a non-callable `then`. */
const THEN_NOT_CALLABLE_MSG = "Promise.prototype.finally: then is not a function";

const INVOKE_FN = "__promise_finally_invoke";
const HANDLER_FN = "__promise_finally_handler";
const THUNK_FN = "__promise_finally_thunk";

interface FinallyInvokeRuntime {
  /** `__promise_finally_invoke(promise, then, onFinally) -> externref`. */
  invokeFuncIdx: number;
  /** `%Promise.prototype%.then` member closure — the native arm's identity key. */
  thenClosure: { type: { kind: "ref"; typeIdx: number }; funcIdx: number };
  rootTypeIdx: number;
  promiseTypeIdx: number;
}

type CtxWithFinallyInvoke = CodegenContext & { __promiseFinallyInvoke?: FinallyInvokeRuntime | null };

/** Resources every runtime body bakes. One record keeps each builder a pure function. */
interface BodyRes {
  readonly ctx: CodegenContext;
  readonly promiseTypeIdx: number;
  readonly rootTypeIdx: number;
  readonly handlerTypeIdx: number;
  readonly handlerMetaTypeIdx: number;
  readonly handlerFieldIdx: number;
  readonly thunkTypeIdx: number;
  readonly thunkMetaTypeIdx: number;
  readonly thunkFieldIdx: number;
  readonly vecNewIdx: number;
  readonly vecPushIdx: number;
  readonly applyIdx: number;
  readonly externGetIdx: number;
  readonly resolveValueIdx: number;
  readonly handlerFuncIdx: number;
  readonly thunkFuncIdx: number;
}

/** `if (!IsCallable(local)) throw TypeError(THEN_NOT_CALLABLE_MSG)`. */
function throwUnlessCallable(res: BodyRes, local: number): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: res.rootTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...stringConstantExternrefInstrs(res.ctx, THEN_NOT_CALLABLE_MSG),
        { op: "call", funcIdx: res.ctx.funcMap.get("__new_TypeError") ?? -1 },
        { op: "throw", tagIdx: ensureExnTag(res.ctx) },
      ],
    },
  ];
}

/** A builtin closure struct of `typeIdx` (meta header + two payload fields). */
function newBuiltinClosure(
  funcIdx: number,
  arity: number,
  metaTypeIdx: number,
  typeIdx: number,
  payload: Instr[],
): Instr[] {
  return [
    { op: "ref.func", funcIdx },
    { op: "i32.const", value: arity },
    closureBagInitInstr(),
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: metaTypeIdx },
    ...payload,
    { op: "struct.new", typeIdx },
    { op: "extern.convert_any" },
  ];
}

/**
 * `__promise_finally_invoke(promise, then, onFinally)` — §27.2.5.3 steps 5–7
 * after the `Get(promise, "then")` the call site already performed.
 * Locals: 3 = thenFinally, 4 = catchFinally, 5 = args.
 */
function buildInvokeBody(res: BodyRes): Instr[] {
  const handler = (isReject: number): Instr[] =>
    newBuiltinClosure(res.handlerFuncIdx, 1, res.handlerMetaTypeIdx, res.handlerTypeIdx, [
      { op: "local.get", index: 2 },
      { op: "i32.const", value: isReject },
    ]);
  return [
    ...throwUnlessCallable(res, 1),
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: res.rootTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...handler(0), { op: "local.set", index: 3 }, ...handler(1), { op: "local.set", index: 4 }],
      else: [
        { op: "local.get", index: 2 },
        { op: "local.set", index: 3 },
        { op: "local.get", index: 2 },
        { op: "local.set", index: 4 },
      ],
    },
    { op: "call", funcIdx: res.vecNewIdx },
    { op: "local.set", index: 5 },
    { op: "local.get", index: 5 },
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: res.vecPushIdx },
    { op: "local.get", index: 5 },
    { op: "local.get", index: 4 },
    { op: "call", funcIdx: res.vecPushIdx },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 0 },
    { op: "local.get", index: 5 },
    { op: "call", funcIdx: res.applyIdx },
  ];
}

/**
 * thenFinally / catchFinally (§27.2.5.3.1/.2), one body keyed on the closure's
 * `isReject` field. Params: 0 = self, 1 = value/reason. Locals: 2 = closure,
 * 3 = result, 4 = promise, 5 = fresh promise, 6 = then, 7 = args.
 */
function buildHandlerBody(res: BodyRes): Instr[] {
  const { ctx, handlerTypeIdx, handlerFieldIdx: f, promiseTypeIdx } = res;
  return [
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: handlerTypeIdx },
    { op: "local.set", index: 2 },
    // result = Call(onFinally, undefined)
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: handlerTypeIdx, fieldIdx: f },
    ...canonicalUndefinedExternInstrs(ctx),
    { op: "call", funcIdx: res.vecNewIdx },
    { op: "call", funcIdx: res.applyIdx },
    { op: "local.set", index: 3 },
    // promise = PromiseResolve(%Promise%, result)
    { op: "local.get", index: 3 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "local.get", index: 3 }],
      else: [
        { op: "i32.const", value: PROMISE_STATE_PENDING },
        { op: "ref.null.extern" },
        { op: "ref.null.extern" },
        closureBagInitInstr(),
        { op: "struct.new", typeIdx: promiseTypeIdx },
        { op: "local.tee", index: 5 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 3 },
        { op: "call", funcIdx: res.resolveValueIdx },
        { op: "drop" },
        { op: "local.get", index: 5 },
        { op: "extern.convert_any" },
      ],
    },
    { op: "local.set", index: 4 },
    // Invoke(promise, "then", «valueThunk»)
    { op: "local.get", index: 4 },
    ...stringConstantExternrefInstrs(ctx, "then"),
    { op: "call", funcIdx: res.externGetIdx },
    { op: "local.set", index: 6 },
    ...throwUnlessCallable(res, 6),
    { op: "call", funcIdx: res.vecNewIdx },
    { op: "local.set", index: 7 },
    { op: "local.get", index: 7 },
    ...newBuiltinClosure(res.thunkFuncIdx, 0, res.thunkMetaTypeIdx, res.thunkTypeIdx, [
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: handlerTypeIdx, fieldIdx: f + 1 },
    ]),
    { op: "call", funcIdx: res.vecPushIdx },
    { op: "local.get", index: 6 },
    { op: "local.get", index: 4 },
    { op: "local.get", index: 7 },
    { op: "call", funcIdx: res.applyIdx },
  ];
}

/** valueThunk / thrower: return the captured value, or throw it. Params: 0 = self, 1 = ignored. */
function buildThunkBody(res: BodyRes): Instr[] {
  const { thunkTypeIdx, thunkFieldIdx: f } = res;
  return [
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: thunkTypeIdx },
    { op: "local.set", index: 2 },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: thunkTypeIdx, fieldIdx: f + 1 },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: thunkTypeIdx, fieldIdx: f },
        { op: "throw", tagIdx: ensureExnTag(res.ctx) },
      ],
    },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: thunkTypeIdx, fieldIdx: f },
  ];
}

/** Register a builtin-closure subtype `{meta header…, value externref, isReject i32}`. */
function registerClosureType(
  ctx: CodegenContext,
  name: string,
  metaTypeIdx: number,
): { typeIdx: number; fieldIdx: number } {
  const metaFields = (ctx.mod.types[metaTypeIdx] as { fields: { name: string; type: ValType; mutable: boolean }[] })
    .fields;
  const fields = [
    ...metaFields.map((field) => ({ ...field })),
    { name: "value", type: EXTERNREF, mutable: false },
    { name: "isReject", type: I32, mutable: false },
  ];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name, fields, superTypeIdx: metaTypeIdx });
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(
    name,
    fields.map((field) => ({ ...field })),
  );
  return { typeIdx, fieldIdx: metaFields.length };
}

function ensureFinallyInvokeRuntime(ctx: CodegenContext, fctx: FunctionContext): FinallyInvokeRuntime | null {
  const holder = ctx as CtxWithFinallyInvoke;
  if (holder.__promiseFinallyInvoke !== undefined) return holder.__promiseFinallyInvoke;
  holder.__promiseFinallyInvoke = null;

  const brand = ensurePromiseNativeProtoGlue(ctx);
  if (brand === undefined) return null;
  demandPromiseDynamicMember(ctx, "then", fctx);
  const thenClosure = ensureStandaloneNativeMethodClosure(ctx, brand, "then", "method");
  if (!thenClosure) return null;

  ensurePromiseSettleFunctions(ctx);
  ensureObjectRuntime(ctx);
  const vec = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  if (ctx.nativeStrings) ensureNativeStringHelpers(ctx);
  addStringConstantGlobal(ctx, "then");
  addStringConstantGlobal(ctx, THEN_NOT_CALLABLE_MSG);
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const resolveValueIdx = ctx.funcMap.get("__promise_resolve_value");
  if (externGetIdx === undefined || resolveValueIdx === undefined) return null;
  if (vec.newIdx === undefined || vec.pushIdx === undefined) return null;

  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, [EXTERNREF], [EXTERNREF]);
  const rootTypeIdx = getFuncRefWrapperRootTypeIdx(ctx);
  if (!wrapper || rootTypeIdx === undefined) return null;
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);

  // thenFinally / catchFinally: `length` 1, `name` "" (§27.2.5.3.1/.2);
  // valueThunk / thrower: `length` 0, `name` "".
  const handlerMetaTypeIdx = ensureBuiltinFnMetaType(
    ctx,
    wrapper.structTypeIdx,
    wrapper.closureInfo,
    "promise:finallyhandler",
    "",
    1,
  );
  const thunkMetaTypeIdx = ensureBuiltinFnMetaType(
    ctx,
    wrapper.structTypeIdx,
    wrapper.closureInfo,
    "promise:finallythunk",
    "",
    0,
  );
  const handler = registerClosureType(ctx, "$__promise_finally_handler", handlerMetaTypeIdx);
  const thunk = registerClosureType(ctx, "$__promise_finally_thunk", thunkMetaTypeIdx);

  const invokeFuncIdx = mintDefinedFunc(ctx);
  const handlerFuncIdx = mintDefinedFunc(ctx);
  const thunkFuncIdx = mintDefinedFunc(ctx);
  const res: BodyRes = {
    ctx,
    promiseTypeIdx,
    rootTypeIdx,
    handlerTypeIdx: handler.typeIdx,
    handlerMetaTypeIdx,
    handlerFieldIdx: handler.fieldIdx,
    thunkTypeIdx: thunk.typeIdx,
    thunkMetaTypeIdx,
    thunkFieldIdx: thunk.fieldIdx,
    vecNewIdx: vec.newIdx,
    vecPushIdx: vec.pushIdx,
    applyIdx,
    externGetIdx,
    resolveValueIdx,
    handlerFuncIdx,
    thunkFuncIdx,
  };

  pushDefinedFunc(ctx, invokeFuncIdx, {
    name: INVOKE_FN,
    typeIdx: addFuncType(ctx, [EXTERNREF, EXTERNREF, EXTERNREF], [EXTERNREF]),
    locals: [
      { name: "thenFinally", type: EXTERNREF },
      { name: "catchFinally", type: EXTERNREF },
      { name: "args", type: EXTERNREF },
    ],
    body: buildInvokeBody(res),
    exported: false,
  });
  ctx.funcMap.set(INVOKE_FN, invokeFuncIdx);

  pushDefinedFunc(ctx, handlerFuncIdx, {
    name: HANDLER_FN,
    typeIdx: wrapper.liftedFuncTypeIdx,
    locals: [
      { name: "h", type: { kind: "ref_null", typeIdx: handler.typeIdx } },
      { name: "result", type: EXTERNREF },
      { name: "promise", type: EXTERNREF },
      { name: "fresh", type: { kind: "ref_null", typeIdx: promiseTypeIdx } },
      { name: "then", type: EXTERNREF },
      { name: "args", type: EXTERNREF },
    ],
    body: buildHandlerBody(res),
    exported: false,
  });
  ctx.funcMap.set(HANDLER_FN, handlerFuncIdx);

  pushDefinedFunc(ctx, thunkFuncIdx, {
    name: THUNK_FN,
    typeIdx: wrapper.liftedFuncTypeIdx,
    locals: [{ name: "t", type: { kind: "ref_null", typeIdx: thunk.typeIdx } }],
    body: buildThunkBody(res),
    exported: false,
  });
  ctx.funcMap.set(THUNK_FN, thunkFuncIdx);

  const runtime: FinallyInvokeRuntime = { invokeFuncIdx, thenClosure, rootTypeIdx, promiseTypeIdx };
  holder.__promiseFinallyInvoke = runtime;
  return runtime;
}

/** Function contexts currently emitting a site's native arm (the re-entry guard). */
const emittingNativeArm = new WeakSet<FunctionContext>();

/**
 * The `Promise.prototype` members a DIRECT reflective spelling
 * (`Promise.prototype.<m>.call(x, …)`) may route to the native member closure.
 * `finally` joins `then`/`catch` because its body now Invokes `then` off any
 * receiver — in exactly the modules where {@link tryEmitObservablePromiseFinally}
 * applies; elsewhere (wasi) the body still `ref.cast`s the receiver.
 */
export function isReflectivePromiseMember(ctx: CodegenContext, member: string): boolean {
  if (member === "then" || member === "catch") return true;
  return member === "finally" && ctx.standalone === true && ctx.wasi !== true && isStandalonePromiseActive(ctx);
}

/**
 * Hand-off from `emitStandalonePromiseFinally`. Emits the whole `finally`
 * site — `Get(promise, "then")`, then the native arm when the receiver is a
 * `$Promise` whose `then` is the intrinsic one, else the generic Invoke —
 * leaving the result externref on the stack. The native arm is produced by
 * RE-ENTERING `emitNative` (= `emitStandalonePromiseFinally`) over locals; the
 * re-entrant call finds its site in {@link emittingNativeArm} and returns
 * false, so it emits the pre-D7 lowering. Returns false, emitting nothing,
 * when the site is not in scope; the caller then emits that lowering itself.
 */
export function tryEmitObservablePromiseFinally(
  ctx: CodegenContext,
  fctx: FunctionContext,
  promiseInstrs: Instr[],
  onFinally: StandalonePromiseThenCallback | null,
  emitNative: (
    ctx: CodegenContext,
    fctx: FunctionContext,
    receiver: Instr[],
    onFinally: StandalonePromiseThenCallback | null,
  ) => void,
): boolean {
  if (emittingNativeArm.has(fctx)) return false;
  if (ctx.standalone !== true || ctx.wasi === true || !isStandalonePromiseActive(ctx)) return false;
  const rt = ensureFinallyInvokeRuntime(ctx, fctx);
  if (rt === null) return false;
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined) return false;

  const recvLocal = allocLocal(fctx, `__finally_recv_${fctx.locals.length}`, EXTERNREF);
  const onFinallyLocal = allocLocal(fctx, `__finally_on_${fctx.locals.length}`, EXTERNREF);
  const thenLocal = allocLocal(fctx, `__finally_then_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(...promiseInstrs, { op: "local.set", index: recvLocal });
  fctx.body.push(...(onFinally ? onFinally.instrs : canonicalUndefinedExternInstrs(ctx)));
  fctx.body.push({ op: "local.set", index: onFinallyLocal });
  fctx.body.push(
    { op: "local.get", index: recvLocal },
    ...stringConstantExternrefInstrs(ctx, "then"),
    { op: "call", funcIdx: externGetIdx },
    { op: "local.set", index: thenLocal },
  );

  const nativeArm: Instr[] = [];
  const outer = fctx.body;
  ctx.liveBodies.add(nativeArm);
  fctx.savedBodies.push(outer);
  fctx.body = nativeArm;
  emittingNativeArm.add(fctx);
  try {
    emitNative(
      ctx,
      fctx,
      [{ op: "local.get", index: recvLocal }],
      onFinally ? { ...onFinally, instrs: [{ op: "local.get", index: onFinallyLocal }] } : null,
    );
  } finally {
    emittingNativeArm.delete(fctx);
    fctx.savedBodies.pop();
    fctx.body = outer;
    ctx.liveBodies.delete(nativeArm);
  }

  // native ⇔ IsPromise(receiver) ∧ then === %Promise.prototype%.then
  fctx.body.push(
    { op: "local.get", index: recvLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: rt.promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        { op: "local.get", index: thenLocal },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: rt.rootTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: [
            { op: "local.get", index: thenLocal },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: rt.rootTypeIdx },
            ...pushBuiltinFnSingletonValueInstrs(ctx, rt.thenClosure),
            { op: "ref.eq" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: nativeArm,
      else: [
        { op: "local.get", index: recvLocal },
        { op: "local.get", index: thenLocal },
        { op: "local.get", index: onFinallyLocal },
        { op: "call", funcIdx: rt.invokeFuncIdx },
      ],
    },
  );
  return true;
}
