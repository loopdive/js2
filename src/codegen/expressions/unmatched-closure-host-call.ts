// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#1058) Terminal arm of the identifier-callee funcref ladder for a LIVE
// closure whose exact funcref type no arm names.
//
// The ladder is built from the signatures visible when the calling body
// compiles. A generic helper erases its callback's `T` to externref, while a
// callback compiled elsewhere keeps its own ABI: a nominal `(ref null $Node)`
// parameter, a `void` result. TypeScript's `forEach(nodes, bind)` in the binder
// is the witness — `bind` matched no arm and the call ended in the TypeError
// arm although the value was a perfectly callable closure.
//
// On the host lane such a closure is still callable through the host: the
// runtime wraps it and re-enters the finalize-time `__call_fn_<N>` dispatcher,
// which is built over the COMPLETE closure table and casts each externref
// argument to the formal's own type. Standalone, WASI and native-first
// profiles keep the TypeError arm.

import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  ensureHostCallFallbackImports,
  type HostCallFallbackPlan,
  planHostCallFallback,
} from "./host-call-fallback.js";
import { flushLateImportShifts } from "./late-imports.js";

/**
 * Register the host-call import for an `arity`-argument unmatched-closure arm.
 * Must run before any dispatch arm captures a function index.
 */
export function reserveUnmatchedClosureHostCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arity: number,
): HostCallFallbackPlan | undefined {
  if (ctx.standalone || ctx.wasi || ctx.targetProfile.semanticProviders === "native-first") return undefined;
  const plan = planHostCallFallback(arity);
  if (!plan.fixedArity) return undefined;
  ensureHostCallFallbackImports(ctx, plan);
  flushLateImportShifts(ctx, fctx);
  return plan;
}

/**
 * `__call_function_<N>(closure, this, args…)` coerced to the ladder's result
 * type, or undefined when the result has no index-stable bridge.
 */
export function buildUnmatchedClosureHostCall(
  ctx: CodegenContext,
  plan: HostCallFallbackPlan,
  closureLocal: number,
  argExternLocals: readonly number[],
  expectedReturn: ValType | null,
  bridge: (from: ValType, to: ValType) => Instr[] | null,
): Instr[] | undefined {
  const callIdx = ctx.funcMap.get(plan.importName);
  if (callIdx === undefined || argExternLocals.length !== plan.arity) return undefined;
  let result: Instr[] | null = [];
  if (expectedReturn === null) result = [{ op: "drop" }];
  else if (expectedReturn.kind !== "externref") result = bridge({ kind: "externref" }, expectedReturn);
  if (result === null) return undefined;
  return [
    { op: "local.get", index: closureLocal },
    { op: "extern.convert_any" },
    { op: "ref.null.extern" },
    ...argExternLocals.map((index): Instr => ({ op: "local.get", index })),
    { op: "call", funcIdx: callIdx },
    ...result,
  ];
}
