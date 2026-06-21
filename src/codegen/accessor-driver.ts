// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1888 S5b — accessor live get/set) Reserve/fill drivers that let the
 * Wasm-native open-`$Object` property runtime (`object-runtime.ts`) invoke a
 * stored accessor `$get` / `$set` closure with the original receiver bound as
 * `this`, under `--target standalone`.
 *
 * ## Why a reserve/fill driver (the funcIdx-ordering problem)
 * `__extern_get` / `__extern_set` are emitted lazily by `ensureObjectRuntime`
 * during expression compilation, but the closure-method dispatchers they need to
 * call — `__call_fn_method_0` (getter, arity 0) / `__call_fn_method_1` (setter,
 * arity 1) — are emitted in FINALIZE (`emitClosureMethodCallExportN`, index.ts),
 * AFTER the object runtime exists, and only when a closure of that arity exists
 * in the module. So `__extern_get` / `__extern_set` cannot bake a `call
 * <__call_fn_method_N funcIdx>` at the time they are emitted.
 *
 * The fix mirrors the proven #1719 CPR read-drive pattern
 * (`reserveProtoIteratorDriver` / `fillProtoIteratorDriver` in
 * `proto-override.ts`): at object-runtime-emit time we reserve two placeholder
 * funcs (`__call_accessor_get` / `__call_accessor_set`) whose funcIdx is fixed by
 * append position and registered in `funcMap`; the accessor arms emit a plain
 * `call <reserved funcIdx>`. In post-processing, AFTER the closure-method
 * dispatchers are registered, `fillAccessorDrivers` fills the placeholder bodies
 * with a thin wrapper around `__call_fn_method_0` / `__call_fn_method_1`. Routing
 * through `funcMap` (not a raw number) is load-bearing: `shiftLateImportIndices`
 * patches the `funcMap` entry and every emitted `call` by the same delta, so a
 * late-import index shift never desyncs the reservation (#329 / #1899 contract).
 *
 * ## Receiver semantics (§6.2.5.5 Get / §10.1.5.3 OrdinarySetWithOwnDescriptor)
 * The getter/setter is called with `this` = the ORIGINAL receiver (the Reference
 * base), not the proto-chain holder where the accessor was found.
 * `__call_fn_method_N` threads its leading `thisVal` arg as `this` via the
 * `__current_this` module global (#1636-S1) — exactly the receiver semantics the
 * accessor protocol requires. The `__extern_get`/`__extern_set` arms pass their
 * original `obj` param (local 0), NOT the proto-walk cursor, as `recv`.
 */
import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";

/** Reserved name for the accessor-get driver (arity-0 getter wrapper). */
export const CALL_ACCESSOR_GET = "__call_accessor_get";
/** Reserved name for the accessor-set driver (arity-1 setter wrapper). */
export const CALL_ACCESSOR_SET = "__call_accessor_set";
/**
 * (#2166 PR-D1) Reserved name for the JSON reviver driver (arity-2 method
 * wrapper: `reviver.call(holder, key, value)`).
 */
export const CALL_REVIVER = "__call_reviver";
/**
 * (#2166 PR-D2) Reserved name for the JSON `toJSON` driver (arity-1 method
 * wrapper: `value.toJSON(key)`).
 */
export const CALL_TO_JSON = "__call_to_json";
/**
 * (#2166 PR-D3) Reserved name for the JSON `stringify` replacer driver (arity-2
 * method wrapper: `replacer.call(holder, key, value)`).
 */
export const CALL_REPLACER = "__call_replacer";

/**
 * Reserve the `__call_accessor_get` driver placeholder and return its funcIdx.
 *
 * Signature: `(externref recv, externref getter) -> externref`.
 * The body is left as a bare `unreachable` and filled by `fillAccessorDrivers`
 * in post-processing. The reservation must run while `ensureObjectRuntime` is
 * emitting `__extern_get`, so the append-position funcIdx is stable before any
 * accessor arm emits its `call`.
 *
 * Idempotent: a second call returns the already-reserved funcIdx.
 */
export function reserveAccessorGetDriver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(CALL_ACCESSOR_GET);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$call_accessor_get_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const placeholder: WasmFunction = {
    name: CALL_ACCESSOR_GET,
    typeIdx: sigIdx,
    locals: [],
    // Placeholder; filled by fillAccessorDrivers in post-processing. A bare
    // `unreachable` keeps the stub valid (externref result) if the fill is ever
    // skipped (no arity-0 closure ⇒ no real getter installed ⇒ driver unused).
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(placeholder);
  ctx.funcMap.set(CALL_ACCESSOR_GET, funcIdx);
  ctx.accessorGetDriverReserved = true;
  return funcIdx;
}

/**
 * Reserve the `__call_accessor_set` driver placeholder and return its funcIdx.
 *
 * Signature: `(externref recv, externref setter, externref value) -> ()`.
 * Setters return no value (the assignment expression result is the RHS, handled
 * at the call site), so the driver result type is empty. Body filled by
 * `fillAccessorDrivers`. Idempotent.
 */
export function reserveAccessorSetDriver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(CALL_ACCESSOR_SET);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
    "$call_accessor_set_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const placeholder: WasmFunction = {
    name: CALL_ACCESSOR_SET,
    typeIdx: sigIdx,
    locals: [],
    // Placeholder; filled by fillAccessorDrivers. Bare `unreachable` is a valid
    // empty-result stub when the fill is skipped (no arity-1 closure in module).
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(placeholder);
  ctx.funcMap.set(CALL_ACCESSOR_SET, funcIdx);
  ctx.accessorSetDriverReserved = true;
  return funcIdx;
}

/**
 * (#2166 PR-D1) Reserve the `__call_reviver` driver placeholder and return its
 * funcIdx.
 *
 * Signature: `(externref holder, externref key, externref value) -> externref`.
 * Filled by `fillAccessorDrivers` to wrap `__call_fn_method_2(holder, reviver,
 * key, value)` — but note the reviver closure itself is NOT a driver param: the
 * §25.5.1 walk threads it separately and the driver receives `holder` as the
 * `this` and `key`/`value` as the two reviver args, with the reviver closure
 * passed as the dispatcher's 2nd operand by the codec via a 4th hidden param.
 * To keep the driver arity fixed we instead make the reviver the FIRST arg and
 * holder the receiver: see `fillAccessorDrivers`. Idempotent.
 */
export function reserveReviverDriver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(CALL_REVIVER);
  if (existing !== undefined) return existing;
  // (holder, reviver, key, value) -> externref. holder is bound as `this`.
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$call_reviver_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const placeholder: WasmFunction = {
    name: CALL_REVIVER,
    typeIdx: sigIdx,
    // Placeholder; filled by fillAccessorDrivers once __call_fn_method_2 exists.
    // A bare `unreachable` keeps the stub valid (externref result) if the fill
    // is skipped (no arity-2 closure ⇒ no reviver could have been passed).
    locals: [],
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(placeholder);
  ctx.funcMap.set(CALL_REVIVER, funcIdx);
  ctx.reviverDriverReserved = true;
  return funcIdx;
}

/**
 * (#2166 PR-D2) Reserve the `__call_to_json` driver placeholder and return its
 * funcIdx.
 *
 * Signature: `(externref value, externref method, externref key) -> externref`.
 * Filled by `fillAccessorDrivers` to wrap `__call_fn_method_1(value, method,
 * key)` — `value` bound as the `toJSON` receiver (`this`), `key` the §25.5.2
 * SerializeJSONProperty step-2.b argument. Idempotent.
 */
export function reserveToJsonDriver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(CALL_TO_JSON);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$call_to_json_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const placeholder: WasmFunction = {
    name: CALL_TO_JSON,
    typeIdx: sigIdx,
    locals: [],
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(placeholder);
  ctx.funcMap.set(CALL_TO_JSON, funcIdx);
  ctx.toJsonDriverReserved = true;
  return funcIdx;
}

/**
 * (#2166 PR-D3) Reserve the `__call_replacer` driver placeholder and return its
 * funcIdx.
 *
 * Signature: `(externref holder, externref replacer, externref key,
 * externref value) -> externref`. The replacer function is invoked as
 * `replacer.call(holder, key, value)` (§25.5.2 SerializeJSONProperty step 3),
 * so `holder` binds as `this` and `key`/`value` are the two arguments — exactly
 * the reviver driver's shape. Filled by `fillAccessorDrivers` wrapping
 * `__call_fn_method_2`. Idempotent.
 */
export function reserveReplacerDriver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(CALL_REPLACER);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$call_replacer_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const placeholder: WasmFunction = {
    name: CALL_REPLACER,
    typeIdx: sigIdx,
    locals: [],
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(placeholder);
  ctx.funcMap.set(CALL_REPLACER, funcIdx);
  ctx.replacerDriverReserved = true;
  return funcIdx;
}

/**
 * Fill the reserved accessor driver bodies in post-processing, AFTER
 * `emitClosureMethodCallExportN(0)` / `(1)` have registered
 * `__call_fn_method_0` / `__call_fn_method_1` in `funcMap`. Each driver is a
 * thin wrapper that forwards to the matching closure-method dispatcher, reusing
 * the proven re-entrancy-safe `__current_this` install/restore (#1636-S1)
 * instead of duplicating funcref-type dispatch inside the object runtime:
 *
 *   __call_accessor_get(recv, getter) = return __call_fn_method_0(recv, getter)
 *   __call_accessor_set(recv, setter, value) =
 *       __call_fn_method_1(recv, setter, value)  ; drop result
 *
 * No-op when the corresponding driver was never reserved (no accessor arm
 * needs it). When the driver WAS reserved but the matching dispatcher was never
 * emitted (no closure of that arity exists — so no real getter/setter closure
 * could have been installed either), the body is filled with a valid fallback
 * (return-undefined for get; bare return for set) so the module still verifies —
 * mirrors `fillProtoIteratorDriver`'s null fallback.
 */
export function fillAccessorDrivers(ctx: CodegenContext): void {
  if (ctx.accessorGetDriverReserved) {
    const driverIdx = ctx.funcMap.get(CALL_ACCESSOR_GET);
    if (driverIdx !== undefined) {
      const driverFn = ctx.mod.functions[driverIdx - ctx.numImportFuncs];
      if (driverFn) {
        const callMethod0 = ctx.funcMap.get("__call_fn_method_0");
        if (callMethod0 === undefined) {
          // No arity-0 closure dispatcher — the getter driver is unreachable
          // from any live accessor arm in that case (no arity-0 closure ⇒ no
          // getter closure installed), but keep a valid body so the module
          // verifies: return undefined (null externref).
          driverFn.body = [{ op: "ref.null.extern" } as Instr];
        } else {
          driverFn.body = [
            { op: "local.get", index: 0 } as Instr, // recv (bound as `this`)
            { op: "local.get", index: 1 } as Instr, // getter closure
            { op: "call", funcIdx: callMethod0 } as Instr,
            // getter result (externref) stays on the stack as the return value
          ];
        }
      }
    }
  }

  if (ctx.accessorSetDriverReserved) {
    const driverIdx = ctx.funcMap.get(CALL_ACCESSOR_SET);
    if (driverIdx !== undefined) {
      const driverFn = ctx.mod.functions[driverIdx - ctx.numImportFuncs];
      if (driverFn) {
        const callMethod1 = ctx.funcMap.get("__call_fn_method_1");
        if (callMethod1 === undefined) {
          // No arity-1 closure dispatcher — setter driver unreachable; empty
          // body (bare return via implicit fallthrough) verifies for () result.
          driverFn.body = [];
        } else {
          driverFn.body = [
            { op: "local.get", index: 0 } as Instr, // recv (bound as `this`)
            { op: "local.get", index: 1 } as Instr, // setter closure
            { op: "local.get", index: 2 } as Instr, // value argument
            { op: "call", funcIdx: callMethod1 } as Instr,
            // __call_fn_method_1 returns an externref result; the setter's
            // return value is discarded per §10.1.5.3 (Set ignores it).
            { op: "drop" } as Instr,
          ];
        }
      }
    }
  }

  // (#2166 PR-D1) JSON reviver driver: holder bound as `this`, key+value the two
  // reviver args. Wraps __call_fn_method_2(holder, reviver, key, value).
  if (ctx.reviverDriverReserved) {
    const driverIdx = ctx.funcMap.get(CALL_REVIVER);
    if (driverIdx !== undefined) {
      const driverFn = ctx.mod.functions[driverIdx - ctx.numImportFuncs];
      if (driverFn) {
        const callMethod2 = ctx.funcMap.get("__call_fn_method_2");
        if (callMethod2 === undefined) {
          // No arity-2 closure dispatcher ⇒ no reviver closure could have been
          // passed; the driver is unreachable from any live walk. Keep a valid
          // identity body: return the value arg unchanged (externref result).
          driverFn.body = [{ op: "local.get", index: 3 } as Instr];
        } else {
          driverFn.body = [
            { op: "local.get", index: 0 } as Instr, // holder (bound as `this`)
            { op: "local.get", index: 1 } as Instr, // reviver closure
            { op: "local.get", index: 2 } as Instr, // key (arg0)
            { op: "local.get", index: 3 } as Instr, // value (arg1)
            { op: "call", funcIdx: callMethod2 } as Instr,
            // result (reviver's return, externref) is this driver's result
          ];
        }
      }
    }
  }

  // (#2166 PR-D2) JSON toJSON driver: value bound as `this`, key the lone arg.
  // Wraps __call_fn_method_1(value, method, key).
  if (ctx.toJsonDriverReserved) {
    const driverIdx = ctx.funcMap.get(CALL_TO_JSON);
    if (driverIdx !== undefined) {
      const driverFn = ctx.mod.functions[driverIdx - ctx.numImportFuncs];
      if (driverFn) {
        const callMethod1 = ctx.funcMap.get("__call_fn_method_1");
        if (callMethod1 === undefined) {
          // No arity-1 closure dispatcher ⇒ no toJSON method closure exists in
          // the module ⇒ the driver is unreachable (the codec's HasProperty
          // ref-test never finds a closure). Keep a valid identity body:
          // return the value arg unchanged (externref result).
          driverFn.body = [{ op: "local.get", index: 0 } as Instr];
        } else {
          driverFn.body = [
            { op: "local.get", index: 0 } as Instr, // value (bound as `this`)
            { op: "local.get", index: 1 } as Instr, // toJSON method closure
            { op: "local.get", index: 2 } as Instr, // key (arg0)
            { op: "call", funcIdx: callMethod1 } as Instr,
            // result (toJSON's return, externref) is this driver's result
          ];
        }
      }
    }
  }

  // (#2166 PR-D3) JSON replacer driver: holder bound as `this`, key+value the two
  // replacer args. Wraps __call_fn_method_2(holder, replacer, key, value).
  if (ctx.replacerDriverReserved) {
    const driverIdx = ctx.funcMap.get(CALL_REPLACER);
    if (driverIdx !== undefined) {
      const driverFn = ctx.mod.functions[driverIdx - ctx.numImportFuncs];
      if (driverFn) {
        const callMethod2 = ctx.funcMap.get("__call_fn_method_2");
        if (callMethod2 === undefined) {
          // No arity-2 closure dispatcher ⇒ no function replacer could have been
          // passed; the driver is unreachable from any live walk. Keep a valid
          // identity body: return the value arg unchanged (externref result).
          driverFn.body = [{ op: "local.get", index: 3 } as Instr];
        } else {
          driverFn.body = [
            { op: "local.get", index: 0 } as Instr, // holder (bound as `this`)
            { op: "local.get", index: 1 } as Instr, // replacer closure
            { op: "local.get", index: 2 } as Instr, // key (arg0)
            { op: "local.get", index: 3 } as Instr, // value (arg1)
            { op: "call", funcIdx: callMethod2 } as Instr,
            // result (replacer's return, externref) is this driver's result
          ];
        }
      }
    }
  }
}
