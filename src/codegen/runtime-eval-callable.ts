// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Cross-module AOT-callable carrier for the standalone runtime-eval provider.
 *
 * Ordinary closures use a module-local wrapper hierarchy whose root depends on
 * allocation order. A separately compiled provider cannot reliably classify
 * every typed AOT closure stored on the caller's global object. This carrier is
 * a closed two-type recursive shape shared structurally by both modules:
 *
 *   carrier { code: (ref codeType), target: externref }
 *   code(carrier, receiver, argsVec) -> externref
 *
 * The provider calls `code` before ordinary closure dispatch. The code lives in
 * the caller module and forwards `target`, `receiver`, and the exact argument
 * vector through that module's own `__apply_closure`.
 */

import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";

export interface RuntimeEvalAotCallableCarrier {
  structTypeIdx: number;
  funcTypeIdx: number;
  trampolineFuncIdx?: number;
}

/** Register the canonical recursive carrier types without emitting a value. */
export function ensureRuntimeEvalAotCallableCarrierTypes(ctx: CodegenContext): RuntimeEvalAotCallableCarrier {
  const cached = ctx.runtimeEvalAotCallableCarrier;
  if (cached) return cached;

  const structTypeIdx = ctx.mod.types.length;
  const funcTypeIdx = structTypeIdx + 1;
  ctx.mod.types.push(
    {
      kind: "struct",
      name: "$RuntimeEvalAotCallable",
      fields: [
        {
          name: "code",
          type: { kind: "ref", typeIdx: funcTypeIdx },
          mutable: false,
        },
        { name: "target", type: { kind: "externref" }, mutable: false },
      ],
      superTypeIdx: -1,
    },
    {
      kind: "func",
      name: "$RuntimeEvalAotCallableCode",
      params: [{ kind: "ref", typeIdx: structTypeIdx }, { kind: "externref" }, { kind: "externref" }],
      results: [{ kind: "externref" }],
    },
  );

  const carrier: RuntimeEvalAotCallableCarrier = { structTypeIdx, funcTypeIdx };
  ctx.runtimeEvalAotCallableCarrier = carrier;
  return carrier;
}

function ensureRuntimeEvalAotCallableTrampoline(
  ctx: CodegenContext,
): RuntimeEvalAotCallableCarrier & { trampolineFuncIdx: number } {
  const carrier = ensureRuntimeEvalAotCallableCarrierTypes(ctx);
  if (carrier.trampolineFuncIdx !== undefined) {
    return carrier as RuntimeEvalAotCallableCarrier & { trampolineFuncIdx: number };
  }

  ensureObjectRuntime(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: applyIdx },
  ];
  const trampolineFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, trampolineFuncIdx, {
    name: "__runtime_eval_call_aot",
    typeIdx: carrier.funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });
  ctx.funcMap.set("__runtime_eval_call_aot", trampolineFuncIdx);
  carrier.trampolineFuncIdx = trampolineFuncIdx;
  if (!ctx.mod.declaredFuncRefs.includes(trampolineFuncIdx)) {
    ctx.mod.declaredFuncRefs.push(trampolineFuncIdx);
  }
  return carrier as RuntimeEvalAotCallableCarrier & { trampolineFuncIdx: number };
}

/** Replace an externref callable on the stack with the canonical carrier. */
export function emitRuntimeEvalAotCallableAdapter(ctx: CodegenContext, fctx: FunctionContext): ValType {
  const carrier = ensureRuntimeEvalAotCallableTrampoline(ctx);
  const targetLocal = allocLocal(fctx, `__runtime_eval_aot_target_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push(
    { op: "local.set", index: targetLocal },
    { op: "ref.func", funcIdx: carrier.trampolineFuncIdx },
    { op: "local.get", index: targetLocal },
    { op: "struct.new", typeIdx: carrier.structTypeIdx },
    { op: "extern.convert_any" },
  );
  return { kind: "externref" };
}
