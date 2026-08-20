// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Standalone provider for the exact checker-certified Promise delay.
 *
 * The source proof lives in `ir/promise-delay.ts`; this file owns only the
 * target projection. The certified executor has one effect: register one
 * zero-argument timer callback which resolves the newly-created Promise with
 * the owner's grounded numeric value. Emitting that relationship directly
 * removes the mechanically-redundant executor closure without changing
 * Promise constructor semantics: timer-registration throws are caught and
 * reject the same pending Promise, and the shared settle helper supplies the
 * one-shot guard and reaction scheduling.
 */

import type { Instr, LocalDef, ValType } from "../ir/types.js";
import { IR_NATIVE_PROMISE_DELAY_FN } from "../ir/promise-delay-lowering.js";
import { PROMISE_STATE_PENDING, ensureAsyncDriveRuntime } from "./async-scheduler.js";
import { getOrCreateFuncRefWrapperTypes } from "./closures.js";
import { closureArityField, closureBagField, closureBagInitInstr } from "./closures/funcref-wrapper-types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureExnTag } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry } from "./shared.js";

const TIMER_IMPORT = "__timer_set_timeout";

interface NativePromiseDelayProviderState {
  readonly providerFuncIdx: number;
  readonly timerCallbackFuncIdx: number;
  readonly callbackCaptureTypeIdx: number;
}

type NativePromiseDelayContext = CodegenContext & {
  __irNativePromiseDelayProvider?: NativePromiseDelayProviderState;
};

function requireUnoccupiedProviderName(ctx: CodegenContext): void {
  const existing = ctx.funcMap.get(IR_NATIVE_PROMISE_DELAY_FN);
  if (existing !== undefined) {
    throw new Error(
      `standalone IR Promise-delay provider name ${IR_NATIVE_PROMISE_DELAY_FN} is already occupied by function ${existing}`,
    );
  }
}

function hasUnoccupiedProviderName(ctx: CodegenContext): boolean {
  return (
    !ctx.funcMap.has(IR_NATIVE_PROMISE_DELAY_FN) &&
    !ctx.mod.functions.some(({ name }) => name === IR_NATIVE_PROMISE_DELAY_FN) &&
    !ctx.mod.imports.some(({ name, desc }) => name === IR_NATIVE_PROMISE_DELAY_FN && desc.kind === "func")
  );
}

/** Prove that this context already owns the exact cached native provider. */
export function hasExactIrNativePromiseDelayProvider(ctx: CodegenContext): boolean {
  const cached = (ctx as NativePromiseDelayContext).__irNativePromiseDelayProvider;
  if (!cached || ctx.funcMap.get(IR_NATIVE_PROMISE_DELAY_FN) !== cached.providerFuncIdx) return false;
  const func = definedFuncAt(ctx, cached.providerFuncIdx);
  const signature = funcSignatureOf(ctx, cached.providerFuncIdx);
  return (
    func?.name === IR_NATIVE_PROMISE_DELAY_FN &&
    signature?.params.length === 2 &&
    signature.params[0]?.kind === "f64" &&
    signature.params[1]?.kind === "f64" &&
    signature.results.length === 1 &&
    signature.results[0]?.kind === "externref"
  );
}

/** Fail-closed preflight for absent or already-materialized provider state. */
export function canEnsureIrNativePromiseDelayProvider(ctx: CodegenContext): boolean {
  const cached = (ctx as NativePromiseDelayContext).__irNativePromiseDelayProvider;
  return cached ? hasExactIrNativePromiseDelayProvider(ctx) : hasUnoccupiedProviderName(ctx);
}

/**
 * Register and return `(ms: f64, value: f64) -> externref<$Promise>`.
 *
 * All shifting/runtime registrations happen before either provider function is
 * minted. The resulting handles therefore live in the append-only function
 * regime and are safe to observe through the Program ABI before prepared
 * component sealing.
 */
