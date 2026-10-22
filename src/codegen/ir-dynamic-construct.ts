// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 S3a/S3c) The host-free lane's `dyn.construct` support: one wrapper per
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
import { compileExpression, flushLateImportShifts, VOID_RESULT } from "./shared.js";
import { coerceType } from "./type-coercion.js";
import { emitUndefined, ensureLateImport } from "./expressions/late-imports.js";
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
import { buildExplicitNullThisElseArm, explicitNullReceiverLane } from "./explicit-null-receiver.js";
import { emitFnctorProtoGet } from "./expressions/fnctor-prototype.js";
import { identifierIsWrittenTo } from "./native-ordinary-instanceof.js";
import { ensureCurrentThisGlobal } from "./statements/nested-declarations.js";
import { isSelfGuardedConstructor, selfGuardedConstructorsLeaveFnctor } from "./helpers/self-guarded-constructor.js";
import { isStrictFunction } from "./helpers/is-strict-function.js";
import { emitGlobalObjectAsThis } from "./helpers/sloppy-this-global.js";
import {
  compileTemplateExpressionAsExternref,
  parseDetachedTemplate,
  publishReceiverHelper,
  receiverHelperContext,
} from "./helpers/template-wrapper.js";

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

// ---------------------------------------------------------------------------
// (#7106 S3c) The self-guarded constructor (test262's `Test262Error`:
// `if (!(this instanceof F)) return new F(m)`) as an IR-owned function. Its
// `new F(…)` sites use the wrapper above with F's function value; these two
// wrappers, each built from legacy's own emitters, give the IR the same
// receiver and the same prototype object legacy sees:
//
//  - `__ir_current_this_{sloppy,strict}() -> externref` — `compileThisKeyword`'s
//    `__current_this` rung: the installed receiver (the #4203 explicit-null
//    marker answered per strictness), else the unbound answer — the global
//    object for sloppy code, `undefined` for strict (§10.2.1.2 step 5).
//  - `__ir_instanceof_fn_<F>(externref) -> i32` — `tryEmitNativeUserCtorInstanceOf`'s
//    chain walk, `__isPrototypeOf(F.prototype, value)`, against the SAME
//    lazily-materialised per-function prototype global `new F()` links to.
// ---------------------------------------------------------------------------

export const IR_CURRENT_THIS_SLOPPY_HELPER = "__ir_current_this_sloppy";
export const IR_CURRENT_THIS_STRICT_HELPER = "__ir_current_this_strict";
const IR_INSTANCEOF_FN_PREFIX = "__ir_instanceof_fn_";

export function irInstanceOfFunctionHelperName(functionName: string): string {
  return `${IR_INSTANCEOF_FN_PREFIX}${functionName}`;
}

/** Collect what `emit` pushes into a detached sequence. */
function captureReceiverSequence(helper: FunctionContext, emit: () => void): Instr[] {
  const outer = helper.body;
  const captured: Instr[] = [];
  helper.body = captured;
  emit();
  helper.body = outer;
  return captured;
}

/**
 * Reserve (once per strictness) the `this` wrapper `dyn.current_this` calls.
 * Returns the function index, or undefined off the host-free lanes.
 */
export function ensureIrCurrentThisHelper(ctx: CodegenContext, strict: boolean): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const name = strict ? IR_CURRENT_THIS_STRICT_HELPER : IR_CURRENT_THIS_SLOPPY_HELPER;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const externref: ValType = { kind: "externref" };
  const helper = receiverHelperContext(name, [], externref);
  const thisGlobal = ensureCurrentThisGlobal(ctx);
  const receiver = allocLocal(helper, "__receiver", externref);
  // `emitUnboundThis` / `emitExplicitNullThis`, with the strictness decided by
  // the IR-owned function rather than by an AST position.
  const unbound = captureReceiverSequence(helper, () =>
    strict ? emitUndefined(ctx, helper) : emitGlobalObjectAsThis(ctx, helper),
  );
  const explicitNull = captureReceiverSequence(helper, () =>
    strict ? helper.body.push({ op: "ref.null.extern" }) : emitGlobalObjectAsThis(ctx, helper),
  );
  const yieldReceiver: Instr[] = [{ op: "local.get", index: receiver }];
  // The marker can only arrive where legacy installs it; testing for it in a
  // module that never does is dead code, never a different answer.
  const installed = explicitNullReceiverLane(ctx)
    ? (buildExplicitNullThisElseArm(ctx, receiver, explicitNull) ?? yieldReceiver)
    : yieldReceiver;
  helper.body.push(
    { op: "global.get", index: thisGlobal },
    { op: "local.tee", index: receiver },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "val", type: externref }, then: unbound, else: installed },
  );
  flushLateImportShifts(ctx, null);
  return publishReceiverHelper(ctx, helper, [externref]);
}

