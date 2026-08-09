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
import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  type ColdFieldLocation,
  coldFieldNameAt,
  coldFieldPresenceInstrs,
  coldOwnFieldsFor,
} from "./fnctor-cold-tail.js";
import { type PresenceSlot, presenceSlotOf, presenceTestInstrs } from "./fnctor-presence-bits.js";
import { compileExpression } from "./shared.js";

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
/**
 * (#4225) Where `key`'s storage lives on this fnctor family — the SINGLE source
 * of truth both fold sites consult, and the seam #3927's per-type emission
 * extends.
 *
 * `base` is a presence bit in the main struct's `$presence_<w>` words. `cold` is
 * the #3927 hot/cold split's `$cold` hop. `undefined` means the family has no
 * storage for this name anywhere, which is the only case where a folded answer
 * is sound.
 *
 * **Why this must not be a base-field-list test.** The cold split REMOVES a
 * moved field from the base struct's field list, so `structFieldNames
 * .includes(key)` answers false for a name the instance really carries. A fold
 * site that decides "genuinely absent" from the base list therefore emits a
 * constant `false` for a present property. Add any new carrier HERE — never at
 * the call sites, which is what let the two sites drift apart in the first
 * place (#4225: one site had the fix and the other could not reach it).
 *
 * **Per-type layouts (#3927) ARE an arm here — and the earlier record that
 * they were "already answered correctly" without one was the #3920
 * receiver-spelling confound, caught by the default-ON gate probe
 * (2026-08-08).** The layout-emit test's `reflectiveSurface` fixture probes a
 * DYNAMIC receiver, which never reaches these folds; the folds fire only on a
 * STRUCT-TYPED receiver, where a split family's flow-grown name is absent
 * from the base field list and both `in` and `hasOwnProperty` answered a
 * constant FALSE for a property the instance carried (probe: native 111,
 * flag-OFF 111, flag-ON 1 — the value round-tripped, both folds wrong). No
 * third {@link PresenceStorage} variant was needed: the split keeps every
 * union name's presence BIT in the BASE words at fixed indices (the
 * emission's §6 constraint, held exactly so this lookup could stay
 * layout-independent), so the side-table lookup returns the existing
 * `"base"` storage shape and every fold site inherits the fix for free.
 */
export type PresenceStorage =
  | { readonly where: "base"; readonly slot: PresenceSlot }
  | { readonly where: "cold"; readonly loc: ColdFieldLocation };

export function findPresenceStorage(ctx: CodegenContext, structName: string, key: string): PresenceStorage | undefined {
  const slot = presenceSlotOf(ctx.structFields.get(structName), key);
  if (slot) return { where: "base", slot };
  // (#3927 per-type layouts) A split family's flow-grown union name: the VALUE
  // slot moved to a sibling layout or the resid carrier, but the presence BIT
  // stayed in the base words at fixed indices. The side-table slot IS a base
  // slot, valid on every layout instance through the shared prefix.
  const layoutSlot = ctx.fnctorLayoutInfo?.get(structName)?.presenceByName.get(key);
  if (layoutSlot) return { where: "base", slot: layoutSlot };
  const loc = coldOwnFieldsFor(ctx, structName).find((c) => coldFieldNameAt(ctx, c) === key);
  return loc ? { where: "cold", loc } : undefined;
}

