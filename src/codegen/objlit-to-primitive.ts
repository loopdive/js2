// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3481 step 3) §7.1.1 step 2 for an `@@toPrimitive` that lives in a struct
 * FIELD.
 *
 * `@@toPrimitive` reaches codegen in three physically different shapes (slice
 * 1's taxonomy): a sidecar slot from `o[Symbol.toPrimitive] = fn`, a struct
 * METHOD from `[Symbol.toPrimitive](hint) {…}`, and an object-literal computed
 * PROPERTY `{ [Symbol.toPrimitive]: fn }` — which stores the closure in a field
 * named `@@toPrimitive` and emits no `${name}_@@toPrimitive` function. Only the
 * method shape had a compiled dispatch, so `coerceType(ref → f64)` skipped step
 * 2 for the property shape and went straight to `valueOf`/`toString`:
 * `Number({[Symbol.toPrimitive]: () => 5, valueOf: () => 7})` answered 7.
 *
 * ## Why two reserved drivers rather than inline instructions
 *
 * Both halves of the dispatch depend on facts that are only complete at
 * FINALIZE: the closure base-wrapper type set (`__is_closure`'s own arm list)
 * and the `__call_fn_method_N` family. A coercion site is compiled long before
 * either exists, so it cannot bake a `call` to them — the #2191 stale-funcIdx
 * hazard. Same reserve/fill discipline as `reserveAccessorGetDriver` /
 * `reserveClassToPrimitive`: mint stable handles now, give them bodies in
 * `fillObjLitToPrimitive` once the closure tables are registered.
 *
 * The callability test is a SEPARATE driver rather than a sentinel return
 * because `@@toPrimitive` may legitimately return `null`/`undefined` (both are
 * primitives, §7.1.1 step 4), so no return value can mean "absent". The caller
 * uses it to choose between the dispatch and its own untouched
 * OrdinaryToPrimitive lowering, which is what makes the change inert for every
 * object that has no live `@@toPrimitive` closure.
 */

import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { collectClosureBaseWrapperTypeIdxs } from "./closure-classifier.js";
import { mintDefinedFunc, pushDefinedFunc, definedFuncAt } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";

/** `(externref tp) -> i32` — 1 when `tp` is a callable closure carrier. */
export const OBJLIT_TP_CALLABLE = "__objlit_tp_callable";
/** `(externref recv, externref tp, externref hint) -> externref`. */
export const OBJLIT_TP_CALL = "__objlit_tp_call";

/**
 * Reserve both drivers and return their funcIdxs, or `undefined` when the
 * module cannot host them. Idempotent.
 */
export function reserveObjLitToPrimitive(ctx: CodegenContext): { callableIdx: number; callIdx: number } {
  const existingCallable = ctx.funcMap.get(OBJLIT_TP_CALLABLE);
  const existingCall = ctx.funcMap.get(OBJLIT_TP_CALL);
  if (existingCallable !== undefined && existingCall !== undefined) {
    return { callableIdx: existingCallable, callIdx: existingCall };
  }
  const callableSig = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$objlit_tp_callable_type");
  const callableIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, callableIdx, {
    name: OBJLIT_TP_CALLABLE,
    typeIdx: callableSig,
    locals: [],
    // Placeholder. A module whose fill never runs answers "not callable", so
    // every caller takes its unchanged OrdinaryToPrimitive branch — the stub is
    // deliberately CONSERVATIVE rather than `unreachable`, because this driver
    // is on the hot path of an ordinary numeric coercion.
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  } satisfies WasmFunction);
  ctx.funcMap.set(OBJLIT_TP_CALLABLE, callableIdx);

  const callSig = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$objlit_tp_call_type",
  );
  const callIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, callIdx, {
    name: OBJLIT_TP_CALL,
    typeIdx: callSig,
    locals: [],
    // Unreachable is safe here: the callability driver above gates every call
    // and reports 0 whenever this one was not filled.
    body: [{ op: "unreachable" }],
    exported: false,
  } satisfies WasmFunction);
  ctx.funcMap.set(OBJLIT_TP_CALL, callIdx);
  ctx.objLitToPrimitiveReserved = true;
  return { callableIdx, callIdx };
}

/**
 * Fill the reserved bodies. MUST run after `emitClosureMethodCallExportN` and
 * `emitClosureArityExport`, i.e. alongside `fillAccessorDrivers` /
 * `fillApplyClosure`. No-op when nothing reserved.
 */
export function fillObjLitToPrimitive(ctx: CodegenContext): void {
  if (!ctx.objLitToPrimitiveReserved) return;

  const callableIdx = ctx.funcMap.get(OBJLIT_TP_CALLABLE);
  if (callableIdx !== undefined) {
    const fn = definedFuncAt(ctx, callableIdx);
    if (fn) {
      const bases = collectClosureBaseWrapperTypeIdxs(ctx);
      if (bases.length === 0) {
        fn.body = [{ op: "i32.const", value: 0 }];
      } else {
        const body: Instr[] = [];
        bases.forEach((baseTypeIdx, i) => {
          body.push({ op: "local.get", index: 0 });
          body.push({ op: "any.convert_extern" });
          body.push({ op: "ref.test", typeIdx: baseTypeIdx });
          if (i > 0) body.push({ op: "i32.or" });
        });
        fn.body = body;
      }
    }
  }

  const callIdx = ctx.funcMap.get(OBJLIT_TP_CALL);
  if (callIdx === undefined) return;
  const call = definedFuncAt(ctx, callIdx);
  if (!call) return;

  // params: 0 = receiver, 1 = the @@toPrimitive closure, 2 = the hint string.
  const callAtArity = (dispatchArity: number): Instr[] | undefined => {
    const target = ctx.funcMap.get(`__call_fn_method_${dispatchArity}`);
    if (target === undefined) return undefined;
    const out: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
    ];
    for (let arg = 1; arg < dispatchArity; arg++) {
      const undef = undefinedExternInstrs(ctx);
      if (undef) out.push(...undef.map((i) => ({ ...i })));
      else out.push({ op: "ref.null.extern" } as Instr);
    }
    out.push({ op: "call", funcIdx: target });
    return out;
  };

  const base = callAtArity(1);
  if (base === undefined) {
    // No arity-1 method dispatcher in this module — leave the callability
    // driver's answer as the only gate (it will have been filled, so guard the
    // body against ever running).
    call.body = [{ op: "unreachable" }];
    return;
  }

  // §7.1.1 step 2c calls with exactly one argument, but `__call_fn_method_N`
  // only carries closures whose DECLARED arity is ≤ N (#4392), so a method
  // written with extra formals needs a wider dispatcher and undefined padding.
  let dispatch = base;
  const arityIdx = ctx.funcMap.get("__closure_arity");
  if (arityIdx !== undefined) {
    call.locals = [{ name: "$declared_arity", type: { kind: "i32" } as ValType }];
    for (let declared = 8; declared > 1; declared--) {
      const wider = callAtArity(declared);
      if (wider === undefined) continue;
      dispatch = [
        { op: "local.get", index: 3 },
        { op: "i32.const", value: declared },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: wider,
          else: dispatch,
        } as Instr,
      ];
    }
    dispatch = [
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: arityIdx },
      { op: "local.set", index: 3 },
      ...dispatch,
    ];
  }
  call.body = dispatch;
}
