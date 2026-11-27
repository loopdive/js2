// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 G1, #7561) The realm's built-in methods the dispatcher cannot call, answered where a call may reach one: in
 * OrdinaryToPrimitive (`ordinary-to-primitive.ts`) and in P1's method call (`dynamic-prototype-methods.ts`). Each is a
 * {@link BuiltinMethodTest} on the method the call read: by identity with the realm's function object (an
 * Object.prototype method, Error.prototype.toString), or for the wrappers' `valueOf` and `toString` (§22.1.3.35 /
 * §22.1.3.29, §21.1.3.7 / §21.1.3.6, §20.3.3.3 / §20.3.3.2) through the realm: `js.object.wrapper-data` answers
 * thisXValue(this) where the method is a held prototype's of that name, and `null` for any other method; `toString`
 * then answers ToString of that primitive. A call tests them in turn ({@link builtinMethodChain}), so an override of
 * any of them is a source function the dispatcher calls.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { WRAPPER_DATA } from "../../runtime/contracts/native-realm-catalog.js";
import { ERROR_TO_STRING_ID, WRAPPER_OF_PRIMITIVE, isArrayIndexKey } from "./builtin-prototype-keys.js";
import { realmCall, typeErrorThen } from "./dynamic-realm-calls.js";
import type { ChainBuilders } from "./dynamic-value-chains.js";
import { CARRIER, carried } from "./dynamic-value-types.js";
import { IS_OBJECT, holdsFamily, type CarrierKind, type LegalizationProgram } from "./dynamic-value-kinds.js";

/** A built-in method a call may reach: whether the method read is it (`instrs` into `cond`), and its answer. */
export interface BuiltinMethodTest {
  readonly instrs: IrInstr[];
  readonly cond: IrValueId;
  readonly answer: (result: IrValueId) => IrInstr[];
}
type Arm = (result: IrValueId) => IrInstr[];

/** The legalization's builders the tests are written with: the chains and the program's ToString. */
export type BuiltinMethodBuilders = ChainBuilders & {
  readonly stringOf: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
};

const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });
const PRIMITIVES = Object.keys(WRAPPER_OF_PRIMITIVE) as CarrierKind[];

/** Whether `method` is the realm's function object `id` (SameValue), answering `answer`. */
export function identityTest(
  b: ChainBuilders,
  instr: IrInstr,
  id: string,
  method: IrValueId,
  answer: Arm,
): BuiltinMethodTest {
  const [builtin, cond] = [b.fresh(), b.fresh()];
  return {
    instrs: [...b.realmIntrinsic(id, builtin), b.intrinsic(instr, "js.value.strict_eq", [method, builtin], cond)],
    cond,
    answer,
  };
}

/**
 * The wrappers' method `name` called on `receiver` through `method`, read under that name (read under another name it
 * is no such call: the dispatcher's built-in arm aborts). `radix`: the call passes an argument, which
 * Number.prototype.toString reads as a radix the realm does not format (the run-time abort; String's and Boolean's
 * `toString` ignore it).
 */
