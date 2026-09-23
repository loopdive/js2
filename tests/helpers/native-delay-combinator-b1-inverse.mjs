// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";

export const B1_FACTORY_PATH = "src/runtime/wasmgc/promise/delay-combinator-layouts.ts";
export const B1_FACTORY_SHA256 = "003f81b2004d3724a7706be792ffae348b1eb66ab86167cb89ac0b4d9cb295ff";
export const B1_DONOR_HASHES = {
  "src/codegen/ir-native-promise-delay.ts": "7f099d0e987684c5f8efcd21417a712793ce1ff3eb15be17f9de21a02d87dcbc",
  "src/codegen/promise-combinators.ts": "6626de0315531f472c6f1b41a4de1bb6d9a35186a87b3c5d6eddd3b70b476f1c",
  "src/codegen/ir-native-async-runtime.ts": "2cbdb3afb82ab0b1c10a53dab5a7a92636a9586f37ba582bbd33baa7f3b7b5f7",
};
// Additive B1 inverse only. These full-file donor hashes are the frozen c2e2fa87
// bytes, not replacement evidence for the original historical receipt ledger.
// Context is mandatory and unique; no normalization discards comments or imports.
export const B1_INVERSE_ROWS = [
  {
    path: "src/codegen/ir-native-async-runtime.ts",
    before:
      '\nimport { IR_ASYNC_PROMISE_ALL_NATIVE_FN } from "../ir/async-semantic-runtime.js";\nimport type { WasmFunction } from "../ir/types.js";\nimport { buildNativeAllProviderLocals } from "../runtime/wasmgc/promise/delay-combinator-layouts.js";\nimport { ensureCombinatorFunctions, emitStandalonePromiseCombinatorRuntime } from "./promise-combinators.js";\nimport type { CodegenContext, FunctionContext } from "./context/types.js";\nimport { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";\n',
    after:
      '\nimport { IR_ASYNC_PROMISE_ALL_NATIVE_FN } from "../ir/async-semantic-runtime.js";\nimport type { WasmFunction } from "../ir/types.js";\nimport { ensureCombinatorFunctions, emitStandalonePromiseCombinatorRuntime } from "./promise-combinators.js";\nimport type { CodegenContext, FunctionContext } from "./context/types.js";\nimport { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";\n',
  },
  {
    path: "src/codegen/ir-native-async-runtime.ts",
    before:
      '  const previous = ctx.currentFunc;\n  ctx.currentFunc = fctx;\n  try {\n    const localPlan = buildNativeAllProviderLocals(\n      combinator.promiseTypeIdx,\n      combinator.arrTypeIdx,\n      combinator.stateTypeIdx,\n      { parameterCount: fctx.params.length, firstLocalOrdinal: fctx.locals.length, argVecLocal: 0 },\n    );\n    // The compatibility emitter binds resources/locals, then immediately\n    // publishes the canonical detached vector body into this exact context.\n    emitStandalonePromiseCombinatorRuntime(ctx, fctx, "all", 0, combinator.vecTypeIdx, combinator.arrTypeIdx);\n    const firstSlot = localPlan.slots.resultLocal;\n    if (fctx.locals.length !== localPlan.locals.length) {\n      throw new Error("native Promise.all provider lost its canonical local population");\n    }\n    for (const [ordinal, expected] of localPlan.locals.entries()) {\n      const actual = fctx.locals[ordinal];\n      if (\n        actual?.name !== expected.name ||\n        actual.type.kind !== expected.type.kind ||\n        (expected.type.kind === "ref" &&\n          (actual.type.kind !== "ref" || actual.type.typeIdx !== expected.type.typeIdx)) ||\n        fctx.localMap.get(expected.name) !== firstSlot + ordinal\n      ) {\n        throw new Error("native Promise.all provider lost its canonical local layout");\n      }\n    }\n    fctx.body.push({ op: "return" });\n  } finally {\n    ctx.currentFunc = previous;\n',
    after:
      '  const previous = ctx.currentFunc;\n  ctx.currentFunc = fctx;\n  try {\n    // The compatibility emitter binds resources/locals, then immediately\n    // publishes the canonical detached vector body into this exact context.\n    emitStandalonePromiseCombinatorRuntime(ctx, fctx, "all", 0, combinator.vecTypeIdx, combinator.arrTypeIdx);\n    fctx.body.push({ op: "return" });\n  } finally {\n    ctx.currentFunc = previous;\n',
  },
  {
    path: "src/codegen/ir-native-promise-delay.ts",
    before:
      ' */\n\nimport type { ValType } from "../ir/types.js";\nimport { createNativeDelayCaptureShape } from "../runtime/wasmgc/promise/delay-combinator-layouts.js";\nimport {\n  buildNativePromiseDelayCallbackLocals,\n  buildNativePromiseDelayCallbackBody,\n',
    after:
      ' */\n\nimport type { ValType } from "../ir/types.js";\nimport {\n  buildNativePromiseDelayCallbackLocals,\n  buildNativePromiseDelayCallbackBody,\n',
  },
  {
    path: "src/codegen/ir-native-promise-delay.ts",
    before:
      'import { IR_NATIVE_PROMISE_DELAY_FN } from "../ir/promise-delay-lowering.js";\nimport { ensureAsyncDriveRuntime } from "./async-scheduler.js";\nimport { getOrCreateFuncRefWrapperTypes } from "./closures.js";\nimport { closureBagInitInstr } from "./closures/funcref-wrapper-types.js";\nimport type { CodegenContext } from "./context/types.js";\nimport { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";\nimport { ensureExnTag } from "./registry/imports.js";\n',
    after:
      'import { IR_NATIVE_PROMISE_DELAY_FN } from "../ir/promise-delay-lowering.js";\nimport { ensureAsyncDriveRuntime } from "./async-scheduler.js";\nimport { getOrCreateFuncRefWrapperTypes } from "./closures.js";\nimport { closureArityField, closureBagField, closureBagInitInstr } from "./closures/funcref-wrapper-types.js";\nimport type { CodegenContext } from "./context/types.js";\nimport { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";\nimport { ensureExnTag } from "./registry/imports.js";\n',
  },
  {
    path: "src/codegen/ir-native-promise-delay.ts",
    before:
      '  }\n\n  const callbackCaptureTypeIdx = ctx.mod.types.length;\n  const captureShape = createNativeDelayCaptureShape(\n    { kind: "ref" as const, typeIdx: callbackWrapper.structTypeIdx },\n    { kind: "ref" as const, typeIdx: runtime.promiseTypeIdx },\n  );\n  ctx.mod.types.push({\n    kind: "struct",\n    name: captureShape.name,\n    fields: [...captureShape.fields],\n    superTypeIdx: captureShape.parent.typeIdx,\n  });\n\n  const timerCallbackFuncIdx = mintDefinedFunc(ctx);\n',
    after:
      '  }\n\n  const callbackCaptureTypeIdx = ctx.mod.types.length;\n  ctx.mod.types.push({\n    kind: "struct",\n    name: "$__ir_promise_delay_timer_cap",\n    fields: [\n      { name: "func", type: { kind: "funcref" }, mutable: false },\n      closureArityField(),\n      closureBagField(),\n      { name: "promise", type: { kind: "ref", typeIdx: runtime.promiseTypeIdx }, mutable: false },\n      { name: "value", type: { kind: "f64" }, mutable: false },\n    ],\n    superTypeIdx: callbackWrapper.structTypeIdx,\n  });\n\n  const timerCallbackFuncIdx = mintDefinedFunc(ctx);\n',
  },
  {
    path: "src/codegen/promise-combinators.ts",
    before:
      '  buildNativePromiseCombinatorVectorBody,\n} from "../runtime/wasmgc/promise/combinator-bodies.js";\nimport type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";\nimport {\n  createNativeCombinatorStateShape,\n  createNativeCombinatorElementShape,\n  buildNativeAllProviderLocals,\n} from "../runtime/wasmgc/promise/delay-combinator-layouts.js";\nimport type { FieldDef, Instr, LocalDef, ValType } from "../ir/types.js";\nimport { ensureBuiltinFnMetaType } from "./builtin-fn-meta.js";\nimport {\n',
    after:
      '  buildNativePromiseCombinatorVectorBody,\n} from "../runtime/wasmgc/promise/combinator-bodies.js";\nimport type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";\nimport type { FieldDef, Instr, LocalDef, ValType } from "../ir/types.js";\nimport { ensureBuiltinFnMetaType } from "./builtin-fn-meta.js";\nimport {\n',
  },
  {
    path: "src/codegen/promise-combinators.ts",
    before:
      '  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", EXTERNREF);\n  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);\n\n  const stateShape = createNativeCombinatorStateShape(\n    { kind: "ref" as const, typeIdx: promiseTypeIdx },\n    { kind: "ref" as const, typeIdx: arrTypeIdx },\n  );\n  const stateTypeIdx = registerStruct(ctx, stateShape.name, [...stateShape.fields]);\n  const elementShape = createNativeCombinatorElementShape({ kind: "ref" as const, typeIdx: stateTypeIdx });\n  const elemCapsTypeIdx = registerStruct(ctx, elementShape.name, [...elementShape.fields]);\n\n  // Func types. The fulfill/reject wrappers share the microtask wrapper shape\n  // `(caps externref, value externref) -> externref` (addFuncType dedups, so this\n',
    after:
      '  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", EXTERNREF);\n  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);\n\n  const stateTypeIdx = registerStruct(ctx, "$CombinatorState", [\n    { name: "resultPromise", type: { kind: "ref", typeIdx: promiseTypeIdx }, mutable: false },\n    { name: "resultsArr", type: { kind: "ref", typeIdx: arrTypeIdx }, mutable: false },\n    { name: "length", type: { kind: "i32" }, mutable: false },\n    { name: "remaining", type: { kind: "i32" }, mutable: true },\n  ]);\n  const elemCapsTypeIdx = registerStruct(ctx, "$CombinatorElemCaps", [\n    { name: "state", type: { kind: "ref", typeIdx: stateTypeIdx }, mutable: false },\n    { name: "index", type: { kind: "i32" }, mutable: false },\n  ]);\n\n  // Func types. The fulfill/reject wrappers share the microtask wrapper shape\n  // `(caps externref, value externref) -> externref` (addFuncType dedups, so this\n',
  },
  {
    path: "src/codegen/promise-combinators.ts",
    before:
      '  // emission below (registration-before-bake, same contract as the literal arm).\n  const reaction = combinatorReactionFns(ctx, ids, method);\n\n  const localPlan = buildNativeAllProviderLocals(ids.promiseTypeIdx, ids.arrTypeIdx, ids.stateTypeIdx, {\n    parameterCount: fctx.params.length,\n    firstLocalOrdinal: fctx.locals.length,\n    argVecLocal,\n  });\n  const { resultLocal, arrLocal, stateLocal, nLocal, iLocal } = localPlan.slots;\n  const expectedSlots = [resultLocal, arrLocal, stateLocal, nLocal, iLocal];\n  for (const [ordinal, local] of localPlan.locals.entries()) {\n    if (allocLocal(fctx, local.name, local.type) !== expectedSlots[ordinal]) {\n      throw new Error("native combinator local allocation diverged from its canonical layout");\n    }\n  }\n\n  const body = buildNativePromiseCombinatorVectorBody(\n    {\n',
    after:
      '  // emission below (registration-before-bake, same contract as the literal arm).\n  const reaction = combinatorReactionFns(ctx, ids, method);\n\n  const resultLocal = allocLocal(fctx, `__comb_result_${fctx.locals.length}`, {\n    kind: "ref",\n    typeIdx: ids.promiseTypeIdx,\n  });\n  const arrLocal = allocLocal(fctx, `__comb_arr_${fctx.locals.length}`, {\n    kind: "ref",\n    typeIdx: ids.arrTypeIdx,\n  });\n  const stateLocal = allocLocal(fctx, `__comb_state_${fctx.locals.length}`, {\n    kind: "ref",\n    typeIdx: ids.stateTypeIdx,\n  });\n  const nLocal = allocLocal(fctx, `__comb_n_${fctx.locals.length}`, { kind: "i32" });\n  const iLocal = allocLocal(fctx, `__comb_i_${fctx.locals.length}`, { kind: "i32" });\n\n  const body = buildNativePromiseCombinatorVectorBody(\n    {\n',
  },
];

export function reconstructB1Source(path, reader) {
  if (createHash("sha256").update(reader(B1_FACTORY_PATH)).digest("hex") !== B1_FACTORY_SHA256)
    throw new Error("changed mandatory B1 canonical factory");
  let source = reader(path);
  if (!(path in B1_DONOR_HASHES)) return source;
  for (const row of B1_INVERSE_ROWS.filter((row) => row.path === path)) {
    if (source.split(row.before).length !== 2) throw new Error(`missing/ambiguous B1 inverse: ${path}`);
    source = source.replace(row.before, row.after);
  }
  return source;
}

/** Full-file donor check for independently executing the old adapter. */
export function originalB1Source(path, reader) {
  const source = reconstructB1Source(path, reader);
  if (path in B1_DONOR_HASHES && createHash("sha256").update(source).digest("hex") !== B1_DONOR_HASHES[path]) {
    throw new Error(`changed complete donor: ${path}`);
  }
  return source;
}
