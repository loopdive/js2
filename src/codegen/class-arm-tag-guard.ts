// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#4618 / #6608) The nominal `__tag` guard that makes a per-class dispatch arm
 * fire only for its OWN class.
 *
 * `ref.test $C` is a STRUCTURAL test. WasmGC canonicalizes struct types by
 * shape, so two unrelated classes with the same field layout — and field NAMES
 * do not exist in wasm, so `class A { x }` and `class B { y }` have the same
 * layout, as does every pair of state-in-a-WeakMap classes, which have no
 * fields at all beyond the compiler's own `__tag` — are literally the same
 * runtime type. Every arm in a per-name ladder then matches every instance and
 * the OUTERMOST arm wins, so a method call by name on a statically-unknown
 * receiver runs the LAST-declared class's body (measured: three classes each
 * declaring `toJSON`, `a.toJSON()` on an `A` ran `E`'s and threw that class's
 * brand error).
 *
 * `__tag` is the compiler's per-class discriminator (field 0 of every class
 * struct, `ctx.classTagMap`), so testing it turns the structural arm into a
 * nominal one. Own tag PLUS every descendant's tag: a parent's arm must keep
 * matching subclass instances so an inherited method still dispatches, and a
 * more-derived arm sits further out when the subclass overrides.
 *
 * Returns `undefined` — so the caller emits its pre-existing bare `ref.test`
 * and the module's bytes do not move — when the guard cannot or need not
 * apply: a struct with no `__tag` (object literals, synthetic carriers), a
 * class with no registered tag, or a layout no other emitted struct shares.
 * The last is what keeps single-declarer programs byte-identical: a ladder
 * whose classes all have distinct shapes needs no test beyond `ref.test`.
 */

import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * The i32 condition `receiver.__tag ∈ {own} ∪ {descendants}`, or `undefined`
 * when no guard is needed (see the module comment).
 *
 * `receiverLocal` must hold the receiver as an `anyref` — the condition casts
 * it to `typeIdx`, so it is only valid inside the arm's own `ref.test` `then`.
 */
export function classArmTagCondition(
  ctx: CodegenContext,
  structName: string,
  typeIdx: number,
  receiverLocal: number,
): Instr[] | undefined {
  const fields = ctx.structFields.get(structName);
  if (!fields || fields.length === 0 || fields[0]!.name !== "__tag") return undefined;
  const layoutSig = (n: string): string | undefined => {
    const fs = ctx.structFields.get(n);
    return fs?.map((f) => `${f.type.kind}:${(f.type as { typeIdx?: number }).typeIdx ?? ""}`).join(",");
  };
  const own = layoutSig(structName);
  if (own === undefined) return undefined;
  // Compare against every emitted struct, not only the ones that also declare
  // this member. A same-layout sibling that does NOT declare the key is the
  // important negative case: without a tag guard its instance passes this
  // arm's structural `ref.test` and appears to inherit an unrelated
  // sibling-only method (React's repeated `class Foo` tests observed
  // UNSAFE_componentWillMount from a later sibling).
  if (![...ctx.structFields.keys()].some((name) => name !== structName && layoutSig(name) === own)) return undefined;
  const ownTag = ctx.classTagMap.get(structName);
  if (ownTag === undefined) return undefined;
  const tags = [ownTag];
  const isDescendantOf = (n: string): boolean => {
    let cur: string | undefined = ctx.classParentMap.get(n);
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === structName) return true;
      seen.add(cur);
      cur = ctx.classParentMap.get(cur);
    }
    return false;
  };
  for (const [childName, tag] of ctx.classTagMap) {
    if (childName !== structName && isDescendantOf(childName) && !tags.includes(tag)) tags.push(tag);
  }
  const readTag: Instr[] = [
    { op: "local.get", index: receiverLocal },
    { op: "ref.cast", typeIdx },
    { op: "struct.get", typeIdx, fieldIdx: 0 },
  ];
  const cond: Instr[] = [...readTag, { op: "i32.const", value: tags[0]! }, { op: "i32.eq" }];
  for (const t of tags.slice(1)) {
    cond.push(...readTag, { op: "i32.const", value: t }, { op: "i32.eq" }, { op: "i32.or" });
  }
  return cond;
}

/**
 * Wrap an arm's bare `ref.test` claim in the nominal guard: the emitted i32 is
 * `ref.test $C && receiver.__tag ∈ tags`. With no guard needed this is exactly
 * the caller's previous two instructions, so the bytes do not move.
 */