export function closedStructPresenceInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  structName: string,
  structTypeIdx: number,
  key: string,
  storage: PresenceStorage | undefined = findPresenceStorage(ctx, structName, key),
): ClosedStructPresence | undefined {
  if (!storage) return undefined;
  const slot = storage.where === "base" ? storage.slot : undefined;
  const cold = storage.where === "cold" ? storage.loc : undefined;

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
function isClosedStructOperand(result: ValType | null | undefined, structTypeIdx: number): boolean {
  if (!result) return false;
  if (result.kind !== "ref" && result.kind !== "ref_null") return false;
  return (result as { typeIdx: number }).typeIdx === structTypeIdx;
}

/**
 * The whole per-instance-presence emission, for a call site that has already
 * decided its fold would answer `true`.
 *
 * `emitOperands` must emit BOTH operands in spec-evaluation order and leave the
 * RECEIVER (and nothing else) on the stack, returning the receiver's compiled
 * type. It is run into a SCRATCH body, so a site whose receiver turns out not to
 * be the expected struct reference pays nothing and falls back to its constant —
 * which is why the whole sequence lives here rather than being open-coded at
 * each caller.
 *
 * Returns `true` when the runtime answer was emitted and the caller is done;
 * `false` when the caller must emit its own fold (nothing has been written to
 * `fctx.body` in that case).
 */
export function emitClosedStructPresence(
  ctx: CodegenContext,
  fctx: FunctionContext,
  structTypeIdx: number,
  key: string,
  emitOperands: () => ValType | null | undefined,
): boolean {
  if (structTypeIdx < 0) return false;
  const structName = ctx.typeIdxToStructName.get(structTypeIdx);
  if (structName === undefined) return false;
  const presence = closedStructPresenceInstrs(ctx, fctx, structName, structTypeIdx, key);
  if (!presence) return false;

  const saved = pushBody(fctx);
  const receiverType = emitOperands();
  const operandInstrs = fctx.body;
  popBody(fctx, saved);

  const confirmed = isClosedStructOperand(receiverType, structTypeIdx);
  if (confirmed) {
    for (const instr of operandInstrs) fctx.body.push(instr);
    for (const instr of presence.instrs) fctx.body.push(instr);
  }
  releaseTempLocal(fctx, presence.recvLocal);
  return confirmed;
}

/** The closed-struct type index a receiver's resolved Wasm type names, or -1. */
function closedStructTypeIdxOf(recvWasm: ValType | undefined): number {
  if (!recvWasm) return -1;
  if (recvWasm.kind !== "ref" && recvWasm.kind !== "ref_null") return -1;
  return (recvWasm as { typeIdx: number }).typeIdx;
}

/**
 * `obj.hasOwnProperty(key)` / `obj.propertyIsEnumerable(key)` call site.
 *
 * Evaluation order is receiver, then argument (whose value is unused — the key
 * is already known statically, but it must still run for its side effects).
 *
 * `structFieldNames === null` means the caller has already decided the
 * receiver's struct fields are NOT its own properties — a `C.prototype` or
 * constructor receiver, where the struct describes the *instance* layout. Those
 * must keep folding, so they are declined here rather than answered from a
 * presence bit that does not describe this receiver at all.
 *
 * (#4225) `foldedAnswer` selects WHICH unsound constant this replaces, and the
 * two directions are not symmetric:
 *
 * - **`1`** — the fold said present from the base field list. Any storage
 *   (base bit or cold hop) demotes it to a presence read, because a
 *   conditionally-assigned field may never have been written.
 * - **`0`** — the fold said absent. Demote **only** when the name has
 *   OFF-BASE storage. That is the whole #4225 defect: the cold split removes a
 *   moved field from the base list, so the fold cannot see it. A base-resident
 *   name that folded to `0` did so for a reason the presence bit does not know
 *   about — `propertyIsEnumerable` answering `0` for a non-enumerable field is
 *   the live example — and reading the bit there would turn a correct `false`
 *   into a wrong `true`. `findPresenceStorage` is the discriminator: a
 *   non-enumerable base field has no cold location, so it never fires.
 */
export function emitHasOwnPresence(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvWasm: ValType | undefined,
  structFieldNames: readonly string[] | null,
  key: string,
  propAccess: ts.PropertyAccessExpression,
  argExpr: ts.Expression,
  foldedAnswer: number,
): boolean {
  if (structFieldNames === null) return false;
  const structTypeIdx = closedStructTypeIdxOf(recvWasm);
  if (structTypeIdx < 0) return false;
  const structName = ctx.typeIdxToStructName.get(structTypeIdx);
  if (structName === undefined) return false;
  const storage = findPresenceStorage(ctx, structName, key);
  if (!storage) return false;
  // A folded 0 is replaced only when it came from LIST-BLINDNESS — the name
  // has storage the base field list cannot see (a cold-tail slot, or a
  // #3927 split family's side-table presence bit, which reports as `"base"`
  // storage for a name ABSENT from the list). A folded 0 for a name the list
  // DOES carry is a semantic zero (propertyIsEnumerable's non-enumerable
  // branch, the defineProperty flag path) and must stand — un-folding it to a
  // presence read would answer 1 for a present-but-non-enumerable property.
  if (foldedAnswer !== 1 && storage.where !== "cold" && structFieldNames.includes(key)) return false;
  return emitClosedStructPresence(ctx, fctx, structTypeIdx, key, () => {
    const recv = compileExpression(ctx, fctx, propAccess.expression);
    if (compileExpression(ctx, fctx, argExpr)) fctx.body.push({ op: "drop" });
    return recv;
  });
}

/**
 * `key in obj` call site. §13.10.1 evaluates the LHS (key) before the RHS
 * (object), so the key is compiled and dropped first.
 */
export function emitInPresence(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvWasm: ValType | undefined,
  key: string,
  keyExpr: ts.Expression,
  recvExpr: ts.Expression,
): boolean {
  return emitClosedStructPresence(ctx, fctx, closedStructTypeIdxOf(recvWasm), key, () => {
    if (compileExpression(ctx, fctx, keyExpr)) fctx.body.push({ op: "drop" });
    return compileExpression(ctx, fctx, recvExpr);
  });
}
