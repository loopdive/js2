// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 J) `JSON.stringify(value)` of the dynamic value, one argument (`JSON_ARM`). The answer is a string or
 * `undefined`, so it is the carrier: each text arm wraps its native string, and `undefined` answers the `undefined`
 * value. An object or function aborts by name at run time.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import type { MemberReadBuilders } from "./dynamic-member-read.js";
import { JSON_ARM, type CarrierKind } from "./dynamic-value-kinds.js";

/** The legalization builders the serialization is written with. */
export interface JsonStringifyBuilders extends Pick<
  MemberReadBuilders,
  "carrier" | "fresh" | "text" | "intrinsic" | "kindsOf" | "kindChain"
> {
  readonly testResult: IrType;
  readonly toStringArm: (instr: IrInstr, kind: CarrierKind, value: IrValueId, result: IrValueId) => IrInstr[];
  readonly formatNumber: (number: IrValueId, result: IrValueId) => IrInstr;
  readonly branch: (
    cond: IrValueId,
    then: (r: IrValueId) => IrInstr[],
    else_: (r: IrValueId) => IrInstr[],
    result: IrValueId,
  ) => IrInstr;
}

type JsonArm = (typeof JSON_ARM)[CarrierKind];
const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });

/** The serialization of the once-evaluated `value` into `result`. */
export function dynamicJsonStringify(
  b: JsonStringifyBuilders,
  instr: IrInstr,
  value: IrValueId,
  result: IrValueId,
): IrInstr[] {
  /** SerializeJSONProperty's text for a value of `kind`, whose row is `row`: a native string. */
  const textOf = (row: Exclude<JsonArm, "undefined">, kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (row) {
      case "quote":
        return [b.intrinsic(instr, "js.value.json_quote", [value], r)];
      case "number": {
        // A number is finite exactly when `n - n` is 0: NaN and both infinities give NaN.
        const [number, difference, zero, finite] = [b.fresh(), b.fresh(), b.fresh(), b.fresh()];
        return [
          b.intrinsic(instr, "js.number.unbox", [value], number),
          { kind: "binary", op: "f64.sub", lhs: number, rhs: number, result: difference, resultType: F64 },
          { kind: "const", value: { kind: "f64", value: 0 }, result: zero, resultType: F64 },
          { kind: "binary", op: "f64.eq", lhs: difference, rhs: zero, result: finite, resultType: b.testResult },
          b.branch(
            finite,
            (s) => [b.formatNumber(number, s)],
            (s) => [b.text("null", s)],
            r,
          ),
        ];
      }
      case "to-string":
        return b.toStringArm(instr, kind, value, r);
      case "unsupported":
        return [b.intrinsic(instr, "js.value.unsupported", [], r)];
    }
  };
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    const row = JSON_ARM[kind];
    if (row === "undefined") return [b.intrinsic(instr, "js.value.undefined", [], r)];
    const text = b.fresh();
    return [...textOf(row, kind, text), { kind: "coerce.to_externref", value: text, result: r, resultType: b.carrier }];
  };
  return b.kindChain(instr, value, result, arm, b.kindsOf(value), b.carrier);
}
