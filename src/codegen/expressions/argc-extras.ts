// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { getArrTypeIdxFromVec } from "../index.js";
import { ensureArgcGlobal, ensureExtrasArgvGlobal } from "../statements/nested-declarations.js";
import { coerceType } from "../type-coercion.js";

/** Build argc/extras setup from call arguments already saved in locals. */
export function buildArgcExtrasSetupFromLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramCount: number,
  extrasLocals: number[],
  actualArgCount = paramCount + extrasLocals.length,
): Instr[] {
  const out: Instr[] = [];
  if (extrasLocals.length > 0) {
    const { globalIdx, vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    for (const local of extrasLocals) out.push({ op: "local.get", index: local });
    out.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: extrasLocals.length });
    const arrayLocal = allocLocal(fctx, `__extras_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    out.push(
      { op: "local.set", index: arrayLocal },
      { op: "i32.const", value: extrasLocals.length },
      { op: "local.get", index: arrayLocal },
      { op: "struct.new", typeIdx: vecTypeIdx },
      { op: "global.set", index: globalIdx },
    );
  }
  out.push(
    { op: "i32.const", value: Math.min(actualArgCount, paramCount) },
    { op: "global.set", index: ensureArgcGlobal(ctx) },
  );
  return out;
}

/** Reset argc and extras, registering both globals when necessary. */
export function buildArgcExtrasReset(ctx: CodegenContext): Instr[] {
  const { globalIdx, vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  return [
    { op: "ref.null", typeIdx: vecTypeIdx },
    { op: "global.set", index: globalIdx },
    { op: "i32.const", value: -1 },
    { op: "global.set", index: ensureArgcGlobal(ctx) },
  ];
}

/** Reset argc and only clear extras when its global already exists. */
export function buildArgcResetNoLazyExtras(ctx: CodegenContext): Instr[] {
  const out: Instr[] = [];
  if (ctx.extrasArgvGlobalIdx >= 0) {
    out.push(
      { op: "ref.null", typeIdx: ctx.extrasArgvVecTypeIdx },
      { op: "global.set", index: ctx.extrasArgvGlobalIdx },
    );
  }
  out.push({ op: "i32.const", value: -1 }, { op: "global.set", index: ensureArgcGlobal(ctx) });
  return out;
}

/** Seed a dynamic closure candidate's true call-site argc/extras protocol. */
export function appendDynamicCandidateArgcSetup(
  ctx: CodegenContext,
  fctx: FunctionContext,
  body: Instr[],
  paramCount: number,
  argLocals: number[],
  actualArgCount: number,
): void {
  // Runtime candidates can declare fewer formals than the checker signature;
  // preserve every real argument so zero-formal bodies can still read it.
  body.push(...buildArgcExtrasSetupFromLocals(ctx, fctx, paramCount, argLocals.slice(paramCount), actualArgCount));
}

/** Append argc/extras setup when the overflow locals are already selected. */
export function appendArgcSetupFromExtras(
  ctx: CodegenContext,
  fctx: FunctionContext,
  body: Instr[],
  paramCount: number,
  extrasLocals: number[],
  actualArgCount: number,
): void {
  body.push(...buildArgcExtrasSetupFromLocals(ctx, fctx, paramCount, extrasLocals, actualArgCount));
}

/** Preserve an already-typed argument in an externref local for ABI reclassification. */
export function saveArgumentLocalAsExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  sourceLocal: number,
  sourceType: ValType,
  output: number[],
): void {
  fctx.body.push({ op: "local.get", index: sourceLocal });
  coerceType(ctx, fctx, sourceType, { kind: "externref" });
  const externLocal = allocLocal(fctx, `__carg_extern_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: externLocal });
  output.push(externLocal);
}

/** Preserve a boxed dynamic-call result while resetting argc/extras globals. */
export function appendExternResultArgcReset(ctx: CodegenContext, fctx: FunctionContext, body: Instr[]): void {
  const resultLocal = allocLocal(fctx, `__dyn_result_${fctx.locals.length}`, { kind: "externref" });
  body.push({ op: "local.set", index: resultLocal }, ...buildArgcResetNoLazyExtras(ctx), {
    op: "local.get",
    index: resultLocal,
  });
}
