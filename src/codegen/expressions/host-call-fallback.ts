// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host-callable fallback ABI for erased dynamic calls: a JS function admitted
 * at the module boundary is invoked through the fixed-arity
 * `__boundary_callback_call_<n>` value adapter. (#6979) The legacy
 * `__call_function` / `__js_array_*` builder ABI of the retired host-semantic
 * lane is gone.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureLateImport } from "./late-imports.js";

export type HostCallFallbackPlan = {
  fixedArity: boolean;
  importName: string;
  arity: number;
};

export function planHostCallFallback(arity: number): HostCallFallbackPlan {
  return { fixedArity: true, importName: `__boundary_callback_call_${arity}`, arity };
}

export function ensureHostCallFallbackImports(ctx: CodegenContext, plan: HostCallFallbackPlan): void {
  const externRef: ValType = { kind: "externref" };
  const params: ValType[] = [externRef, externRef];
  for (let i = 0; i < plan.arity; i++) params.push(externRef);
  ensureLateImport(ctx, plan.importName, params, [externRef]);
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
  for (const argLocal of argLocals) invokePrefix.push({ op: "local.get", index: argLocal });
  invokePrefix.push({ op: "call", funcIdx: callFn });
  return invokePrefix;
}

/**
 * The same boundary call when the caller already retained the callee as an
 * externref. Identifier-call dispatch does this before its guarded conversion
 * to the native closure root, so converting through anyref and back would add
 * no information and would obscure that the value stays JS-owned.
 */
export function buildExternrefHostCallFallbackArm(
  ctx: CodegenContext,
  plan: HostCallFallbackPlan,
  calleeExternLocal: number,
  argLocals: readonly number[],
  thisArgInstrs: readonly Instr[],
): Instr[] | undefined {
  const callFn = ctx.funcMap.get(plan.importName);
  if (callFn === undefined || argLocals.length !== plan.arity) return undefined;
  const body: Instr[] = [{ op: "local.get", index: calleeExternLocal }, ...thisArgInstrs];
  for (const argLocal of argLocals) body.push({ op: "local.get", index: argLocal });
  body.push({ op: "call", funcIdx: callFn });
  return body;
}

/**
 * (#6686) Under the native regime a dynamic call already has an in-Wasm
 * default (the apply fallback). The JS boundary callback must only take the
 * callees Wasm does NOT own — an admitted JS function is a non-eq host ref —
 * so a native closure that matched no inline arm keeps its native dispatch.
 */
export function composeHostCallFallback(
  nativeDefault: Instr[] | undefined,
  hostArm: Instr[] | undefined,
  calleeAnyLocal: number,
): Instr[] | undefined {
  if (hostArm === undefined || nativeDefault === undefined) return hostArm;
  return [
    { op: "local.get", index: calleeAnyLocal },
    { op: "ref.test", typeIdx: -19 /* eq */ },
    { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: nativeDefault, else: hostArm },
  ];
}
