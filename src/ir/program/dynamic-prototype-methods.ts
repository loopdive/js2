// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 P1, G1) The dynamic-value legalization of a call of a prototype method the realm holds (an Object.prototype
 * method of `NATIVE_OBJECT_PROTOTYPE_METHODS`, `Error.prototype.toString` where the program holds the Error family):
 * `o.m(v)` is F2's [[Get]] of `m` on the once-evaluated receiver, then the
 * dispatcher's call with the receiver as `this`. Where the callee is that [[Get]], the call is the method's own
 * algorithm when the value read is the realm's built-in (an own property, a user prototype's method or a write to `m`
 * is any other value, and takes the dispatcher), because the algorithm's first step, ToPropertyKey, can call the key's
 * `toString`, which only the program can run (`stringOf`). Called through any other value the built-in is the
 * dispatcher's run-time abort.
 *
 * Only the method-call shape `o.m(v)` is such a call: its receiver is the receiver of the [[Get]] that read the callee,
 * so it is never `undefined` or `null` (that [[Get]] threw). A detached call (`var h = o.m; h(v)`) has another
 * receiver and takes the dispatcher.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { closureMethodArity } from "../core/closure-invocation-callables.js";
import type { NativeObjectPrototypeMethod } from "../../runtime/contracts/native-realm-catalog.js";
import { ERROR_TO_STRING_ID, nativeObjectPrototypeMethod, objectPrototypeMethodId } from "./builtin-prototype-keys.js";
import { constantKeyOf } from "./dynamic-member-access.js";
import { realmCall } from "./dynamic-realm-calls.js";
import { CARRIER, carried } from "./dynamic-value-chains.js";
import { MEMBER_ACCESS_ARM, isOrdinaryObject, type CarrierKind } from "./dynamic-value-kinds.js";
import type { ObjectStaticBuilders } from "./dynamic-object-statics.js";
import { functionChainAnswer } from "./dynamic-error-constructors.js";

type Call = Extract<IrInstr, { kind: "call" }>;
const isObjectCoercible = (kind: CarrierKind): boolean => MEMBER_ACCESS_ARM[kind] !== "type-error";

/** The Boolean the realm's tests answer, boxed into the call's carrier. */
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** A realm method this module writes: an Object.prototype method by name, or (#7354 G1) `Error.prototype.toString`. */
export type RealmMethod = NativeObjectPrototypeMethod | "Error.prototype.toString";

/**
 * The method `call` calls, when it is `o.m(…)`: the dispatcher's call of a [[Get]] of a populated name on its receiver;
 * `toString` only where `errors` (the program holds the Error family).
 */
export function prototypeMethodOfCall(
  call: Call,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
  errors: boolean,
): RealmMethod | undefined {
  if (closureMethodArity(call.target.name) === undefined) return undefined;
  const uncoerced = (value: IrValueId): IrValueId => {
    const definition = definitions.get(value);
    return definition?.kind === "coerce.to_externref" ? definition.value : value;
  };
  const callee = definitions.get(uncoerced(call.args[1]!));
  if (callee?.kind !== "dyn.member_get" || callee.recv !== uncoerced(call.args[0]!)) return undefined;
  const name = constantKeyOf(definitions, callee.key);
  if (name === "toString" && errors) return "Error.prototype.toString";
  return name === undefined ? undefined : nativeObjectPrototypeMethod(name);
}

/** The catalog id of `method`. */
const methodId = (method: RealmMethod): string =>
  method === "Error.prototype.toString" ? ERROR_TO_STRING_ID : objectPrototypeMethodId(method);

/** `value`, the realm's Boolean of `test`, boxed into the carrier `result`. */
function boxed(b: ObjectStaticBuilders, instr: Call, test: (value: IrValueId) => IrInstr[], result: IrValueId) {
  const value = b.fresh();
  return [...test(value), b.intrinsic(instr, "js.boolean.box", [value], result)];
}
const constant =
  (answer: boolean) =>
  (result: IrValueId): IrInstr[] => [
    { kind: "const", value: { kind: "bool", value: answer }, result, resultType: BOOLEAN },
  ];

/**
 * §20.1.3.2 / §20.1.3.4: ToPropertyKey(V) first, then ToObject(this value) and its own property `P` (enumerable too
 * for `propertyIsEnumerable`). An ordinary object's or a function's own properties are the kernel's; a number's or a
 * Boolean's wrapper owns none; a string's own `length` and indices need the String exotic the realm lacks: the run-time
 * abort.
 */
function ownProperty(b: ObjectStaticBuilders, instr: Call, enumerable: boolean, result: IrValueId): IrInstr[] {
  const [receiver, , argument] = instr.args as [IrValueId, IrValueId, IrValueId | undefined];
  const [text, key] = [b.fresh(), b.fresh()];
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (MEMBER_ACCESS_ARM[kind]) {
      case "object":
      case "function":
        return boxed(b, instr, (s) => b.selectorCall("js.object.has-own", [receiver, key], Number(enumerable), s), r);
      default:
        return kind === "number" || kind === "boolean" ? boxed(b, instr, constant(false), r) : b.abort(instr, r);
    }
  };
  return [
    // A missing argument is `undefined`, whose ToString is "undefined".
    ...(argument === undefined ? [b.text("undefined", text)] : b.stringOf(instr, argument, text)),
    carried(text, key),
    // The receiver is no `undefined` or `null` (the module doc), so the chain runs over its other kinds.
    ...b.kindChain(instr, receiver, result, arm, b.kinds.kindsOf(receiver).filter(isObjectCoercible), CARRIER),
  ];
}

