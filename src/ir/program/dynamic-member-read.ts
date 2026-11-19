// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4) A member read of the dynamic value with a constant key (`MEMBER_READ_ARM`): a TypeError for `undefined`
 * / `null`, the realm's [[Get]] for an object, `undefined` for a primitive. A key a built-in prototype holds (the
 * realm's prototypes do not hold it yet), or a primitive receiver in a program whose code can reach a built-in
 * prototype, refuses by name.
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { BUILTIN_REACHABLE_KEYS, isArrayIndexKey } from "./builtin-prototype-keys.js";
import { MEMBER_READ_ARM, type CarrierKind, type ProgramObjects } from "./dynamic-value-kinds.js";
import { realmCall, typeError, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
import { gap } from "./dynamic-value-gap.js";

/** The legalization builders a member read is written with. */
export interface MemberReadBuilders extends TypeErrorBuilders {
  readonly definitions: ReadonlyMap<IrValueId, IrInstr>;
  readonly intrinsic: (
    instr: IrInstr,
    id: IntrinsicId,
    args: readonly IrValueId[],
    result?: IrValueId | null,
  ) => IrInstr;
  readonly kindsOf: (value: IrValueId) => readonly CarrierKind[];
  readonly kindChain: (
    instr: IrInstr,
    value: IrValueId,
    result: IrValueId,
    arm: (kind: CarrierKind, result: IrValueId) => IrInstr[],
    kinds: readonly CarrierKind[],
    resultType: IrType,
  ) => IrInstr[];
}

/** The string a once-boxed constant key holds, or `undefined` for any other key. */
function constantKey(definitions: ReadonlyMap<IrValueId, IrInstr>, key: IrValueId): string | undefined {
  const box = definitions.get(key);
  const text = box?.kind === "box" ? definitions.get(box.value) : undefined;
  return text?.kind === "string.const" ? text.value : undefined;
}

/** The read of `key` off the once-evaluated `receiver` into `result`. */
export function dynamicMemberRead(
  b: MemberReadBuilders,
  program: { readonly objects: ProgramObjects; readonly catches: boolean },
  instr: IrInstr,
  receiver: IrValueId,
  key: IrValueId,
  result: IrValueId,
): IrInstr[] {
  const name = constantKey(b.definitions, key) ?? gap("dyn.member_get with a computed key");
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (MEMBER_READ_ARM[kind]) {
      case "type-error":
        // The TypeError does not complete; `undefined` only gives the arm its value.
        return [
          ...typeError(b, `Cannot read properties of ${kind} (reading '${name}')`, program.catches),
          b.intrinsic(instr, "js.value.undefined", [], r),
        ];
      case "get":
        if (BUILTIN_REACHABLE_KEYS.object.has(name)) gap(`member read '${name}' needs Object.prototype's properties`);
        return [realmCall("js.object.get", [receiver, key, receiver], r)];
      case "primitive": {
        // (#7354 O2b) Only this arm assumes the built-in prototypes are the specification's; the object arm is the
        // realm's own [[Get]].
        const reached = program.objects.unplain;
        if (reached !== undefined) gap(`member read '${name}' (${reached})`);
        const reachable = BUILTIN_REACHABLE_KEYS[kind as keyof typeof BUILTIN_REACHABLE_KEYS];
        if (reachable.has(name) || (kind === "string" && isArrayIndexKey(name)))
          gap(`member read '${name}' of a ${kind} needs its wrapper prototype`);
        return [b.intrinsic(instr, "js.value.undefined", [], r)];
      }
    }
  };
  return b.kindChain(instr, receiver, result, arm, b.kindsOf(receiver), b.carrier);
}
