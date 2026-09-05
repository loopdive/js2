// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Exact native provider for typed `string.repeat`.
 *
 * The historical `__str_repeat` kernel accepts an already-normalized i32.
 * Typed IR deliberately keeps the JS count as f64, so this adapter owns the
 * observable ToIntegerOrInfinity validation before narrowing and delegation.
 */
import { IR_COUNTED_STRING_REPEAT_NATIVE_MAX_RESULT_CODE_UNITS, IR_STRING_REPEAT_FN } from "../ir/string-runtime.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import {
  definedFuncAt,
  funcSignatureOf,
  mintDefinedFunc,
  nativeStrHelperHandle,
  pushDefinedFunc,
} from "./func-space.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

export const IR_NATIVE_STRING_REPEAT_PROVIDER_FN = `${IR_STRING_REPEAT_FN}_native`;
export const IR_NATIVE_STRING_REPEAT_RANGE_ERROR_MESSAGE = "RangeError: Invalid count value";
/**
 * Keeps the rope-doubling kernel's intermediate signed-i32 length below 2^31.
 * A provider may reject a non-empty result at an implementation-size limit;
 * it must never let integer narrowing change the requested count.
 */
export const IR_NATIVE_STRING_REPEAT_MAX_RESULT_CODE_UNITS = IR_COUNTED_STRING_REPEAT_NATIVE_MAX_RESULT_CODE_UNITS;

interface NativeStringRepeatState {
  readonly funcIdx: number;
  readonly stringTypeIdx: number;
}

type NativeStringRepeatContext = CodegenContext & {
  __irNativeStringRepeat?: NativeStringRepeatState;
};

/** Verify the existing native `(string, i32) -> string` repeat kernel. */
export function hasExactIrNativeCountedStringRepeatProviderAbi(ctx: CodegenContext, funcIdx: number): boolean {
  const signature = funcSignatureOf(ctx, funcIdx);
  return (
    ctx.nativeStrings === true &&
    ctx.anyStrTypeIdx >= 0 &&
    nativeStrHelperHandle(ctx, "__str_repeat") === funcIdx &&
    definedFuncAt(ctx, funcIdx)?.name === "__str_repeat" &&
    signature?.params.length === 2 &&
    signature.params[0]?.kind === "ref" &&
    signature.params[0].typeIdx === ctx.anyStrTypeIdx &&
    signature.params[1]?.kind === "i32" &&
    signature.results.length === 1 &&
    signature.results[0]?.kind === "ref" &&
    signature.results[0].typeIdx === ctx.anyStrTypeIdx
  );
}

/** Resolve the authenticated counted-repeat provider without creating an adapter. */
export function ensureIrNativeCountedStringRepeatProvider(ctx: CodegenContext): number {
  if (!ctx.nativeStrings) throw new Error("counted native IR string.repeat provider requires native strings");
  ensureNativeStringHelpers(ctx);
  const funcIdx = nativeStrHelperHandle(ctx, "__str_repeat");
  if (funcIdx === undefined || !hasExactIrNativeCountedStringRepeatProviderAbi(ctx, funcIdx)) {
    throw new Error("counted native IR string.repeat provider has a malformed __str_repeat ABI");
  }
  // Keep CompileResult/adapter-manifest metadata stable against the direct and
  // generic-provider lanes. Native modules do not import this pool entry; the
  // authenticated counted path merely removes its dead code materialization.
  if (!ctx.mod.stringPool.includes(IR_NATIVE_STRING_REPEAT_RANGE_ERROR_MESSAGE)) {
    ctx.mod.stringPool.push(IR_NATIVE_STRING_REPEAT_RANGE_ERROR_MESSAGE);
  }
  return funcIdx;
}

function hasExactProvider(ctx: CodegenContext, state: NativeStringRepeatState): boolean {
  const signature = funcSignatureOf(ctx, state.funcIdx);
  return (
    ctx.funcMap.get(IR_NATIVE_STRING_REPEAT_PROVIDER_FN) === state.funcIdx &&
    definedFuncAt(ctx, state.funcIdx)?.name === IR_NATIVE_STRING_REPEAT_PROVIDER_FN &&
    signature?.params.length === 2 &&
    signature.params[0]?.kind === "ref_null" &&
    signature.params[0].typeIdx === state.stringTypeIdx &&
    signature.params[1]?.kind === "f64" &&
    signature.results.length === 1 &&
    signature.results[0]?.kind === "ref_null" &&
    signature.results[0].typeIdx === state.stringTypeIdx
  );
}

