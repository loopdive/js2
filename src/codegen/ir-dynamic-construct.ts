// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 S3a) The host-free lane's `dyn.construct` support: one wrapper per
 * arity, `__ir_dyn_construct_<N>(callee, a0 … aN-1) -> externref`, whose body
 * is EXACTLY the sequence `tryCompileNativeConstructFromValue`
 * (`expressions/new-super.ts`) emits inline after it has evaluated a dynamic
 * constructor value and its arguments: a null prototype slot (the driver
 * falls back to `__extern_get(callee, "prototype")`), the `$__ta_ctor` arm
 * when the module constructs typed arrays dynamically, and the ordinary
 * `__native_construct_<N>` driver. The same arming calls run first, in the
 * same order, so an IR caller and a legacy caller of `new <value>(…)` share
 * every driver, guard and runtime object this module reserves.
 *
 * The wrapper exists only so the IR's dynamic-lowering handle can stay an
 * opaque `Instr[]` (no `FunctionContext`): the typed-array arm is a legacy
 * emitter that writes through one. It is built in `preregisterDynamicSupport`,
 * before any Phase-3 body, so no IR body drives a late import shift.
 */

import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { flushLateImportShifts } from "./shared.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { addFuncType, getOrRegisterTaCtorType, taCtorIdentityTestInstrs } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { MAX_NATIVE_CONSTRUCT_ARITY, reserveNativeConstructDriver } from "./native-construct.js";
import { reserveBuiltinCollectionDynConstruct } from "./builtin-collection-dyn-construct.js";
import {
  markClassValueConstructSite,
  moduleHasF64TypedConstructFormal,
  moduleHasRefTypedConstructFormal,
} from "./standalone-class-construct.js";
import { armExternF64ArgTypeGuard, armExternRefArgTypeGuard } from "./extern-arg-marshal.js";
import { armConstructIsConstructorGuard } from "./construct-is-constructor-guard.js";
import { buildInt8ArrayCarrierMatch, emitTaDynCtorConstructFromLocals } from "./dataview-native.js";
import { noJsHost } from "./js-errors.js";
import { isFunctionIntrinsicValueCallee } from "./closures/function-intrinsic-construct.js";
import { tracesToProxyConstructorValue } from "./proxy-value-provenance.js";
import { admitBoundValueConstruct } from "./construct-bound.js";
import { isRuntimeEvalCallableResultExpression } from "./expressions/runtime-eval-callable-result.js";
import { funcConstructorForCallee } from "./fnctor-ctor-decl.js";
import { resolvesToGlobalFunctionAlias } from "./expressions/eval-inline.js";
import { resolvesToNonConstructableValue } from "./expressions/non-constructable.js";

/** The largest arity `dyn.construct` admits: the fixed-arity driver family. */
export const IR_DYNAMIC_CONSTRUCT_MAX_ARITY = MAX_NATIVE_CONSTRUCT_ARITY;

export function irDynamicConstructHelperName(arity: number): string {
  return `__ir_dyn_construct_${arity}`;
}

/**
 * Selector predicate: is `new <callee>(…)` on this identifier the PLAIN
 * dynamic-value construct (the ordinary driver), with none of the legacy
 * special arms that choose a different lowering for the same syntax? Every
 * arm below is one `tryCompileNativeConstructFromValue` (or its dispatcher)
 * takes before the ordinary driver; a site any of them claims stays legacy.
 */
export function irDynamicConstructCalleeIsPlain(ctx: CodegenContext, callee: ts.Identifier): boolean {
  if (!noJsHost(ctx)) return false;
  if (ctx.classSet.has(callee.text) || ctx.externClasses.has(callee.text)) return false;
  if (funcConstructorForCallee(ctx, callee)) return false; // a compiled fnctor owns the typed-struct path
  if (resolvesToNonConstructableValue(ctx, callee)) return false; // the throwing path
  if (isFunctionIntrinsicValueCallee(ctx, callee)) return false; // (#6651 W2a) `%Function%` value
  if (tracesToProxyConstructorValue(ctx, callee)) return false; // (#5196 R3-0) Proxy value
  if (admitBoundValueConstruct(ctx, callee)) return false; // (#6651 W2b) bound value
  if (isRuntimeEvalCallableResultExpression(ctx, callee)) return false;
  if (ctx.runtimeEvalCallableBoundaryEnabled === true && resolvesToGlobalFunctionAlias(callee, ctx.oracle))
    return false;
  return true;
}

/**
 * Reserve (once per arity) the wrapper the IR `dyn.construct` lowering calls.
 * Returns the function index, or undefined off the host-free lanes.
 */
