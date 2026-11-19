// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4) A member read of the dynamic value with a constant key (`MEMBER_READ_ARM`): a TypeError for `undefined`
 * / `null`, the realm's [[Get]] for an object, `undefined` for a primitive. A key a built-in prototype holds (the
 * realm's prototypes do not hold it yet), or a program whose prototypes code can change, refuses by name. (#7352 A2)
 * A number key reads an object through the index-keyed [[Get]] (`js.object.get-index`).
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
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
} from "./dynamic-member-access.js";

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
      case "primitive": {
        // A number key's ToString names no built-in prototype property; it may name a string's own character.
        const reaches =
          member.kind === "index"
            ? kind === "string"
            : BUILTIN_REACHABLE_KEYS[kind as "number" | "boolean" | "string"].has(member.name) ||
              (kind === "string" && isArrayIndexKey(member.name));
        if (reaches) gap(`${operation} of a ${kind} needs its wrapper prototype`);
        return [b.intrinsic(instr, "js.value.undefined", [], r)];
      }
    }
  };
  return b.kindChain(instr, receiver, result, arm, b.kindsOf(receiver), b.carrier);
}
