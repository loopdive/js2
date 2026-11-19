// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4) A member read of the dynamic value with a constant key (`MEMBER_READ_ARM`): a TypeError for `undefined`
 * / `null`, the realm's [[Get]] for an object, `undefined` for a primitive. A key a built-in prototype holds (the
 * realm's prototypes do not hold it yet), or a program whose prototypes code can change, refuses by name.
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { BUILTIN_REACHABLE_KEYS, isArrayIndexKey } from "./builtin-prototype-keys.js";
import { MEMBER_READ_ARM, plainObjectRefusal, type CarrierKind } from "./dynamic-value-kinds.js";
import { gap } from "./dynamic-value-gap.js";
import { nativeRealmGlobalReadRefusal } from "../../runtime/contracts/native-realm-globals.js";
import type { ProgramObjects } from "../source-plain-objects.js";

/** The legalization builders a member read is written with. */
export interface MemberReadBuilders {
  readonly carrier: IrType;
  readonly definitions: ReadonlyMap<IrValueId, IrInstr>;
  readonly fresh: () => IrValueId;
  readonly text: (value: string, result: IrValueId) => IrInstr;
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

/** (#7350 B2b) The global a read off the realm's global object names (G1's lowering), or `undefined`. */
export function globalObjectRead(definitions: ReadonlyMap<IrValueId, IrInstr>, value: IrValueId): string | undefined {
  const read = definitions.get(value);
  return read?.kind === "dyn.member_get" && definitions.get(read.recv)?.kind === "dyn.global_object"
    ? constantKey(definitions, read.key)
    : undefined;
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
  const call = (
    feature: "js.object.create-type-error" | "js.object.get",
    args: IrValueId[],
    r: IrValueId,
  ): IrInstr => ({
    kind: "call",
    target: irIntrinsicFuncRef(feature),
    args,
    result: r,
    resultType: b.carrier,
  });
  // (#7350 B2b) The global object's own data property, which the realm defines for every key read off it: no prototype
  // is reached, and G1's admission proved the program leaves the property as the realm defined it.
  if (b.definitions.get(receiver)?.kind === "dyn.global_object") {
    const unread = nativeRealmGlobalReadRefusal(name);
    if (unread !== undefined) gap(`read of the global '${name}' (${unread})`);
    return [call("js.object.get", [receiver, key, receiver], result)];
  }
  const refusal = plainObjectRefusal(program.objects, `member read '${name}'`);
  if (refusal !== undefined) gap(refusal);
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (MEMBER_READ_ARM[kind]) {
      case "type-error": {
        // A catch would read this TypeError as a dynamic value, and no carrier kind holds an error yet.
        if (program.catches) gap(`member read '${name}' of a possibly nullish value in a program that catches`);
        const [message, carried, error] = [b.fresh(), b.fresh(), b.fresh()];
        return [
          b.text(`Cannot read properties of ${kind} (reading '${name}')`, message),
          { kind: "coerce.to_externref", value: message, result: carried, resultType: b.carrier },
          call("js.object.create-type-error", [carried], error),
          { kind: "throw", value: error, result: null, resultType: null },
          b.intrinsic(instr, "js.value.undefined", [], r),
        ];
      }
      case "get":
        if (BUILTIN_REACHABLE_KEYS.object.has(name)) gap(`member read '${name}' needs Object.prototype's properties`);
        return [call("js.object.get", [receiver, key, receiver], r)];
      case "primitive": {
        const reachable = BUILTIN_REACHABLE_KEYS[kind as keyof typeof BUILTIN_REACHABLE_KEYS];
        if (reachable.has(name) || (kind === "string" && isArrayIndexKey(name)))
          gap(`member read '${name}' of a ${kind} needs its wrapper prototype`);
        return [b.intrinsic(instr, "js.value.undefined", [], r)];
      }
    }
  };
  return b.kindChain(instr, receiver, result, arm, b.kindsOf(receiver), b.carrier);
}
