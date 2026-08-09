// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1712 — stack-flat JS-host calls to compiled fnctor prototype methods.
 *
 * A generic `this.method(...)` on a reconstructed fnctor used to lower to
 * `__extern_method_call`. The host resolved the raw prototype closure, wrapped
 * it as a JS Function, and called back into `__call_fn_method_N`. Recursive
 * descent therefore retained one JavaScript frame per parser edge and could
 * exhaust the native stack even when the source nesting was modest.
 *
 * The call site now asks the host only for the LIVE raw callable and invokes it
 * through this private in-Wasm driver. Drivers are reserved while function
 * bodies compile, then filled after `__call_fn_method_N` has been emitted over
 * the complete closure-shape table. This is the same stable-handle reserve/fill
 * discipline used by accessor-driver.ts.
 */
import type { Instr, ValType } from "../ir/types.js";
import { addFuncType } from "./index.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureArgcGlobal } from "./statements/nested-declarations.js";

const EXTERNREF: ValType = { kind: "externref" };
const DRIVER_PREFIX = "__host_fnctor_method_call_";

function driverName(arity: number): string {
  return `${DRIVER_PREFIX}${arity}`;
}

/** Host fallback used when live lookup yields a genuine JS callable. */
export function hostFnctorCallableFallbackImportName(arity: number): string {
  return `__extern_call_raw_callable_${arity}`;
}

/** Reserve a stable `(receiver, rawClosure, ...args) -> externref` driver. */
export function reserveHostFnctorMethodDriver(ctx: CodegenContext, arity: number): number {
  const name = driverName(arity);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const params = Array.from({ length: arity + 2 }, () => EXTERNREF);
  const typeIdx = addFuncType(ctx, params, [EXTERNREF], `$${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/** Highest reserved driver arity, or -1 when the host fast path is unused. */
export function maxReservedHostFnctorMethodArity(ctx: CodegenContext): number {
  for (let arity = 8; arity >= 0; arity--) {
    if (ctx.funcMap.has(driverName(arity))) return arity;
  }
  return -1;
}

export function maxHostFnctorMethodArity(ctx: CodegenContext, closureArity: number): number {
  return Math.max(closureArity, maxReservedHostFnctorMethodArity(ctx), ctx.maxHostDynamicMethodCallArity ?? 0);
}

/**
 * Fill every reserved driver after the public closure-method dispatchers exist.
 * A missing dispatcher leaves a valid undefined result rather than a trap.
 */
export function fillHostFnctorMethodDrivers(ctx: CodegenContext): void {
  for (let arity = 0; arity <= 8; arity++) {
    const driverIdx = ctx.funcMap.get(driverName(arity));
    if (driverIdx === undefined) continue;
    const driver = definedFuncAt(ctx, driverIdx);
    if (!driver) continue;

    const closureArityIdx = ctx.funcMap.get("__closure_arity");
    const argcGlobalIdx = ensureArgcGlobal(ctx);
    const undefinedIdx = ctx.funcMap.get("__get_undefined");
    const methodIdx = ctx.funcMap.get(`__call_fn_method_${arity}`);
    const fallbackIdx = ctx.funcMap.get(hostFnctorCallableFallbackImportName(arity));
    if (methodIdx === undefined || closureArityIdx === undefined || fallbackIdx === undefined) {
      driver.body = [{ op: "ref.null.extern" }];
      continue;
    }

    const declaredLocal = arity + 2;
    const callAtArity = (dispatchArity: number): Instr[] => {
      const target = ctx.funcMap.get(`__call_fn_method_${dispatchArity}`);
      if (target === undefined) return [{ op: "ref.null.extern" }];
      const call: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
      ];
      for (let arg = 0; arg < dispatchArity; arg++) {
        if (arg < arity) {
          call.push({ op: "local.get", index: arg + 2 });
        } else if (undefinedIdx !== undefined) {
          call.push({ op: "call", funcIdx: undefinedIdx });
        } else {
          call.push({ op: "ref.null.extern" });
        }
      }
      call.push({ op: "call", funcIdx: target });
      return call;
    };

    // Calls with omitted trailing arguments must dispatch at least at the
    // closure's declared arity; __call_fn_method_N only includes closures with
    // formals <= N. Seed __argc with the actual count before padding so an
    // `arguments.length` read still observes the source call, not the widened
    // transport arity.
    let dispatch = callAtArity(arity);
    for (let declared = 8; declared > arity; declared--) {
      dispatch = [
        { op: "local.get", index: declaredLocal },
        { op: "i32.const", value: declared },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: callAtArity(declared),
          else: dispatch,
        },
      ];
    }
    const fallbackCall: Instr[] = [];
    for (let local = 1; local < arity + 2; local++) {
      fallbackCall.push({ op: "local.get", index: local });
    }
    fallbackCall.splice(1, 0, { op: "local.get", index: 0 });
    fallbackCall.push({ op: "call", funcIdx: fallbackIdx });

    const body: Instr[] = [
      { op: "i32.const", value: arity },
      { op: "global.set", index: argcGlobalIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: closureArityIdx },
      { op: "local.set", index: declaredLocal },
      { op: "local.get", index: declaredLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: EXTERNREF },
        then: fallbackCall,
        else: dispatch,
      },
    ];
    driver.locals = [{ name: "__declared_arity", type: { kind: "i32" } }];
    driver.body = body;
  }
}
