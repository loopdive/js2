// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster D, slice D4) `Promise.resolve.call(C, x)` / `Promise.reject.call(C, r)` where
 * `C` is a COMPILED CLASS — including `class X extends Promise` — natively, in standalone.
 *
 * §27.2.4.7 / §27.2.4.7.1 PromiseResolve and §27.2.4.6 are one protocol with two slots:
 *
 *   [resolve only] if IsPromise(x) and SameValue(Get(x, "constructor"), C): return x
 *   capability = NewPromiseCapability(C)     -- Construct(C, «executor»), both slots callable
 *   Call(capability.[[Resolve]] | [[Reject]], undefined, «x»)
 *   return capability.[[Promise]]
 *
 * D1 (`emitStandalonePromiseCustomSettle`) serves an ordinary `function` constructor through a
 * [[Call]]; a class has no [[Call]] (§10.2.1 step 2), so it takes D3's [[Construct]] — the
 * one-argument native construct driver, whose class arm runs the class's own `<C>_new`. Before
 * this module a class `C` fell through to the intrinsic `Promise.resolve` value, which ignores
 * its receiver: `C` was never constructed (`ctx-ctor.js` saw `callCount` 0).
 *
 * Standalone only. The receiver admission is D3's (`resolveCompiledClassReceiver`).
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { rollbackSpeculative, snapshotSpeculative } from "./context/speculative.js";
import { getFuncRefWrapperRootTypeIdx } from "./closures/funcref-wrapper-types.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { coerceType, compileExpression } from "./shared.js";
import { getOrRegisterPromiseType, isStandalonePromiseActive } from "./async-scheduler.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import {
  buildCustomCapabilityExecutorInstrs,
  customCapabilityTypeError,
  ensureCustomCapabilityRuntime,
} from "./promise-combinators.js";
import {
  isOrdinaryFunctionCtorArg,
  reserveConstructDriver,
  resolveCompiledClassReceiver,
} from "./promise-class-receiver-drive.js";
import { GLOBAL_NON_CONSTRUCTOR_FUNCTION_NAMES } from "./expressions/non-constructable.js";
import { isBuiltinConstructorIdentityName } from "./builtin-static-globals.js";

const EXTERNREF: ValType = { kind: "externref" };
/** WasmGC `eq` abstract heap type — the only thing `ref.eq` accepts. */
const EQ_HEAP_TYPE = -19;

/**
 * A binding that shadows a global VALUE name (`const undefined = class …`, `const parseInt = …`):
 * the identifier value read resolves such names to the global before it reaches the binding, so
 * the construct call would see the global, not the class. Those keep their previous lowering.
 */
export function shadowsGlobalValueName(arg: ts.Expression): boolean {
  if (!ts.isIdentifier(arg)) return false;
  const name = arg.text;
  return (
    name === "undefined" ||
    name === "NaN" ||
    name === "Infinity" ||
    name === "globalThis" ||
    GLOBAL_NON_CONSTRUCTOR_FUNCTION_NAMES.has(name) ||
    isBuiltinConstructorIdentityName(name)
  );
}

/**
 * `Promise.{resolve,reject}.call(C, x)` for a compiled-class `C`. Returns the result type when
 * it emitted the lowering; `undefined` — with the function body rolled back — when it declined.
 */
export function tryEmitClassReceiverSettleCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  settle: "resolve" | "reject",
): ValType | undefined {
  const ctorArg = expr.arguments[0];
  if (ctorArg === undefined || expr.arguments.length > 2) return undefined;
  return emitClassReceiverSettle(ctx, fctx, ctorArg, expr.arguments[1], settle);
}

/**
 * (#5197 r3 Step 1f) The shared body: `C` is `ctorArg` (the `.call` receiver, or the
 * `P` of a direct `P.resolve(x)` / `P.reject(r)` on a Promise subclass — a static
 * inherited from `%Promise%`, so its `this` is `P`), `valueArg` the settled value.
 */