/**
 * §20.1.3.3: a V that is not an object answers false before ToObject(this value); else V's [[Prototype]] chain is
 * walked for `this`. Only an ordinary object's chain can hold a value the program has (an error's included); a
 * function's holds the realm's built-in prototypes alone, which no program obtains (M1), but (#7354 G1) %Error%
 * (`functionChainAnswer`).
 */
function prototypeOf(b: ObjectStaticBuilders, instr: Call, result: IrValueId): IrInstr[] {
  const [receiver, , argument] = instr.args as [IrValueId, IrValueId, IrValueId | undefined];
  if (argument === undefined) return boxed(b, instr, constant(false), result);
  const walk = (kind: CarrierKind) =>
    isOrdinaryObject(kind)
      ? (s: IrValueId) => [realmCall("js.object.inherits", [argument, receiver], s)]
      : kind === "function"
        ? (s: IrValueId) => functionChainAnswer(b, instr, b.errors, receiver, constant(false), s, BOOLEAN)
        : constant(false);
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => boxed(b, instr, walk(kind), r);
  return b.kindChain(instr, argument, result, arm, b.kinds.kindsOf(argument), CARRIER);
}

/**
 * The legalized call: the method's algorithm when the callee is the realm's own method, else the call as it was.
 * (#7354 G1) Error.prototype.toString is the realm's own (§20.5.3.4, `js.object.error-to-string`): its receiver is
 * the [[Get]]'s, an object, as no primitive's wrapper prototype reaches it.
 */
export function dynamicPrototypeMethodCall(b: ObjectStaticBuilders, instr: Call, method: RealmMethod): IrInstr[] {
  const [builtin, same] = [b.fresh(), b.fresh()];
  const algorithm = (r: IrValueId): IrInstr[] =>
    method === "Error.prototype.toString"
      ? [realmCall("js.object.error-to-string", [instr.args[0]!], r)]
      : method === "isPrototypeOf"
        ? prototypeOf(b, instr, r)
        : ownProperty(b, instr, method === "propertyIsEnumerable", r);
  return [
    ...b.realmIntrinsic(methodId(method), builtin),
    b.intrinsic(instr, "js.value.strict_eq", [instr.args[1]!, builtin], same),
    b.branch(same, algorithm, (r) => [{ ...instr, result: r, resultType: CARRIER }], instr.result!, CARRIER),
  ];
}
