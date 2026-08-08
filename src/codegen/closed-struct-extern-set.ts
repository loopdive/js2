// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4194) Closed-struct arms for the standalone dynamic WRITE helper —
 * `__extern_set` — the missing twin of `fillClosedStructExternGetArms`.
 *
 * ## The gap this closes
 * A computed write through a dynamic key — `node[key] = v` — lowers to
 * `__extern_set(_strict)`. The strict wrapper delegates every non-`$Object`
 * receiver to `__extern_set`, whose non-`$Object` arm knows vecs and closures
 * and otherwise SILENTLY DROPS the write. A closed compiler struct (fnctor or
 * class instance) is exactly that receiver, so before this fill:
 *
 *   - `n[k] = v` was a no-op even for a name with a physical slot
 *     (measured on the #4194 fixture: `n["type"] = "T2"` reads back unchanged
 *     in standalone; native and js-host both apply it);
 *   - acorn's `copyNode` (`for (p in node) newNode[p] = node[p]`) copied
 *     nothing even after #4219/#4229 made the enumeration half real — which is
 *     the measured zero-effect that blocks flipping the #3927 per-type-layout
 *     emission default-ON.
 *
 * ## Shape
 * Mirrors the GET fill's structure — key flattened once, per-name probes,
 * per-receiver `ref.test` arms with the same `$shape` collision guards, cold
 * arms through `$cold` (`coldFieldWriteArm`, tail lazily allocated by
 * `__cold_ensure_*`) — but as a plain linear probe ladder, not the #3926
 * hash-bucket `br_table`: dynamic writes are orders of magnitude colder than
 * reads (acorn today: ~0 per parse), so the ladder is not worth a table.
 *
 * A successful arm ends in `return`; a key that matches no arm falls through
 * to the pre-existing body (vec/closure arms, `$Object` path) unchanged, so a
 * name with NO physical storage anywhere — a true expando on a closed struct —
 * still drops exactly as before. That residual is #4010/#4098 substrate
 * territory, not this fill's.
 *
 * ## Value coercion is deliberately funcMap-READ-ONLY
 * This fill runs at finalize, after bodies bake their indices — registering an
 * import here is the #2043 index-shift class. So instead of the general
 * `coercionInstrs` (which may `ensureLateImport`), {@link writeCoerceInstrs}
 * emits only pure instruction sequences or `funcMap`-resolved calls, and a
 * field whose coercion helper is absent is SKIPPED (that field stays exactly
 * as writable as it was yesterday: not at all). Every flow-grown field — the
 * whole copyNode surface — is `externref` and coerces as a no-op.
 *
 * ## Tombstones (`delete n.x` then `n[k] = v`)
 * A write to a previously-deleted key must revive it. The tombstone marker is
 * bag-identity (`bag[key] === bag`, instance-tombstones.ts), so the arm clears
 * it by storing a null extern over the marker — via `__closure_bag_lookup`,
 * never ensure (a write to a bagless instance must not allocate a bag for a
 * key that lives in a struct slot). Fnctor instances never tombstone
 * (`__is_class_instance_carrier` screens them), and the lookup answers null
 * there, so the clear is a cheap no-op outside class instances.
 */
import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { isSyntheticStructName } from "./emit-helpers.js";
import { coldFieldWriteArm, coldTailAllocatorName, findColdStructsForField } from "./fnctor-cold-tail.js";
import { exposedClosedStructFieldName } from "./fnctor-identity-fields.js";
import { type PresenceSlot, presenceSetInstrs, presenceSlotOf } from "./fnctor-presence-bits.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";

/**
 * Coerce the boxed externref value (in `valLocal`) to `fieldType`, pure or
 * funcMap-read-only. `null` = no safe coercion available → the caller skips
 * the field (it keeps today's behaviour: unwritable through this path).
 * Ref-typed fields return instructions that ASSUME the caller emitted the
 * {@link refBrandTestInstrs} guard.
 */
function writeCoerceInstrs(ctx: CodegenContext, fieldType: ValType, valLocal: number): Instr[] | null {
  switch (fieldType.kind) {
    case "externref":
    case "ref_extern":
      return [{ op: "local.get", index: valLocal }];
    case "ref":
    case "ref_null":
      return [
        { op: "local.get", index: valLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: fieldType.typeIdx },
      ];
    case "f64": {
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx === undefined) return null;
      return [
        { op: "local.get", index: valLocal },
        { op: "call", funcIdx: unboxIdx },
      ];
    }
    case "i32": {
      if (fieldType.boolean === true) {
        const unboxBoolIdx = ctx.funcMap.get("__unbox_boolean");
        if (unboxBoolIdx === undefined) return null;
        return [
          { op: "local.get", index: valLocal },
          { op: "call", funcIdx: unboxBoolIdx },
        ];
      }
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx === undefined) return null;
      return [{ op: "local.get", index: valLocal }, { op: "call", funcIdx: unboxIdx }, { op: "i32.trunc_sat_f64_s" }];
    }
    default:
      return null;
  }
}

