// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 W2) The wrapper prototypes' `valueOf` and `toString` (§22.1.3.35 / §22.1.3.29, §21.1.3.7 / §21.1.3.6,
 * §20.3.3.3 / §20.3.3.2): built-ins the dispatcher cannot call, so the legalization answers a call that reaches one
 * where it may (OrdinaryToPrimitive, `ordinary-to-primitive.ts`; a method call, `dynamic-prototype-methods.ts`).
 *
 * One realm call decides it: `js.object.wrapper-this(method, this)` is thisXValue(this) (§22.1.3.35.1 thisStringValue
 * and its siblings: a primitive of the kind, a wrapper's slot, else the method's TypeError) where `method` is a held
 * wrapper method, and `null` for any other method; `toString` then answers ToString of that primitive.
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { realmCall } from "./dynamic-realm-calls.js";
import type { CarrierKind } from "./dynamic-value-kinds.js";

/** A built-in method a call may reach: whether `method` is it (`instrs` into `cond`), and its answer. */
export interface BuiltinMethodTest {
  readonly instrs: IrInstr[];
  readonly cond: IrValueId;
  readonly answer: (result: IrValueId) => IrInstr[];
}

/** The legalization's builders the test is written with. */
export interface WrapperMethodBuilders {
  readonly carrier: IrType;
  readonly fresh: () => IrValueId;
  readonly intrinsic: (
    instr: IrInstr,
    id: IntrinsicId,
    args: readonly IrValueId[],
    result?: IrValueId | null,
  ) => IrInstr;
  readonly kinds: { readonly learn: (value: IrValueId, kinds: readonly CarrierKind[]) => void };
  readonly anyKind: (instr: IrInstr, of: readonly CarrierKind[], value: IrValueId, result: IrValueId) => IrInstr[];
  readonly kindChain: (
    instr: IrInstr,
    value: IrValueId,
    result: IrValueId,
    arm: (kind: CarrierKind, result: IrValueId) => IrInstr[],
    kinds: readonly CarrierKind[],
    resultType: IrType,
  ) => IrInstr[];
  readonly branch: (
    cond: IrValueId,
    then: (result: IrValueId) => IrInstr[],
    else_: (result: IrValueId) => IrInstr[],
    result: IrValueId,
    resultType?: IrType,
  ) => IrInstr;
  readonly stringOf: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
  /** (#7354 C2) The run-time abort, a carrier answer. */
  readonly abort: (instr: IrInstr, result: IrValueId) => IrInstr[];
}

const PRIMITIVES: readonly CarrierKind[] = ["string", "number", "boolean"];
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/**
 * Whether `method`, called with `receiver` as `this`, is a held wrapper method, and its answer (a carrier value).
 * `radix`: the call passes an argument, which Number.prototype.toString reads as a radix the realm does not format
 * (the run-time abort; String's and Boolean's `toString` ignore it).
 */
export function wrapperMethodTest(
  b: WrapperMethodBuilders,
  instr: IrInstr,
  method: IrValueId,
  receiver: IrValueId,
  radix = false,
): BuiltinMethodTest {
  const [value, absent, cond] = [b.fresh(), b.fresh(), b.fresh()];
  b.kinds.learn(value, [...PRIMITIVES, "null"]);
  const primitive = b.fresh();
  b.kinds.learn(primitive, PRIMITIVES);
  const carried = (from: IrValueId, r: IrValueId): IrInstr => ({
    kind: "coerce.to_externref",
    value: from,
    result: r,
    resultType: b.carrier,
  });
  const text = (r: IrValueId): IrInstr[] => {
    const string = b.fresh();
    return [...b.stringOf(instr, primitive, string), carried(string, r)];
  };
  const asText = (r: IrValueId): IrInstr[] =>
    radix
      ? b.kindChain(
          instr,
          primitive,
          r,
          (kind, s) => (kind === "number" ? b.abort(instr, s) : text(s)),
          PRIMITIVES,
          b.carrier,
        )
      : text(r);
  return {
    instrs: [
      realmCall("js.object.wrapper-this", [method, receiver], value),
      ...b.anyKind(instr, ["null"], value, absent),
      { kind: "unary", op: "i32.eqz", rand: absent, result: cond, resultType: BOOLEAN },
    ],
    cond,
    answer: (r) => {
      const isToString = b.fresh();
      return [
        carried(value, primitive),
        realmCall("js.object.wrapper-to-string", [method], isToString),
        b.branch(isToString, asText, (s) => [carried(primitive, s)], r, b.carrier),
      ];
    },
  };
}
