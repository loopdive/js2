// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The dynamic-value legalization of the recognised `Object` statics (`src/ir/realm-static-call.ts`): the
 * front end emits one helper call per static over its arguments as carriers, already evaluated in source order and
 * padded with `undefined` to the catalog's length; this module writes the specification's steps that precede the
 * realm's descriptor bodies (`object-static-bodies.ts`): each argument's kind test (a TypeError for a primitive) and
 * ToPropertyKey (the program's own ToString, which can call a key's `toString`), in the specification's order.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { NativeObjectStatic } from "../../runtime/contracts/native-realm-catalog.js";
import { nativeObjectStatic } from "./builtin-prototype-keys.js";
import { realmCall, typeErrorThen } from "./dynamic-realm-calls.js";
import { CARRIER, carried, type ChainBuilders } from "./dynamic-value-chains.js";
import { unlessUnheldOwnKey } from "./dynamic-builtin-methods.js";
import { constantArgumentOf } from "./dynamic-member-access.js";
import { MEMBER_ACCESS_ARM, holdsFamily, type CarrierKind, type LegalizationProgram } from "./dynamic-value-kinds.js";

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
  /** (#7561) What the program allows its values (the wrapper kinds it can hold). */
  readonly program: LegalizationProgram;
  readonly definitions: ReadonlyMap<IrValueId, IrInstr>;
};
type Call = Extract<IrInstr, { kind: "call" }>;
type Arm = (result: IrValueId) => IrInstr[];

/** The kinds the kernel's own-property roles serve: an ordinary object and a function object. */
const served = (kind: CarrierKind): boolean =>
  MEMBER_ACCESS_ARM[kind] === "object" || MEMBER_ACCESS_ARM[kind] === "function";

/**
 * ToPropertyKey of `value`, the program's ToString, into `text`; (#7561) where the program can hold a wrapper,
 * (#7352) an array prototype or (#7574) the root, a constant string key is that constant, so the realm's use names the one member it
 * reaches (`pinnedMembers`).
 */
export function toPropertyKey(b: ObjectStaticBuilders, instr: IrInstr, value: IrValueId, text: IrValueId): IrInstr[] {
  const pins =
    b.program.objects.wrappers.size > 0 || holdsFamily(b.program, "array") || holdsFamily(b.program, "object");
  const known = pins ? constantArgumentOf(b.definitions, value) : undefined;
  return known === undefined ? b.stringOf(instr, value, text) : [b.text(known, text)];
}

/** The legalized `Object.<name>(…args)` into the call's result. */
export function dynamicObjectStatic(b: ObjectStaticBuilders, instr: Call, name: NativeObjectStatic): IrInstr[] {
  const [first, second, third] = instr.args as [IrValueId, IrValueId, IrValueId | undefined];
  const undefinedValue = (r: IrValueId) => b.intrinsic(instr, "js.value.undefined", [], r);
  const throwing = (message: string, r: IrValueId) =>
    typeErrorThen({ ...b, carrier: CARRIER }, message, undefinedValue(r));
  /**
   * A chain over the kinds `value` may hold: `object` answers a served object ((#7354 G1) an error is one), and
   * `other` answers each remaining kind (a primitive, `undefined`, `null`).
   */
  const byKind = (value: IrValueId, object: Arm, other: (kind: CarrierKind, r: IrValueId) => IrInstr[], r: IrValueId) =>
    b.kindChain(
      instr,
      value,
      r,
      (kind, s) => (served(kind) ? object(s) : other(kind, s)),
      b.kinds.kindsOf(value),
      CARRIER,
    );
  /** ToPropertyKey of `value`, then `then` with the key's carrier. */
  const withKey = (value: IrValueId, then: (key: IrValueId) => IrInstr[]): IrInstr[] => {
    const [text, key] = [b.fresh(), b.fresh()];
    return [...toPropertyKey(b, instr, value, text), carried(text, key), ...then(key)];
  };
  const nullish = (kind: CarrierKind) => MEMBER_ACCESS_ARM[kind] === "type-error";
  /** (#7561) `then`, but the run-time abort for a key the realm lacks on `object` (`unlessUnheldOwnKey`). */
  const unlessUnheld = (object: IrValueId, key: IrValueId | undefined, then: Arm) =>
    unlessUnheldOwnKey(b, instr, b.program, object, key && constantArgumentOf(b.definitions, key), then);
  /**
   * ObjectDefineProperties(object, properties) after ToObject(properties), answering `object`. A number or a Boolean
   * becomes a wrapper without own properties; a string's own index properties need the String object the realm lacks.
   * `undefinedMap`: what an `undefined` map is: `Object.defineProperties` throws ToObject's TypeError, `Object.create`
   * takes it as no properties at all.
   */
  const defineAll = (object: IrValueId, properties: IrValueId, r: IrValueId, undefinedMap: "TypeError" | "none") =>
    byKind(
      properties,
      unlessUnheld(properties, undefined, (s) => [
        realmCall("js.object.descriptors-define", [object, properties]),
        carried(object, s),
      ]),
      (kind, s) =>
        undefinedMap === "none" && kind === "undefined"
          ? [carried(object, s)]
          : nullish(kind)
            ? throwing("Cannot convert undefined or null to object", s)
            : kind === "string"
              ? b.abort(instr, s)
              : [carried(object, s)],
      r,
    );
  const onObject = (object: Arm) =>
    byKind(first, object, (_kind, r) => throwing(`Object.${name} called on non-object`, r), instr.result!);
  switch (name) {
    case "defineProperty":
      return onObject((r) =>
        withKey(second, (key) =>
          unlessUnheld(first, second, (s) => [
            realmCall("js.object.descriptor-define", [first, key, third!]),
            carried(first, s),
          ])(r),
        ),
      );
    case "defineProperties":
      return onObject(unlessUnheld(first, undefined, (r) => defineAll(first, second, r, "TypeError")));
    case "getOwnPropertyDescriptor":
      return byKind(
        first,
        (r) =>
          withKey(second, (key) =>
            unlessUnheld(first, second, (s) => [realmCall("js.object.own-descriptor", [first, key], s)])(r),
          ),
        (kind, r) =>
          nullish(kind)
            ? throwing("Cannot convert undefined or null to object", r)
            : withKey(second, () => (kind === "string" ? b.abort(instr, r) : [undefinedValue(r)])),
        instr.result!,
      );
    case "create":
      // The prototype must be an object or null: an ordinary object links (a function is no ordinary object, which the
      // realm's creation takes: the abort), `null` ends the chain.
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
          if (create) return [create, ...defineAll(object, second, r, "none")];
          return served(kind) ? b.abort(instr, r) : throwing("Object prototype may only be an Object or null", r);
        },
        b.kinds.kindsOf(first),
        CARRIER,
      );
  }
}