/** Register `(ref null $AnyString, f64) -> ref null $AnyString`, exactly once. */
export function ensureIrNativeStringRepeatProvider(ctx: CodegenContext): number {
  const saved = (ctx as NativeStringRepeatContext).__irNativeStringRepeat;
  if (saved) {
    if (!hasExactProvider(ctx, saved)) throw new Error("native IR string.repeat provider lost its exact ABI");
    return saved.funcIdx;
  }
  if (!ctx.nativeStrings) throw new Error("native IR string.repeat provider requires native strings");
  if (
    ctx.funcMap.has(IR_NATIVE_STRING_REPEAT_PROVIDER_FN) ||
    ctx.mod.functions.some((fn) => fn.name === IR_NATIVE_STRING_REPEAT_PROVIDER_FN) ||
    ctx.mod.imports.some((entry) => entry.desc.kind === "func" && entry.name === IR_NATIVE_STRING_REPEAT_PROVIDER_FN)
  ) {
    throw new Error(`native IR string.repeat provider name ${IR_NATIVE_STRING_REPEAT_PROVIDER_FN} is occupied`);
  }

  ensureNativeStringHelpers(ctx);
  if (ctx.anyStrTypeIdx < 0) throw new Error("native IR string.repeat provider has no AnyString carrier");
  // This may register exception support/imports. Complete it before reading
  // the raw-helper handle or minting the adapter's stable handle.
  const throwRangeError = buildThrowJsErrorInstrs(ctx, "RangeError", IR_NATIVE_STRING_REPEAT_RANGE_ERROR_MESSAGE);
  // Each branch owns distinct instruction objects. Later import-index
  // relocation walks both buffers and must never patch a shared call twice.
  const throwInvalidCount = (): Instr[] => throwRangeError.map((instruction) => ({ ...instruction }));
  const repeatKernel = nativeStrHelperHandle(ctx, "__str_repeat");
  if (repeatKernel === undefined) throw new Error("native IR string.repeat provider has no __str_repeat kernel");

  const stringType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx } as const satisfies ValType;
  const typeIdx = addFuncType(ctx, [stringType, { kind: "f64" }], [stringType], "$__ir_string_repeat_native_type");
  const integerCount = 2;
  const sourceLength = 3;
  const body: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "f64.trunc" },
    { op: "local.set", index: integerCount },
    { op: "local.get", index: integerCount },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    { op: "local.get", index: integerCount },
    { op: "f64.const", value: Infinity },
    { op: "f64.eq" },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: throwInvalidCount(), else: [] },
    // ToIntegerOrInfinity(NaN) is +0. Normalize explicitly so the final
    // non-saturating i32 conversion is reached only with a finite value.
    { op: "local.get", index: integerCount },
    { op: "local.get", index: integerCount },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "f64.const", value: 0 },
        { op: "local.set", index: integerCount },
      ],
      else: [],
    },
    // Validation precedes this fast path: "".repeat(-1) must throw, while a
    // valid enormous count on an empty receiver must still return "".
    { op: "local.get", index: 0 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 },
    { op: "local.tee", index: sourceLength },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "return" }],
      else: [],
    },
    // The historical kernel accepts an i32 count and doubles ropes with i32
    // lengths. Bound the requested result in f64 first, so neither count
    // narrowing nor a doubling intermediate can silently wrap/saturate.
    { op: "local.get", index: sourceLength },
    { op: "f64.convert_i32_u" },
    { op: "local.get", index: integerCount },
    { op: "f64.mul" },
    { op: "f64.const", value: IR_NATIVE_STRING_REPEAT_MAX_RESULT_CODE_UNITS },
    { op: "f64.gt" },
    { op: "if", blockType: { kind: "empty" }, then: throwInvalidCount(), else: [] },
    { op: "local.get", index: 0 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: integerCount },
    { op: "i32.trunc_f64_s" },
    { op: "call", funcIdx: repeatKernel },
  ];
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: IR_NATIVE_STRING_REPEAT_PROVIDER_FN,
    typeIdx,
    locals: [
      { name: "integerCount", type: { kind: "f64" } },
      { name: "sourceLength", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  ctx.funcMap.set(IR_NATIVE_STRING_REPEAT_PROVIDER_FN, funcIdx);
  const state = Object.freeze({ funcIdx, stringTypeIdx: ctx.anyStrTypeIdx });
  (ctx as NativeStringRepeatContext).__irNativeStringRepeat = state;
  if (!hasExactProvider(ctx, state))
    throw new Error("native IR string.repeat provider materialized with a malformed ABI");
  return funcIdx;
}
