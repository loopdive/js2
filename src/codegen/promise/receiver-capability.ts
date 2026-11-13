// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7089) The `this`-reading Promise statics on the native `$Promise` carrier
// (native-first / default gc, standalone, WASI): `Promise.try` and
// `Promise.withResolvers` called with an explicit receiver, plus the TS-cast
// spellings of the combinator `.call` forms.
//
//   Promise.withResolvers.call(C)         §27.2.4.8  NewPromiseCapability(C) → { promise, resolve, reject }
//   Promise.try(fn, ...args)              §27.2.4.9  C = %Promise%
//   Promise.try.call(C, fn, ...args)      §27.2.4.9  NewPromiseCapability(C); Call(fn, undefined, args);
//                                                    abrupt → Call(reject, «e»), else Call(resolve, «v»)
//   (Promise.all as any).call(C, …)       routed to the #6651 D3/D4 class-receiver providers
//
// NewPromiseCapability(C) has two implementations behind one capability record
// (`$__promise_custom_capability`, the struct the D1–D4 executor fills):
//   - C = %Promise% → `__promise_intrinsic_capability` (the pending promise and
//     settle closures `__promise_with_resolvers` builds; no executor runs);
//   - C a compiled class (including `class X extends Promise`) or an ordinary
//     function → Construct(C, «executor») through the native construct driver,
//     exactly as D4 (`promise-class-receiver-settle.ts`) does, then the
//     IsCallable checks on both captured slots (§27.2.1.5 steps 8-9).
// Any other receiver declines (the call keeps its previous lowering); a
// statically non-constructor receiver already took the IsConstructor TypeError
// in promise-static-call-typeerror.ts.
//
// Every semantic step lives here or in the runtime bodies; the direct-AST
// call site only routes (plan/method/ir-only-development-freeze.md).

import type { Instr, ValType } from "../../ir/types.js";
import { buildTargetTaggedTry } from "../../wasm/physical/exception-control.js";
import { ts } from "../../ts-api.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import { getFuncRefWrapperRootTypeIdx } from "../closures/funcref-wrapper-types.js";
import { allocLocal } from "../context/locals.js";
import { rollbackSpeculative, snapshotSpeculative } from "../context/speculative.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { resolvesToNamedAmbientGlobal } from "../expressions/non-constructable.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import {
  isOrdinaryFunctionCtorArg,
  reserveConstructDriver,
  resolveCompiledClassReceiver,
  tryEmitClassReceiverCombinatorCall,
} from "../promise-class-receiver-drive.js";
import { shadowsGlobalValueName, tryEmitClassReceiverSettleCall } from "../promise-class-receiver-settle.js";
import {
  buildCustomCapabilityExecutorInstrs,
  customCapabilityTypeError,
  ensureCustomCapabilityRuntime,
  isNativeCombinatorMethod,
  type CustomCapabilityRuntime,
} from "../promise-combinators.js";
import { ensureExnTag } from "../registry/imports.js";
import { coerceType, compileExpression } from "../shared.js";
import type { InnerResult } from "../shared.js";
import {
  ensurePromiseIntrinsicCapability,
  ensurePromiseWithResolvers,
  tryEmitNativePromiseWithResolvers,
} from "./with-resolvers.js";

const EXTERNREF: ValType = { kind: "externref" };