export function ensureIrDynamicConstructHelper(ctx: CodegenContext, arity: number): number | undefined {
  if (!noJsHost(ctx) || arity < 0 || arity > IR_DYNAMIC_CONSTRUCT_MAX_ARITY) return undefined;
  const name = irDynamicConstructHelperName(arity);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const externref: ValType = { kind: "externref" };
  const helper: FunctionContext = {
    name,
    params: [
      { name: "callee", type: externref },
      ...Array.from({ length: arity }, (_, i) => ({ name: `arg${i}`, type: externref })),
    ],
    locals: [],
    localMap: new Map(),
    returnType: externref,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  // The arming prelude of `tryCompileNativeConstructFromValue`, same order.
  ensureLateImport(ctx, "__extern_get", [externref, externref], [externref]);
  ensureLateImport(ctx, "__object_create", [externref], [externref]);
  flushLateImportShifts(ctx, helper);
  addStringConstantGlobal(ctx, "prototype");
  markClassValueConstructSite(ctx);
  armConstructIsConstructorGuard(ctx, helper);
  if (moduleHasRefTypedConstructFormal(ctx)) armExternRefArgTypeGuard(ctx, helper);
  if (moduleHasF64TypedConstructFormal(ctx)) armExternF64ArgTypeGuard(ctx, helper);
  const driverIdx = reserveNativeConstructDriver(ctx, arity, stringConstantExternrefInstrs(ctx, "prototype"));
  reserveBuiltinCollectionDynConstruct(ctx);

  // Legacy keeps the callee, the (null) prototype and every argument in
  // externref locals; mirror that so the typed-array arm reads the same shape.
  const calleeLocal = allocLocal(helper, "__nc_callee", externref);
  helper.body.push({ op: "local.get", index: 0 }, { op: "local.set", index: calleeLocal });
  const protoLocal = allocLocal(helper, "__nc_proto", externref);
  helper.body.push({ op: "ref.null.extern" }, { op: "local.set", index: protoLocal });
  const argLocals: number[] = [];
  for (let i = 0; i < arity; i++) {
    const argLocal = allocLocal(helper, `__nc_arg${i}`, externref);
    helper.body.push({ op: "local.get", index: 1 + i }, { op: "local.set", index: argLocal });
    argLocals.push(argLocal);
  }
  const nativeDriverCall: Instr[] = [
    { op: "local.get", index: calleeLocal },
    { op: "local.get", index: protoLocal },
    ...argLocals.map((argLocal): Instr => ({ op: "local.get", index: argLocal })),
    { op: "call", funcIdx: ctx.funcMap.get(`__native_construct_${arity}`) ?? driverIdx },
  ];
  if (ctx.moduleUsesDynTaView) {
    // (#4626 / #5383 S14) the runtime `$__ta_ctor` identity arm, verbatim.
    getOrRegisterTaCtorType(ctx);
    const descLocal = allocLocal(helper, "__nc_tadesc", { kind: "anyref" } as ValType);
    helper.body.push(
      { op: "local.get", index: calleeLocal },
      { op: "any.convert_extern" },
      { op: "local.set", index: descLocal },
    );
    const taArm: Instr[] = [];
    const savedBody = helper.body;
    helper.body = taArm;
    emitTaDynCtorConstructFromLocals(ctx, helper, descLocal, argLocals);
    helper.body = savedBody;
    const int8CarrierMatch = buildInt8ArrayCarrierMatch(ctx, descLocal, []);
    if (int8CarrierMatch.length > 0) {
      const taMatch = allocLocal(helper, "__nc_tamatch", { kind: "i32" });
      helper.body.push(...taCtorIdentityTestInstrs(ctx, [{ op: "local.get", index: descLocal }]));
      helper.body.push({ op: "local.set", index: taMatch });
      helper.body.push(
        ...buildInt8ArrayCarrierMatch(ctx, descLocal, [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: taMatch },
        ]),
      );
      helper.body.push({ op: "local.get", index: taMatch });
    } else {
      helper.body.push(...taCtorIdentityTestInstrs(ctx, [{ op: "local.get", index: descLocal }]));
    }
    helper.body.push({
      op: "if",
      blockType: { kind: "val", type: externref },
      then: taArm,
      else: nativeDriverCall,
    });
  } else {
    helper.body.push(...nativeDriverCall);
  }

  const typeIdx = addFuncType(
    ctx,
    helper.params.map((p) => p.type),
    [externref],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: helper.locals,
    body: helper.body,
    exported: false,
  });
  return funcIdx;
}
