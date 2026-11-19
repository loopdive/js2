// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4, #7352 A2) What a member read and a member write of the dynamic value share: the legalization builders
 * they are written with, the key as the legalization classifies it, a call of a realm-served object contract, and
 * RequireObjectCoercible's TypeError for an `undefined` / `null` receiver.
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { isArrayIndexKey } from "./builtin-prototype-keys.js";
import { plainObjectRefusal, type CarrierKind } from "./dynamic-value-kinds.js";
import { gap } from "./dynamic-value-gap.js";
import type { OrdinaryObjectRuntimeFeature } from "../runtime/contracts/manifest.js";
import type { ProgramObjects } from "../source-plain-objects.js";

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
  /** (#7352 A2) ToNumber of the once-evaluated value into `result`. */
  readonly toNumber: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
}

/** What a member access asks of the whole program. */
export interface MemberAccessProgram {
  readonly objects: ProgramObjects;
  readonly catches: boolean;
  readonly handlesExceptions: boolean;
}

/**
 * A member key: a once-boxed constant string (`name`), or (#7352 A2) a boxed number (`index`, its f64 payload). A
 * constant number is an array index exactly when its ToString is one (§6.1.7: CanonicalNumericIndexString of a
 * number's ToString is the number); any other is a property key that needs ToString of a number, which the realm
 * cannot reach, so it refuses by name. A number that is no index at run time aborts in the realm by name.
 * `operation` names the access in its refusals.
 */
export type MemberKey = (
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "index"; readonly index: IrValueId }
) & { readonly label: string; readonly operation: string };

const DYNAMIC_OPERATION = { read: "dyn.member_get", write: "dyn.member_set" } as const;

/**
 * The key of a `read` or `write` of `key`, or a named refusal: a computed key, a constant number that is no array
 * index, or a program whose objects are not plain (a key outside the built-in prototypes answers by its own property
 * only while no code can change them).
 */
export function memberAccess(
  b: MemberAccessBuilders,
  program: MemberAccessProgram,
  key: IrValueId,
  access: "read" | "write",
): MemberKey {
  const box = b.definitions.get(key);
  const operand = box?.kind === "box" ? b.definitions.get(box.value) : undefined;
  const [kind, ...others] = b.kindsOf(key);
  const named = (label: string) => {
    const operation = `member ${access} ${label}`;
    const refusal = plainObjectRefusal(program.objects, operation);
    return refusal === undefined ? { label, operation } : gap(refusal);
  };
  if (operand?.kind === "string.const") return { kind: "name", name: operand.value, ...named(`'${operand.value}'`) };
  if (box?.kind !== "box" || kind !== "number" || others.length !== 0)
    return gap(`${DYNAMIC_OPERATION[access]} with a computed key`);
  const constant = constantNumber(b.definitions, box.value);
  if (constant === undefined) return { kind: "index", index: box.value, ...named("a number key") };
  const name = String(constant);
  if (!isArrayIndexKey(name))
    gap(`${DYNAMIC_OPERATION[access]} with the number key ${name} (it needs ToString of a number)`);
  return { kind: "index", index: box.value, ...named(`'${name}'`) };
}

/** The number `value` holds when it is a constant, or the negation of one (`a[-1]`). */
function constantNumber(definitions: ReadonlyMap<IrValueId, IrInstr>, value: IrValueId): number | undefined {
  const definition = definitions.get(value);
  if (definition?.kind === "const") return definition.value.kind === "f64" ? definition.value.value : undefined;
  if (definition?.kind !== "unary" || definition.op !== "f64.neg") return undefined;
  const operand = constantNumber(definitions, definition.rand);
  return operand === undefined ? undefined : -operand;
}

/** A call of a realm-served `js.object.*` contract. */
export function objectCall(
  b: MemberAccessBuilders,
  feature: OrdinaryObjectRuntimeFeature,
  args: readonly IrValueId[],
  result: IrValueId | null,
): IrInstr {
  return {
    kind: "call",
    target: irIntrinsicFuncRef(feature),
    args,
    result,
    resultType: result === null ? null : b.carrier,
  };
}

/**
 * An access that can throw an error refuses `operation` by name in a program that catches: the catch would read the
 * error as a dynamic value, and no carrier kind holds an error yet.
 */
export function refuseCaughtError(program: MemberAccessProgram, operation: string): void {
  if (program.catches) gap(`${operation} in a program that catches`);
}

/**
 * The TypeError the access throws (RequireObjectCoercible, a strict failed [[Set]]), `message` naming it; then
 * `undefined` into `result`, the arm's value on a path that never continues.
 */
export function throwTypeError(b: MemberAccessBuilders, instr: IrInstr, message: string, result: IrValueId): IrInstr[] {
  const [text, carried, error] = [b.fresh(), b.fresh(), b.fresh()];
  return [
    b.text(message, text),
    { kind: "coerce.to_externref", value: text, result: carried, resultType: b.carrier },
    objectCall(b, "js.object.create-type-error", [carried], error),
    { kind: "throw", value: error, result: null, resultType: null },
    b.intrinsic(instr, "js.value.undefined", [], result),
  ];
}
