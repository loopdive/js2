// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { hostFreeEnvironment, type CodegenContext } from "../context/types.js";
import {
  ensureAnyToStringHelper,
  standaloneConsoleSinkAvailable,
  STANDALONE_STDOUT_APPEND_FN,
} from "../native-strings.js";
import { ensureWasiWriteAnyStringHelper } from "../wasi.js";
import { addFuncType } from "../registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { flushLateImportShifts } from "../expressions/late-imports.js";
import {
  IR_CONSOLE_FORMAT_VALUE_FN,
  IR_CONSOLE_SINK_APPEND_FN,
  IR_CONSOLE_STDERR_APPEND_FN,
} from "../../shared/contracts/console-output.js";

/**
 * A host-free module has an observable console sink: standalone's stdout rope,
 * or WASI's `fd_write` import (registered only for a WASI target). Selecting by
 * the registered provider, not the target flag, keeps this one lowering for both.
 */
export function nativeConsoleOutputAvailable(ctx: CodegenContext): boolean {
  return (
    hostFreeEnvironment(ctx) && ctx.nativeStrings && (standaloneConsoleSinkAvailable(ctx) || ctx.wasiFdWriteIdx >= 0)
  );
}

/** Reuse the native console value renderer, without reinterpreting objects via ToPrimitive. */
function ensureIrConsoleFormatValue(ctx: CodegenContext): number | null {
  if (!nativeConsoleOutputAvailable(ctx) || ctx.fast) return null;
  const existing = ctx.funcMap.get(IR_CONSOLE_FORMAT_VALUE_FN);
  if (existing !== undefined) return existing;
  const render = ensureAnyToStringHelper(ctx);
  flushLateImportShifts(ctx, null);
  if (ctx.anyStrTypeIdx < 0) return null;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "ref", typeIdx: ctx.anyStrTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: IR_CONSOLE_FORMAT_VALUE_FN,
    typeIdx,
    locals: [],
    exported: false,
    body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "call", funcIdx: render }],
  });
  ctx.funcMap.set(IR_CONSOLE_FORMAT_VALUE_FN, funcIdx);
  return funcIdx;
}

/** Preserve standalone's rope and WASI's fd 1/2 routing through their existing providers. */
function ensureIrNativeConsoleOutput(ctx: CodegenContext, stderr: boolean): number | null {
  if (!nativeConsoleOutputAvailable(ctx)) return null;
  if (ctx.wasiFdWriteIdx < 0) return ctx.funcMap.get(STANDALONE_STDOUT_APPEND_FN) ?? null;
  const index = ensureWasiWriteAnyStringHelper(ctx, stderr);
  return index >= 0 ? index : null;
}

export const IR_NATIVE_CONSOLE_SYMBOLS: ReadonlySet<string> = new Set([
  IR_CONSOLE_FORMAT_VALUE_FN,
  IR_CONSOLE_SINK_APPEND_FN,
  IR_CONSOLE_STDERR_APPEND_FN,
]);

/** One native console provider boundary; unknown bindings fail closed. */
export function ensureIrNativeConsoleProvider(ctx: CodegenContext, symbol: string): number | null {
  if (symbol === IR_CONSOLE_FORMAT_VALUE_FN) return ensureIrConsoleFormatValue(ctx);
  if (symbol === IR_CONSOLE_SINK_APPEND_FN || symbol === IR_CONSOLE_STDERR_APPEND_FN)
    return ensureIrNativeConsoleOutput(ctx, symbol === IR_CONSOLE_STDERR_APPEND_FN);
  return null;
}
