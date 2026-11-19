// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4, O3) A member read or write of the dynamic value with a constant key, as one chain over the receiver's
 * kinds (`MEMBER_ACCESS_ARM`): a TypeError for `undefined` / `null`, the realm's [[Get]] or [[Set]] for an object, and
 * for a primitive what its pristine wrapper answers. A key a built-in prototype holds (the realm's prototypes do not
 * hold it yet), a computed key, or a program whose prototypes code can change refuses by name.
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { BUILTIN_REACHABLE_KEYS, isArrayIndexKey } from "./builtin-prototype-keys.js";
import { MEMBER_ACCESS_ARM, plainObjectRefusal, type CarrierKind, type ProgramObjects } from "./dynamic-value-kinds.js";
import { gap } from "./dynamic-value-gap.js";

/** The legalization builders a member access is written with. */
export interface MemberAccessBuilders {
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

type Program = { readonly objects: ProgramObjects; readonly catches: boolean };

/** OrdinarySet's answer (`js.object.set`). */
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** A thrown TypeError: `what` the receiver may be, as a refusal names it, and the error's message. */
type ThrowTypeError = (what: string, message: string, result: IrValueId) => IrInstr[];

/** What sets a read and a write apart past the receiver chain they share. */
interface Access {
  readonly name: string;
  /** The access as a refusal names it ("member read 'k'"). */
  readonly operation: string;
  readonly resultType: IrType;
  /** V8's TypeError message for a nullish receiver. */
  readonly nullishMessage: (kind: CarrierKind) => string;
  /** The answer of an arm whose value no code reads (after a throw, or a sloppy write's ignored failure). */
  readonly unread: (result: IrValueId) => IrInstr;
  readonly object: (result: IrValueId) => IrInstr;
  readonly primitive: (kind: CarrierKind, result: IrValueId, throwTypeError: ThrowTypeError) => IrInstr[];
}

/** The string a once-boxed constant key holds; any other key refuses by name. */
function constantKey(b: MemberAccessBuilders, instr: IrInstr, key: IrValueId): string {
  const box = b.definitions.get(key);
  const text = box?.kind === "box" ? b.definitions.get(box.value) : undefined;
  return text?.kind === "string.const" ? text.value : gap(`${instr.kind} with a computed key`);
}

const call = (
  feature: "js.object.create-type-error" | "js.object.get" | "js.object.set",
  args: IrValueId[],
  result: IrValueId,
  resultType: IrType,
): IrInstr => ({ kind: "call", target: irIntrinsicFuncRef(feature), args, result, resultType });

/** The chain both accesses take over the once-evaluated `receiver`, into `result`. */
function memberAccess(
  b: MemberAccessBuilders,
  program: Program,
  instr: IrInstr,
  access: Access,
  receiver: IrValueId,
  result: IrValueId,
): IrInstr[] {
  const refusal = plainObjectRefusal(program.objects, access.operation);
  if (refusal !== undefined) gap(refusal);
  const throwTypeError: ThrowTypeError = (what, text, r) => {
    // A catch would read this TypeError as a dynamic value, and no carrier kind holds an error yet.
    if (program.catches) gap(`${access.operation} of ${what} in a program that catches`);
    const [message, carried, error] = [b.fresh(), b.fresh(), b.fresh()];
    return [
      b.text(text, message),
      { kind: "coerce.to_externref", value: message, result: carried, resultType: b.carrier },
      call("js.object.create-type-error", [carried], error, b.carrier),
      { kind: "throw", value: error, result: null, resultType: null },
      access.unread(r),
    ];
  };
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (MEMBER_ACCESS_ARM[kind]) {
      case "type-error":
        return throwTypeError("a possibly nullish value", access.nullishMessage(kind), r);
      case "object":
        if (BUILTIN_REACHABLE_KEYS.object.has(access.name))
          gap(`${access.operation} needs Object.prototype's properties`);
        return [access.object(r)];
      case "primitive":
        return access.primitive(kind, r, throwTypeError);
    }
  };
  return b.kindChain(instr, receiver, result, arm, b.kindsOf(receiver), access.resultType);
}

/** The read of `key` off the once-evaluated `receiver` into `result`. */
export function dynamicMemberRead(
  b: MemberAccessBuilders,
  program: Program,
  instr: IrInstr,
  receiver: IrValueId,
  key: IrValueId,
  result: IrValueId,
): IrInstr[] {
  const name = constantKey(b, instr, key);
  const operation = `member read '${name}'`;
  const access: Access = {
    name,
    operation,
    resultType: b.carrier,
    nullishMessage: (kind) => `Cannot read properties of ${kind} (reading '${name}')`,
    unread: (r) => b.intrinsic(instr, "js.value.undefined", [], r),
    object: (r) => call("js.object.get", [receiver, key, receiver], r, b.carrier),
    primitive: (kind, r) => {
      const reachable = BUILTIN_REACHABLE_KEYS[kind as keyof typeof BUILTIN_REACHABLE_KEYS];
      if (reachable.has(name) || (kind === "string" && isArrayIndexKey(name)))
        gap(`${operation} of a ${kind} needs its wrapper prototype`);
      return [b.intrinsic(instr, "js.value.undefined", [], r)];
    },
  };
  return memberAccess(b, program, instr, access, receiver, result);
}

/**
 * (#7354 O3) The write of `value` to `key` on the once-evaluated `receiver`, its OrdinarySet answer into a value no
 * code reads. A primitive's wrapper answers `false` for every key a plain program can write: the pristine prototypes
 * hold no setter but `__proto__`'s, which makes a program unplain, and its other properties are data properties, read
 * only or set on the receiver, which is no object. PutValue ignores that failure in sloppy code (`sloppy`) and throws
 * a TypeError in strict code.
 */
export function dynamicMemberWrite(
  b: MemberAccessBuilders,
  program: Program,
  instr: IrInstr,
  receiver: IrValueId,
  key: IrValueId,
  value: IrValueId,
  sloppy: boolean,
): IrInstr[] {
  const name = constantKey(b, instr, key);
  const unread = (r: IrValueId): IrInstr => ({
    kind: "const",
    value: { kind: "bool", value: false },
    result: r,
    resultType: BOOLEAN,
  });
  const access: Access = {
    name,
    operation: `member write '${name}'`,
    resultType: BOOLEAN,
    nullishMessage: (kind) => `Cannot set properties of ${kind} (setting '${name}')`,
    unread,
    object: (r) => call("js.object.set", [receiver, key, value, receiver], r, BOOLEAN),
    primitive: (kind, r, throwTypeError) =>
      sloppy
        ? [unread(r)]
        : throwTypeError("a possibly primitive value in strict code", `Cannot create property '${name}' on ${kind}`, r),
  };
  return memberAccess(b, program, instr, access, receiver, b.fresh());
}
