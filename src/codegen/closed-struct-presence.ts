// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3920) The per-instance own-presence answer for a STATICALLY-KNOWN key on a
 * STATICALLY-KNOWN closed-struct receiver.
 *
 * ## What was wrong
 * A conditionally-assigned fnctor/class field (`if (c) this.p = v`) is a
 * physical slot on the shape but an OPTIONAL own property of the instance;
 * #2847/#3780 gave it a `$presence_<w>` bit for exactly that reason, and every
 * VALUE read consults it. The reflective predicates did not: `"p" in bag` and
 * `bag.hasOwnProperty("p")` both folded to `i32.const 1` from
 * `structFieldNames.includes("p")` — the SHAPE question, not the instance
 * question — so they answered `true` for a property the instance never got.
 * The wrong answer stayed invisible because the value read on the same line was
 * right.
 *
 * ## Why the answer comes from the presence WORD, not the field list
 * A field-list derivation is layout-dependent: it re-breaks the moment one
 * logical shape is emitted as several physical layouts (#3927's per-type
 * layouts, and already today for a hot/cold-split field, which is not in the
 * main struct's field list at all). The presence bit is a per-source-field
 * LOGICAL number resolved through {@link presenceSlotOf} against the owning
 * struct's own field array, and the cold hop is resolved through
 * {@link coldFieldPresenceInstrs} — the same two mechanisms the value read and
 * the `__hasOwnProperty` runtime ladder use. Sharing them is what keeps the
 * three surfaces from disagreeing again.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coldFieldNameAt, coldFieldPresenceInstrs, coldOwnFieldsFor } from "./fnctor-cold-tail.js";
import { presenceSlotOf, presenceTestInstrs } from "./fnctor-presence-bits.js";

export interface ClosedStructPresence {
  /** Consume the receiver already on the stack, leave one `i32`. */
  readonly instrs: Instr[];
  /** Scratch local the caller must release once the instrs are emitted. */
  readonly recvLocal: number;
}

/**
 * `undefined` when the SHAPE answers the question and no runtime test is
 * needed — either there is no such field, or the field is unconditional and
 * therefore present on every instance. Both keep the caller's existing fold.
 *
 * The scratch local is always `(ref null $S)` and the null case is CHECKED, not
 * `ref.as_non_null`-ed. Two reasons, both load-bearing:
 *
 * - A nullable local accepts a non-null value too, so the caller only has to
 *   prove the receiver is *some* ref to `structTypeIdx` — never that its
 *   nullability matches. A `ref`/`ref null` mismatch on `local.set` is a module
 *   validation failure, i.e. a hard compile error on a path that used to emit a
 *   constant.
 * - The folds this replaces never trapped. Turning a wrong constant into a trap
 *   would be a strictly worse answer than the one being fixed.
 *
 * The redundant null test on a provably non-null receiver folds away in
 * `wasm-opt`.
 */
export function closedStructPresenceInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  structName: string,
  structTypeIdx: number,
  key: string,
): ClosedStructPresence | undefined {
  const slot = presenceSlotOf(ctx.structFields.get(structName), key);
  const cold = slot ? undefined : coldOwnFieldsFor(ctx, structName).find((loc) => coldFieldNameAt(ctx, loc) === key);
  if (!slot && !cold) return undefined;

  const recvLocal = allocTempLocal(fctx, { kind: "ref_null", typeIdx: structTypeIdx } as ValType);
  const recv: Instr[] = [{ op: "local.get", index: recvLocal }, { op: "ref.as_non_null" }];
  const present: Instr[] = slot
    ? [...recv, ...presenceTestInstrs(structTypeIdx, slot)]
    : coldFieldPresenceInstrs(cold!, recv);
  const instrs: Instr[] = [
    { op: "local.set", index: recvLocal },
    { op: "local.get", index: recvLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: present,
    },
  ];
  return { instrs, recvLocal };
}

/**
 * Does a compiled operand actually carry the closed-struct reference the
 * presence instrs expect?
 *
 * The caller resolves the receiver's type from the checker, then compiles the
 * expression — the two can disagree (a widened binding, a subtype, an
 * externref-slotted variable). Committing a mismatch is not a wrong answer, it
 * is an INVALID MODULE, so the presence path is entered only when the compiled
 * value is confirmed.
 */
export function isClosedStructOperand(result: ValType | null | undefined, structTypeIdx: number): boolean {
  if (!result) return false;
  if (result.kind !== "ref" && result.kind !== "ref_null") return false;
  return (result as { typeIdx: number }).typeIdx === structTypeIdx;
}
