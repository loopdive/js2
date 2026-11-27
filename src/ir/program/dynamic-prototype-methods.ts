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
 * receiver and takes the dispatcher, whose built-in arm (#7557) calls the realm's built-in caller: the same
 * algorithms ({@link realmMethodAlgorithm}) over the caller's `this` (any kind) and argument vector.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { closureMethodArity } from "../core/closure-invocation-callables.js";
import {
  ERROR_TO_STRING_ID,
  IS_ARRAY_ID,
  REALM_BRAND,
  nativeObjectPrototypeMethod,
  objectPrototypeMethodId,
} from "./builtin-prototype-keys.js";
import {
  builtinMethodChain,
  identityTest,
  wrapperMethodTest,
  type WrapperMethodName,
} from "./dynamic-builtin-methods.js";
import { constantKeyOf } from "./dynamic-member-access.js";
import { realmCall, typeErrorThen } from "./dynamic-realm-calls.js";
import { BOOLEAN, CARRIER, carried } from "./dynamic-value-types.js";
import { MEMBER_ACCESS_ARM, isOrdinaryObject, type CarrierKind, type ProgramFamilies } from "./dynamic-value-kinds.js";
import type { ConvertingBuilders } from "./dynamic-value-chains.js";
import { functionChainAnswer } from "./dynamic-realm-constructors.js";

export type Call = Extract<IrInstr, { kind: "call" }>;
const isObjectCoercible = (kind: CarrierKind): boolean => MEMBER_ACCESS_ARM[kind] !== "type-error";
type Arm = (result: IrValueId) => IrInstr[];

/**
 * (#7557) One call of a realm method: the instruction it stands for, its `this` and the kinds `this` may hold, and its
 * argument `index` (`undefined` where the call has none: a missing argument reads as `undefined`).
 */
export interface BuiltinCall {
  readonly instr: Call;
  readonly receiver: IrValueId;
  readonly receiverKinds: readonly CarrierKind[];
  /** A detached call (the dispatcher's): its `this` may be any value; a method call's is the [[Get]]'s receiver. */
  readonly detached: boolean;
  readonly argument: (index: number) => IrValueId | undefined;
}

/** A method call `o.m(…args)`: its receiver is the [[Get]]'s, so it is no `undefined` or `null` (the module doc). */
function methodCallOf(b: ConvertingBuilders, instr: Call): BuiltinCall {
  const receiver = instr.args[0]!;
  return {
    instr,
    receiver,
    receiverKinds: b.kinds.kindsOf(receiver).filter(isObjectCoercible),
    detached: false,
    argument: (index) => instr.args[2 + index],
  };
}

/**
 * The realm methods `call` may call, when it is `o.m(…)`: the dispatcher's call of a [[Get]] of a populated name on its
 * receiver: an Object.prototype method or Error.prototype.toString (only where `families.errors`, the program holds the
 * Error family) by catalog id, and (#7354 W2) whether a held wrapper's `valueOf` / `toString` may be it.
 */
export function realmMethodsNamed(name: string, families: ProgramFamilies): RealmMethods | undefined {
  const objectMethod = nativeObjectPrototypeMethod(name);
  const ids = [
    ...(objectMethod ? [objectPrototypeMethodId(objectMethod)] : []),
    ...(name === "toString" && families.errors ? [ERROR_TO_STRING_ID] : []),
    ...(name === "isArray" && families.arrays ? [IS_ARRAY_ID] : []),
  ];
  const wrapper = families.wrappers.size > 0 && (name === "valueOf" || name === "toString") ? name : undefined;
  return ids.length === 0 && wrapper === undefined ? undefined : { ids, wrapper };
}

/** `realmMethodsNamed` of `call`'s callee, when the call is `o.m(…)` with a constant name. */
export function prototypeMethodOfCall(
  call: Call,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
  families: ProgramFamilies,
): RealmMethods | undefined {
  if (closureMethodArity(call.target.name) === undefined) return undefined;
  const uncoerced = (value: IrValueId): IrValueId => {
    const definition = definitions.get(value);
    return definition?.kind === "coerce.to_externref" ? definition.value : value;
  };
  const callee = definitions.get(uncoerced(call.args[1]!));
  if (callee?.kind !== "dyn.member_get" || callee.recv !== uncoerced(call.args[0]!)) return undefined;
  const name = constantKeyOf(definitions, callee.key);
  return name === undefined ? undefined : realmMethodsNamed(name, families);
}

/** The realm methods a call may reach: by identity (`ids`), and (W2) a held wrapper's of the name read (`wrapper`). */
export interface RealmMethods {
  readonly ids: readonly string[];
  readonly wrapper?: WrapperMethodName;
}

/** `value`, the realm's Boolean of `test`, boxed into the carrier `result`. */
function boxed(b: ConvertingBuilders, instr: Call, test: (value: IrValueId) => IrInstr[], result: IrValueId) {
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
function ownProperty(b: ConvertingBuilders, call: BuiltinCall, enumerable: boolean, result: IrValueId): IrInstr[] {
  const { instr, receiver } = call;
  const argument = call.argument(0);
  const [text, key] = [b.fresh(), b.fresh()];
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (MEMBER_ACCESS_ARM[kind]) {
      case "object":
      case "function":
        return boxed(b, instr, (s) => b.selectorCall("js.object.has-own", [receiver, key], Number(enumerable), s), r);
      case "type-error":
        return toObjectError(b, r);
      default:
        return kind === "number" || kind === "boolean" ? boxed(b, instr, constant(false), r) : b.abort(instr, r);
    }
  };
  return [
    // A missing argument is `undefined`, whose ToString is "undefined".
    ...(argument === undefined ? [b.text("undefined", text)] : b.stringOf(instr, argument, text)),
    carried(text, key),
    ...b.kindChain(instr, receiver, result, arm, call.receiverKinds, CARRIER),
  ];
}

/** (#7557) ToObject's TypeError for an `undefined` or `null` `this` (a detached call's), as an unread carrier. */
const toObjectError = (b: ConvertingBuilders, r: IrValueId): IrInstr[] =>
  typeErrorThen({ ...b, carrier: CARRIER }, "Cannot convert undefined or null to object", unread(r));
/** The value of an arm that ends in a throw, which no code reads. */
const unread = (r: IrValueId): IrInstr => ({
  kind: "const",
  value: { kind: "null", ty: CARRIER },
  result: r,
  resultType: CARRIER,
});

/**
 * §20.1.3.3: a V that is not an object answers false before ToObject(this value); else V's [[Prototype]] chain is
 * walked for `this`. Only an ordinary object's chain can hold a value the program has (an error's included); a
 * function's holds the realm's built-in prototypes alone, which no program obtains (M1), but (#7354 G1) %Error% and
 * (W2) %Object.prototype% (`functionChainAnswer`).
 */
function prototypeOf(b: ConvertingBuilders, call: BuiltinCall, result: IrValueId): IrInstr[] {
  const { instr, receiver } = call;
  const argument = call.argument(0);
  if (argument === undefined) return boxed(b, instr, constant(false), result);
  const walk = (kind: CarrierKind) =>
    isOrdinaryObject(kind)
      ? (s: IrValueId) => [realmCall("js.object.inherits", [argument, receiver], s)]
      : kind === "function"
        ? (s: IrValueId) =>
            functionChainAnswer(b, instr, argument, receiver, constant(false), constant(true), s, BOOLEAN)
        : constant(false);
  // (#7557) An object V, then ToObject(this value): a detached call's `undefined` or `null` throws.
  const coercible =
    (kind: CarrierKind): Arm =>
    (r) => {
      const nullish = call.receiverKinds.filter((held) => !isObjectCoercible(held));
      if (nullish.length === 0) return boxed(b, instr, walk(kind), r);
      const cond = b.fresh();
      return [
        ...b.anyKind(instr, nullish, receiver, cond),
        b.branch(
          cond,
          (s) => toObjectError(b, s),
          (s) => boxed(b, instr, walk(kind), s),
          r,
          CARRIER,
        ),
      ];
    };
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] =>
    MEMBER_ACCESS_ARM[kind] === "object" || MEMBER_ACCESS_ARM[kind] === "function"
      ? coercible(kind)(r)
      : boxed(b, instr, constant(false), r);
  return b.kindChain(instr, argument, result, arm, b.kinds.kindsOf(argument), CARRIER);
}