/** Strip parentheses and TS-only wrappers (`as`, `!`, `<T>x`, `satisfies`). */
function peel(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function isAmbientPromise(ctx: CodegenContext, expr: ts.Expression): boolean {
  const e = peel(expr);
  return ts.isIdentifier(e) && e.text === "Promise" && resolvesToNamedAmbientGlobal(ctx, e, "Promise");
}

/** The receiver kind NewPromiseCapability(C) is built for, or undefined to decline. */
function classifyReceiver(
  ctx: CodegenContext,
  receiver: ts.Expression | undefined,
): "intrinsic" | "custom" | undefined {
  if (receiver === undefined) return "intrinsic";
  if (isAmbientPromise(ctx, receiver)) return "intrinsic";
  const ctor = peel(receiver);
  if (shadowsGlobalValueName(ctor)) return undefined;
  if (resolveCompiledClassReceiver(ctx, ctor) !== undefined || isOrdinaryFunctionCtorArg(ctx, ctor)) return "custom";
  return undefined;
}

interface CapabilityLocals {
  ctor: number;
  cap: number;
  promise: number;
}

/** Compile `e` (or push `absent`) as an externref. */
function pushExtern(ctx: CodegenContext, fctx: FunctionContext, e: ts.Expression | undefined, absent: Instr[]): void {
  if (e === undefined) {
    fctx.body.push(...absent);
    return;
  }
  const t = compileExpression(ctx, fctx, e, EXTERNREF);
  if (t === null) fctx.body.push({ op: "ref.null.extern" });
  else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
}

/** Evaluate and discard trailing arguments the builtin ignores. */
function evaluateAndDrop(ctx: CodegenContext, fctx: FunctionContext, args: readonly ts.Expression[]): void {
  for (const argument of args) {
    if (compileExpression(ctx, fctx, argument) !== null) fctx.body.push({ op: "drop" });
  }
}

/**
 * Emit NewPromiseCapability(C): `L.cap` holds the record (resolve, reject), `L.promise` the
 * promise. For a custom C, `L.ctor` already holds C. Must run after every argument is
 * evaluated: arming the construct driver may register late imports.
 */
function emitNewPromiseCapability(
  ctx: CodegenContext,
  fctx: FunctionContext,
  kind: "intrinsic" | "custom",
  capability: CustomCapabilityRuntime,
  L: CapabilityLocals,
): void {
  const fresh: Instr[] = [
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: capability.stateTypeIdx },
    { op: "local.set", index: L.cap },
  ];
  if (kind === "intrinsic") {
    fctx.body.push(
      ...fresh,
      { op: "local.get", index: L.cap },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: ctx.funcMap.get("__promise_intrinsic_capability")! },
      { op: "local.set", index: L.promise },
    );
    return;
  }
  const driverIdx = reserveConstructDriver(ctx, fctx);
  const wrapperRoot = getFuncRefWrapperRootTypeIdx(ctx)!;
  const isCallable = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: L.cap },
    { op: "struct.get", typeIdx: capability.stateTypeIdx, fieldIdx },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: wrapperRoot },
  ];
  fctx.body.push(
    ...fresh,
    { op: "local.get", index: L.ctor },
    { op: "ref.null.extern" },
    ...buildCustomCapabilityExecutorInstrs(capability, L.cap),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: ctx.funcMap.get("__native_construct_1") ?? driverIdx },
    { op: "local.set", index: L.promise },
    ...isCallable(0),
    ...isCallable(1),
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: [], else: customCapabilityTypeError(ctx) },
  );
}

/** Shared registration; undefined (with nothing registered that matters) when unavailable. */
function prepare(
  ctx: CodegenContext,
  fctx: FunctionContext,
  kind: "intrinsic" | "custom",
): { capability: CustomCapabilityRuntime; L: CapabilityLocals } | undefined {
  const capability = ensureCustomCapabilityRuntime(ctx);
  if (!capability || getFuncRefWrapperRootTypeIdx(ctx) === undefined) return undefined;
  if (kind === "intrinsic" && ensurePromiseIntrinsicCapability(ctx, capability.stateTypeIdx) === undefined)
    return undefined;
  const local = (name: string, type: ValType): number => allocLocal(fctx, `__prc_${name}_${fctx.locals.length}`, type);
  return {
    capability,
    L: {
      ctor: local("ctor", EXTERNREF),
      cap: local("cap", { kind: "ref_null", typeIdx: capability.stateTypeIdx }),
      promise: local("promise", EXTERNREF),
    },
  };
}