/** Runtime brand guard for a ref-typed slot: 1 iff the value can be stored. */
function refBrandTestInstrs(fieldType: ValType, valLocal: number): Instr[] | null {
  if (fieldType.kind !== "ref" && fieldType.kind !== "ref_null") return null;
  const test: Instr[] = [
    { op: "local.get", index: valLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: fieldType.typeIdx },
  ];
  if (fieldType.kind === "ref_null") {
    test.push({ op: "local.get", index: valLocal }, { op: "ref.is_null" }, { op: "i32.or" });
  }
  return test;
}

interface SetEntry {
  typeIdx: number;
  fieldIdx: number;
  fieldType: ValType;
  presenceSlot?: PresenceSlot;
  shapeFieldIdx?: number;
  shapeId?: number;
}

/**
 * Clear a tombstone marker for (param0 obj, param1 key), lookup-only. Empty
 * when the bag machinery is absent (host mode / no classes reserved).
 */
function untombstoneInstrs(ctx: CodegenContext, externSetIdx: number | undefined, scratchLocal: number): Instr[] {
  const lookupIdx = ctx.funcMap.get("__closure_bag_lookup");
  if (lookupIdx === undefined || externSetIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: lookupIdx },
    { op: "local.tee", index: scratchLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: scratchLocal },
        { op: "local.get", index: 1 },
        { op: "ref.null.extern" },
        { op: "call", funcIdx: externSetIdx },
      ],
    },
  ];
}

/**
 * Finalize `__extern_set` with closed-struct write arms. Standalone only;
 * funcMap-read-only (cold allocators were minted by
 * `reserveColdTailAllocators`, the unbox helpers resolve or the field is
 * skipped). No-op when no closed struct declares a writable exposed field.
 */