/** (#7354 A1) §23.1.2.2 IsArray(arg): the realm's array brand of an object, `false` for any other value. */
function isArray(b: ConvertingBuilders, call: BuiltinCall, result: IrValueId): IrInstr[] {
  const { instr } = call;
  const argument = call.argument(0);
  if (argument === undefined) return boxed(b, instr, constant(false), result);
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] =>
    boxed(
      b,
      instr,
      isOrdinaryObject(kind)
        ? (s) => b.selectorCall("js.object.has-brand", [argument], REALM_BRAND.array, s)
        : constant(false),
      r,
    );
  return b.kindChain(instr, argument, result, arm, b.kinds.kindsOf(argument), CARRIER);
}

/**
 * The legalized call: the algorithm of the realm's own method the callee is, tested in turn, else the call as it was.
 * (#7354 G1) Error.prototype.toString is the realm's own (§20.5.3.4, `js.object.error-to-string`): its receiver is the
 * [[Get]]'s, an object, as no primitive's wrapper prototype reaches it. (#7354 W2) A wrapper's `valueOf` / `toString`
 * (`dynamic-builtin-methods.ts`; Number.prototype.toString with a radix argument is the run-time abort).
 */
export function dynamicPrototypeMethodCall(
  b: ConvertingBuilders,
  instr: Call,
  methods: RealmMethods,
  dispatches: boolean,
): IrInstr[] {
  const callee = instr.args[1]!;
  // Without a source function no dispatcher exists, and every function value is a built-in: its abort.
  const call = builtinMethodChain(
    b,
    realmMethodTests(b, methodCallOf(b, instr), callee, methods),
    (r) => (dispatches ? [{ ...instr, result: r, resultType: CARRIER }] : b.abort(instr, r)),
    CARRIER,
  );
  return call(instr.result!);
}