/**
 * Reserve (once per function) the `value instanceof F` wrapper
 * `dyn.instanceof_fn` calls. Returns the function index, or undefined when the
 * chain walk is unavailable on this lane.
 */
export function ensureIrInstanceOfFunctionHelper(ctx: CodegenContext, functionName: string): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const name = irInstanceOfFunctionHelperName(functionName);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  // The selector admits only constructors that never get the bespoke fnctor
  // struct (`isSelfGuardedConstructor`), so legacy's `ref.test` arm is absent
  // by construction.
  if (ctx.structMap.has(`__fnctor_${functionName}`)) {
    throw new Error(`ir/function-receiver: ${functionName} has a fnctor struct; instanceof would miss it (#7106 S3c)`);
  }
  const externref: ValType = { kind: "externref" };
  const isProtoOf = ensureLateImport(ctx, "__isPrototypeOf", [externref, externref], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, null);
  if (isProtoOf === undefined) return undefined;
  const helper = receiverHelperContext(name, [{ name: "value", type: externref }], { kind: "i32" });
  if (!emitFnctorProtoGet(ctx, helper, functionName)) return undefined;
  helper.body.push(
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: ctx.funcMap.get("__isPrototypeOf") ?? isProtoOf },
  );
  flushLateImportShifts(ctx, null);
  return publishReceiverHelper(ctx, helper, [{ kind: "i32" }]);
}

/**
 * Selector/lowering predicate: may the IR read `this` inside `fn`, and with
 * which strictness? `undefined` = not on this lane / not this shape.
 */
export function irFunctionThisStrictness(ctx: CodegenContext, fn: ts.FunctionDeclaration): boolean | undefined {
  if (!selfGuardedConstructorsLeaveFnctor(ctx) || ctx.fast) return undefined;
  if (!isSelfGuardedConstructor(fn)) return undefined;
  return isStrictFunction(fn, ctx.inferModuleStrictArguments);
}

/**
 * Is `ident` (a `new` callee or an `instanceof` right operand) a self-guarded
 * constructor the IR may use as a value — the declaration legacy keeps out of
 * the fnctor machinery, never reassigned, never a generator?
 */
export function irSelfGuardedConstructorValue(ctx: CodegenContext, ident: ts.Identifier): boolean {
  if (!selfGuardedConstructorsLeaveFnctor(ctx) || ctx.fast) return false;
  const decl = ctx.oracle.valueDeclarationOf(ident);
  if (decl === undefined || !isSelfGuardedConstructor(decl) || decl.asteriskToken !== undefined) return false;
  return !identifierIsWrittenTo(ident.getSourceFile(), ident.text);
}

// ---------------------------------------------------------------------------
// (#7106 Stage 4, #7119) `__ir_dyn_mcall_<m>_<n>(recv, a0, …) -> externref` —
// the IR's built-in (or wider than one-argument) method call on a DYNAMIC
// receiver on the non-fast host-free lanes.
//
// The generic `__ir_dyn_method_call_N` → `__extern_method_call` route answers
// `undefined` for every receiver the native object runtime has no brand arm
// for (a string, a number, a vec …): it dispatches open-`$Object` methods
// only. Legacy, for the same `any`-receiver call site, emits brand dispatch by
// method name — the native string arm, `__extern_toString`, the reflective
// `.call`/`.apply`, the vec push/pop arms, the closed-method dispatcher
// `__call_m_<m>_<n>`. This wrapper is that emission plus the one step legacy's
// brand arms skip. Once per (method, arity) it compiles, with legacy's own
// emitters over a fixed template whose only free names are its externref
// parameters (the dynamic carrier of these lanes, which is legacy's `any`):
//
//   f = recv.m                            // the call's single [[Get]]
//   IsCallable(f) ? f.call(recv, a0, …)   // an own / inherited method value
//                 : recv.m(a0, …)         // legacy's any-receiver brand dispatch
//
// Legacy's brand arms do not consult the receiver for a built-in name — its
// `join` on any receiver is the generic array-like algorithm, so
// `{ join() {…} }.join()` and a constructor-prototype `join` were missed
// (measured). A built-in method of a primitive or vec receiver has no runtime
// value, so the read answers undefined there and the brand arm runs.
//
// The template is a runtime operation, not source: its text is a function of
// (method, arity) alone, parsed into its own detached file, so legacy's checker
// queries on it answer "unknown" — the facts of an `any` call site. The
// callable test is emitted directly (`__is_callable`): legacy folds a template
// `typeof` on a detached node statically (measured: `i32.const 0`).
// ---------------------------------------------------------------------------

