// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrConst, IrValueId } from "./nodes.js";
import { irDynamic, irVal, type IrType } from "./types.js";
import type { TagId } from "./tag-domain.js";

/** Pure port of the actual caller builder; not a site-issuance or admission capability. */
export interface NativeNumberUndefinedBuilder {
  typeOf(value: IrValueId): IrType;
  emitConst(value: IrConst, type: IrType): IrValueId;
  emitUnary(op: Extract<IrInstr, { kind: "unary" }>["op"], value: IrValueId, type: IrType): IrValueId;
  emitBinary(op: Extract<IrInstr, { kind: "binary" }>["op"], lhs: IrValueId, rhs: IrValueId, type: IrType): IrValueId;
  emitBox(value: IrValueId, type: IrType): IrValueId;
  emitVecGet(vec: IrValueId, index: IrValueId, type: IrType): IrValueId;
  emitVecLenI32(vec: IrValueId): IrValueId;
  collectBodyInstrs(emit: () => void): IrInstr[];
  emitIfElse(args: {
    cond: IrValueId;
    then: readonly IrInstr[];
    thenValue: IrValueId;
    else: readonly IrInstr[];
    elseValue: IrValueId;
    resultType: IrType;
  }): IrValueId;
}

/** The caller has evaluated the original receiver and numeric index exactly once. */
export function emitNativeNumberUndefinedRead(
  builder: NativeNumberUndefinedBuilder,
  receiver: IrValueId,
  rawIndex: IrValueId,
  numericTag: TagId,
  singletonTag: TagId,
): IrValueId {
  const f64 = irVal({ kind: "f64" }),
    i32 = irVal({ kind: "i32" });
  const type = builder.typeOf(rawIndex);
  if (type.kind !== "val" || (type.val.kind !== "f64" && type.val.kind !== "i32"))
    throw new TypeError("native Number/Undefined index is not numeric");
  const index = type.val.kind === "i32" ? rawIndex : builder.emitUnary("i32.trunc_sat_f64_s", rawIndex, i32);
  const length = builder.emitVecLenI32(receiver);
  let valid = builder.emitBinary("i32.lt_u", index, length, i32);
  if (type.val.kind === "f64") {
    const restored = builder.emitUnary("f64.convert_i32_s", index, f64);
    const exact = builder.emitBinary("f64.eq", rawIndex, restored, i32);
    valid = builder.emitBinary("i32.and", valid, exact, i32);
  }
  let number!: IrValueId, absent!: IrValueId;
  const then = builder.collectBodyInstrs(() => {
    const payload = builder.emitVecGet(receiver, index, f64);
    number = builder.emitBox(payload, irDynamic(numericTag));
  });
  const otherwise = builder.collectBodyInstrs(() => {
    absent = builder.emitConst({ kind: "undefined" }, irDynamic(singletonTag));
  });
  return builder.emitIfElse({
    cond: valid,
    then,
    thenValue: number,
    else: otherwise,
    elseValue: absent,
    resultType: irDynamic(),
  });
}

/** Source-certified value join; only the selected original expression is evaluated. */
export function emitNativeNumberUndefinedJoin(
  builder: NativeNumberUndefinedBuilder,
  condition: IrValueId,
  whenTrue: () => IrValueId,
  whenFalse: () => IrValueId,
  numericTag: TagId,
): IrValueId {
  const number = (value: IrValueId) => {
    const type = builder.typeOf(value);
    if (type.kind === "dynamic") return value;
    if (type.kind !== "val" || type.val.kind !== "f64")
      throw new TypeError("native Number/Undefined arm is not a number");
    return builder.emitBox(value, irDynamic(numericTag));
  };
  let left!: IrValueId, right!: IrValueId;
  const then = builder.collectBodyInstrs(() => {
    left = number(whenTrue());
  });
  const otherwise = builder.collectBodyInstrs(() => {
    right = number(whenFalse());
  });
  return builder.emitIfElse({
    cond: condition,
    then,
    thenValue: left,
    else: otherwise,
    elseValue: right,
    resultType: irDynamic(),
  });
}
