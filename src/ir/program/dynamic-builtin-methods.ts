// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 G1, W2) The realm's built-in methods the dispatcher cannot call, answered where a call may reach one: in
 * OrdinaryToPrimitive (`ordinary-to-primitive.ts`) and in a method call (`dynamic-prototype-methods.ts`). Each is a
 * {@link BuiltinMethodTest} on the method the call read: by identity with the realm's function object (an
 * Object.prototype method, Error.prototype.toString), or (W2) through the realm for the wrappers' `valueOf` and
 * `toString` (§22.1.3.35 / §22.1.3.29, §21.1.3.7 / §21.1.3.6, §20.3.3.3 / §20.3.3.2): `js.object.wrapper-data` answers
 * thisXValue(this) (§22.1.3.35.1 thisStringValue and its siblings: a primitive of the kind, a wrapper's slot, else the
 * method's TypeError) where the method is a held wrapper's of that name, and `null` for any other method; `toString`
 * then answers ToString of that primitive. A call tests them in turn ({@link builtinMethodChain}).
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { WRAPPER_DATA, WRAPPER_OF_PRIMITIVE, realmIntrinsicSelector } from "./builtin-prototype-keys.js";
import type { ConvertingBuilders } from "./dynamic-value-chains.js";
import type { CarrierKind } from "./dynamic-value-kinds.js";
import { BOOLEAN, CARRIER, carried } from "./dynamic-value-types.js";

/** A built-in method a call may reach: whether the method read is it (`instrs` into `cond`), and its answer. */
export interface BuiltinMethodTest {
  readonly instrs: IrInstr[];
  readonly cond: IrValueId;
  readonly answer: (result: IrValueId) => IrInstr[];
}

/** The legalization's builders the tests are written with. */
export type BuiltinMethodBuilders = Pick<
  ConvertingBuilders,
  "fresh" | "intrinsic" | "anyKind" | "branch" | "kindChain" | "abort" | "selectorCall" | "kinds" | "stringOf"
>;

/**
 * Whether `method` is the realm's function object `id` (SameValue), answering `answer`. (#7557) The test does not make
 * the realm hold `id` (`js.object.is-intrinsic`): a program pays only for the methods it reads.
 */
export function identityTest(
  b: BuiltinMethodBuilders,
  id: string,
  method: IrValueId,
  answer: (result: IrValueId) => IrInstr[],
): BuiltinMethodTest {
  const cond = b.fresh();
  return { instrs: b.selectorCall("js.object.is-intrinsic", [method], realmIntrinsicSelector(id), cond), cond, answer };
}

const PRIMITIVES = Object.keys(WRAPPER_OF_PRIMITIVE) as CarrierKind[];

/** The wrapper prototype methods {@link wrapperMethodTest} answers. */
export type WrapperMethodName = "valueOf" | "toString";

/**
 * The wrappers' method `name` called on `receiver` through `method`, read under that name (a wrapper method read under
 * another name is no such call: it reaches the dispatcher, whose built-in arm is the run-time abort). `radix`: the call
 * passes an argument, which Number.prototype.toString reads as a radix the realm does not format (the run-time abort;
 * String's and Boolean's `toString` ignore it).
 */
export function wrapperMethodTest(
  b: BuiltinMethodBuilders,
  instr: IrInstr,
  name: WrapperMethodName,
  method: IrValueId,
  receiver: IrValueId,
  radix = false,
): BuiltinMethodTest {
  const [value, absent, cond, primitive] = [b.fresh(), b.fresh(), b.fresh(), b.fresh()];
  b.kinds.learn(primitive, PRIMITIVES);
  const text = (r: IrValueId): IrInstr[] => {
    const string = b.fresh();
    return [...b.stringOf(instr, primitive, string), carried(string, r)];
  };
  const answer = (r: IrValueId): IrInstr[] => {
    if (name === "valueOf") return [carried(primitive, r)];
    if (!radix) return text(r);
    return b.kindChain(
      instr,
      primitive,
      r,
      (kind, s) => (kind === "number" ? b.abort(instr, s) : text(s)),
      PRIMITIVES,
      CARRIER,
    );
  };
  return {
    instrs: [
      ...b.selectorCall("js.object.wrapper-data", [receiver, method], WRAPPER_DATA[name], value),
      ...b.anyKind(instr, ["null"], value, absent),
      { kind: "unary", op: "i32.eqz", rand: absent, result: cond, resultType: BOOLEAN },
    ],
    cond,
    answer: (r) => [carried(value, primitive), ...answer(r)],
  };
}

/** The tests in turn, each answering where it holds, else `otherwise`; into the arm's result, of `resultType`. */
export function builtinMethodChain(
  b: {
    readonly branch: (
      cond: IrValueId,
      then: (result: IrValueId) => IrInstr[],
      else_: (result: IrValueId) => IrInstr[],
      result: IrValueId,
      resultType: IrType,
    ) => IrInstr;
  },
  tests: readonly (() => BuiltinMethodTest)[],
  otherwise: (result: IrValueId) => IrInstr[],
  resultType: IrType,
): (result: IrValueId) => IrInstr[] {
  return tests.reduceRight(
    (next: (result: IrValueId) => IrInstr[], test) =>
      (r: IrValueId): IrInstr[] => {
        const { instrs, cond, answer } = test();
        return [...instrs, b.branch(cond, answer, next, r, resultType)];
      },
    otherwise,
  );
}
