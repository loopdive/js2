// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Standalone runtime-eval provider ABI and direct-eval caller bridge. */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { currentDirectEvalBindings } from "../direct-eval-environment.js";
import { emitGlobalEnvironmentObject } from "../global-environment.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjVecBuilders } from "../object-runtime.js";
import { addStringConstantGlobal, ensureExnTag } from "../registry/imports.js";
import { coerceType, compileExpression } from "../shared.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/** Core-Wasm provider namespace owned by #2928/#2527. */
export const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";

/**
 * Unwrap the provider's `[ok, value]` result vector. A provider-side throw uses
 * that vector because Wasm exception tags are module instances, not
 * structurally canonical values: throwing the provider's private tag directly
 * cannot be caught by the user module. Re-throwing `value` through the caller's
 * own tag restores ordinary AOT try/catch behavior. The vector is intentional:
 * unlike a source-inferred plain object, the canonical externref vec carrier is
 * structurally shared by both modules.
 */
export function emitRuntimeEvalResultUnwrap(ctx: CodegenContext, fctx: FunctionContext): ValType {
  const envelopeLocal = allocLocal(fctx, `__runtime_eval_result_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: envelopeLocal });

  const externref: ValType = { kind: "externref" };
  const getIdx = ensureLateImport(ctx, "__extern_get_idx", [externref, { kind: "f64" }], [externref]);
  const truthyIdx = ensureLateImport(ctx, "__is_truthy", [externref], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  const liveGetIdx = ctx.funcMap.get("__extern_get_idx") ?? getIdx;
  const liveTruthyIdx = ctx.funcMap.get("__is_truthy") ?? truthyIdx;
  if (liveGetIdx === undefined || liveTruthyIdx === undefined) {
    fctx.body.push({ op: "ref.null.extern" });
    return externref;
  }

  const getField = (index: 0 | 1): Instr[] => [
    { op: "local.get", index: envelopeLocal },
    { op: "f64.const", value: index },
    { op: "call", funcIdx: liveGetIdx },
  ];
  const value = getField(1);
  const thrown = [...getField(1), { op: "throw", tagIdx: ensureExnTag(ctx) } satisfies Instr];

  fctx.body.push(...getField(0), { op: "call", funcIdx: liveTruthyIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: externref },
    then: value,
    else: thrown,
  });
  return externref;
}

/**
 * Standalone direct eval route. The caller supplies two parallel `$ObjVec`s:
 * source names and canonical mutable capture cells. The provider wraps those
 * cells in a declarative EnvRec, so interpreter stores immediately update the
 * bindings read by subsequent AOT instructions (and vice versa).
 */
export function emitStandaloneDirectEvalRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (args.length === 0) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  // Register the builders before emitting argument expressions: doing so can
  // mint functions, and keeping that mutation ahead of the call operands makes
  // late-index repair straightforward.
  ensureObjVecBuilders(ctx);
  const bindings = currentDirectEvalBindings(ctx, fctx);
  for (const binding of bindings) addStringConstantGlobal(ctx, binding.name);

  const externref: ValType = { kind: "externref" };
  const sourceLocal = allocLocal(fctx, `__runtime_direct_eval_source_${fctx.locals.length}`, externref);
  const sourceType = compileExpression(ctx, fctx, args[0]!);
  if (sourceType === null) {
    emitUndefined(ctx, fctx);
  } else if (sourceType.kind !== "externref") {
    coerceType(ctx, fctx, sourceType, externref);
  }
  fctx.body.push({ op: "local.set", index: sourceLocal });
  for (let i = 1; i < args.length; i++) {
    const extraType = compileExpression(ctx, fctx, args[i]!);
    if (extraType !== null) fctx.body.push({ op: "drop" });
  }

  // Argument compilation may add late imports and shift defined function
  // indices. funcMap is the authoritative post-shift lookup.
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;

  const namesLocal = allocLocal(fctx, `__runtime_direct_eval_names_${fctx.locals.length}`, externref);
  const slotsLocal = allocLocal(fctx, `__runtime_direct_eval_slots_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "call", funcIdx: objVecNewIdx }, { op: "local.set", index: namesLocal });
  fctx.body.push({ op: "call", funcIdx: objVecNewIdx }, { op: "local.set", index: slotsLocal });
  for (const binding of bindings) {
    fctx.body.push(
      { op: "local.get", index: namesLocal },
      ...stringConstantExternrefInstrs(ctx, binding.name),
      { op: "call", funcIdx: objVecPushIdx },
      { op: "local.get", index: slotsLocal },
      { op: "local.get", index: binding.cellLocal },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: objVecPushIdx },
    );
  }

  fctx.body.push({ op: "local.get", index: sourceLocal });
  if (emitGlobalEnvironmentObject(ctx, fctx) === null) fctx.body.push({ op: "ref.null.extern" });
  const thisType = compileExpression(ctx, fctx, ts.factory.createThis());
  if (thisType === null) {
    emitUndefined(ctx, fctx);
  } else if (thisType.kind !== "externref") {
    coerceType(ctx, fctx, thisType, externref);
  }
  fctx.body.push({ op: "local.get", index: namesLocal }, { op: "local.get", index: slotsLocal });

  const evalIdx = ensureLateImport(
    ctx,
    "__runtime_direct_eval",
    [externref, externref, externref, externref, externref],
    [externref],
    RUNTIME_EVAL_IMPORT_MODULE,
  );
  flushLateImportShifts(ctx, fctx);
  if (evalIdx === undefined) {
    fctx.body.push(
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "ref.null.extern" },
    );
    return externref;
  }
  const liveIdx = ctx.funcMap.get("__runtime_direct_eval") ?? evalIdx;
  fctx.body.push({ op: "call", funcIdx: liveIdx });
  return emitRuntimeEvalResultUnwrap(ctx, fctx);
}
