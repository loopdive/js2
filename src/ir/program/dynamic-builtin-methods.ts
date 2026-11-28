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
import {
  ERROR_TO_STRING_ID,
  FUNCTION_PROTOTYPE_ID,
  FUNCTION_PROTOTYPE_UNHELD_KEYS,
  IS_ARRAY_ID,
  PROTOTYPE_METHOD_IDS,
  OBJECT_PROTOTYPE_ID,
  OBJECT_PROTOTYPE_UNHELD_KEYS,
  WRAPPER_DATA,
  WRAPPER_OF_PRIMITIVE,
  isArrayIndexKey,
  objectPrototypeMethodId,
  objectStaticId,
  wrapperMethodId,
} from "./builtin-prototype-keys.js";
import { realmCall, typeErrorThen } from "./dynamic-realm-calls.js";
import type { ChainBuilders } from "./dynamic-value-chains.js";
import { BOOLEAN, CARRIER, carried } from "./dynamic-value-types.js";
import { IS_OBJECT, holdsFamily, type CarrierKind, type LegalizationProgram } from "./dynamic-value-kinds.js";
import { objectTagOf } from "./dynamic-object-tag.js";

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
 * reaches it only where a program can write it to a wrapper prototype or (#7557) call it with any `this` (`primitives`).
 */
function errorToString(b: ChainBuilders, instr: IrInstr, receiver: IrValueId, primitives: boolean): Arm {
  const object: Arm = (r) => [realmCall("js.object.error-to-string", [receiver], r)];
  if (!primitives) return object;
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
 * (#7574) Object.prototype's `toString` (§20.1.3.6, the tag of `receiver`) and `valueOf` (§20.1.3.7: ToObject of an
 * object is itself; a primitive `this` reaches it only through a wrapper prototype written to hold it, the run-time
 * abort) called on `receiver` through `method`.
 */
function objectPrototypeMethodTest(
  b: BuiltinMethodBuilders,
  instr: IrInstr,
  program: LegalizationProgram,
  name: "valueOf" | "toString",
  method: IrValueId,
  receiver: IrValueId,
): BuiltinMethodTest {
  const answer: Arm =
    name === "toString"
      ? (r) => {
          const tag = b.fresh();
          return [...objectTagOf(b, program, instr, receiver, tag), carried(tag, r)];
        }
      : (r) =>
          b.kindChain(
            instr,
            receiver,
            r,
            (kind, s) => (IS_OBJECT[kind] ? [carried(receiver, s)] : b.abort(instr, s)),
            b.kinds.kindsOf(receiver),
            CARRIER,
          );
  return identityTest(b, instr, objectPrototypeMethodId(name), method, answer);
}

/**
 * The realm's conversion methods a method read under `name` may be, in the order a call tests them:
 * Error.prototype.toString where a value may be an error, a wrapper prototype's `valueOf` / `toString` where a value
 * may be a wrapper, (#7574) Object.prototype's where the program can obtain the root. The one list OrdinaryToPrimitive,
 * P1's call and the object tag share. (#7557) `detached`: the receiver may be any value (the built-in caller's `this`).
 */
export function conversionMethodTests(
  b: BuiltinMethodBuilders,
  instr: IrInstr,
  program: LegalizationProgram,
  name: string,
  method: IrValueId,
  receiver: IrValueId,
  radix = false,
  detached = false,
): (() => BuiltinMethodTest)[] {
  const primitives = detached || program.objects.wrappers.size > 0;
  const wrappers = program.objects.wrappers.size > 0;
  return [
    ...(name === "toString" && holdsFamily(program, "error")
      ? [() => identityTest(b, instr, ERROR_TO_STRING_ID, method, errorToString(b, instr, receiver, primitives))]
      : []),
    ...((name === "valueOf" || name === "toString") && wrappers
      ? [() => wrapperMethodTest(b, instr, name, method, receiver, radix)]
      : []),
    ...((name === "valueOf" || name === "toString") && holdsFamily(program, "object")
      ? [() => objectPrototypeMethodTest(b, instr, program, name, method, receiver)]
      : []),
  ];
}

/**
 * `Object.prototype.toString.call(v)` (`dyn.object_tag`) into its result: the tag of `v`; (#7574) where the program can
 * obtain the root it can write its `toString`, so the call is of the method the root holds, answered by the table
 * above, and any other method is the run-time abort. (#7557) Where the program may replace `Function.prototype.call`
 * (`ProgramObjects.replacesCall`), the call may be of another function: the run-time abort, never the fold.
 */
export function dynamicObjectTag(
  b: BuiltinMethodBuilders,
  program: LegalizationProgram,
  instr: Extract<IrInstr, { kind: "dyn.object_tag" }>,
): IrInstr[] {
  if (program.objects.replacesCall) {
    const aborted = b.fresh();
    b.kinds.learn(aborted, ["string"]);
    return [...b.abort(instr, aborted), ...b.stringOf(instr, aborted, instr.result!)];
  }
  if (!holdsFamily(program, "object")) return objectTagOf(b, program, instr, instr.value, instr.result!);
  const [root, text, key, method, tag] = [b.fresh(), b.fresh(), b.fresh(), b.fresh(), b.fresh()];
  const tests = conversionMethodTests(b, instr, program, "toString", method, instr.value);
  // Every method of the table answers a string.
  b.kinds.learn(tag, ["string"]);
  return [
    ...b.realmIntrinsic(OBJECT_PROTOTYPE_ID, root),
    b.text("toString", text),
    carried(text, key),
    realmCall("js.object.get", [root, key, root], method),
    ...builtinMethodChain(b, tests, (r) => b.abort(instr, r), CARRIER)(tag),
    ...b.stringOf(instr, tag, instr.result!),
  ];
}

/**
 * An own-property query of `object` with `key` (when it is a constant) that the realm could answer "absent" for a
 * property it lacks is the run-time abort; `then` otherwise: (#7574) where `object` is the root and `key` may be one
 * the root lacks (`OBJECT_PROTOTYPE_UNHELD_KEYS`), (#7557) where it is Function.prototype and `key` may be one that
 * lacks (`FUNCTION_PROTOTYPE_UNHELD_KEYS`), and where `object` is a String object ({@link unlessStringObject}).
 */
export function unlessUnheldOwnKey(
  b: ChainBuilders,
  instr: IrInstr,
  program: LegalizationProgram,
  object: IrValueId,
  key: string | undefined,
  then: Arm,
): Arm {
  const partial = (
    [
      ["object", OBJECT_PROTOTYPE_ID, OBJECT_PROTOTYPE_UNHELD_KEYS],
      ["function", FUNCTION_PROTOTYPE_ID, FUNCTION_PROTOTYPE_UNHELD_KEYS],
    ] as const
  ).flatMap(([family, id, unheld]) =>
    holdsFamily(program, family) && (key === undefined || unheld.has(key))
      ? [() => identityTest(b, instr, id, object, (r) => b.abort(instr, r))]
      : [],
  );
  return builtinMethodChain(b, partial, unlessStringObject(b, instr, program, object, key, then), CARRIER);
}

/**
 * (#7561) #7350 B3b-1's interim abort: a String object's index properties are virtual and the realm lacks them (B3c),
 * so an own-property query of `object` with a key that may be an array index is the run-time abort where `object` is a
 * String object; `then` otherwise, and wherever no String object can exist.
 */
function unlessStringObject(
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

/**
 * (#7557) The built-in functions the program may hold that the realm's built-in caller answers and that have no
 * [[Construct]]: the methods held by name whose names the source spells, `Array.isArray`, the statics read as values,
 * `Function.prototype`, and the conversion methods of the families the program holds. `new` of one is IsConstructor's
 * TypeError (`dynamicConstruct`), never the caller's [[Call]].
 */
export function heldNonConstructors(program: LegalizationProgram): readonly string[] {
  const { objects } = program;
  const conversions = ["toString", "valueOf"] as const;
  return [
    ...[...objects.prototypeMethodNames].map((name) => PROTOTYPE_METHOD_IDS.get(name)!),
    ...(holdsFamily(program, "array") ? [IS_ARRAY_ID] : []),
    ...[...objects.staticValues].map(objectStaticId),
    ...(holdsFamily(program, "function") ? [FUNCTION_PROTOTYPE_ID] : []),
    ...(holdsFamily(program, "error") ? [ERROR_TO_STRING_ID] : []),
    ...(holdsFamily(program, "object") ? conversions.map(objectPrototypeMethodId) : []),
    ...[...objects.wrappers].flatMap((wrapper) => conversions.map((name) => wrapperMethodId(wrapper, name))),
  ];
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