function wrapperMethodTest(
  b: BuiltinMethodBuilders,
  instr: IrInstr,
  name: "valueOf" | "toString",
  method: IrValueId,
  receiver: IrValueId,
  radix: boolean,
): BuiltinMethodTest {
  const [value, absent, cond, primitive] = [b.fresh(), b.fresh(), b.fresh(), b.fresh()];
  b.kinds.learn(primitive, PRIMITIVES);
  const text: Arm = (r) => {
    const string = b.fresh();
    return [...b.stringOf(instr, primitive, string), carried(string, r)];
  };
  const answer: Arm = (r) =>
    name === "valueOf"
      ? [carried(primitive, r)]
      : radix
        ? b.kindChain(
            instr,
            primitive,
            r,
            (kind, s) => (kind === "number" ? b.abort(instr, s) : text(s)),
            PRIMITIVES,
            CARRIER,
          )
        : text(r);
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

/**
 * (§20.5.3.4) Error.prototype.toString of `receiver`: the realm's for an object; a TypeError for a primitive, which
 * reaches it only where a program can write it to a wrapper prototype (`wrappers`).
 */
function errorToString(b: ChainBuilders, instr: IrInstr, receiver: IrValueId, wrappers: boolean): Arm {
  const object: Arm = (r) => [realmCall("js.object.error-to-string", [receiver], r)];
  if (!wrappers) return object;
  return (r) =>
    b.kindChain(
      instr,
      receiver,
      r,
      (kind, s) =>
        IS_OBJECT[kind]
          ? object(s)
          : typeErrorThen(
              { ...b, carrier: CARRIER },
              "Error.prototype.toString requires that 'this' be an Object",
              b.intrinsic(instr, "js.value.undefined", [], s),
            ),
      b.kinds.kindsOf(receiver),
      CARRIER,
    );
}

/**
 * The realm's conversion methods a method read under `name` may be, in the order a call tests them:
 * Error.prototype.toString where a value may be an error, a wrapper prototype's `valueOf` / `toString` where a value
 * may be a wrapper. The one list OrdinaryToPrimitive and P1's call share.
 */
export function conversionMethodTests(
  b: BuiltinMethodBuilders,
  instr: IrInstr,
  program: LegalizationProgram,
  name: string,
  method: IrValueId,
  receiver: IrValueId,
  radix = false,
): (() => BuiltinMethodTest)[] {
  const wrappers = program.objects.wrappers.size > 0;
  return [
    ...(name === "toString" && holdsFamily(program, "error")
      ? [() => identityTest(b, instr, ERROR_TO_STRING_ID, method, errorToString(b, instr, receiver, wrappers))]
      : []),
    ...((name === "valueOf" || name === "toString") && wrappers
      ? [() => wrapperMethodTest(b, instr, name, method, receiver, radix)]
      : []),
  ];
}

/**
 * (#7561) #7350 B3b-1's interim abort: a String object's index properties are virtual and the realm lacks them (B3c),
 * so an own-property query of `object` with a key that may be an array index (`key`, when it is a constant) is the
 * run-time abort where `object` is a String object; `then` otherwise, and wherever no String object can exist.
 */
export function unlessStringObject(
  b: ChainBuilders,
  instr: IrInstr,
  program: LegalizationProgram,
  object: IrValueId,
  key: string | undefined,
  then: Arm,
): Arm {
  if (!program.objects.wrappers.has("String") || (key !== undefined && !isArrayIndexKey(key))) return then;
  // Only a non-empty string has index properties (String.prototype's is "").
  return (r) => {
    const [absent, data, string, characters, indexed] = [b.fresh(), b.fresh(), b.fresh(), b.fresh(), b.fresh()];
    return [
      { kind: "const", value: { kind: "null", ty: CARRIER }, result: absent, resultType: CARRIER },
      ...b.selectorCall("js.object.wrapper-data", [object, absent], WRAPPER_DATA.slot, data),
      b.intrinsic(instr, "js.value.is_string", [data], string),
      b.intrinsic(instr, "js.value.to_boolean", [data], characters),
      { kind: "binary", op: "i32.and", lhs: string, rhs: characters, result: indexed, resultType: BOOLEAN },
      b.branch(indexed, (s) => b.abort(instr, s), then, r, CARRIER),
    ];
  };
}

/** The tests in turn, each answering where it holds, else `otherwise`; into the arm's result, of `resultType`. */
export function builtinMethodChain(
  b: { readonly branch: (cond: IrValueId, then: Arm, else_: Arm, result: IrValueId, resultType: IrType) => IrInstr },
  tests: readonly (() => BuiltinMethodTest)[],
  otherwise: Arm,
  resultType: IrType,
): Arm {
  return tests.reduceRight(
    (next: Arm, test) =>
      (r: IrValueId): IrInstr[] => {
        const { instrs, cond, answer } = test();
        return [...instrs, b.branch(cond, answer, next, r, resultType)];
      },
    otherwise,
  );
}
