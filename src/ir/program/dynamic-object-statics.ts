// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The dynamic-value legalization of the recognised `Object` statics (`src/ir/realm-static-call.ts`): the
 * front end emits one helper call per static over its arguments as carriers, already evaluated in source order and
 * padded with `undefined` to the catalog's length; this module writes the specification's steps that precede the
 * realm's descriptor bodies (`object-static-bodies.ts`): each argument's kind test (a TypeError for a primitive, the
 * run-time abort for the realm's error object, whose properties the kernel does not serve) and ToPropertyKey (the
 * program's own ToString, which can call a key's `toString`), in the specification's order.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { NativeObjectStatic } from "../../runtime/contracts/native-realm-catalog.js";
import { nativeObjectStatic } from "./builtin-prototype-keys.js";
import { realmCall, typeErrorThen } from "./dynamic-realm-calls.js";
import { CARRIER, carried, type ChainBuilders } from "./dynamic-value-chains.js";
import { MEMBER_ACCESS_ARM, type CarrierKind } from "./dynamic-value-kinds.js";

const HELPER_PREFIX = "__ir_object_static:";
/** The front end's helper symbol for `Object.<name>`. */
export const objectStaticHelper = (name: NativeObjectStatic): string => HELPER_PREFIX + name;
/** The static a helper symbol names, if it is one. */
export function objectStaticOfHelper(symbol: string): NativeObjectStatic | undefined {
  return symbol.startsWith(HELPER_PREFIX) ? nativeObjectStatic(symbol.slice(HELPER_PREFIX.length))?.name : undefined;
}

/** The legalization's builders, with its ToString (`stringOf`, ToPropertyKey here). */
export type ObjectStaticBuilders = ChainBuilders & {
  readonly stringOf: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
};
type Call = Extract<IrInstr, { kind: "call" }>;
type Arm = (result: IrValueId) => IrInstr[];

/** The kinds the kernel's own-property roles serve: an ordinary object and a function object. */
const served = (kind: CarrierKind): boolean =>
  MEMBER_ACCESS_ARM[kind] === "object" || MEMBER_ACCESS_ARM[kind] === "function";

/** The legalized `Object.<name>(…args)` into the call's result. */
export function dynamicObjectStatic(b: ObjectStaticBuilders, instr: Call, name: NativeObjectStatic): IrInstr[] {
  const [first, second, third] = instr.args as [IrValueId, IrValueId, IrValueId | undefined];
  const undefinedValue = (r: IrValueId) => b.intrinsic(instr, "js.value.undefined", [], r);
  const throwing = (message: string, r: IrValueId) =>
    typeErrorThen({ ...b, carrier: CARRIER }, message, undefinedValue(r));
  /**
   * The run-time abort, as an arm that does not complete: the abort is a pure intrinsic, and a static whose result is
   * unused would otherwise drop it and run on as if the define had happened. The throw of its text never runs; it only
   * keeps the abort live.
   */
  const abort = (r: IrValueId): IrInstr[] => [
    ...b.abort(instr, r),
    { kind: "throw", value: r, result: null, resultType: null },
  ];
  /**
   * A chain over the kinds `value` may hold: `object` answers a served object, the realm's error is the abort, and
   * `other` answers each remaining kind (a primitive, `undefined`, `null`).
   */
  const byKind = (value: IrValueId, object: Arm, other: (kind: CarrierKind, r: IrValueId) => IrInstr[], r: IrValueId) =>
    b.kindChain(
      instr,
      value,
      r,
      (kind, s) => (served(kind) ? object(s) : kind === "error" ? abort(s) : other(kind, s)),
      b.kinds.kindsOf(value),
      CARRIER,
    );
  /** ToPropertyKey of `value`, then `then` with the key's carrier. */
  const withKey = (value: IrValueId, then: (key: IrValueId) => IrInstr[]): IrInstr[] => {
    const [text, key] = [b.fresh(), b.fresh()];
    return [...b.stringOf(instr, value, text), carried(text, key), ...then(key)];
  };
  const nullish = (kind: CarrierKind) => MEMBER_ACCESS_ARM[kind] === "type-error";
  /**
   * ObjectDefineProperties(object, properties) after ToObject(properties), answering `object`. A number or a Boolean
   * becomes a wrapper without own properties; a string's own index properties need the String object the realm lacks.
   * `Object.create` takes an `undefined` second argument as no properties at all.
   */
  const defineAll = (object: IrValueId, properties: IrValueId, r: IrValueId, undefinedIsNone = false) =>
    byKind(
      properties,
      (s) => [realmCall("js.object.descriptors-define", [object, properties]), carried(object, s)],
      (kind, s) =>
        undefinedIsNone && kind === "undefined"
          ? [carried(object, s)]
          : nullish(kind)
            ? throwing("Cannot convert undefined or null to object", s)
            : kind === "string"
              ? abort(s)
              : [carried(object, s)],
      r,
    );
  const onObject = (object: Arm) =>
    byKind(first, object, (_kind, r) => throwing(`Object.${name} called on non-object`, r), instr.result!);
  switch (name) {
    case "defineProperty":
      return onObject((r) =>
        withKey(second, (key) => [realmCall("js.object.descriptor-define", [first, key, third!]), carried(first, r)]),
      );
    case "defineProperties":
      return onObject((r) => defineAll(first, second, r));
    case "getOwnPropertyDescriptor":
      return byKind(
        first,
        (r) => withKey(second, (key) => [realmCall("js.object.own-descriptor", [first, key], r)]),
        (kind, r) =>
          nullish(kind)
            ? throwing("Cannot convert undefined or null to object", r)
            : withKey(second, () => (kind === "string" ? abort(r) : [undefinedValue(r)])),
        instr.result!,
      );
    case "create":
      // The prototype must be an object or null: an ordinary object links (a function's or an error's prototype is
      // no ordinary object, which the realm's creation takes: the abort), `null` ends the chain.
      return b.kindChain(
        instr,
        first,
        instr.result!,
        (kind, r) => {
          const object = b.fresh();
          const create =
            MEMBER_ACCESS_ARM[kind] === "object"
              ? realmCall("js.object.create-with-prototype", [first], object)
              : kind === "null"
                ? realmCall("js.object.create-null", [], object)
                : undefined;
          if (create) return [create, ...defineAll(object, second, r, true)];
          return served(kind) || kind === "error"
            ? abort(r)
            : throwing("Object prototype may only be an Object or null", r);
        },
        b.kinds.kindsOf(first),
        CARRIER,
      );
  }
}
