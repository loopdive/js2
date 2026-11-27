// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4, O2b) The realm calls the dynamic-value legalization writes: a `js.object.*` contract call, and the
 * TypeError the legalization raises itself (a nullish member read, an object without a usable conversion method).
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import type { OrdinaryObjectRuntimeFeature } from "../runtime/contracts/manifest.js";
import { irOrdinaryObjectCallableDeclaration } from "../runtime/ordinary-object-callables.js";

/** The call of the realm's `feature` on `args`, its result (if the contract has one) into `result`. */
export function realmCall(
  feature: OrdinaryObjectRuntimeFeature,
  args: readonly IrValueId[],
  result: IrValueId | null = null,
): IrInstr {
  const target = irIntrinsicFuncRef(feature);
  return {
    kind: "call",
    target,
    args,
    result,
    resultType: irOrdinaryObjectCallableDeclaration(target)!.results[0] ?? null,
  };
}

const INTRINSIC_HELPER_PREFIX = "__ir_realm_intrinsic:";
/**
 * (#7354 G1) The front end's helper symbol for a read of the realm's built-in function object `id` (an identifier
 * naming the pristine global, `identifier-read.ts`); the legalization writes it as `js.object.intrinsic`.
 */
export const realmIntrinsicHelper = (id: string): string => INTRINSIC_HELPER_PREFIX + id;
/** The intrinsic id a helper symbol reads, if it is one. */
export const realmIntrinsicOfHelper = (symbol: string): string | undefined =>
  symbol.startsWith(INTRINSIC_HELPER_PREFIX) ? symbol.slice(INTRINSIC_HELPER_PREFIX.length) : undefined;

/**
 * (#7354 A1) The front end's helper symbol for an array literal: its operands are the literal's length (an f64, holes
 * and a trailing elision counted), then each present element's index key (a string) and value, in source order. The
 * legalization writes it as the realm's array (`arrayOf`), a dynamic value.
 */
export const ARRAY_LITERAL_HELPER = "__ir_array_literal";
/** Whether `instr` is the front end's array literal helper call. */
export const isArrayLiteralCall = (instr: IrInstr | undefined): boolean =>
  instr?.kind === "call" &&
  instr.target.binding.kind === "runtime" &&
  instr.target.binding.symbol === ARRAY_LITERAL_HELPER;

/**
 * (#7557) The front end's helper symbol for the realm's built-in caller's body (`realm-builtin-caller.ts`): its
 * operands are the built-in, the call's `this` and the argument vector; the legalization writes the built-ins'
 * algorithms (`dynamic-builtin-call.ts`).
 */
export const REALM_BUILTIN_CALL_HELPER = "__ir_realm_builtin_call";

/** The builders a synthesized TypeError is written with. */
export interface TypeErrorBuilders {
  readonly carrier: IrType;
  readonly fresh: () => IrValueId;
  readonly text: (value: string, result: IrValueId) => IrInstr;
}

/**
 * A TypeError with `message`, as statements that do not complete: the one place the legalization raises one. It is
 * the realm's error, thrown under the program's one exception tag: a source `catch` catches it, and (#7354 M2) a
 * catch that reads it reads the error kind of the dynamic value (`dynamic-value-kinds.ts`).
 */
export function typeError(b: TypeErrorBuilders, message: string): IrInstr[] {
  const [text, carried, error] = [b.fresh(), b.fresh(), b.fresh()];
  return [
    b.text(message, text),
    { kind: "coerce.to_externref", value: text, result: carried, resultType: b.carrier },
    realmCall("js.object.create-type-error", [carried], error),
    { kind: "throw", value: error, result: null, resultType: null },
  ];
}

/** {@link typeError}, then `answer`: the value of an arm that ends in the throw, which no code reads. */
export function typeErrorThen(b: TypeErrorBuilders, message: string, answer: IrInstr): IrInstr[] {
  return [...typeError(b, message), answer];
}