export function ensureIrNativePromiseDelayProvider(ctx: CodegenContext): number {
  const cached = (ctx as NativePromiseDelayContext).__irNativePromiseDelayProvider;
  if (cached) {
    if (!hasExactIrNativePromiseDelayProvider(ctx)) {
      throw new Error("cached standalone IR Promise-delay provider lost its exact function ABI or allocator");
    }
    return cached.providerFuncIdx;
  }
  if (!ctx.standalone || !ctx.nativeStrings || ctx.wasi) {
    throw new Error("native Promise-delay provider requires the standalone native-string target");
  }
  requireUnoccupiedProviderName(ctx);

  // These registrations may allocate types/functions (and, on other target
  // profiles, imports). Complete them before reading any baked handle below.
  addUnionImportsViaRegistry(ctx);
  const exnTagIdx = ensureExnTag(ctx);
  const runtime = ensureAsyncDriveRuntime(ctx);
  const callbackWrapper = getOrCreateFuncRefWrapperTypes(ctx, [], [], "host-one-shot");
  const timerFuncIdx = ctx.funcMap.get(TIMER_IMPORT);
  const boxNumberFuncIdx = ctx.funcMap.get("__box_number");
  const resolveValueFuncIdx = ctx.funcMap.get("__promise_resolve_value");
  if (
    !callbackWrapper ||
    timerFuncIdx === undefined ||
    boxNumberFuncIdx === undefined ||
    resolveValueFuncIdx === undefined
  ) {
    throw new Error(
      "standalone IR Promise-delay provider is missing its timer, numeric-box, closure, or Promise-settlement dependency",
    );
  }

  const callbackCaptureTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__ir_promise_delay_timer_cap",
    fields: [
      { name: "func", type: { kind: "funcref" }, mutable: false },
      closureArityField(),
      closureBagField(),
      { name: "promise", type: { kind: "ref", typeIdx: runtime.promiseTypeIdx }, mutable: false },
      { name: "value", type: { kind: "f64" }, mutable: false },
    ],
    superTypeIdx: callbackWrapper.structTypeIdx,
  });

  const timerCallbackFuncIdx = mintDefinedFunc(ctx);
  const timerCallbackBody: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: callbackCaptureTypeIdx },
    { op: "struct.get", typeIdx: callbackCaptureTypeIdx, fieldIdx: 3 },
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: callbackCaptureTypeIdx },
    { op: "struct.get", typeIdx: callbackCaptureTypeIdx, fieldIdx: 4 },
    { op: "call", funcIdx: boxNumberFuncIdx },
    { op: "call", funcIdx: resolveValueFuncIdx },
    { op: "drop" },
  ];
  pushDefinedFunc(ctx, timerCallbackFuncIdx, {
    name: "__ir_promise_delay_timer_callback",
    typeIdx: callbackWrapper.liftedFuncTypeIdx,
    locals: [],
    body: timerCallbackBody,
    exported: false,
  });

  const f64: ValType = { kind: "f64" };
  const externref: ValType = { kind: "externref" };
  const providerTypeIdx = addFuncType(ctx, [f64, f64], [externref], "$__ir_promise_delay_native_type");
  const providerFuncIdx = mintDefinedFunc(ctx);
  const promiseLocal = 2;
  const reasonLocal = 3;
  const providerLocals: LocalDef[] = [
    { name: "$promise", type: { kind: "ref", typeIdx: runtime.promiseTypeIdx } },
    { name: "$reason", type: externref },
  ];
  const timerRegistration: Instr[] = [
    { op: "ref.func", funcIdx: timerCallbackFuncIdx },
    { op: "i32.const", value: 0 },
    closureBagInitInstr(),
    { op: "local.get", index: promiseLocal },
    { op: "local.get", index: 1 },
    { op: "struct.new", typeIdx: callbackCaptureTypeIdx },
    { op: "extern.convert_any" },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: boxNumberFuncIdx },
    { op: "call", funcIdx: timerFuncIdx },
    { op: "drop" },
  ];
  const providerBody: Instr[] = [
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: runtime.promiseTypeIdx },
    { op: "local.set", index: promiseLocal },
    {
      op: "try",
      blockType: { kind: "empty" },
      body: timerRegistration,
      catches: [
        {
          tagIdx: exnTagIdx,
          body: [
            { op: "local.set", index: reasonLocal },
            { op: "local.get", index: promiseLocal },
            { op: "local.get", index: reasonLocal },
            { op: "call", funcIdx: runtime.rejectFuncIdx },
            { op: "drop" },
          ],
        },
      ],
      // A JavaScript timer provider can throw a foreign host exception rather
      // than the module's tagged `throw` payload. The Promise constructor must
      // still return a rejected Promise instead of leaking that exception
      // synchronously. No host exception-value import is introduced here: the
      // rejection reason is the native null/undefined boundary sentinel.
      catchAll: [
        { op: "local.get", index: promiseLocal },
        { op: "ref.null.extern" },
        { op: "call", funcIdx: runtime.rejectFuncIdx },
        { op: "drop" },
      ],
    },
    { op: "local.get", index: promiseLocal },
    { op: "extern.convert_any" },
  ];
  ctx.funcMap.set(IR_NATIVE_PROMISE_DELAY_FN, providerFuncIdx);
  pushDefinedFunc(ctx, providerFuncIdx, {
    name: IR_NATIVE_PROMISE_DELAY_FN,
    typeIdx: providerTypeIdx,
    locals: providerLocals,
    body: providerBody,
    exported: false,
  });

  if (!definedFuncAt(ctx, providerFuncIdx)) {
    throw new Error("standalone IR Promise-delay provider failed to occupy its minted function handle");
  }
  ctx.requiresStandaloneTimerCallbackDispatch = true;
  (ctx as NativePromiseDelayContext).__irNativePromiseDelayProvider = {
    providerFuncIdx,
    timerCallbackFuncIdx,
    callbackCaptureTypeIdx,
  };
  return providerFuncIdx;
}