/** `Promise.withResolvers.call(C, ...ignored)`. */
function emitWithResolversCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  rest: readonly ts.Expression[],
): InnerResult | undefined {
  const kind = classifyReceiver(ctx, receiver);
  if (kind === undefined) return undefined;
  if (kind === "intrinsic") {
    // C = %Promise%: the #7090 runtime function, byte-identical to the direct call.
    const funcIdx = ensurePromiseWithResolvers(ctx);
    if (funcIdx === undefined) return undefined;
    evaluateAndDrop(ctx, fctx, rest);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__promise_with_resolvers")! });
    return EXTERNREF;
  }
  const snap = snapshotSpeculative(ctx, fctx);
  // Registration strictly precedes emission: `ensurePromiseWithResolvers` registers the object
  // runtime and the three key strings this lowering also uses.
  const prepared = ensurePromiseWithResolvers(ctx) === undefined ? undefined : prepare(ctx, fctx, kind);
  const newObj = ctx.funcMap.get("__new_plain_object");
  const externSet = ctx.funcMap.get("__extern_set");
  if (!prepared || newObj === undefined || externSet === undefined) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }
  const { capability, L } = prepared;
  pushExtern(ctx, fctx, receiver, []);
  fctx.body.push({ op: "local.set", index: L.ctor });
  evaluateAndDrop(ctx, fctx, rest);
  emitNewPromiseCapability(ctx, fctx, kind, capability, L);
  const obj = allocLocal(fctx, `__prc_obj_${fctx.locals.length}`, EXTERNREF);
  const define = (key: "promise" | "resolve" | "reject", value: Instr[]): Instr[] => [
    { op: "local.get", index: obj },
    ...stringConstantExternrefInstrs(ctx, key),
    ...value,
    { op: "call", funcIdx: ctx.funcMap.get("__extern_set")! },
  ];
  const slot = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: L.cap },
    { op: "struct.get", typeIdx: capability.stateTypeIdx, fieldIdx },
  ];
  fctx.body.push(
    { op: "call", funcIdx: ctx.funcMap.get("__new_plain_object")! },
    { op: "local.set", index: obj },
    ...define("promise", [{ op: "local.get", index: L.promise }]),
    ...define("resolve", slot(0)),
    ...define("reject", slot(1)),
    { op: "local.get", index: obj },
  );
  return EXTERNREF;
}

