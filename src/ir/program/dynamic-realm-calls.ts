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
import { gap } from "./dynamic-value-gap.js";

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

/** The builders a synthesized TypeError is written with. */
export interface TypeErrorBuilders {
  readonly carrier: IrType;
  readonly fresh: () => IrValueId;
  readonly text: (value: string, result: IrValueId) => IrInstr;
}

/**
 * A TypeError with `message`, as statements that do not complete: the one place the legalization raises one. It is
 * thrown under the program's one exception tag, so a source `catch` that only binds or rethrows it catches it, and
 * without a catch it ends the program as JavaScript's uncaught TypeError does. (#7354 M1) In a program that reads a
 * catch binding (`readsCaught`) the read could see it, and no carrier kind holds an error yet (`typeof e`, `e.name`
 * would answer wrong), so such a program refuses by name at compile time instead; M2 makes the error a carrier kind.
 */
export function typeError(b: TypeErrorBuilders, message: string, readsCaught: boolean): IrInstr[] {
  if (readsCaught) gap(`TypeError "${message}" in a program that reads a caught value`);
  const [text, carried, error] = [b.fresh(), b.fresh(), b.fresh()];
  return [
    b.text(message, text),
    { kind: "coerce.to_externref", value: text, result: carried, resultType: b.carrier },
    realmCall("js.object.create-type-error", [carried], error),
    { kind: "throw", value: error, result: null, resultType: null },
  ];
}
