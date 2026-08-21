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
 *     nothing even after #4219/#4243 made the enumeration half real — which is
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
 * ## Value coercion goes through the SINGLE engine, and that is safe here
 * Values coerce via `coercionInstrs` (#1917/#2108 — the coercion-sites gate
 * exists precisely so nobody hand-rolls a second unbox matrix). The usual
 * finalize-time worry — the engine registering a late import and shifting
 * baked indices, the #2043 class — does not apply to THIS fill: it is
 * standalone-only, where the engine's helpers are union NATIVES minted as
 * append-only defined funcs (no import-index shift), and vec-typed fields
 * resolve materializers `reserveVecFieldMaterializers` reserved before every
 * value-coercion fill. Every flow-grown field — the whole copyNode surface —
 * is `externref` and coerces as a no-op anyway.
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
import { inheritedSetAnyDirty } from "./inherited-set-gate.js"; // (#4602) per-key #4504 gate
import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { isSyntheticStructName } from "./emit-helpers.js";
import { coldFieldWriteArm, coldTailAllocatorName, findColdStructsForField } from "./fnctor-cold-tail.js";
import {
  findFnctorLayoutStructsForField,
  findFnctorResidStructsForField,
  layoutFieldWriteInstrs,
  layoutMatchTestInstrs,
  residEnsureAllocatorName,
  residFieldWriteInstrs,
  residMatchTestInstrs,
} from "./fnctor-layout-emit.js"; // (#3927) per-type layouts — write side of the computed path
import { exposedClosedStructFieldName } from "./fnctor-identity-fields.js";
import { INSTANCE_FIELD_RESURRECT } from "./instance-props.js";
import { INSTANCE_FIELD_DELETED } from "./instance-tombstones.js";
import { type PresenceSlot, presenceSetInstrs, presenceSlotOf, presenceTestInstrs } from "./fnctor-presence-bits.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import {
  SET_DECISION_ALLOW_OWN,
  SET_DECISION_HANDLED,
  SET_DECISION_MISS,
  SET_DECISION_REFUSED,
} from "./proto-index-store.js";
import { coercionInstrs } from "./type-coercion.js";

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
function untombstoneInstrs(
  ctx: CodegenContext,
  resurrectIdx: number | undefined,
  externSetIdx: number | undefined,
  scratchLocal: number,
): Instr[] {
  if (resurrectIdx !== undefined) {
    return [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      // This helper probes the existing bag entry and deletes only the
      // self-referential tombstone marker.  In particular it never re-enters
      // __extern_set, whose inherited descriptor walk would be the wrong
      // operation after a physical field already won this write.
      { op: "call", funcIdx: resurrectIdx },
    ];
  }
  // Preserve the pre-#4504 arm byte-for-byte in flag-clear modules.  There is
  // no inherited descriptor walk there, so recursively clearing the marker
  // through the bag remains the established behaviour.
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
  // Keep the pre-#4504 inline tombstone-clear path byte-identical in flag-clear
  // modules. The direct helper is selected only while inherited [[Set]] is
  // active, because only then would recursive __extern_set re-enter the new
  // descriptor decision.
  const resurrectIdx =
    ctx.standalone && inheritedSetAnyDirty(ctx) ? ctx.funcMap.get(INSTANCE_FIELD_RESURRECT) : undefined;
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const setResultGlobalIdx = ctx.externSetResultGlobalIdx;
  const setDecideIdx = ctx.funcMap.get("__extern_set_decide");
  const setOwnIdx = ctx.funcMap.get("__extern_set_own");
  const bagLookupIdx = ctx.funcMap.get("__closure_bag_lookup");
  const deletedIdx = ctx.funcMap.get(INSTANCE_FIELD_DELETED);
  const objectTypes = ctx.objectRuntimeTypes;
  const objFindIdx = ctx.funcMap.get("__obj_find");

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
  // (#3927 per-type layouts) The flow-grown union names of every split
  // family — their storage is a layout slot or the resid carrier, both
  // invisible to the struct walk above (layouts/resid are synthetic-hidden).
  const layoutNames = new Set<string>();
  for (const info of ctx.fnctorLayoutInfo?.values() ?? []) {
    for (const name of info.residFieldNames) layoutNames.add(name);
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
  if (byField.size === 0 && coldByField.size === 0 && layoutNames.size === 0) return;

  // A presence-tracked field represents a flow-grown property: its storage
  // exists in the struct shape, but it is not an own property until the bit is
  // set.  When #4504's descriptor authority is active, a first write must ask
  // it before materializing that storage.  The helper dependencies are all
  // reserved before this FINALIZE pass; keeping this a read-only lookup avoids
  // index churn here.
  const presenceDecisionAvailable =
    ctx.standalone &&
    inheritedSetAnyDirty(ctx) &&
    setResultGlobalIdx !== undefined &&
    setDecideIdx !== undefined &&
    setOwnIdx !== undefined &&
    bagLookupIdx !== undefined &&
    objectTypes !== undefined &&
    objFindIdx !== undefined;

  // Appended scratch locals (existing locals/indices untouched).
  const paramCount = 3; // obj, key, value
  const localBase = paramCount + fn.locals.length;
  const RECV_ANY = localBase; // anyref — receiver for the cold arms
  const COLD_ANY = localBase + 1; // anyref — cold-tail scratch
  const FKEY = localBase + 2; // flattened key ($NativeString as anyref-compatible ref)
  const BAG = localBase + 3; // existing carrier bag; lookup-only
  const DECISION = localBase + 4; // shared four-state [[Set]] decision
  const BAG_ENTRY = localBase + 5; // existing own entry in BAG, if any
  fn.locals.push(
    { name: "__xs_recv", type: { kind: "anyref" } },
    { name: "__xs_cold", type: { kind: "anyref" } },
    { name: "__xs_fkey", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
    // Historical tombstone-clear scratch.  In #4504 modules the same local is
    // the lookup-only carrier bag passed to the shared decision.
    { name: "__xs_bag", type: { kind: "externref" } },
  );
  if (presenceDecisionAvailable) {
    fn.locals.push(
      { name: "__xs_decision", type: { kind: "i32" } },
      { name: "__xs_bag_entry", type: { kind: "ref_null", typeIdx: objectTypes!.propEntryTypeIdx } },
    );
  }

  // #4504 publishes every physical-field success before returning from this
  // finalize-prepended path.  Otherwise Reflect.set sees its reset sentinel
  // after a real mutation, and strict assignment can drift from the same
  // completed [[Set]] outcome.
  const successAndReturn = (): Instr[] => [
    ...(setResultGlobalIdx === undefined
      ? []
      : ([
          { op: "i32.const", value: 1 },
          { op: "global.set", index: setResultGlobalIdx },
        ] satisfies Instr[])),
    { op: "return" },
  ];
  const refusalAndReturn = (): Instr[] => [
    ...(setResultGlobalIdx === undefined
      ? []
      : ([
          { op: "i32.const", value: 2 },
          { op: "global.set", index: setResultGlobalIdx },
        ] satisfies Instr[])),
    { op: "return" },
  ];

  const buildReceiverArms = (fieldName: string): Instr[] => {
    const arms: Instr[] = [];
    for (const entry of byField.get(fieldName) ?? []) {
      // The SINGLE coercion engine (#1917/#2108 — never hand-roll a fresh
      // box/unbox matrix). Safe at this fill despite the finalize timing:
      // the fill is standalone-only, where the engine's helpers are UNION
      // NATIVES minted as APPEND-ONLY defined funcs (no import-index shift —
      // the #2043 class needs a late IMPORT), and vec-typed fields resolve
      // materializers reserved by `reserveVecFieldMaterializers`, which runs
      // before every value-coercion fill.
      const buildStore = (): Instr[] => {
        const store: Instr[] = [
          { op: "local.get", index: RECV_ANY },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "local.get", index: 2 }, // value (externref)
          ...coercionInstrs(ctx, { kind: "externref" }, entry.fieldType),
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
        store.push(...untombstoneInstrs(ctx, resurrectIdx, externSetIdx, BAG));
        store.push(...successAndReturn());
        return store;
      };
      // A ref-typed slot only stores a brand-matching value; a mismatched
      // value falls through (ends in the pre-existing silent-drop, exactly
      // today's behaviour for it — representation-polymorphic JS fields are
      // the member-set dispatcher's fallback case too).
      const buildGuardedStore = (): Instr[] => {
        const brandTest = refBrandTestInstrs(entry.fieldType, 2);
        return brandTest === null
          ? buildStore()
          : [...brandTest, { op: "if", blockType: { kind: "empty" }, then: buildStore() }];
      };
      /**
       * Resolve a physically absent field. `ignoreBagOwn` is used only after
       * a class-field tombstone: the marker is a live bag entry, but logically
       * the own field is absent, so it must not mask an inherited setter or
       * non-writable descriptor. A later MISS/ALLOW store clears that marker.
       */
      const buildAbsentPhysicalStore = (ignoreBagOwn: boolean): Instr[] => [
        { op: "local.get", index: 0 },
        ...(ignoreBagOwn
          ? ([{ op: "ref.null.extern" }] satisfies Instr[])
          : ([{ op: "local.get", index: BAG }] satisfies Instr[])),
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: setDecideIdx! },
        { op: "local.tee", index: DECISION },
        { op: "i32.const", value: SET_DECISION_HANDLED },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: successAndReturn() },
        { op: "local.get", index: DECISION },
        { op: "i32.const", value: SET_DECISION_REFUSED },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: refusalAndReturn() },
        // A real own bag data property still wins on ALLOW. A tombstone is
        // deliberately excluded: it is not a descriptor and must never be
        // overwritten before the inherited decision is made.
        ...(!ignoreBagOwn
          ? ([
              { op: "local.get", index: DECISION },
              { op: "i32.const", value: SET_DECISION_ALLOW_OWN },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: BAG },
                  { op: "any.convert_extern" },
                  { op: "ref.test", typeIdx: objectTypes!.objectTypeIdx },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: BAG },
                      { op: "any.convert_extern" },
                      { op: "ref.cast", typeIdx: objectTypes!.objectTypeIdx },
                      { op: "local.get", index: 1 },
                      { op: "call", funcIdx: objFindIdx! },
                      { op: "local.tee", index: BAG_ENTRY },
                      { op: "ref.is_null" },
                      { op: "i32.eqz" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: BAG },
                          { op: "local.get", index: 1 },
                          { op: "local.get", index: 2 },
                          { op: "call", funcIdx: setOwnIdx! },
                          { op: "global.set", index: setResultGlobalIdx! },
                          { op: "return" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ] satisfies Instr[])
          : []),
        // Only MISS and a nearest writable-data ALLOW may materialize this
        // physical field. A nearer writable descriptor never falls through to
        // a farther companion/accessor.
        { op: "local.get", index: DECISION },
        { op: "i32.const", value: SET_DECISION_MISS },
        { op: "i32.eq" },
        { op: "local.get", index: DECISION },
        { op: "i32.const", value: SET_DECISION_ALLOW_OWN },
        { op: "i32.eq" },
        { op: "i32.or" },
        { op: "if", blockType: { kind: "empty" }, then: buildGuardedStore() },
      ];
      const buildLookupAndAbsentPhysicalStore = (): Instr[] => [
        // Lookup-only: inherited refusal must not fabricate a carrier bag.
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: bagLookupIdx! },
        { op: "local.set", index: BAG },
        ...buildAbsentPhysicalStore(false),
      ];
      const buildNonDeletedStore = (): Instr[] =>
        entry.presenceSlot === undefined
          ? buildGuardedStore()
          : [
              { op: "local.get", index: RECV_ANY },
              { op: "ref.cast", typeIdx: entry.typeIdx },
              ...presenceTestInstrs(entry.typeIdx, entry.presenceSlot),
              {
                op: "if",
                blockType: { kind: "empty" },
                // A set bit is a real physical own property and wins before
                // every inherited descriptor.
                then: buildGuardedStore(),
                else: buildLookupAndAbsentPhysicalStore(),
              },
            ];
      const presenceAwareStore: Instr[] = presenceDecisionAvailable
        ? deletedIdx === undefined
          ? buildNonDeletedStore()
          : [
              // A deleted declared class field retains a stale struct slot
              // and (usually) a set presence bit. Its bag marker makes it
              // logically absent, so consult the inherited descriptor first.
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: deletedIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: buildAbsentPhysicalStore(true),
                else: buildNonDeletedStore(),
              },
            ]
        : buildGuardedStore();
      const exactThen: Instr[] =
        entry.shapeFieldIdx === undefined || entry.shapeId === undefined
          ? presenceAwareStore
          : [
              // WasmGC canonicalizes same-shaped structs; the `$shape` stamp
              // says which LOGICAL shape this instance is (see the GET fill).
              { op: "local.get", index: RECV_ANY },
              { op: "ref.cast", typeIdx: entry.typeIdx },
              { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.shapeFieldIdx },
              { op: "i32.const", value: entry.shapeId },
              { op: "i32.eq" },
              { op: "if", blockType: { kind: "empty" }, then: presenceAwareStore },
            ];
      arms.push(
        { op: "local.get", index: RECV_ANY },
        { op: "ref.test", typeIdx: entry.typeIdx },
        { op: "if", blockType: { kind: "empty" }, then: exactThen },
      );
    }
    // Cold/layout/resid fields are presence-tracked flow slots too. Reuse the
    // same four-state authority as the main-slot absent path: a real existing
    // carrier-bag own property wins, while a nearest inherited descriptor gets
    // exactly one terminal decision before storage is materialized.
    const buildFlowAbsentStore = (buildStore: () => Instr[]): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: bagLookupIdx! },
      { op: "local.set", index: BAG },
      { op: "local.get", index: 0 },
      { op: "local.get", index: BAG },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: setDecideIdx! },
      { op: "local.tee", index: DECISION },
      { op: "i32.const", value: SET_DECISION_HANDLED },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: successAndReturn() },
      { op: "local.get", index: DECISION },
      { op: "i32.const", value: SET_DECISION_REFUSED },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: refusalAndReturn() },
      { op: "local.get", index: DECISION },
      { op: "i32.const", value: SET_DECISION_ALLOW_OWN },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: BAG },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: objectTypes!.objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: BAG },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: objectTypes!.objectTypeIdx },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: objFindIdx! },
              { op: "local.tee", index: BAG_ENTRY },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: BAG },
                  { op: "local.get", index: 1 },
                  { op: "local.get", index: 2 },
                  { op: "call", funcIdx: setOwnIdx! },
                  { op: "global.set", index: setResultGlobalIdx! },
                  { op: "return" },
                ],
              },
            ],
          },
        ],
      },
      { op: "local.get", index: DECISION },
      { op: "i32.const", value: SET_DECISION_MISS },
      { op: "i32.eq" },
      { op: "local.get", index: DECISION },
      { op: "i32.const", value: SET_DECISION_ALLOW_OWN },
      { op: "i32.eq" },
      { op: "i32.or" },
      { op: "if", blockType: { kind: "empty" }, then: buildStore() },
    ];
    for (const loc of coldByField.get(fieldName) ?? []) {
      const mainStructName = ctx.typeIdxToStructName.get(loc.mainStructTypeIdx);
      const ensureIdx =
        mainStructName === undefined ? undefined : ctx.funcMap.get(coldTailAllocatorName(mainStructName));
      if (ensureIdx === undefined) continue;
      const buildColdStore = (): Instr[] => [
        ...coldFieldWriteArm(loc, RECV_ANY, 2, COLD_ANY, ensureIdx, []),
        ...untombstoneInstrs(ctx, resurrectIdx, externSetIdx, BAG),
        ...successAndReturn(),
      ];
      const coldThen: Instr[] =
        loc.presenceSlot !== undefined && presenceDecisionAvailable
          ? [
              { op: "local.get", index: RECV_ANY },
              { op: "ref.cast", typeIdx: loc.mainStructTypeIdx },
              { op: "struct.get", typeIdx: loc.mainStructTypeIdx, fieldIdx: loc.coldSlotFieldIdx },
              { op: "local.set", index: COLD_ANY },
              { op: "local.get", index: COLD_ANY },
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: buildFlowAbsentStore(buildColdStore),
                else: [
                  { op: "local.get", index: COLD_ANY },
                  { op: "ref.cast", typeIdx: loc.coldStructTypeIdx },
                  ...presenceTestInstrs(loc.coldStructTypeIdx, loc.presenceSlot),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: buildColdStore(),
                    else: buildFlowAbsentStore(buildColdStore),
                  },
                ],
              },
            ]
          : buildColdStore();
      arms.push(
        { op: "local.get", index: RECV_ANY },
        { op: "ref.test", typeIdx: loc.mainStructTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: coldThen,
        },
      );
    }
    // (#3927 per-type layouts) Inline layout arms first (stamp-guarded — two
    // sibling layouts with the same field kinds share ONE canonical wasm
    // type, so `ref.test` alone would write another field's slot), then each
    // family's resid arm as its terminal (`ref.test $base` matches every
    // family member, range-guarded against cross-family base twins). All
    // flow-grown slots are externref ⇒ no coercion. No tombstone clear:
    // split families are fnctors, and fnctor instances never tombstone
    // (`__is_class_instance_carrier` is class-only).
    if (layoutNames.has(fieldName)) {
      for (const loc of findFnctorLayoutStructsForField(ctx, fieldName)) {
        if (!loc.mutable) continue;
        const buildLayoutStore = (): Instr[] => [
          ...layoutFieldWriteInstrs(loc, RECV_ANY, 2, []),
          ...successAndReturn(),
        ];
        const layoutThen: Instr[] =
          loc.presenceSlot !== undefined && presenceDecisionAvailable
            ? [
                { op: "local.get", index: RECV_ANY },
                { op: "ref.cast", typeIdx: loc.layoutTypeIdx },
                ...presenceTestInstrs(loc.layoutTypeIdx, loc.presenceSlot),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: buildLayoutStore(),
                  else: buildFlowAbsentStore(buildLayoutStore),
                },
              ]
            : buildLayoutStore();
        arms.push(...layoutMatchTestInstrs(loc, RECV_ANY), {
          op: "if",
          blockType: { kind: "empty" },
          then: layoutThen,
        });
      }
      for (const loc of findFnctorResidStructsForField(ctx, fieldName)) {
        const ensureIdx = ctx.funcMap.get(residEnsureAllocatorName(loc.baseStructName));
        if (ensureIdx === undefined) continue;
        const buildResidStore = (): Instr[] => [
          ...residFieldWriteInstrs(loc, RECV_ANY, 2, COLD_ANY, ensureIdx, []),
          ...successAndReturn(),
        ];
        const residThen: Instr[] =
          loc.presenceSlot !== undefined && presenceDecisionAvailable
            ? [
                { op: "local.get", index: RECV_ANY },
                { op: "ref.cast", typeIdx: loc.baseTypeIdx },
                ...presenceTestInstrs(loc.baseTypeIdx, loc.presenceSlot),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: buildResidStore(),
                  else: buildFlowAbsentStore(buildResidStore),
                },
              ]
            : buildResidStore();
        arms.push(...residMatchTestInstrs(loc, RECV_ANY), {
          op: "if",
          blockType: { kind: "empty" },
          then: residThen,
        });
      }
    }
    return arms;
  };

  const keyArms: Instr[] = [];
  const names = new Set<string>([...byField.keys(), ...coldByField.keys(), ...layoutNames]);
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
