// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 L0a) The dynamic-value legalization of the comparisons whose operands may be of different kinds: the
 * relational operators (the front end's `__ir_dyn_lt/le/gt/ge`, §13.10.1 over IsLessThan §7.2.13) and loose equality
 * (`dyn.eq` with `loose`, IsLooselyEqual §7.2.14). Both are written with the conversions `+` uses
 * (`conversionBuilders`): ToPrimitive is `primitiveOf`, ToNumber `toNumber`, ToString `stringOf`, so a comparison runs
 * the one ToPrimitive of the dynamic value (`ordinary-to-primitive.ts`).
 *
 * ToPrimitive's hint is `number` for both: IsLessThan asks for it, and IsLooselyEqual's `default` is answered as
 * `number` by every object kind this lane admits (OrdinaryToPrimitive; Date, the one exception, does not exist here).
 * Two strings are ordered by UTF-16 code units (`js.value.string_compare`) and equal as strict equality has them.
 */
import type { IrBinop, IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import {
  IR_DYN_GE_FN,
  IR_DYN_GT_FN,
  IR_DYN_LE_FN,
  IR_DYN_LT_FN,
} from "../../shared/contracts/dynamic-operator-helpers.js";
import { boolean, carried, type ChainBuilders, type conversionBuilders } from "./dynamic-value-chains.js";
import { ADD_ROLE, IS_OBJECT, type CarrierKind } from "./dynamic-value-kinds.js";

/** How each relational operator folds a number comparison and a string compare's sign (-1/0/1). */
interface Relational {
  readonly number: IrBinop;
  readonly sign: IrBinop;
}

/**
 * The relational operators by front-end helper. `a > b` is IsLessThan(b, a) and `a <= b` is the negation of it with
 * undefined (a NaN) as false: for numbers exactly `f64.gt` / `f64.le`, which are false on NaN; for strings the sign's
 * order. ToPrimitive still runs on `a` first for every operator (LeftFirst only orders the two conversions).
 */
const RELATIONAL: ReadonlyMap<string, Relational> = new Map([
  [IR_DYN_LT_FN, { number: "f64.lt", sign: "i32.lt_s" }],
  [IR_DYN_LE_FN, { number: "f64.le", sign: "i32.le_s" }],
  [IR_DYN_GT_FN, { number: "f64.gt", sign: "i32.gt_s" }],
  [IR_DYN_GE_FN, { number: "f64.ge", sign: "i32.ge_s" }],
]);

/** The relational operator the front-end helper `symbol` stands for, if it is one. */
export const relationalOfHelper = (symbol: string): Relational | undefined => RELATIONAL.get(symbol);

const I32: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32" }) });
const NULLISH: readonly CarrierKind[] = ["undefined", "null"];
/** The primitives a ToPrimitive leaves as text: a string, and (M2) an error, whose ToPrimitive is its own text. */
const TEXT: readonly CarrierKind[] = (Object.keys(ADD_ROLE) as CarrierKind[]).filter(
  (kind) => ADD_ROLE[kind] === "concat",
);

type Conversions = ReturnType<typeof conversionBuilders>;

export function comparisonBuilders(builders: ChainBuilders, conversions: Conversions) {
  const { kinds, admitted, intrinsic, fresh, holds, branch } = builders;
  const { stringOf, toNumber, primitiveOf } = conversions;
  const binary = (op: IrBinop, lhs: IrValueId, rhs: IrValueId, result: IrValueId, resultType: IrType): IrInstr => ({
    kind: "binary",
    op,
    lhs,
    rhs,
    result,
    resultType,
  });
  /**
   * Whether both operands (`i32.and`) or either (`i32.or`) hold one of `of`, into `cond`: `known` where the kinds
   * decide it (one operand decides an `and` false and an `or` true on its own).
   */
  const both = (
    instr: IrInstr,
    op: "i32.and" | "i32.or",
    operands: readonly IrValueId[],
    of: readonly CarrierKind[],
    cond: IrValueId = fresh(),
    resultType: IrType = I32,
  ) => {
    const tests = operands.map((value) => holds(instr, value, of));
    const decides = op === "i32.or";
    const decided = tests.map((test) => test.known);
    const known = decided.includes(decides) ? decides : decided.every((d) => d === !decides) ? !decides : undefined;
    const instrs: IrInstr[] = [
      ...tests.flatMap((test) => test.instrs),
      binary(op, tests[0]!.cond, tests[1]!.cond, cond, resultType),
    ];
    return { instrs, cond, known };
  };
  /** `then` where the test holds, `else_` where not: one arm when the kinds decide it, a branch otherwise. */
  const choose = (
    test: ReturnType<typeof both>,
    then: (r: IrValueId) => IrInstr[],
    else_: (r: IrValueId) => IrInstr[],
    result: IrValueId,
    resultType: IrType,
  ): IrInstr[] =>
    test.known === true
      ? then(result)
      : test.known === false
        ? else_(result)
        : [...test.instrs, branch(test.cond, then, else_, result, resultType)];
  /** The native string of the once-evaluated primitive `value`, which holds one of the text kinds here. */
  const textOf = (instr: IrInstr, value: IrValueId, result: IrValueId): IrInstr[] =>
    stringOf(
      instr,
      value,
      result,
      kinds.kindsOf(value).filter((kind) => TEXT.includes(kind)),
    );
  /**
   * Two primitives compared as texts when both are (`textual`, over the carriers of their strings), else as numbers
   * (`numeric`, over their ToNumbers).
   */
  const textOrNumber = (
    instr: IrInstr,
    operands: readonly IrValueId[],
    textual: (texts: readonly IrValueId[], r: IrValueId) => IrInstr[],
    numeric: (numbers: readonly IrValueId[], r: IrValueId) => IrInstr[],
    result: IrValueId,
    resultType: IrType,
  ): IrInstr[] =>
    choose(
      both(instr, "i32.and", operands, TEXT),
      (r) => {
        const texts = operands.map(() => fresh());
        const carriers = operands.map(() => fresh());
        return [
          ...operands.flatMap((value, index) => [
            ...textOf(instr, value, texts[index]!),
            carried(texts[index]!, carriers[index]!),
          ]),
          ...textual(carriers, r),
        ];
      },
      (r) => {
        const numbers = operands.map(() => fresh());
        return [...operands.flatMap((value, index) => toNumber(instr, value, numbers[index]!)), ...numeric(numbers, r)];
      },
      result,
      resultType,
    );
  /** ToPrimitive of each operand, left first (§7.2.13 step 1/2 run both before either is compared). */
  const primitives = (instr: IrInstr, operands: readonly IrValueId[]) => {
    const converted = operands.map((value) => primitiveOf(instr, value));
    return {
      instrs: converted.flatMap((operand) => operand.instrs),
      values: converted.map((operand) => operand.value),
    };
  };

  /** `l <op> r` of two once-evaluated carrier operands into `result` (IsLessThan with the operator's fold). */
  const relational = (instr: IrInstr, operator: Relational, operands: readonly IrValueId[], result: IrValueId) => {
    const { instrs, values } = primitives(instr, operands);
    const compare = (texts: readonly IrValueId[], r: IrValueId): IrInstr[] => {
      const [sign, zero] = [fresh(), fresh()];
      return [
        intrinsic(instr, "js.value.string_compare", texts, sign),
        { kind: "const", value: { kind: "i32", value: 0 }, result: zero, resultType: I32 },
        binary(operator.sign, sign, zero, r, instr.resultType!),
      ];
    };
    const order = (numbers: readonly IrValueId[], r: IrValueId): IrInstr[] => [
      binary(operator.number, numbers[0]!, numbers[1]!, r, instr.resultType!),
    ];
    return [...instrs, ...textOrNumber(instr, values, compare, order, result, instr.resultType!)];
  };

  /**
   * `l == r` of two once-evaluated carrier operands into `result`. `undefined` and `null` equal each other and nothing
   * else, without a conversion; two objects are equal only as the same object, without a conversion; otherwise the
   * object side (if any) is converted (§7.2.14 steps 11-12) and the primitives compared: a conversion that answers
   * `undefined` or `null` equals nothing here (the other side is neither), two texts compare as strings, and any other
   * pair as numbers (a Boolean's ToNumber first, steps 9-10, and a string's against a number, steps 5-6, are one rule).
   */
  const looseEquality = (instr: IrInstr, operands: readonly IrValueId[], result: IrValueId): IrInstr[] => {
    const type = instr.resultType!;
    const nullish = both(instr, "i32.or", operands, NULLISH);
    const bothNullish = (r: IrValueId): IrInstr[] => {
      const test = both(instr, "i32.and", operands, NULLISH, r, type);
      return test.known === undefined ? test.instrs : [boolean(test.known, r)];
    };
    const objects = admitted.filter((kind) => IS_OBJECT[kind]);
    const identity = (r: IrValueId): IrInstr[] => [intrinsic(instr, "js.value.strict_eq", operands, r)];
    const converted = (r: IrValueId): IrInstr[] => {
      const { instrs, values } = primitives(instr, operands);
      const equalTexts = (texts: readonly IrValueId[], s: IrValueId): IrInstr[] => [
        intrinsic(instr, "js.value.strict_eq", texts, s),
      ];
      const equalNumbers = (numbers: readonly IrValueId[], s: IrValueId): IrInstr[] => [
        binary("f64.eq", numbers[0]!, numbers[1]!, s, type),
      ];
      return [
        ...instrs,
        ...choose(
          both(instr, "i32.or", values, NULLISH),
          (s) => [boolean(false, s)],
          (s) => textOrNumber(instr, values, equalTexts, equalNumbers, s, type),
          r,
          type,
        ),
      ];
    };
    return choose(
      nullish,
      bothNullish,
      (r) => choose(both(instr, "i32.and", operands, objects), identity, converted, r, type),
      result,
      type,
    );
  };
  return { relational, looseEquality };
}