const DMC_RECEIVER = "__ir_dmc_recv";
const DMC_METHOD_VALUE = "__ir_dmc_fn";
const dmcArgumentName = (index: number): string => `__ir_dmc_arg${index}`;

/** The host-free lanes whose dynamic carrier is legacy's `any` externref. */
export function irDynamicMethodCallWrapperLane(ctx: CodegenContext): boolean {
  return noJsHost(ctx) && !ctx.fast;
}

/** `recv.m`, `f.call(recv, a0, …)` and `recv.m(a0, …)`, parsed in a detached file. */
function dynamicMethodCallTemplate(
  method: string,
  arity: number,
): readonly [ts.Expression, ts.Expression, ts.Expression] {
  const args = Array.from({ length: arity }, (_, index) => dmcArgumentName(index));
  const text =
    `function __ir_dmc(${[DMC_RECEIVER, ...args].join(", ")}) {\n` +
    `  ${DMC_RECEIVER}.${method};\n` +
    `  ${DMC_METHOD_VALUE}.call(${[DMC_RECEIVER, ...args].join(", ")});\n` +
    `  ${DMC_RECEIVER}.${method}(${args.join(", ")});\n` +
    `}`;
  const [read, own, branded] = parseDetachedTemplate("__ir_dyn_mcall.js", text, 3);
  return [read!, own!, branded!];
}

/**
 * Reserve (once per method/arity) the wrapper `name` — the IR names it
 * (`ir/dynamic-method-call-names.ts`), and only an identifier-safe `method`
 * reaches here. Returns its function index, or undefined off the wrapper lanes
 * or when legacy's emitter reports an error for the template (its diagnostics
 * are dropped).
 */
export function ensureIrDynamicMethodCallHelper(
  ctx: CodegenContext,
  name: string,
  method: string,
  arity: number,
): number | undefined {
  if (!irDynamicMethodCallWrapperLane(ctx) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(method)) return undefined;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const externref: ValType = { kind: "externref" };
  const helper = receiverHelperContext(
    name,
    [DMC_RECEIVER, ...Array.from({ length: arity }, (_, index) => dmcArgumentName(index))].map((param) => ({
      name: param,
      type: externref,
    })),
    externref,
  );
  const methodValue = allocLocal(helper, DMC_METHOD_VALUE, externref);
  const [read, own, branded] = dynamicMethodCallTemplate(method, arity);
  const errorsBefore = ctx.errors.length;

  ensureLateImport(ctx, "__is_callable", [externref], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, helper);
  compileTemplateExpressionAsExternref(ctx, helper, read);
  helper.body.push({ op: "local.set", index: methodValue });
  const isCallable = ctx.funcMap.get("__is_callable");
  if (isCallable === undefined) throw new Error("ir/dynamic-method-call: __is_callable is not registered");
  helper.body.push({ op: "local.get", index: methodValue }, { op: "call", funcIdx: isCallable });

  // Each completed sequence stays parked in `savedBodies` until the join, so a
  // late import registered by a later branch still shifts its call indices;
  // the live body is never also parked (one shift walk per sequence).
  const outer = helper.body;
  const parked: Instr[][] = [outer];
  helper.savedBodies.push(outer);
  const branches = [own, branded].map((expression) => {
    helper.body = [];
    compileTemplateExpressionAsExternref(ctx, helper, expression);
    const branch = helper.body;
    helper.savedBodies.push(branch);
    parked.push(branch);
    return branch;
  });
  helper.body = [];
  flushLateImportShifts(ctx, helper);
  helper.savedBodies.splice(helper.savedBodies.length - parked.length, parked.length);
  helper.body = outer;
  helper.body.push({ op: "if", blockType: { kind: "val", type: externref }, then: branches[0]!, else: branches[1]! });

  if (ctx.errors.length !== errorsBefore) {
    ctx.errors.length = errorsBefore;
    return undefined;
  }
  flushLateImportShifts(ctx, helper);
  return publishReceiverHelper(ctx, helper, [externref]);
}
