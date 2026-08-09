// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FieldDef, Instr } from "../ir/types.js";

/**
 * (#3780) Packed own-property presence flags for conditionally-assigned fnctor
 * fields.
 *
 * #2847 gave every conditionally-assigned property a hidden `$has_<name>` slot
 * so an untouched default is distinguishable from an explicit `null`/`0`. One
 * whole `i32` per tracked property is correct but expensive in the only place
 * that matters — object size. Acorn's `Node` has 63 tracked properties, so the
 * flags alone were 252 bytes of a ~536-byte AST node, and the standalone
 * self-parse allocates ~32.5k of them.
 *
 * The flags now live in `$presence_<w>` words appended after the source fields:
 * tracked field `i` occupies bit `i & 31` of word `i >>> 5`. 63 flags collapse
 * from 63 slots to 2.
 *
 * Presence is a per-instance bit, never a value, so nothing outside this module
 * needs the physical layout — call sites ask for a {@link PresenceSlot} and emit
 * through {@link presenceTestInstrs} / {@link presenceSetInstrs}.
 */
export interface PresenceSlot {
  /** Physical field index of the `$presence_<w>` word holding the bit. */
  readonly wordFieldIdx: number;
  /** Single-bit mask selecting this field inside that word. */
  readonly mask: number;
}

/** Name of the packed presence word holding bit `bit`. */
export function presenceWordName(bit: number): string {
  return `$presence_${bit >>> 5}`;
}

/**
 * Resolve `fieldName`'s presence slot, or `undefined` when the field is not
 * presence-tracked (always-present fields need no check at all).
 */
export function presenceSlotOf(
  fields: readonly (FieldDef | undefined)[] | undefined,
  fieldName: string,
): PresenceSlot | undefined {
  if (!fields) return undefined;
  const field = fields.find((candidate) => candidate?.name === fieldName);
  if (!field?.presenceTracked || field.presenceBit === undefined) return undefined;
  const wordFieldIdx = fields.findIndex((candidate) => candidate?.name === presenceWordName(field.presenceBit!));
  if (wordFieldIdx < 0) return undefined;
  // `1 << 31` is negative in JS; wasm `i32.const` is signed LEB128, so the
  // negative literal encodes the same 32-bit pattern the mask needs.
  return { wordFieldIdx, mask: (1 << (field.presenceBit & 31)) | 0 };
}

/**
 * Consume a struct reference on the stack, push `1` when the field is present
 * and `0` otherwise.
 *
 * Normalized rather than left as the raw masked word because several consumers
 * hand the result straight to a `return` whose value reaches the host as a
 * boolean (`__shas_<name>`), where a mask like `4096` would read as a bare
 * number. Inside a branch the extra `i32.ne` folds away.
 */
export function presenceTestInstrs(structTypeIdx: number, slot: PresenceSlot): Instr[] {
  return [
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: slot.wordFieldIdx },
    { op: "i32.const", value: slot.mask },
    { op: "i32.and" },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
  ];
}

/**
 * Mark the field present. `pushReceiver` must emit the receiver as a
 * `(ref $struct)` and is used TWICE: setting one bit is a read-modify-write of
 * a shared word, so unlike the old one-slot-per-field `struct.set` the
 * reference cannot simply be consumed off the stack. Callers pass a repeatable
 * producer (a `local.get`, or a `local.get` + `ref.cast`), never a
 * side-effecting expression.
 */
export function presenceSetInstrs(
  structTypeIdx: number,
  slot: PresenceSlot,
  pushReceiver: readonly Instr[] | number,
): Instr[] {
  const recv: readonly Instr[] =
    typeof pushReceiver === "number" ? [{ op: "local.get", index: pushReceiver }] : pushReceiver;
  return [
    ...recv,
    ...recv,
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: slot.wordFieldIdx },
    { op: "i32.const", value: slot.mask },
    { op: "i32.or" },
    { op: "struct.set", typeIdx: structTypeIdx, fieldIdx: slot.wordFieldIdx },
  ];
}
