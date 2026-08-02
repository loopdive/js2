// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Standalone runtime-eval provider ABI and direct-eval caller bridge. */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { currentDirectEvalBindings } from "../direct-eval-environment.js";
import { emitGlobalEnvironmentObject } from "../global-environment.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjVecBuilders } from "../object-runtime.js";
import { addStringConstantGlobal, ensureExnTag } from "../registry/imports.js";
import { getOrRegisterRefCellType } from "../registry/types.js";
import { coerceType, compileExpression } from "../shared.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/** Core-Wasm provider namespace owned by #2928/#2527. */
export const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";

/** Caller-owned spare cells available to names introduced by sloppy eval.
 * This is deliberately generous for the separate-module MVP; combined-module
 * packaging can replace it with a growable canonical carrier. */
const DIRECT_EVAL_STATE_BINDING_CAPACITY = 64;

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

  const getField = (index: 0 | 1 | 2): Instr[] => [
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
 * Standalone direct eval route. The caller supplies three name/cell vector
 * pairs: a persistent current-activation environment, fresh call-site lexical
 * shadows, and captured outer bindings. The provider links those records in
 * that order, so eval-created sloppy vars persist without overwriting an outer
 * capture and interpreter stores still update canonical AOT cells directly.
 */
export function emitStandaloneDirectEvalRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  const args = call.arguments;
  if (args.length === 0) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  // Register the builders before emitting argument expressions: doing so can
  // mint functions, and keeping that mutation ahead of the call operands makes
  // late-index repair straightforward.
  ensureObjVecBuilders(ctx);
  const bindings = currentDirectEvalBindings(ctx, fctx);
  for (const layer of [bindings.activation, bindings.lexical, bindings.outer]) {
    for (const binding of layer) addStringConstantGlobal(ctx, binding.name);
  }

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

  const bindingPushInstrs = (namesLocal: number, slotsLocal: number, layer: typeof bindings.activation): Instr[] => {
    const instrs: Instr[] = [];
    for (const binding of layer) {
      instrs.push(
        { op: "local.get", index: namesLocal },
        ...stringConstantExternrefInstrs(ctx, binding.name),
        { op: "call", funcIdx: objVecPushIdx },
        { op: "local.get", index: slotsLocal },
        { op: "local.get", index: binding.cellLocal },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: objVecPushIdx },
      );
    }
    return instrs;
  };

  const freshLayer = (label: string, layer: typeof bindings.activation): [number, number] => {
    const namesLocal = allocLocal(fctx, `__runtime_direct_eval_${label}_names_${fctx.locals.length}`, externref);
    const slotsLocal = allocLocal(fctx, `__runtime_direct_eval_${label}_slots_${fctx.locals.length}`, externref);
    fctx.body.push(
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: namesLocal },
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: slotsLocal },
      ...bindingPushInstrs(namesLocal, slotsLocal, layer),
    );
    return [namesLocal, slotsLocal];
  };
  const stateCellTypeIdx = fctx.directEvalRefCellTypeIdx ?? getOrRegisterRefCellType(ctx, externref);
  fctx.directEvalRefCellTypeIdx = stateCellTypeIdx;
  if (fctx.directEvalActivationStateCellLocals === undefined) {
    fctx.directEvalActivationStateCellLocals = [];
    for (let i = 0; i < DIRECT_EVAL_STATE_BINDING_CAPACITY * 2; i += 1) {
      fctx.directEvalActivationStateCellLocals.push(
        allocLocal(fctx, `__runtime_direct_eval_state_cell_${i}_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: stateCellTypeIdx,
        }),
      );
    }
  }
  const activationStateCellLocals = fctx.directEvalActivationStateCellLocals;
  for (const cellLocal of activationStateCellLocals) {
    fctx.body.push(
      { op: "local.get", index: cellLocal },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "ref.null.extern" },
          { op: "struct.new", typeIdx: stateCellTypeIdx },
          { op: "local.set", index: cellLocal },
        ],
      },
    );
  }
  const activationStatePoolLocal = allocLocal(
    fctx,
    `__runtime_direct_eval_activation_state_pool_${fctx.locals.length}`,
    externref,
  );
  fctx.body.push({ op: "call", funcIdx: objVecNewIdx }, { op: "local.set", index: activationStatePoolLocal });
  for (const cellLocal of activationStateCellLocals) {
    fctx.body.push(
      { op: "local.get", index: activationStatePoolLocal },
      { op: "local.get", index: cellLocal },
      { op: "ref.as_non_null" },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: objVecPushIdx },
    );
  }
  const [activationNamesLocal, activationSlotsLocal] = freshLayer("activation_seed", bindings.activation);
  const [lexicalNamesLocal, lexicalSlotsLocal] = freshLayer("lexical", bindings.lexical);
  const [outerNamesLocal, outerSlotsLocal] = freshLayer("outer", bindings.outer);

  // Preserve the compiler's mapped-arguments decision at the interpreter
  // boundary. Each vector index corresponds to arguments[index] and carries
  // the canonical parameter binding name, or null when that index is
  // unmapped. The provider can then mirror writes in execution order without
  // inventing a cross-module GC class or copying parameter values.
  const mappedParamNamesLocal = allocLocal(
    fctx,
    `__runtime_direct_eval_mapped_param_names_${fctx.locals.length}`,
    externref,
  );
  fctx.body.push({ op: "call", funcIdx: objVecNewIdx }, { op: "local.set", index: mappedParamNamesLocal });
  const mappedArgsInfo = fctx.mappedArgsInfo;
  if (mappedArgsInfo) {
    for (let i = 0; i < mappedArgsInfo.paramCount; i += 1) {
      const paramName = fctx.params[mappedArgsInfo.paramOffset + i]?.name;
      const isMapped = paramName !== undefined && !mappedArgsInfo.unmappedIndices?.has(i);
      fctx.body.push({ op: "local.get", index: mappedParamNamesLocal });
      if (isMapped) {
        fctx.body.push(...stringConstantExternrefInstrs(ctx, paramName));
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: objVecPushIdx });
    }
  }

  fctx.body.push({ op: "local.get", index: sourceLocal });
  if (emitGlobalEnvironmentObject(ctx, fctx) === null) fctx.body.push({ op: "ref.null.extern" });
  const thisType = compileExpression(ctx, fctx, ts.factory.createThis());
  if (thisType === null) {
    emitUndefined(ctx, fctx);
  } else if (thisType.kind !== "externref") {
    coerceType(ctx, fctx, thisType, externref);
  }
  fctx.body.push(
    { op: "local.get", index: activationStatePoolLocal },
    { op: "local.get", index: activationNamesLocal },
    { op: "local.get", index: activationSlotsLocal },
    { op: "local.get", index: lexicalNamesLocal },
    { op: "local.get", index: lexicalSlotsLocal },
    { op: "local.get", index: outerNamesLocal },
    { op: "local.get", index: outerSlotsLocal },
    { op: "i32.const", value: isStrictContext(call, ctx.inferModuleStrictArguments) ? 1 : 0 },
    { op: "local.get", index: mappedParamNamesLocal },
  );

  const evalIdx = ensureLateImport(
    ctx,
    "__runtime_direct_eval",
    [
      externref,
      externref,
      externref,
      externref,
      externref,
      externref,
      externref,
      externref,
      externref,
      externref,
      { kind: "i32" },
      externref,
    ],
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
      { op: "drop" },
      { op: "drop" },
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