/** The tests of `methods` on `callee`, each answering the method's algorithm for `call` (`realmMethodAlgorithm`). */
export function realmMethodTests(b: ConvertingBuilders, call: BuiltinCall, callee: IrValueId, methods: RealmMethods) {
  return [
    ...methods.ids.map((id) => () => identityTest(b, id, callee, (r) => realmMethodAlgorithm(b, call, id, r))),
    ...(methods.wrapper !== undefined
      ? [
          () =>
            wrapperMethodTest(b, call.instr, methods.wrapper!, callee, call.receiver, call.argument(0) !== undefined),
        ]
      : []),
  ];
}

/**
 * The algorithm of the realm method `id` for `call`, into `r`. (#7354 G1) Error.prototype.toString is the realm's own
 * (§20.5.3.4, `js.object.error-to-string`) over an object `this`; (#7557) a detached call's other `this` is the
 * TypeError (step 2), or for a function the run-time abort (the realm reads no function's `name`).
 */
function realmMethodAlgorithm(b: ConvertingBuilders, call: BuiltinCall, id: string, r: IrValueId): IrInstr[] {
  if (id === ERROR_TO_STRING_ID) return errorToString(b, call, r);
  if (id === objectPrototypeMethodId("isPrototypeOf")) return prototypeOf(b, call, r);
  if (id === IS_ARRAY_ID) return isArray(b, call, r);
  return ownProperty(b, call, id === objectPrototypeMethodId("propertyIsEnumerable"), r);
}

function errorToString(b: ConvertingBuilders, call: BuiltinCall, result: IrValueId): IrInstr[] {
  const { instr, receiver } = call;
  // A method call's `this` is an object: no primitive's prototype chain reaches Error.prototype.
  if (!call.detached) return [realmCall("js.object.error-to-string", [receiver], result)];
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] =>
    isOrdinaryObject(kind)
      ? [realmCall("js.object.error-to-string", [receiver], r)]
      : kind === "function"
        ? b.abort(instr, r)
        : typeErrorThen(
            { ...b, carrier: CARRIER },
            "Error.prototype.toString requires that 'this' be an Object",
            unread(r),
          );
  return b.kindChain(instr, receiver, result, arm, call.receiverKinds, CARRIER);
}
