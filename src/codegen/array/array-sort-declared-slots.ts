// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7167) The declared-slot half of the generic `Array.prototype.sort`
 * write-back, for a receiver that is a closed WasmGC struct.
 *
 * `const o = { length: 3, 0: "c", 2: "a" }` lowers to a closed struct whose
 * index-named properties are physical fields. The sort value body writes the
 * sorted items back with `__extern_set_strict(O, <boxed k>, v)`. The closed-
 * struct write arms on `__extern_set` (`fillClosedStructExternSetArms`, S1)
 * match a STRING key only, so the boxed number skipped the slot and landed in
 * the instance's expando bag: dynamic reads (`p[k]`, which consult the bag
 * first) saw the sorted order, typed field reads (`o[0]`) kept the old one.
 *
 * Fix, without touching the shared runtime: for a receiver whose struct type
 * declares an index-named field `n` that S1 has an arm for, element `n` is
 * ALSO written under its canonical key string first (the literal `"n"`, so no
 * runtime ToString), which reaches the slot through S1. The boxed write that follows is unchanged, so
 * every other surface sees exactly what it saw before:
 *
 *   - a value the slot cannot hold (S1 refuses: `undefined` into a `string`
 *     field) still lands in the bag, as before;
 *   - a key that is not a declared field gets no string write, so an
 *     inherited setter still runs once.
 *
 * The candidate set mirrors S1's own screen (non-synthetic, mutable, not
 * accessor-backed), read at emit time: a struct type registered later simply
 * gets no arm, i.e. today's behaviour. Mode-neutral: where S1 is not built
 * (wasi) the string write reaches the same bag entry the boxed write then
 * overwrites with the same value, and a declared data field has no setter, so
 * the extra write is unobservable. Returns `[]` without native strings or when
 * no struct declares an index-named field, keeping those modules byte-identical.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { isSyntheticStructName } from "../emit-helpers.js";
import { exposedClosedStructFieldName } from "../fnctor-identity-fields.js";

/** A canonical array index name ("0", "17"; not "01", "1.5", "-0"), below 2^31 so an i32 compare holds it. */
function canonicalIndexOf(name: string): number | undefined {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(name)) return undefined;
  const n = Number(name);
  return n <= 0x7fffffff ? n : undefined;
}

/** Struct typeIdx → its index-named S1-writable field indices. */
function declaredIndexSlots(ctx: CodegenContext): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [structName, fields] of ctx.structFields) {
    if (isSyntheticStructName(structName)) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    const slots: number[] = [];
    for (const field of fields) {
      const name = exposedClosedStructFieldName(field?.name);
      if (!field || !name || !field.mutable) continue;
      if (ctx.classAccessorSet.has(`${structName}_${field.name}`)) continue;
      const n = canonicalIndexOf(name);
      if (n !== undefined && !slots.includes(n)) slots.push(n);
    }
    if (slots.length > 0) out.set(typeIdx, slots);
  }
  return out;
}

/**
 * The string-keyed slot write for element `i` (an i32 local) of the sorted
 * list, guarded per declaring struct type. `recv` is the receiver externref
 * local, `value` pushes the element. The key is the index's literal string,
 * known at compile time, built by `keyString` (the caller passes
 * `stringConstantExternrefInstrs`; taking it as a parameter keeps this module
 * out of the native-strings import cycle). `[]` without native strings or
 * when no struct declares an index-named field.
 */
export function sortDeclaredSlotWrite(
  ctx: CodegenContext,
  recv: number,
  i: number,
  value: Instr[],
  strictSetIdx: number,
  keyString: (key: string) => Instr[],
): Instr[] {
  if (!ctx.nativeStrings) return [];
  const out: Instr[] = [];
  for (const [typeIdx, indices] of declaredIndexSlots(ctx)) {
    // `if (i == n0) set "n0" else if (i == n1) …`
    let chain: Instr[] = [];
    for (const n of [...indices].reverse()) {
      const write: Instr[] = [
        { op: "local.get", index: recv },
        ...keyString(String(n)),
        ...value,
        { op: "call", funcIdx: strictSetIdx },
      ];
      chain = [
        { op: "local.get", index: i },
        { op: "i32.const", value: n },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: write, ...(chain.length > 0 ? { else: chain } : {}) },
      ];
    }
    out.push(
      { op: "local.get", index: recv },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      { op: "if", blockType: { kind: "empty" }, then: chain },
    );
  }
  return out;
}
