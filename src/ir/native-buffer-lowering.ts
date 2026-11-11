// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7274) Lower one plan-certified native ArrayBuffer / DataView operation
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
  IR_NATIVE_DV_NEW_FN,
} from "../shared/contracts/native-buffer-adapters.js";
import type { IrNativeBufferClass, IrNativeBufferOperation } from "./native-buffer-surface.js";
import { irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import { IrInvariantError } from "./outcomes.js";

const F64: IrType = irVal({ kind: "f64" });
const handle = (cls: IrNativeBufferClass): IrType => ({ kind: "extern", className: cls });

export interface IrNativeBufferLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly funcName: string;
  lower(expr: ts.Expression, hint: IrType): IrValueId;
  /** ToNumber of a lowered number-typed operand (f64 as is, the dynamic carrier unboxed), or `null`. */
  toNumber(value: IrValueId): IrValueId | null;
  /** Box a concrete value into the dynamic carrier, or `null` when it has none. */
  toDynamic(value: IrValueId, operand: ts.Expression): IrValueId | null;
}

function mismatch(host: IrNativeBufferLoweringHost, what: string): never {
  throw new IrInvariantError(
    "selection-preparation-mismatch",
    "build",
    `ir/native-buffer: a certified ${what} (${host.funcName})`,
  );
}

function lowerNumber(expr: ts.Expression | undefined, host: IrNativeBufferLoweringHost): IrValueId {
  if (expr === undefined) return host.builder.emitConst({ kind: "f64", value: 0 }, F64);
  return host.toNumber(host.lower(expr, F64)) ?? mismatch(host, "number operand has no f64 lowering");
}

function lowerHandle(expr: ts.Expression, cls: IrNativeBufferClass, host: IrNativeBufferLoweringHost): IrValueId {
  const value = host.lower(expr, handle(cls));
  const type = host.builder.typeOf(value);
  if (type.kind !== "extern" || type.className !== cls) mismatch(host, `${cls} receiver lowered to ${type.kind}`);
  return value;
}

/** A dynamic-carrier operand; an omitted one is `undefined`. */
function lowerDynamic(expr: ts.Expression | undefined, host: IrNativeBufferLoweringHost): IrValueId {
  if (expr === undefined) return host.builder.emitDynUndefined();
  const value = host.lower(expr, irDynamic());
  if (host.builder.typeOf(value).kind === "dynamic") return value;
  return host.toDynamic(value, expr) ?? mismatch(host, "operand has no dynamic carrier");
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
      const length = lowerNumber(op.length, host);
      if (op.maxByteLength === undefined) return call(host, IR_NATIVE_AB_NEW_FN, [length], handle("ArrayBuffer"));
      const max = lowerNumber(op.maxByteLength, host);
      return call(host, IR_NATIVE_AB_NEW_RESIZABLE_FN, [length, max], handle("ArrayBuffer"));
    }
    case "construct-view": {
      const buffer = lowerHandle(op.buffer, "ArrayBuffer", host);
      const offset = lowerNumber(op.offset, host);
      const length = lowerDynamic(op.length, host);
      return call(host, IR_NATIVE_DV_NEW_FN, [buffer, offset, length], handle("DataView"));
    }
    case "get": {
      const { fn, result } = op.member;
      return call(host, fn, [lowerHandle(op.receiver, op.receiverClass, host)], result === "boolean" ? irBool() : F64);
    }
    case "call": {
      const { fn, operands, resultClass } = op.member;
      const receiver = lowerHandle(op.receiver, op.receiverClass, host);
      const args = operands.map((_, i) => lowerDynamic(op.args[i], host));
      return call(host, fn, [receiver, ...args], resultClass ? handle(resultClass) : irDynamic());
    }
  }
}
