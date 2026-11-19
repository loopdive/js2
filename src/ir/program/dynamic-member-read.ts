// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4) A member read of the dynamic value with a constant key (`MEMBER_READ_ARM`): a TypeError for `undefined`
 * / `null`, the realm's [[Get]] for an object, `undefined` for a primitive. A key a built-in prototype holds (the
 * realm's prototypes do not hold it yet), or a program whose prototypes code can change, refuses by name. (#7352 A2)
 * A number key reads an object through the index-keyed [[Get]] (`js.object.get-index`). (#7352) A string answers its
 * own `length` and its code unit at an index key (`js.value.char_at`) first.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { BUILTIN_REACHABLE_KEYS, isArrayIndexKey } from "./builtin-prototype-keys.js";
import { MEMBER_READ_ARM, type CarrierKind } from "./dynamic-value-kinds.js";
import { gap } from "./dynamic-value-gap.js";
import {
  memberAccess,
  objectCall,
  refuseCaughtError,
  throwTypeError,
  type MemberAccessBuilders,
  type MemberAccessProgram,
  type MemberKey,
} from "./dynamic-member-access.js";

const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });

/** The read of `key` off the once-evaluated `receiver` into `result`. */
export function dynamicMemberRead(
  b: MemberAccessBuilders,
  program: MemberAccessProgram,
  instr: IrInstr,
  receiver: IrValueId,
  key: IrValueId,
  result: IrValueId,
): IrInstr[] {
  const member = memberAccess(b, program, key, "read");
  const { label, operation } = member;
  // (#7352 A2) In a program with Arrays an object may be one, whose prototype is %Array.prototype%.
  const [inherited, prototype] = program.objects.arrays
    ? [BUILTIN_REACHABLE_KEYS.array, "Array.prototype"]
    : [BUILTIN_REACHABLE_KEYS.object, "Object.prototype"];
  // A number key's ToString names no built-in prototype property.
  const primitive = (kind: "number" | "boolean" | "string", r: IrValueId): IrInstr[] => {
    if (member.kind === "name" && BUILTIN_REACHABLE_KEYS[kind].has(member.name))
      gap(`${operation} of a ${kind} needs its wrapper prototype`);
    return [b.intrinsic(instr, "js.value.undefined", [], r)];
  };
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (MEMBER_READ_ARM[kind]) {
      case "type-error":
        refuseCaughtError(program, `${operation} of a possibly nullish value`);
        return throwTypeError(b, instr, `Cannot read properties of ${kind} (reading ${label})`, r);
      case "get":
        if (member.kind === "index")
          return [objectCall(b, "js.object.get-index", [receiver, member.index, receiver], r)];
        if (inherited.has(member.name)) gap(`${operation} needs ${prototype}'s properties`);
        return [objectCall(b, "js.object.get", [receiver, key, receiver], r)];
      case "string-own":
        return stringOwnRead(b, instr, member, receiver, r) ?? primitive("string", r);
      case "primitive":
        return primitive(kind as "number" | "boolean", r);
    }
  };
  return b.kindChain(instr, receiver, result, arm, b.kindsOf(receiver), b.carrier);
}

/**
 * (#7352) A string's own property (§10.4.3): `length`, or the code unit at a number key or a constant index key
 * (`undefined` past its end); `undefined` for any other key, which only its prototypes can answer.
 */
function stringOwnRead(
  b: MemberAccessBuilders,
  instr: IrInstr,
  member: MemberKey,
  receiver: IrValueId,
  result: IrValueId,
): IrInstr[] | undefined {
  if (member.kind === "index") return [b.intrinsic(instr, "js.value.char_at", [receiver, member.index], result)];
  if (member.name === "length") {
    const [text, length] = [b.fresh(), b.fresh()];
    return [
      b.intrinsic(instr, "js.value.as_string", [receiver], text),
      { kind: "string.len", value: text, result: length, resultType: F64 },
      b.intrinsic(instr, "js.number.box", [length], result),
    ];
  }
  if (!isArrayIndexKey(member.name)) return undefined;
  const index = b.fresh();
  return [
    { kind: "const", value: { kind: "f64", value: Number(member.name) }, result: index, resultType: F64 },
    b.intrinsic(instr, "js.value.char_at", [receiver, index], result),
  ];
}