/** `Promise.try(fn, ...args)` (receiver undefined ⇒ %Promise%) / `Promise.try.call(C, fn, ...args)`. */
function emitPromiseTry(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression | undefined,
  callback: ts.Expression | undefined,
  args: readonly ts.Expression[],
): InnerResult | undefined {
  const kind = classifyReceiver(ctx, receiver);
  if (kind === undefined) return undefined;
  const snap = snapshotSpeculative(ctx, fctx);
  const vec = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const undefinedValue = canonicalUndefinedExternInstrs(ctx);
  const tagIdx = ensureExnTag(ctx);
  const prepared = prepare(ctx, fctx, kind);
  if (!prepared || vec.newIdx === undefined || vec.pushIdx === undefined || applyIdx === undefined) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }
  const { capability, L } = prepared;
  const local = (name: string, type: ValType): number => allocLocal(fctx, `__prt_${name}_${fctx.locals.length}`, type);
  const fn = local("fn", EXTERNREF);
  const argv = local("argv", EXTERNREF);
  const value = local("value", EXTERNREF);
  const ok = local("ok", { kind: "i32" });

  // Argument evaluation (C, callbackfn, then the rest) completes before the builtin runs.
  if (kind === "custom") {
    pushExtern(ctx, fctx, receiver, []);
    fctx.body.push({ op: "local.set", index: L.ctor });
  }
  pushExtern(ctx, fctx, callback, undefinedValue);
  fctx.body.push(
    { op: "local.set", index: fn },
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: argv },
  );
  for (const argument of args) {
    fctx.body.push({ op: "local.get", index: argv });
    pushExtern(ctx, fctx, argument, undefinedValue);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! });
  }
  // (`Promise.try.call(Promise, …)` skips the receiver: it is the pure ambient identifier.)

  emitNewPromiseCapability(ctx, fctx, kind, capability, L);
  // Re-read every index AFTER the construct driver's arming: it may have shifted functions.
  const undef = canonicalUndefinedExternInstrs(ctx);
  const apply = ctx.funcMap.get("__apply_closure")!;
  const objvecNew = ctx.funcMap.get("__objvec_new")!;
  const objvecPush = ctx.funcMap.get("__objvec_push")!;
  fctx.body.push(
    // status = Completion(Call(callbackfn, undefined, args))
    buildTargetTaggedTry(
      ctx,
      { kind: "empty" },
      [
        { op: "local.get", index: fn },
        ...undef,
        { op: "local.get", index: argv },
        { op: "call", funcIdx: apply },
        { op: "local.set", index: value },
        { op: "i32.const", value: 1 },
        { op: "local.set", index: ok },
      ],
      [
        {
          tagIdx,
          body: [
            { op: "local.set", index: value },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: ok },
          ],
        },
      ],
    ),
    // ? Call(resolve | reject, undefined, «status.[[Value]]») — outside the try: a throwing
    // settle function propagates, as the spec's `?` does.
    { op: "local.get", index: ok },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [
        { op: "local.get", index: L.cap },
        { op: "struct.get", typeIdx: capability.stateTypeIdx, fieldIdx: 0 },
      ],
      else: [
        { op: "local.get", index: L.cap },
        { op: "struct.get", typeIdx: capability.stateTypeIdx, fieldIdx: 1 },
      ],
    },
    ...undef,
    { op: "call", funcIdx: objvecNew },
    { op: "local.set", index: argv },
    { op: "local.get", index: argv },
    { op: "local.get", index: value },
    { op: "call", funcIdx: objvecPush },
    { op: "local.get", index: argv },
    { op: "call", funcIdx: apply },
    { op: "drop" },
    { op: "local.get", index: L.promise },
  );
  return EXTERNREF;
}

/**
 * Route the receiver-reading Promise statics to the native provider. Returns undefined —
 * having emitted nothing — when the native carrier is off or the shape is not admitted.
 */
export function tryEmitNativePromiseReceiverCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  const direct = tryEmitNativePromiseWithResolvers(ctx, fctx, expr, propAccess);
  if (direct !== undefined) return direct;
  if (expr.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  if (propAccess.name.text === "try" && isAmbientPromise(ctx, propAccess.expression)) {
    return emitPromiseTry(ctx, fctx, undefined, expr.arguments[0], expr.arguments.slice(1));
  }
  if (propAccess.name.text !== "call") return undefined;
  const target = peel(propAccess.expression);
  if (!ts.isPropertyAccessExpression(target) || !isAmbientPromise(ctx, target.expression)) return undefined;
  const [receiver, ...rest] = expr.arguments;
  if (receiver === undefined) return undefined;
  const method = target.name.text;
  if (method === "withResolvers") return emitWithResolversCall(ctx, fctx, receiver, rest);
  if (method === "try") return emitPromiseTry(ctx, fctx, receiver, rest[0], rest.slice(1));
  // The plain `Promise.<m>.call(C, …)` spelling keeps its dedicated arms in
  // call-namespace-static.ts; only a TS-cast spelling those arms cannot see is routed here.
  const plain = target === propAccess.expression && ts.isIdentifier(target.expression);
  if (plain || isAmbientPromise(ctx, receiver)) return undefined;
  if (isNativeCombinatorMethod(method)) return tryEmitClassReceiverCombinatorCall(ctx, fctx, expr, method);
  if (method === "resolve" || method === "reject") return tryEmitClassReceiverSettleCall(ctx, fctx, expr, method);
  return undefined;
}
