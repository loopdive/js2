// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Exact native provider for typed `string.repeat`, and (#7442) the length-checked pad provider.
 *
 * The historical `__str_repeat` kernel accepts an already-normalized i32.
 * Typed IR deliberately keeps the JS count as f64, so this adapter owns the
 * observable ToIntegerOrInfinity validation before narrowing and delegation.
 *
 * (#7442) `NATIVE_STRING_MAX_LENGTH` is the native string length limit. Repeat and pad are the builders whose
 * requested length is a number the caller chooses; both used to clamp it to i32 and then build a wrapped or saturated
 * result. Both providers now throw RangeError through {@link buildNativeStringLengthCheck}. The check lives in these
 * lazily built providers, not in the kernels: the native-string prelude is throw-free, and a throw there would
 * register the error constructor import and the exception tag in every module that uses a string.
 */
import { IR_STRING_REPEAT_FN, NATIVE_STRING_MAX_LENGTH } from "../ir/string-runtime.js";
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
export const NATIVE_STRING_LENGTH_RANGE_ERROR_MESSAGE = "RangeError: Invalid string length";

/**
 * Instructions that throw RangeError when the f64 length `length` pushes exceeds the limit. Builds fresh instruction
 * objects on every call: import relocation walks each body and must never patch a shared call twice. May register
 * the error constructor import, so a caller builds it before reading any function index it bakes.
 */
function buildNativeStringLengthCheck(ctx: CodegenContext, length: readonly Instr[]): Instr[] {
  return [
    ...length,
    { op: "f64.const", value: NATIVE_STRING_MAX_LENGTH },
    { op: "f64.gt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "RangeError", NATIVE_STRING_LENGTH_RANGE_ERROR_MESSAGE),
      else: [],
    },
  ];
}

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
  for (const message of [IR_NATIVE_STRING_REPEAT_RANGE_ERROR_MESSAGE, NATIVE_STRING_LENGTH_RANGE_ERROR_MESSAGE]) {
    if (!ctx.mod.stringPool.includes(message)) ctx.mod.stringPool.push(message);
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
  // Both throws may register exception support/imports. Complete them before
  // reading the raw-helper handle or minting the adapter's stable handle.
  const throwInvalidCount = buildThrowJsErrorInstrs(ctx, "RangeError", IR_NATIVE_STRING_REPEAT_RANGE_ERROR_MESSAGE);
  const integerCount = 2;
  const sourceLength = 3;
  // The kernel accepts an i32 count and doubles ropes with i32 lengths: bound the result in f64 before narrowing.
  const tooLong = buildNativeStringLengthCheck(ctx, [
    { op: "local.get", index: sourceLength },
    { op: "f64.convert_i32_u" },
    { op: "local.get", index: integerCount },
    { op: "f64.mul" },
  ]);
  const repeatKernel = nativeStrHelperHandle(ctx, "__str_repeat");
  if (repeatKernel === undefined) throw new Error("native IR string.repeat provider has no __str_repeat kernel");

  const stringType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx } as const satisfies ValType;
  const typeIdx = addFuncType(ctx, [stringType, { kind: "f64" }], [stringType], "$__ir_string_repeat_native_type");
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
    { op: "if", blockType: { kind: "empty" }, then: throwInvalidCount, else: [] },
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
    ...tooLong,
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

export type NativeStringPadKernel = "__str_padStart" | "__str_padEnd";

export function isNativeStringPadKernel(name: string): name is NativeStringPadKernel {
  return name === "__str_padStart" || name === "__str_padEnd";
}

/**
 * The pad kernel behind a length check, with the kernel's own `(string, i32 targetLength, string) -> string` ABI.
 * §22.1.3.17.2 StringPaddingBuiltinsImpl returns the receiver unchanged when the target is not longer than it or the
 * fill is empty, so the check runs only past those two returns.
 */
export function ensureNativeStringPadProvider(ctx: CodegenContext, kernelName: NativeStringPadKernel): number {
  const name = `${kernelName}_checked`;
  const existing = ctx.nativeStrHelpers.get(name);
  if (existing !== undefined) return existing;

  ensureNativeStringHelpers(ctx);
  const [receiver, targetLength, fill] = [0, 1, 2];
  const stringLength = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 },
  ];
  const tooLong = buildNativeStringLengthCheck(ctx, [
    { op: "local.get", index: targetLength },
    { op: "f64.convert_i32_s" },
  ]);
  const kernel = nativeStrHelperHandle(ctx, kernelName);
  const kernelType = kernel === undefined ? undefined : definedFuncAt(ctx, kernel)?.typeIdx;
  if (kernel === undefined || kernelType === undefined)
    throw new Error(`native string pad has no ${kernelName} kernel`);

  const body: Instr[] = [
    { op: "local.get", index: targetLength },
    ...stringLength(receiver),
    { op: "i32.gt_s" },
    ...stringLength(fill),
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: tooLong, else: [] },
    { op: "local.get", index: receiver },
    { op: "local.get", index: targetLength },
    { op: "local.get", index: fill },
    { op: "call", funcIdx: kernel },
  ];
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx: kernelType,
    locals: [],
    body,
    exported: false,
  });
  ctx.nativeStrHelpers.set(name, funcIdx);
  return funcIdx;
}
