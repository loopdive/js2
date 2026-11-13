// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FieldDef, Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { presenceWordName } from "./fnctor-presence-bits.js";
import { readEnv } from "../env.js";

export const FNCTOR_CONSTRUCTOR_FIELD = "$constructor";

/**
 * (#6951 G3) Construction-time `[[Prototype]]` snapshot slot for standalone
 * fnctor instances. §10.1.14 GetPrototypeFromConstructor reads `F.prototype`
 * once, at `new F()`; a later `F.prototype = …` must not re-link instances
 * that already exist. A null slot (an allocation path that does not snapshot,
 * e.g. a split layout family) means "use the live per-fnctor global", which is
 * the pre-#6951 answer.
 */
export const FNCTOR_PROTO_FIELD = "$__fnctorProto";

/** The snapshot slot definition — mutable so `Object.setPrototypeOf` can re-link. */
export function fnctorProtoField(): FieldDef {
  return { name: FNCTOR_PROTO_FIELD, type: { kind: "externref" }, mutable: true };
}

/**
 * (#6951) Whether `__fnctor_proto_start` (the instance → `[[Prototype]]`
 * ladder) is reserved. It used to require a gate-APPROVED fnctor, but since
 * #6949 every constructed ordinary fnctor has a prototype global, so a module
 * whose `new F()` sites are all keep-static/keep-typed needs the ladder too —
 * without it `new F().inherited` and `Object.getPrototypeOf(new F())` never
 * consult F's prototype at all.
 */
export function fnctorProtoStartNeeded(ctx: CodegenContext): boolean {
  const gate = ctx.fnctorEscapeGate;
  return ctx.standalone && ((gate?.approvedNames.size ?? 0) > 0 || (gate?.ctorDeclByName.size ?? 0) > 0);
}

/**
 * (#6951 G3) Leave a `__fnctor_<F>` instance's `[[Prototype]]` link on the
 * stack: its construction-time snapshot, or — when the slot is null (an
 * allocation path that did not snapshot, e.g. a split layout family) or the
 * struct has no slot — the live per-fnctor global, the pre-#6951 answer.
 * `receiverAsStruct` leaves the receiver as `(ref $__fnctor_<F>)`.
 */
export function fnctorProtoLinkInstrs(
  ctx: CodegenContext,
  fnctorName: string,
  typeIdx: number,
  protoGlobalIdx: number,
  scratchSlot: number,
  receiverAsStruct: Instr[],
): Instr[] {
  const fieldIdx = ctx.structFields.get(`__fnctor_${fnctorName}`)?.findIndex((f) => f.name === FNCTOR_PROTO_FIELD);
  if (fieldIdx === undefined || fieldIdx < 0) return [{ op: "global.get", index: protoGlobalIdx }];
  return [
    ...receiverAsStruct,
    { op: "struct.get", typeIdx, fieldIdx },
    { op: "local.tee", index: scratchSlot },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "global.get", index: protoGlobalIdx }],
      else: [{ op: "local.get", index: scratchSlot }],
    },
  ];
}

/** Canonical compiler-owned constructor identity slot for standalone fnctors. */
export function fnctorConstructorField(): FieldDef {
  return { name: FNCTOR_CONSTRUCTOR_FIELD, type: { kind: "externref" }, mutable: false };
}

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
  const padSlots = Number(readEnv("JS2WASM_FNCTOR_PAD_SLOTS") ?? "0");
  if (Number.isInteger(padSlots) && padSlots > 0) {
    for (let i = 0; i < padSlots; i++) {
      fields.push({ name: `__pad${i}`, type: { kind: "externref" }, mutable: true });
    }
  }
  const stride = readEnv("JS2WASM_PACKED_PRESENCE_BITS") === "0" ? 32 : 1;
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
    fields.push(fnctorConstructorField());
    fields.push(fnctorProtoField());
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
