// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FieldDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { presenceWordName } from "./fnctor-presence-bits.js";

export const FNCTOR_CONSTRUCTOR_FIELD = "$constructor";

/**
 * Append compiler-owned fields after every source field. Presence bits remain
 * ahead of the constructor identity so existing source and presence indices
 * stay stable.
 */
export function appendFnctorInternalFields(
  ctx: CodegenContext,
  fields: FieldDef[],
  onlyConditional: ReadonlyMap<string, boolean>,
): void {
  // (#3780) Presence flags are PACKED — one bit per tracked field, not one
  // `i32` slot. See `fnctor-presence-bits.ts` for why: on acorn's `Node` the
  // unpacked form was 252 bytes of every AST node.
  //
  // `JS2WASM_PACKED_PRESENCE_BITS=0` is the paired control: it strides the bit
  // assignment by a full word, so every tracked field lands alone in its own
  // `$presence_<n>` slot and the struct regains the pre-#3780 footprint. Read
  // and write lowering is byte-for-byte the same in both modes, which is the
  // point — the A/B then isolates the LAYOUT from the instruction mix.
  // (#3927) GC-sensitivity probe — OFF unless `JS2WASM_FNCTOR_PAD_SLOTS=<N>`.
  // Appends N never-referenced `externref` slots to every derived fnctor
  // struct, inflating the per-instance footprint by exactly 4·N bytes (V8
  // compressed refs) plus N `ref.null` operands at each `struct.new`. The
  // paired A/B (base vs padded) measures d(wall-clock)/d(slot) on the
  // standalone acorn lane, which bounds the payoff of every proposed
  // union-shrinking slice (per-shape splitting, hot/cold tail) BEFORE its
  // dispatcher-surface risk is paid — the same layout-isolation idiom as
  // `JS2WASM_PACKED_PRESENCE_BITS=0` below. The `__pad` prefix keeps the
  // slots invisible to property lookup, `for…in`/`Object.keys` and host
  // marshalling (`exposedClosedStructFieldName` hides `__`-prefixed fields);
  // they are not presence-tracked, so presence-word count is unchanged and
  // the delta is purely the slots themselves.
  const padSlots = Number(process.env.JS2WASM_FNCTOR_PAD_SLOTS ?? "0");
  if (Number.isInteger(padSlots) && padSlots > 0) {
    for (let i = 0; i < padSlots; i++) {
      fields.push({ name: `__pad${i}`, type: { kind: "externref" }, mutable: true });
    }
  }
  const stride = process.env.JS2WASM_PACKED_PRESENCE_BITS === "0" ? 32 : 1;
  const tracked = fields.filter((candidate) => onlyConditional.get(candidate.name) === true);
  tracked.forEach((field, index) => {
    field.presenceTracked = true;
    field.presenceBit = index * stride;
  });
  const wordCount = tracked.length === 0 ? 0 : (((tracked.length - 1) * stride) >>> 5) + 1;
  for (let word = 0; word < wordCount; word++) {
    fields.push({ name: presenceWordName(word * 32), type: { kind: "i32" }, mutable: true });
  }
  if (ctx.standalone) {
    fields.push({ name: FNCTOR_CONSTRUCTOR_FIELD, type: { kind: "externref" }, mutable: false });
  }
}

/**
 * Map a physical closed-struct field to its JavaScript getter name. Compiler
 * fields stay hidden except for the fnctor constructor back-pointer, which
 * models the inherited, non-enumerable `prototype.constructor` property.
 */
export function exposedClosedStructFieldName(fieldName: string | undefined): string | undefined {
  if (fieldName === FNCTOR_CONSTRUCTOR_FIELD) return "constructor";
  if (!fieldName || fieldName.startsWith("$") || fieldName.startsWith("__")) return undefined;
  return fieldName;
}