export function emitClassReceiverSettle(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ctorArg: ts.Expression,
  valueArg: ts.Expression | undefined,
  settle: "resolve" | "reject",
): ValType | undefined {
  if (!isStandalonePromiseActive(ctx)) return undefined;
  // (#5197 r3 Step 5) …or an ordinary function `C` whose closure ABI D1 could not use (held as an
  // externref value, e.g. once the module reads `Function.prototype`): Construct(C, «executor»)
  // through the same driver, whose ordinary tail runs the function with a fresh `this`.
  const admitted = resolveCompiledClassReceiver(ctx, ctorArg) !== undefined || isOrdinaryFunctionCtorArg(ctx, ctorArg);
  if (!admitted || shadowsGlobalValueName(ctorArg)) return undefined;

  const snap = snapshotSpeculative(ctx, fctx);
  // Registration strictly precedes emission.
  const capability = ensureCustomCapabilityRuntime(ctx);
  const vec = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const absentValue = canonicalUndefinedExternInstrs(ctx);
  const typeError = customCapabilityTypeError(ctx);
  const promiseTypeIdx = settle === "resolve" ? getOrRegisterPromiseType(ctx) : -1;
  if (settle === "resolve") addStringConstantGlobal(ctx, "constructor");
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  const wrapperRoot = getFuncRefWrapperRootTypeIdx(ctx);
  if (
    !capability ||
    wrapperRoot === undefined ||
    vec.newIdx === undefined ||
    vec.pushIdx === undefined ||
    applyIdx === undefined ||
    ctx.funcMap.get("__extern_get") === undefined
  ) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }

  const local = (name: string, type: ValType): number => allocLocal(fctx, `__pcs_${name}_${fctx.locals.length}`, type);
  const ctorLocal = local("ctor", EXTERNREF);
  const valueLocal = local("value", EXTERNREF);
  const capLocal = local("cap", {
    kind: "ref_null",
    typeIdx: capability.stateTypeIdx,
  });
  const resultLocal = local("result", EXTERNREF);
  const argsLocal = local("args", EXTERNREF);
  const anyA = local("a", { kind: "anyref" });
  const anyB = local("b", { kind: "anyref" });

  // Argument evaluation (C, then x) completes before the builtin runs.
  for (const [arg, into] of [
    [ctorArg, ctorLocal],
    [valueArg, valueLocal],
  ] as const) {
    if (arg === undefined) {
      fctx.body.push(...absentValue);
    } else {
      const t = compileExpression(ctx, fctx, arg, EXTERNREF);
      if (t === null) fctx.body.push({ op: "ref.null.extern" });
      else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
    }
    fctx.body.push({ op: "local.set", index: into });
  }

  // The construct driver's arming may register late imports: do it before any instruction below
  // bakes a function index.
  const driverIdx = reserveConstructDriver(ctx, fctx);
  const fn = (name: string): number => ctx.funcMap.get(name)!;
  const isCallable = (slot: number): Instr[] => [
    { op: "local.get", index: capLocal },
    { op: "struct.get", typeIdx: capability.stateTypeIdx, fieldIdx: slot },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: wrapperRoot },
  ];
  const viaCapability: Instr[] = [
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: capability.stateTypeIdx },
    { op: "local.set", index: capLocal },
    { op: "local.get", index: ctorLocal },
    { op: "ref.null.extern" },
    ...buildCustomCapabilityExecutorInstrs(capability, capLocal),
    { op: "extern.convert_any" },
    {
      op: "call",
      funcIdx: ctx.funcMap.get("__native_construct_1") ?? driverIdx,
    },
    { op: "local.set", index: resultLocal },
    ...isCallable(0),
    ...isCallable(1),
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: [], else: typeError },
    { op: "call", funcIdx: vec.newIdx },
    { op: "local.set", index: argsLocal },
    { op: "local.get", index: argsLocal },
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: vec.pushIdx },
    { op: "local.get", index: capLocal },
    {
      op: "struct.get",
      typeIdx: capability.stateTypeIdx,
      fieldIdx: settle === "reject" ? 1 : 0,
    },
    { op: "ref.null.extern" },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: applyIdx },
    { op: "drop" },
    { op: "local.get", index: resultLocal },
  ];
  if (settle === "reject") {
    fctx.body.push(...viaCapability);
    return EXTERNREF;
  }
  // PromiseResolve step 1: a promise whose `constructor` is C is returned as is.
  const sameConstructor: Instr[] = [
    { op: "local.get", index: valueLocal },
    ...stringConstantExternrefInstrs(ctx, "constructor"),
    { op: "call", funcIdx: fn("__extern_get") },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyA },
    { op: "local.get", index: ctorLocal },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyB },
    { op: "local.get", index: anyA },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "local.get", index: anyB },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: anyA },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "local.get", index: anyB },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
  fctx.body.push(
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: sameConstructor,
      else: [{ op: "i32.const", value: 0 }],
    },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "local.get", index: valueLocal }],
      else: viaCapability,
    },
  );
  return EXTERNREF;
}