export function fillClosedStructExternSetArms(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.anyStrTypeIdx < 0) return;
  const fn: WasmFunction | undefined = ctx.mod.functions.find((candidate) => candidate.name === "__extern_set");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (!fn || flattenIdx === undefined || equalsIdx === undefined) return;
  const externSetIdx = ctx.funcMap.get("__extern_set");

  const byField = new Map<string, SetEntry[]>();
  const coldByField = new Map<string, ReturnType<typeof findColdStructsForField>>();
  for (const [structName, fields] of ctx.structFields) {
    if (isSyntheticStructName(structName)) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    const shapeFieldIdx = fields.findIndex((field: FieldDef | undefined) => field?.name === "$shape");
    const shapeId = ctx.shapeIdByStructName.get(structName);
    for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
      const field = fields[fieldIdx];
      const exposedName = exposedClosedStructFieldName(field?.name);
      if (!field || !exposedName || !field.mutable) continue;
      // Accessor-backed names keep the accessor path (the $Object/dispatch
      // arms know it; a raw slot store would bypass the setter).
      if (ctx.classAccessorSet.has(`${structName}_${field.name}`)) continue;
      const presenceSlot = presenceSlotOf(fields, field.name);
      let entries = byField.get(exposedName);
      if (!entries) {
        entries = [];
        byField.set(exposedName, entries);
      }
      entries.push({
        typeIdx,
        fieldIdx,
        fieldType: field.type,
        ...(presenceSlot ? { presenceSlot } : {}),
        ...(shapeFieldIdx >= 0 && shapeId !== undefined ? { shapeFieldIdx, shapeId } : {}),
      });
    }
  }
  // (#3927) Cold-tail write arms — the split moved these names off the main
  // struct, so the walk above cannot see them. Keyed per name; each arm
  // lazily allocates the tail via `__cold_ensure_*` exactly like the
  // member-set dispatcher's cold arms.
  for (const [mainStructName] of ctx.fnctorColdTailStructName ?? []) {
    const coldStructName = ctx.fnctorColdTailStructName?.get(mainStructName);
    const coldFields = coldStructName === undefined ? undefined : ctx.structFields.get(coldStructName);
    for (const field of coldFields ?? []) {
      if (!field?.name || field.name.startsWith("$") || field.name.startsWith("__") || !field.mutable) continue;
      if (coldByField.has(field.name)) continue;
      const locs = findColdStructsForField(ctx, field.name).filter((loc) => loc.mutable);
      if (locs.length > 0) coldByField.set(field.name, locs);
    }
  }
  if (byField.size === 0 && coldByField.size === 0) return;

  // Appended scratch locals (existing locals/indices untouched).
  const paramCount = 3; // obj, key, value
  const localBase = paramCount + fn.locals.length;
  const RECV_ANY = localBase; // anyref — receiver for the cold arms
  const COLD_ANY = localBase + 1; // anyref — cold-tail scratch
  const FKEY = localBase + 2; // flattened key ($NativeString as anyref-compatible ref)
  const BAG = localBase + 3; // externref — tombstone-clear scratch
  fn.locals.push(
    { name: "__xs_recv", type: { kind: "anyref" } },
    { name: "__xs_cold", type: { kind: "anyref" } },
    { name: "__xs_fkey", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
    { name: "__xs_bag", type: { kind: "externref" } },
  );

  const buildReceiverArms = (fieldName: string): Instr[] => {
    const arms: Instr[] = [];
    for (const entry of byField.get(fieldName) ?? []) {
      const coerce = writeCoerceInstrs(ctx, entry.fieldType, 2);
      if (coerce === null) continue; // no safe coercion → field keeps today's (unwritable) behaviour
      const store: Instr[] = [
        { op: "local.get", index: RECV_ANY },
        { op: "ref.cast", typeIdx: entry.typeIdx },
        ...coerce,
        { op: "struct.set", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx },
      ];
      if (entry.presenceSlot !== undefined) {
        store.push(
          ...presenceSetInstrs(entry.typeIdx, entry.presenceSlot, [
            { op: "local.get", index: RECV_ANY },
            { op: "ref.cast", typeIdx: entry.typeIdx },
          ]),
        );
      }
      store.push(...untombstoneInstrs(ctx, externSetIdx, BAG));
      store.push({ op: "return" });
      // A ref-typed slot only stores a brand-matching value; a mismatched
      // value falls through (ends in the pre-existing silent-drop, exactly
      // today's behaviour for it — representation-polymorphic JS fields are
      // the member-set dispatcher's fallback case too).
      const brandTest = refBrandTestInstrs(entry.fieldType, 2);
      const guardedStore: Instr[] =
        brandTest === null ? store : [...brandTest, { op: "if", blockType: { kind: "empty" }, then: store }];
      const exactThen: Instr[] =
        entry.shapeFieldIdx === undefined || entry.shapeId === undefined
          ? guardedStore
          : [
              // WasmGC canonicalizes same-shaped structs; the `$shape` stamp
              // says which LOGICAL shape this instance is (see the GET fill).
              { op: "local.get", index: RECV_ANY },
              { op: "ref.cast", typeIdx: entry.typeIdx },
              { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.shapeFieldIdx },
              { op: "i32.const", value: entry.shapeId },
              { op: "i32.eq" },
              { op: "if", blockType: { kind: "empty" }, then: guardedStore },
            ];
      arms.push(
        { op: "local.get", index: RECV_ANY },
        { op: "ref.test", typeIdx: entry.typeIdx },
        { op: "if", blockType: { kind: "empty" }, then: exactThen },
      );
    }
    for (const loc of coldByField.get(fieldName) ?? []) {
      const mainStructName = ctx.typeIdxToStructName.get(loc.mainStructTypeIdx);
      const ensureIdx =
        mainStructName === undefined ? undefined : ctx.funcMap.get(coldTailAllocatorName(mainStructName));
      if (ensureIdx === undefined) continue;
      arms.push(
        { op: "local.get", index: RECV_ANY },
        { op: "ref.test", typeIdx: loc.mainStructTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...coldFieldWriteArm(loc, RECV_ANY, 2, COLD_ANY, ensureIdx, []),
            ...untombstoneInstrs(ctx, externSetIdx, BAG),
            { op: "return" },
          ],
        },
      );
    }
    return arms;
  };

  const keyArms: Instr[] = [];
  const names = new Set<string>([...byField.keys(), ...coldByField.keys()]);
  for (const fieldName of names) {
    const receiverArms = buildReceiverArms(fieldName);
    if (receiverArms.length === 0) continue;
    keyArms.push(
      { op: "local.get", index: FKEY },
      { op: "ref.as_non_null" },
      ...nativeStringLiteralInstrs(ctx, fieldName),
      { op: "call", funcIdx: equalsIdx },
      { op: "if", blockType: { kind: "empty" }, then: receiverArms },
    );
  }
  if (keyArms.length === 0) return;

  // Prepended block: only for a NON-$Object receiver that IS a closed struct
  // candidate, and only for a native-string key — everything else falls
  // through to the pre-existing body untouched (byte-path-identical for
  // $Object / vec / closure / host receivers).
  const objTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  const receiverIsCandidate: Instr[] =
    objTypeIdx !== undefined
      ? [{ op: "local.get", index: RECV_ANY }, { op: "ref.test", typeIdx: objTypeIdx }, { op: "i32.eqz" }]
      : [{ op: "i32.const", value: 1 }];
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: RECV_ANY },
    ...receiverIsCandidate,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "call", funcIdx: flattenIdx },
            { op: "local.set", index: FKEY },
            ...keyArms,
          ],
        },
      ],
    },
  );
}
