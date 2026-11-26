// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 L0a) The dynamic-value legalization of the comparisons whose operands may be of different kinds: the
 * relational operators (the front end's `__ir_dyn_lt/le/gt/ge`, §13.10.1 over IsLessThan §7.2.13) and loose equality
 * (`dyn.eq` with `loose`, IsLooselyEqual §7.2.14). Both are written with the conversions `+` uses
 * (`conversionBuilders`): ToPrimitive is `primitivesOf` and ToNumber `toNumber`, so a comparison runs the one
 * ToPrimitive of the dynamic value (`ordinary-to-primitive.ts`).
 *
 * ToPrimitive's hint is `number` for both: IsLessThan asks for it, and IsLooselyEqual's `default` is answered as
 * `number` by every object kind this lane admits (OrdinaryToPrimitive; Date, the one exception, does not exist here).
 * Two strings are ordered by UTF-16 code units (`js.value.string_compare`, the Prepared lane's one string compare) and
 * equal as strict equality has them.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { RELATIONAL_OPERATORS, type RelationalOperator } from "../../shared/contracts/dynamic-operator-helpers.js";
import { I32, boolean, type ChainBuilders, type conversionBuilders } from "./dynamic-value-chains.js";
import { IS_OBJECT, type CarrierKind } from "./dynamic-value-kinds.js";

/** The relational operator the front-end helper `symbol` stands for, if it is one. */
export const relationalOfHelper = (symbol: string): RelationalOperator | undefined =>
  Object.values(RELATIONAL_OPERATORS).find((operator) => operator.helper === symbol);

/** A comparison's two once-evaluated operands, left first. */
type Pair = readonly [IrValueId, IrValueId];
const pair = (values: readonly IrValueId[]): Pair => [values[0]!, values[1]!];

const NULLISH: readonly CarrierKind[] = ["undefined", "null"];
const STRING: readonly CarrierKind[] = ["string"];

export function comparisonBuilders(
  builders: ChainBuilders,
  { toNumber, primitivesOf }: ReturnType<typeof conversionBuilders>,
) {
  const { admitted, intrinsic, fresh, holds, branch } = builders;
  /**
   * Whether both operands (`every`, `i32.and`) or either (`some`, `i32.or`) hold one of `of`, into a fresh `cond`, with
   * `known` where the proven kinds decide it. (The chains' `disjunction` or-s the tests it is handed; this decides from
   * the operands' kinds first.)
   */
  const operandsHold = (
    instr: IrInstr,
    quantifier: "every" | "some",
    [left, right]: Pair,
    of: readonly CarrierKind[],
  ) => {
    const [l, r] = [holds(instr, left, of), holds(instr, right, of)];
    // One operand that does not hold decides `every` (false); one that holds decides `some` (true).
    const known =
      quantifier === "every"
        ? l.known === false || r.known === false
          ? false
          : l.known && r.known
            ? true
            : undefined
        : l.known === true || r.known === true
          ? true
          : l.known === false && r.known === false
            ? false
            : undefined;
    const cond = fresh();
    const op = quantifier === "every" ? "i32.and" : "i32.or";
    const instrs: IrInstr[] = [
      ...l.instrs,
      ...r.instrs,
      { kind: "binary", op, lhs: l.cond, rhs: r.cond, result: cond, resultType: I32 },
    ];
    return { instrs, cond, known };
  };
  /** `then` where the test holds, `else_` where not: one arm when the kinds decide it, a branch otherwise. */
  const choose = (
    test: ReturnType<typeof operandsHold>,
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
  /** Two primitives compared as strings when both are (`textual`), else as numbers (`numeric`, over their ToNumbers). */
  const textOrNumber = (
    instr: IrInstr,
    operands: Pair,
    textual: (r: IrValueId) => IrInstr[],
    numeric: (numbers: readonly IrValueId[], r: IrValueId) => IrInstr[],
    result: IrValueId,
    resultType: IrType,
  ): IrInstr[] =>
    choose(
      operandsHold(instr, "every", operands, STRING),
      textual,
      (r) => {
        const numbers = operands.map(() => fresh());
        return [...operands.flatMap((value, index) => toNumber(instr, value, numbers[index]!)), ...numeric(numbers, r)];
      },
      result,
      resultType,
    );

  /** `l <op> r` of two once-evaluated carrier operands into `result` (IsLessThan with the operator's fold). */
  const relational = (instr: IrInstr, operator: RelationalOperator, operands: Pair, result: IrValueId) => {
    const type = instr.resultType!;
    const { instrs, values: primitives } = primitivesOf(instr, operands);
    const values = pair(primitives);
    const compare = (r: IrValueId): IrInstr[] => {
      const [left, right, sign, zero] = [fresh(), fresh(), fresh(), fresh()];
      return [
        intrinsic(instr, "js.value.as_string", [values[0]], left),
        intrinsic(instr, "js.value.as_string", [values[1]], right),
        intrinsic(instr, "js.value.string_compare", [left, right], sign),
        { kind: "const", value: { kind: "i32", value: 0 }, result: zero, resultType: I32 },
        { kind: "binary", op: operator.sign, lhs: sign, rhs: zero, result: r, resultType: type },
      ];
    };
    const order = (numbers: readonly IrValueId[], r: IrValueId): IrInstr[] => [
      { kind: "binary", op: operator.number, lhs: numbers[0]!, rhs: numbers[1]!, result: r, resultType: type },
    ];
    return [...instrs, ...textOrNumber(instr, values, compare, order, result, type)];
  };

  /**
   * `l == r` of two once-evaluated carrier operands into `result`. `undefined` and `null` equal each other and nothing
   * else, without a conversion; two objects are equal only as the same object, without a conversion; otherwise the
   * object side (if any) is converted (§7.2.14 steps 11-12) and the primitives compared: a conversion that answers
   * `undefined` or `null` equals nothing here (the other side is neither), two strings compare as strings, and any
   * other pair as numbers (a Boolean's ToNumber first, steps 9-10, and a string's against a number, steps 5-6, are one
   * rule).
   */
  const looseEquality = (instr: IrInstr, operands: Pair, result: IrValueId): IrInstr[] => {
    const type = instr.resultType!;
    const answer = (value: boolean) => (r: IrValueId) => [boolean(value, r)];
    const bothNullish = (r: IrValueId): IrInstr[] =>
      choose(operandsHold(instr, "every", operands, NULLISH), answer(true), answer(false), r, type);
    const objects = admitted.filter((kind) => IS_OBJECT[kind]);
    const identity = (r: IrValueId): IrInstr[] => [intrinsic(instr, "js.value.strict_eq", operands, r)];
    const converted = (r: IrValueId): IrInstr[] => {
      const { instrs, values: primitives } = primitivesOf(instr, operands);
      const values = pair(primitives);
      const equalStrings = (s: IrValueId): IrInstr[] => [intrinsic(instr, "js.value.strict_eq", values, s)];
      const equalNumbers = (numbers: readonly IrValueId[], s: IrValueId): IrInstr[] => [
        { kind: "binary", op: "f64.eq", lhs: numbers[0]!, rhs: numbers[1]!, result: s, resultType: type },
      ];
      return [
        ...instrs,
        ...choose(
          operandsHold(instr, "some", values, NULLISH),
          answer(false),
          (s) => textOrNumber(instr, values, equalStrings, equalNumbers, s, type),
          r,
          type,
        ),
      ];
    };
    return choose(
      operandsHold(instr, "some", operands, NULLISH),
      bothNullish,
      (r) => choose(operandsHold(instr, "every", operands, objects), identity, converted, r, type),
      result,
      type,
    );
  };
  return { relational, looseEquality };
}
