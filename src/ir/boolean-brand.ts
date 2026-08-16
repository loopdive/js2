// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrFunctionBuilder } from "./builder.js";
import type { IrType, IrValueId } from "./nodes.js";

/**
 * (#4503) The IR's BOOLEAN BRAND — a JS `boolean` on the shared `i32` carrier.
 *
 * A JS boolean and a native-annotated (`type i32 = number`) integer land on the
 * SAME physical carrier, so an IrType of bare `i32` cannot answer "is this
 * value a JS boolean?". Consumers that must distinguish them were left
 * guessing, and guessing here is a WRONG-OUTPUT class of gap rather than a
 * demote: `${b}` has to print `"true"`, not `"1"` (§7.1.17 ToString(Boolean)).
 * That is exactly why #4467 had to keep REJECTING boolean template
 * substitutions — its measured residual, retired by this brand.
 *
 * The brand is deliberately the ALREADY-EXISTING structural `boolean` flag on
 * the `i32` ValType (#1788 / #2785), not a new `IrType` arm:
 *
 *   - It changes **no** value representation — still an `i32` 0/1. Boxed /
 *     dynamic value representation is #2949's territory and stays out of this.
 *   - `valTypeEquals` compares only `kind` (+ `typeIdx`), so the brand is
 *     ERASABLE under `irTypeEquals`: a branded and an unbranded `i32` stay
 *     interchangeable at joins, slot writes and the verifier. Threading it
 *     through more producers therefore cannot create a new type mismatch or a
 *     new demotion — the backward-compat property a new `bool` IrType arm (a
 *     STRICT, non-erasable identity that every join, resolver and backend
 *     switch would have had to learn) could not have offered.
 *   - The legacy path already reads this exact flag at its escape-box site
 *     (`coerceType(i32 → externref)` picks `__box_boolean` over
 *     `__box_number`), so the IR is adopting the compiler's existing notion of
 *     boolean-ness rather than inventing a second one.
 *
 * READING CONTRACT: brand PRESENT ⇒ the producer proved a JS boolean. Brand
 * ABSENT ⇒ unknown — a consumer that needs the distinction must fail CLOSED
 * (demote), never assume "not branded therefore number".
 */
export function irBool(): IrType {
  return { kind: "val", val: { kind: "i32", boolean: true } };
}

/** (#4503) Is this the boolean-branded `i32` carrier? */
export function irTypeIsBoolean(t: IrType): boolean {
  return t.kind === "val" && t.val.kind === "i32" && t.val.boolean === true;
}

/**
 * (#4503) §7.1.17 ToString(Boolean) — the spelling is the literal `"true"` /
 * `"false"`, so a branded boolean needs no runtime formatter and no per-lane
 * provider (unlike the numeric family's `IR_NUMBER_TO_STRING_FN`): two
 * `string.const`s selected by the value. `cond ? "true" : "false"` is the shape
 * #3144 made lowerable on either string backend — the `if`'s result carrier
 * comes from the instr's IrType, so this site asks no mode question.
 *
 * The caller establishes the brand first; this function does not re-check it,
 * because a non-boolean arriving here would be a producer invariant violation,
 * not a capability gap.
 */
export function lowerBooleanToString(builder: IrFunctionBuilder, value: IrValueId): IrValueId {
  let whenTrue!: IrValueId;
  const thenBody = builder.collectBodyInstrs(() => {
    whenTrue = builder.emitStringConst("true");
  });
  let whenFalse!: IrValueId;
  const elseBody = builder.collectBodyInstrs(() => {
    whenFalse = builder.emitStringConst("false");
  });
  return builder.emitIfElse({
    cond: value,
    then: thenBody,
    thenValue: whenTrue,
    else: elseBody,
    elseValue: whenFalse,
    resultType: builder.typeOf(whenTrue),
  });
}
