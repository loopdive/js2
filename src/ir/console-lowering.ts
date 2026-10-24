// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import { irVal, type IrValueId } from "./nodes.js";
import { irTypeIsBoolean, lowerBooleanToString } from "./boolean-brand.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import {
  IR_CONSOLE_FORMAT_VALUE_FN,
  IR_CONSOLE_SINK_APPEND_FN,
  IR_CONSOLE_STDERR_APPEND_FN,
  IR_NUMBER_TO_STRING_NATIVE_FN,
} from "./host-free-runtime.js";
import { IrUnsupportedError } from "./outcomes.js";

/** Render the already evaluated argument with the native console's canonical providers. */
function renderNativeConsoleArgument(
  builder: IrFunctionBuilder,
  value: IrValueId,
  numberFormatter: boolean,
): IrValueId {
  const type = builder.typeOf(value);
  if (type.kind === "string") return value;
  if (type.kind === "dynamic") {
    const rendered = builder.emitCall(irRuntimeFuncRef(IR_CONSOLE_FORMAT_VALUE_FN), [value], { kind: "string" });
    if (rendered === null) throw new Error("Native console renderer returned no string");
    return rendered;
  }
  if (irTypeIsBoolean(type)) return lowerBooleanToString(builder, value);
  if (type.kind === "val" && type.val.kind === "i32") {
    value = builder.emitUnary("f64.convert_i32_s", value, irVal({ kind: "f64" }));
  } else if (type.kind !== "val" || type.val.kind !== "f64") {
    throw new IrUnsupportedError("method-call-unsupported", "build", `native console cannot render ${type.kind}`);
  }
  if (!numberFormatter)
    throw new IrUnsupportedError(
      "primitive-method-unsupported",
      "build",
      "native console requires its number formatter",
    );
  const rendered = builder.emitCall(irRuntimeFuncRef(IR_NUMBER_TO_STRING_NATIVE_FN), [value], { kind: "string" });
  if (rendered === null) throw new Error("Native number renderer returned no string");
  return rendered;
}

/** One source argument evaluation, one newline, and the correct native output channel. */
export function lowerNativeConsoleLine(
  builder: IrFunctionBuilder,
  value: IrValueId,
  method: string,
  numberFormatter: boolean,
): void {
  const rendered = renderNativeConsoleArgument(builder, value, numberFormatter);
  const line = builder.emitStringConcat(rendered, builder.emitStringConst("\n"));
  const sink = method === "warn" || method === "error" ? IR_CONSOLE_STDERR_APPEND_FN : IR_CONSOLE_SINK_APPEND_FN;
  builder.emitCall(irRuntimeFuncRef(sink), [line], null);
}
