// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7442) The native string length limit, enforced where a string builder is asked for a result past it.
 *
 * `NATIVE_STRING_MAX_LENGTH` is the one limit. Repeat and pad are the builders whose requested length is a number the
 * caller chooses; both used to clamp it to i32 and then build a wrapped or saturated result. They now throw
 * RangeError through {@link buildNativeStringLengthCheck}, the repeat provider (`ir-native-string-repeat.ts`) and the
 * pad provider below.
 *
 * The check lives in lazily built providers, not in the kernels: the native-string prelude is throw-free, and a throw
 * there would register the error constructor import and the exception tag in every module that uses a string.
 */
import { NATIVE_STRING_MAX_LENGTH } from "../ir/string-runtime.js";
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, nativeStrHelperHandle, pushDefinedFunc } from "./func-space.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureNativeStringHelpers } from "./native-strings.js";

export const NATIVE_STRING_LENGTH_RANGE_ERROR_MESSAGE = "RangeError: Invalid string length";

/**
 * Instructions that throw RangeError when the f64 length `length` pushes exceeds the limit. Builds fresh instruction
 * objects on every call: import relocation walks each body and must never patch a shared call twice. May register
 * the error constructor import, so a caller builds it before reading any function index it bakes.
 */
export function buildNativeStringLengthCheck(ctx: CodegenContext, length: readonly Instr[]): Instr[] {
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
