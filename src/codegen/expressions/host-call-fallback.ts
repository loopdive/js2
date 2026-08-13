// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host-callable fallback ABI for erased dynamic calls.
 *
 * Common fixed-arity calls cross the Wasm/JS boundary once. Wider calls and
 * the kill-switch path retain the legacy JS-array builder ABI.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureLateImport } from "./late-imports.js";

export type HostCallFallbackPlan = {
  fixedArity: boolean;
  importName: string;
  arity: number;
};

export function planHostCallFallback(arity: number, nativeBoundary = false): HostCallFallbackPlan {
  const fixedArity = nativeBoundary || (process.env.JS2WASM_FIXED_ARITY_HOST_CALLS !== "0" && arity <= 4);
  return {
    fixedArity,
    importName: nativeBoundary
      ? `__boundary_callback_call_${arity}`
      : fixedArity
        ? `__call_function_${arity}`
        : "__call_function",
    arity,
  };
}

export function ensureHostCallFallbackImports(ctx: CodegenContext, plan: HostCallFallbackPlan): void {
  const externRef: ValType = { kind: "externref" };
  if (plan.fixedArity) {
    const params: ValType[] = [externRef, externRef];
    for (let i = 0; i < plan.arity; i++) params.push(externRef);
    ensureLateImport(ctx, plan.importName, params, [externRef]);
    return;
  }
  ensureLateImport(ctx, "__js_array_new", [], [externRef]);
  ensureLateImport(ctx, "__js_array_push", [externRef, externRef], []);
  ensureLateImport(ctx, "__call_function", [externRef, externRef, externRef], [externRef]);
}

export function buildHostCallFallbackArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  plan: HostCallFallbackPlan,
  calleeAnyLocal: number,
  argLocals: readonly number[],
  // (#4313) A bare call's `thisArg` is `undefined`. A caller that can
  // materialize a real `undefined` externref passes it here; the null default
  // preserves the previous behaviour for callers that cannot.
  thisArgInstrs: readonly Instr[] = [{ op: "ref.null.extern" }],
): Instr[] | undefined {
  const callFn = ctx.funcMap.get(plan.importName);
  if (callFn === undefined) return undefined;
  const invokePrefix: Instr[] = [
    { op: "local.get", index: calleeAnyLocal },
    { op: "extern.convert_any" },
    ...thisArgInstrs, // bare-call thisArg
  ];
  if (plan.fixedArity) {
    for (const argLocal of argLocals) invokePrefix.push({ op: "local.get", index: argLocal });
    invokePrefix.push({ op: "call", funcIdx: callFn });
    return invokePrefix;
  }

  const arrNew = ctx.funcMap.get("__js_array_new");
  const arrPush = ctx.funcMap.get("__js_array_push");
  if (arrNew === undefined || arrPush === undefined) return undefined;
  const hostArgsLocal = allocLocal(fctx, `__dyn_hostargs_${fctx.locals.length}`, { kind: "externref" });
  const arm: Instr[] = [
    { op: "call", funcIdx: arrNew },
    { op: "local.set", index: hostArgsLocal },
  ];
  for (const argLocal of argLocals) {
    arm.push({ op: "local.get", index: hostArgsLocal });
    arm.push({ op: "local.get", index: argLocal });
    arm.push({ op: "call", funcIdx: arrPush });
  }
  arm.push(...invokePrefix, { op: "local.get", index: hostArgsLocal }, { op: "call", funcIdx: callFn });
  return arm;
}
