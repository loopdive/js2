// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7352 A2) A member write of the dynamic value (`MEMBER_WRITE_ARM`): a TypeError for `undefined` / `null`; on an
 * object, in a program with Arrays, a number key is the index-keyed [[Set]] (`js.object.set-index`) and `length` is
 * ArraySetLength (`js.object.set-length`); a primitive's [[Set]] fails. Every other object write is OrdinarySet,
 * which the realm does not serve yet (#7354 O3), and refuses by name, as does any object write in a program without
 * Arrays, where every object is ordinary.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { MEMBER_WRITE_ARM, type CarrierKind } from "./dynamic-value-kinds.js";
import { gap } from "./dynamic-value-gap.js";
import {
  memberAccess,
  objectCall,
  refuseCaughtError,
  throwTypeError,
  type MemberAccessBuilders,
  type MemberAccessProgram,
} from "./dynamic-member-access.js";

/** The write `instr` (`recv[key] = value`, each once-evaluated). */
export function dynamicMemberWrite(
  b: MemberAccessBuilders,
  program: MemberAccessProgram,
  instr: Extract<IrInstr, { kind: "dyn.member_set" }>,
): IrInstr[] {
  const member = memberAccess(b, program, instr.key, "write");
  const { label, operation } = member;
  const done = (r: IrValueId): IrInstr => b.intrinsic(instr, "js.value.undefined", [], r);
  const set = (r: IrValueId): IrInstr[] => {
    if (!program.objects.arrays || (member.kind === "name" && member.name !== "length"))
      gap(`${operation} needs OrdinarySet`);
    if (member.kind === "index")
      return [objectCall(b, "js.object.set-index", [instr.recv, member.index, instr.value], null), done(r)];
    refuseCaughtError(program, `${operation} (ArraySetLength's RangeError)`);
    const length = b.fresh();
    return [
      ...b.toNumber(instr, instr.value, length),
      objectCall(b, "js.object.set-length", [instr.recv, length], null),
      done(r),
    ];
  };
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (MEMBER_WRITE_ARM[kind]) {
      case "type-error":
        refuseCaughtError(program, `${operation} of a possibly nullish value`);
        return throwTypeError(b, instr, `Cannot set properties of ${kind} (setting ${label})`, r);
      case "set":
        return set(r);
      case "fail":
        if (instr.sloppy) return [done(r)];
        refuseCaughtError(program, `${operation} of a primitive in strict code`);
        return throwTypeError(b, instr, `Cannot create property ${label} on a ${kind}`, r);
    }
  };
  // The chain's value is the arms' `undefined`, which nothing reads.
  return b.kindChain(instr, instr.recv, b.fresh(), arm, b.kindsOf(instr.recv), b.carrier);
}