export function classArmClaimInstrs(
  ctx: CodegenContext,
  structName: string,
  typeIdx: number,
  receiverLocal: number,
): Instr[] {
  const tagCond = classArmTagCondition(ctx, structName, typeIdx, receiverLocal);
  return [
    { op: "local.get", index: receiverLocal },
    { op: "ref.test", typeIdx },
    ...(tagCond === undefined
      ? []
      : ([
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: tagCond,
            else: [{ op: "i32.const", value: 0 }],
          },
        ] satisfies Instr[])),
  ];
}

/**
 * (#7158) The `__tag` values a closed-struct ENUMERATION arm for `structName`
 * must accept, or `undefined` when its bare `ref.test` is already exact.
 *
 * Enumeration arms (`__object_keys`, for…in, `getOwnPropertyNames`, and the
 * JSON/assign/spread consumers built on them) answer a NAME LIST, so an arm may
 * only fire for instances whose own layout it describes. `ref.test` alone is
 * too wide twice over: a same-layout twin (`class A { a = 1 }` /
 * `class B { b = 1 }`, or a private-only `class C { #x = 1 }` beside
 * `class D { y = 2 }`) is the same canonical type, and a subclass struct is a
 * subtype, so `ref.test $Base` also accepts an instance that has its own,
 * longer arm. The accepted set is every class whose NEAREST arm-owning
 * ancestor-or-self is `structName` — a subclass without its own arm still
 * reads its parent's names, exactly as the structural test answered before.
 *
 * `armStructNames` is the set of struct names that own an arm. Untagged
 * structs, unregistered classes, and arms with neither a layout twin nor an
 * arm-owning descendant get `undefined`, so their bytes do not move.
 */
function enumerationArmTags(
  ctx: CodegenContext,
  structName: string,
  armStructNames: ReadonlySet<string>,
): number[] | undefined {
  const fields = ctx.structFields.get(structName);
  if (!fields || fields[0]?.name !== "__tag" || ctx.classTagMap.get(structName) === undefined) return undefined;
  const layoutSig = (n: string): string | undefined =>
    ctx.structFields
      .get(n)
      ?.map((f) => `${f.type.kind}:${(f.type as { typeIdx?: number }).typeIdx ?? ""}`)
      .join(",");
  const own = layoutSig(structName);
  const nearestArm = (cls: string): string | undefined => {
    const seen = new Set<string>();
    let cur: string | undefined = cls;
    while (cur !== undefined && !armStructNames.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = ctx.classParentMap.get(cur);
    }
    return cur !== undefined && armStructNames.has(cur) ? cur : undefined;
  };
  const twin = [...ctx.structFields.keys()].some((n) => n !== structName && layoutSig(n) === own);
  const armDescendant = [...armStructNames].some(
    (n) => n !== structName && nearestArm(ctx.classParentMap.get(n) ?? "") === structName,
  );
  if (!twin && !armDescendant) return undefined;
  const tags: number[] = [];
  for (const [cls, tag] of ctx.classTagMap) if (nearestArm(cls) === structName && !tags.includes(tag)) tags.push(tag);
  return tags;
}

/**
 * (#7158) Set `classTags` on every enumeration entry that needs the nominal
 * guard (`structName` names each entry's class struct).
 */
export function assignEnumerationArmTags(
  ctx: CodegenContext,
  entries: { structName?: string; classTags?: number[] }[],
): void {
  const armStructNames = new Set(entries.map((entry) => entry.structName!));
  for (const entry of entries) {
    const classTags = enumerationArmTags(ctx, entry.structName!, armStructNames);
    if (classTags) entry.classTags = classTags;
  }
}

/**
 * (#7158) Appended after an enumeration arm's `ref.test` on the externref
 * receiver in local 0: the i32 becomes `ref.test ∧ __tag ∈ classTags`. Empty
 * (bytes unchanged) when the arm needs no guard.
 */
export function enumerationArmTagGuard(typeIdx: number, classTags: number[] | undefined): Instr[] {
  if (classTags === undefined) return [];
  const cond: Instr[] = [];
  for (const [i, tag] of classTags.entries()) {
    cond.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx },
      { op: "struct.get", typeIdx, fieldIdx: 0 },
      { op: "i32.const", value: tag },
      { op: "i32.eq" },
      ...(i > 0 ? [{ op: "i32.or" } as Instr] : []),
    );
  }
  if (cond.length === 0) cond.push({ op: "i32.const", value: 0 });
  return [
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: cond, else: [{ op: "i32.const", value: 0 }] },
  ];
}
