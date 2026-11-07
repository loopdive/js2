// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7274) Lower one plan-certified native `ArrayBuffer` operation
 * (`native-buffer-surface.ts`) to a direct call of its adapter. The operands
 * are evaluated left to right, as the source argument list is, and the
 * adapter performs the coercions legacy performs at the same site.
 */
import type { ts } from "../ts-api.js";
import { irBool } from "./boolean-brand.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import {
  IR_NATIVE_AB_NEW_FN,
  IR_NATIVE_AB_NEW_RESIZABLE_FN,
  IR_NATIVE_AB_SLICE_FN,
} from "../shared/contracts/native-buffer-adapters.js";
import {
  IR_NATIVE_BUFFER_CLASS,
  IR_NATIVE_BUFFER_GETTER_FNS,
  type IrNativeBufferOperation,
} from "./native-buffer-surface.js";
import { irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import { IrInvariantError } from "./outcomes.js";

const BUFFER: IrType = { kind: "extern", className: IR_NATIVE_BUFFER_CLASS };
const F64: IrType = irVal({ kind: "f64" });

export interface IrNativeBufferLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly funcName: string;
  lower(expr: ts.Expression, hint: IrType): IrValueId;
  /** ToNumber of a lowered number-typed operand (f64 as is, the dynamic carrier unboxed), or `null`. */
  toNumber(value: IrValueId): IrValueId | null;
  /** Box a concrete value into the dynamic carrier, or `null` when it has none. */
  toDynamic(value: IrValueId, operand: ts.Expression): IrValueId | null;
}

function lowerNumber(expr: ts.Expression, host: IrNativeBufferLoweringHost): IrValueId {
  const value = host.toNumber(host.lower(expr, F64));
  if (value === null) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      `ir/native-buffer: a number-typed operand has no f64 lowering (${host.funcName})`,
    );
  }
  return value;
}

function lowerReceiver(expr: ts.Expression, host: IrNativeBufferLoweringHost): IrValueId {
  const value = host.lower(expr, BUFFER);
  const type = host.builder.typeOf(value);
  if (type.kind !== "extern" || type.className !== IR_NATIVE_BUFFER_CLASS) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      `ir/native-buffer: a certified receiver lowered to ${type.kind} (${host.funcName})`,
    );
  }
  return value;
}

function lowerBound(expr: ts.Expression | undefined, host: IrNativeBufferLoweringHost): IrValueId {
  if (expr === undefined) return host.builder.emitDynUndefined();
  const value = host.lower(expr, irDynamic());
  if (host.builder.typeOf(value).kind === "dynamic") return value;
  const boxed = host.toDynamic(value, expr);
  if (boxed === null) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      `ir/native-buffer: a number or undefined slice bound has no dynamic carrier (${host.funcName})`,
    );
  }
  return boxed;
}

function call(host: IrNativeBufferLoweringHost, name: string, args: IrValueId[], result: IrType): IrValueId {
  const value = host.builder.emitCall(irRuntimeFuncRef(name), args, result);
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (value === null) throw new Error(`ir/native-buffer: ${name} returned void (${host.funcName})`);
  return value;
}

export function lowerNativeBufferOperation(op: IrNativeBufferOperation, host: IrNativeBufferLoweringHost): IrValueId {
  switch (op.kind) {
    case "construct": {
      const length =
        op.length === undefined ? host.builder.emitConst({ kind: "f64", value: 0 }, F64) : lowerNumber(op.length, host);
      if (op.maxByteLength === undefined) return call(host, IR_NATIVE_AB_NEW_FN, [length], BUFFER);
      return call(host, IR_NATIVE_AB_NEW_RESIZABLE_FN, [length, lowerNumber(op.maxByteLength, host)], BUFFER);
    }
    case "get": {
      const receiver = lowerReceiver(op.receiver, host);
      return call(host, IR_NATIVE_BUFFER_GETTER_FNS[op.member], [receiver], op.member === "resizable" ? irBool() : F64);
    }
    case "slice": {
      const receiver = lowerReceiver(op.receiver, host);
      const start = lowerBound(op.bounds[0], host);
      const end = lowerBound(op.bounds[1], host);
      return call(host, IR_NATIVE_AB_SLICE_FN, [receiver, start, end], BUFFER);
    }
  }
}
