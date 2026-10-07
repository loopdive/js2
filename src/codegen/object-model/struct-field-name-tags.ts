// (#6872) Same-structure class structs in the `__struct_field_names` ladder.
// Leaf module: depends only on context/IR types.
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

/** One legacy `ref.test typeIdx → CSV` arm of the `__struct_field_names` ladder.
 *  `tag` (class structs only): the `__tag` value an instance of THIS class
 *  carries in field 0, set when the arm must discriminate by it. */
export type FieldNameLegacyEntry = { typeIdx: number; names: string[]; structName: string; tag?: number };

/**
 * Two classes whose fields have the same Wasm types share ONE struct type
 * (`class Renderer { options; parser }` / `class Hooks { options; block }` both
 * lower to `(struct i32 externref externref)`), so `ref.test` alone answered
 * whichever class's names came first in the ladder — and the host, which reads
 * an object's own keys from this list, then reported `block` absent on every
 * `Hooks` instance. Each such class carries its own `__tag` in field 0; when
 * the classes sharing a type disagree on their names, every one of them
 * discriminates by it. A sharer without a tag keeps a plain arm, placed after
 * the tagged ones by the stable sort.
 */
export function tagDisambiguateSharedClassStructs(ctx: CodegenContext, entries: FieldNameLegacyEntry[]): void {
  // Group by STRUCTURE, not index: identical definitions are distinct indices
  // in the type section yet one type after the engine canonicalizes them.
  const structuralKey = (typeIdx: number): string | undefined => {
    const def = ctx.mod.types[typeIdx];
    if (def?.kind !== "struct" || def.superTypeIdx !== undefined) return undefined;
    return JSON.stringify(def.fields.map((field) => [field.type, field.mutable]));
  };
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = structuralKey(entry.typeIdx);
    if (key === undefined) continue;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const reordered = new Map<(typeof entries)[number], typeof entries>();
  for (const group of groups.values()) {
    if (group.length < 2 || new Set(group.map((entry) => entry.names.join(","))).size < 2) continue;
    for (const entry of group) {
      const tag = ctx.classTagMap.get(entry.structName);
      if (tag !== undefined && ctx.structFields.get(entry.structName)?.[0]?.name === "__tag") entry.tag = tag;
    }
    // Tagged arms first: an untagged arm's `ref.test` accepts every sharer.
    reordered.set(group[0]!, [
      ...group.filter((e) => e.tag !== undefined),
      ...group.filter((e) => e.tag === undefined),
    ]);
  }
  if (reordered.size === 0) return;
  const grouped = new Set([...reordered.values()].flat());
  const out: typeof entries = [];
  for (const entry of entries) {
    const group = reordered.get(entry);
    if (group) out.push(...group);
    else if (!grouped.has(entry)) out.push(entry);
  }
  entries.splice(0, entries.length, ...out);
}

/** The i32 condition for one ladder arm: `ref.test`, then (tagged arms) `__tag == tag`. */
export function fieldNameArmTest(anyLocal: number, typeIdx: number, tag: number | undefined): Instr[] {
  const matches: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx },
  ];
  if (tag === undefined) return matches;
  matches.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx },
      { op: "struct.get", typeIdx, fieldIdx: 0 },
      { op: "i32.const", value: tag },
      { op: "i32.eq" },
    ],
    else: [{ op: "i32.const", value: 0 }],
  });
  return matches;
}
