// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4010 S2) `__carrier_bag_delete(obj, key)` — OrdinaryDelete over the
 * own-property side table of a **non-`$Object` receiver**, and the non-`$Object`
 * arms of `__delete_property` that reach it.
 *
 * ## The defect this closes
 * `__delete_property`'s non-`$Object` arm returned **1 (success) without
 * deleting anything**. That is the worst shape a gate can have: a loud claim of
 * success covering a silent wrong answer. Measured on current main, standalone:
 *
 * ```js
 * const a = [1,2,3]; a.q = 12; delete a.q;   // returns TRUE
 * a.q                                        // => 12   (STILL PRESENT)
 *
 * function f(){}  f.p = 12;  delete f.p;     // returns TRUE
 * f.p                                        // => 12   (STILL PRESENT)
 * ```
 *
 * Both values live in a per-receiver `$Object` **bag** — `vec-props.ts` (#3537)
 * for arrays, `closure-props.ts` (#3468) for functions — that the delete native
 * had never heard of. Because the bag IS an ordinary `$Object`, the whole of
 * OrdinaryDelete (§10.1.10: configurability preflight, `FLAG_TOMBSTONE`,
 * count/tombstone bookkeeping) is already implemented for it — this native only
 * has to find the right bag and delegate. No delete semantics are re-implemented
 * here, which is why a non-configurable bag entry still refuses correctly.
 *
 * ## Tri-state, because a detector must be able to say "I don't know"
 * The result is deliberately **-1 / 0 / 1**, not a boolean:
 *
 * | result | meaning                       | caller does            |
 * | ------ | ----------------------------- | ---------------------- |
 * | `-1`   | no bag, or the bag does not hold this key — **NOT HANDLED** | fall through, unchanged |
 * | `0`    | the bag holds it and refused (non-configurable)              | `return 0`              |
 * | `1`    | deleted                                                      | `return 1`              |
 *
 * Collapsing `-1` into `1` would make "I could not see anything" indistinguishable
 * from "there was nothing", which is exactly the defect above. It is also what
 * makes the change **strictly additive**: the arm fires only for a key the bag
 * demonstrably holds, so every receiver/key the old code answered for keeps its
 * answer bit-for-bit. In particular `delete fn.name` / `delete fn.length` on a
 * builtin stays with the #2896 `__builtinfn_delete` arm, which runs FIRST and
 * returns — this native is never consulted for it. That matters: the
 * `built-ins/**\/{name,length}.js` stratum is the ~700-file population whose
 * regression cost #4055 v1 **-684** host-free passes, and it is untouched here.
 *
 * ## Scope: delete only (#4010's ordering law)
 * > Own-property VISIBILITY cannot ship before own-property DELETABILITY.
 *
 * S1' fixed the value clobber; this is S2. **No visibility surface moves**:
 * `__hasOwnProperty` / `__object_hasOwn` / `__vec_gopd` / `Object.keys` reach is
 * byte-identical, pinned by the SCOPE PIN cases in `tests/issue-4010.test.ts`.
 * Widening those is S3 and is gated on running the `{name,length}.js` stratum
 * explicitly first.
 *
 * ## LOOKUP, never ENSURE
 * Same rule as `carrier-bag-hasown.ts`: deleting a key a receiver never had must
 * not allocate a bag for it and hand a later `__integrity_bag` consumer a
 * carrier that previously had none.
 *
 * ## Byte-neutrality
 * Reserved only when a carrier predicate exists (standalone/wasi — in gc/host
 * mode the `env::__extern_*` imports own the dynamic-property path), and the
 * placeholder body is `i32.const -1` ("not handled"), so a skipped fill degrades
 * to exactly today's behaviour instead of trapping.
 */
import type { Instr } from "../ir/types.js";
import { selectNativeStringLiteral } from "../runtime/wasmgc/values/string-literal-bodies.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { exposedClosedStructFieldName, FNCTOR_CONSTRUCTOR_FIELD } from "./fnctor-identity-fields.js";
import { buildInstanceTombstoneDeleteArm } from "./instance-tombstones.js"; // (#4098 G1 s1)
import { addFuncType } from "./registry/types.js";
import { buildShapeGuardedArm } from "./shape-guarded-arm.js";
import { linkBrandRoleOf } from "./shape-brand.js";
import { isInternalStructFieldName } from "./struct-field-exports.js";
import { isNominalStructParent } from "./struct-hierarchy-layout.js";

/** The tri-state carrier-bag delete native minted here. */
export const CARRIER_BAG_DELETE = "__carrier_bag_delete";

/** #3468 closure-own-property side table (`closure-props.ts`). */
const IS_CLOSURE_PROP_CARRIER = "__is_closure_prop_carrier";
const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";
/** #3537 array-expando side table (`vec-props.ts`). */
const IS_VEC_PROP_CARRIER = "__is_vec_prop_carrier";
const VEC_BAG_LOOKUP = "__vec_bag_lookup";
/** (#4098) Native `$Error_struct.$props` carrier (`error-props.ts`). */
const IS_ERROR_PROP_CARRIER = "__is_error_prop_carrier";
const ERROR_PROP_BAG_LOOKUP = "__error_prop_bag_lookup";

/** Sole local of `__carrier_bag_delete` (params are 0=obj, 1=key). */
const BAG = 2;

/**
 * A closed anonymous receiver which may use the identity bag for a true
 * expando delete. This is intentionally narrower than the generic
 * `IS_INSTANCE_EXPANDO_CARRIER` universe: classes retain #5753's marker arm,
 * fnctors own their split/cold layouts, and every unknown representation keeps
 * the historical `-1` fallthrough.
 */
type PreexistingNativeStringLiteral =
  | { readonly kind: "global"; readonly globalIdx: number }
  | { readonly kind: "callable"; readonly funcIdx: number };

type PhysicalAnonymousField = {
  /**
   * Materialized before FINALIZE. The anonymous delete fill must never append a
   * literal global or helper while it is wiring an existing native.
   */
  readonly literal: PreexistingNativeStringLiteral;
};

type AnonymousExpandoDeleteCandidate = {
  readonly typeIdx: number;
  readonly physicalFields: readonly PhysicalAnonymousField[];
  readonly shapeFieldIdx?: number;
  readonly shapeId?: number;
};

/**
 * Recover a literal materialization that source emission has already made
 * available. Selection is pure; unlike `nativeStringLiteralInstrs`, this cannot
 * mint a late global or oversized rope helper during FINALIZE.
 */
function preexistingNativeStringLiteral(
  ctx: CodegenContext,
  value: string,
): PreexistingNativeStringLiteral | undefined {
  const selection = selectNativeStringLiteral(ctx.utf8Storage, ctx.utf8StrTypeIdx >= 0, value);
  if (selection.kind === "global") {
    const globalIdx = ctx.nativeStrLiteralGlobals.get(selection.key);
    return globalIdx === undefined ? undefined : { kind: "global", globalIdx };
  }
  const funcIdx = ctx.nativeStrHelpers.get(selection.key);
  return funcIdx === undefined ? undefined : { kind: "callable", funcIdx };
}

function preexistingNativeStringLiteralInstrs(literal: PreexistingNativeStringLiteral): Instr[] {
  return literal.kind === "global"
    ? [{ op: "global.get", index: literal.globalIdx }]
    : [{ op: "call", funcIdx: literal.funcIdx }];
}

/**
 * Return only receiver types whose final identity can be established without a
 * new layout marker.
 *
 * This runs after `resolveAndRecordShapeStamping`, while all user source bodies
 * and their struct types are complete. `brandCollidingShapeTypes` runs later:
 * an admitted bare `__anon_` type is either structurally unique or receives a
 * trailing nominal brand before encoding. `noBrandShapeTypes`, supertype
 * edges, aliases, and linked modules are deliberately declined because that
 * final argument would no longer establish an exact receiver inventory.
 */
function collectAnonymousExpandoDeleteCandidates(ctx: CodegenContext): AnonymousExpandoDeleteCandidate[] {
  if (!(ctx.standalone || ctx.wasi)) return [];
  // A linked peer can contribute a canonical twin that this module cannot
  // inventory here. The shape-brand pass handles that broader problem, but this
  // narrow consumer has no cross-module receipt, so retain the old fallback.
  if (linkBrandRoleOf(ctx) !== undefined) return [];

  // `shape-brand.ts` only brands a bare candidate after this anchor. Requiring
  // the same precondition keeps a later same-layout type from widening a
  // `ref.test` arm which the branding pass cannot repair.
  const shapeBrandAnchorIdx = ctx.structMap.get("__vec_base");
  if (shapeBrandAnchorIdx === undefined) return [];

  const namesByTypeIdx = new Map<number, string[]>();
  for (const [structName, typeIdx] of ctx.structMap) {
    const names = namesByTypeIdx.get(typeIdx);
    if (names) names.push(structName);
    else namesByTypeIdx.set(typeIdx, [structName]);
  }

  const out: AnonymousExpandoDeleteCandidate[] = [];
  for (const [structName, fields] of ctx.structFields) {
    if (!structName.startsWith("__anon_")) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined || typeIdx <= shapeBrandAnchorIdx) continue;
    // `structMap` aliases are not a runtime identity proof. Require both maps
    // to name exactly this source shape before emitting a `ref.test` arm.
    const aliases = namesByTypeIdx.get(typeIdx);
    if (aliases?.length !== 1 || aliases[0] !== structName || ctx.typeIdxToStructName.get(typeIdx) !== structName) {
      continue;
    }
    const typeDef = ctx.mod.types[typeIdx];
    if (
      !typeDef ||
      typeDef.kind !== "struct" ||
      typeDef.name !== structName ||
      typeDef.fields !== fields ||
      typeDef.superTypeIdx !== undefined ||
      isNominalStructParent(ctx.mod, typeIdx) ||
      ctx.noBrandShapeTypes.has(typeIdx)
    ) {
      continue;
    }
    // Cold/residual layouts are fnctor-owned. An anonymous type must never
    // borrow their incomplete field inventory merely because it has an
    // incidental structural match.
    if (
      ctx.fnctorColdTailTypeIdx?.has(structName) ||
      ctx.fnctorColdTailStructName?.has(structName) ||
      ctx.fnctorLayoutInfo?.has(structName)
    ) {
      continue;
    }

    const physicalFields: PhysicalAnonymousField[] = [];
    const seenPhysicalNames = new Set<string>();
    let completeInventory = true;
    for (const field of fields) {
      if (!field || field.name === undefined) {
        completeInventory = false;
        break;
      }
      // A user-recorded `$constructor` is not fnctor identity state. Preserve
      // both its literal spelling and the dynamic-reader's historical exposed
      // `constructor` spelling, so neither overlay can reveal a stale slot.
      // Every other spelling is internal only when the insertion metadata says
      // so. Test `undefined`, rather than truthiness: the empty string is a
      // legal physical key.
      const sourceRecorded = !isInternalStructFieldName(ctx, structName, field.name);
      const physicalNames =
        field.name === FNCTOR_CONSTRUCTOR_FIELD && sourceRecorded
          ? [field.name, exposedClosedStructFieldName(field.name)]
          : [exposedClosedStructFieldName(field.name) ?? (sourceRecorded ? field.name : undefined)];
      for (const physicalName of physicalNames) {
        if (physicalName === undefined || seenPhysicalNames.has(physicalName)) continue;
        // Well-known Symbol fields use their `@@name` internal spelling. A
        // string comparison cannot distinguish `Symbol.iterator` from the
        // ordinary string "@@iterator", so decline this whole receiver rather
        // than delete a bag overlay and resurrect physical Symbol storage.
        if (physicalName.startsWith("@@")) {
          completeInventory = false;
          break;
        }
        const literal = preexistingNativeStringLiteral(ctx, physicalName);
        // The inventory is all-or-nothing: an oversized or otherwise
        // unmaterialized physical field must decline the whole candidate rather
        // than tempt FINALIZE to mint a new literal helper.
        if (literal === undefined) {
          completeInventory = false;
          break;
        }
        seenPhysicalNames.add(physicalName);
        physicalFields.push({ literal });
      }
      if (!completeInventory) break;
    }
    if (!completeInventory) continue;

    const shapeFieldIdx = fields.findIndex((field) => field?.name === "$shape");
    const shapeId = ctx.shapeIdByStructName.get(structName);
    // A partial stamp is not an identity guard. A non-stamped type is safe only
    // through the unique-or-later-branded rule above.
    if (shapeFieldIdx >= 0 !== (shapeId !== undefined)) continue;
    out.push({
      typeIdx,
      physicalFields,
      ...(shapeFieldIdx >= 0 && shapeId !== undefined ? { shapeFieldIdx, shapeId } : {}),
    });
  }
  return out.sort((left, right) => left.typeIdx - right.typeIdx);
}

/**
 * Reserve `__carrier_bag_delete(externref, externref) -> i32` as an
 * `i32.const -1` placeholder, so `__delete_property`'s arms can bake a
 * `call <idx>` before `fillCarrierBagDelete` knows `__delete_property`'s own
 * index. Append-only mint (no funcIdx shifts), idempotent, and a no-op unless a
 * carrier substrate was reserved. Returns the funcIdx, or `undefined`.
 */
export function reserveCarrierBagDelete(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(CARRIER_BAG_DELETE);
  if (existing !== undefined) return existing;
  const hasCarrier =
    ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER) !== undefined ||
    ctx.funcMap.get(IS_VEC_PROP_CARRIER) !== undefined ||
    ctx.funcMap.get(IS_ERROR_PROP_CARRIER) !== undefined;
  if (!hasCarrier) return undefined;

  const externref = { kind: "externref" } as const;
  const typeIdx = addFuncType(ctx, [externref, externref], [{ kind: "i32" }], `$${CARRIER_BAG_DELETE}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: CARRIER_BAG_DELETE,
    typeIdx,
    locals: [{ name: "bag", type: externref }],
    // Safe no-op: "not handled" ⇒ every caller keeps its pre-#4010 answer.
    body: [{ op: "i32.const", value: -1 }],
    exported: false,
  });
  ctx.funcMap.set(CARRIER_BAG_DELETE, funcIdx);
  return funcIdx;
}

/**
 * The non-`$Object` head of `__delete_property`'s body, in emission order:
 *
 * 1. the #2896 builtin-fn metadata arm (`delete fn.name` / `delete fn.length`) —
 *    UNCHANGED, and deliberately first, so the `{name,length}.js` stratum never
 *    reaches the bag arm;
 * 2. `if (!(obj is $Object))` → consult the carrier bag; only a definite answer
 *    (`>= 0`) returns, otherwise the historical `return 1` no-op success.
 *
 * `resultLocal` must be an i32 local of the enclosing native.
 */
export function buildNonObjectDeleteArms(
  ctx: CodegenContext,
  args: {
    bfnDeleteIdx: number | undefined;
    boundaryDeleteIdx?: number;
    objectTypeIdx: number;
    anyLocal: number;
    resultLocal: number;
  },
): Instr[] {
  const cbdIdx = ctx.funcMap.get(CARRIER_BAG_DELETE);
  const bagArm: Instr[] =
    cbdIdx === undefined
      ? []
      : [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: cbdIdx },
          { op: "local.tee", index: args.resultLocal },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: args.resultLocal }, { op: "return" }],
          },
        ];
  const boundaryArm: Instr[] =
    args.boundaryDeleteIdx === undefined
      ? []
      : [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: args.boundaryDeleteIdx },
          { op: "local.tee", index: args.resultLocal },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: args.resultLocal },
              { op: "i32.const", value: 2 },
              { op: "i32.eq" },
              { op: "return" },
            ],
          },
        ];
  return [
    ...(args.bfnDeleteIdx !== undefined
      ? ([
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: args.bfnDeleteIdx },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: args.anyLocal },
    { op: "ref.test", typeIdx: args.objectTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      // (#4098 G1 s1) The instance-tombstone arm goes LAST, for the same reason
      // the bag arm is second: every receiver/key an earlier arm answers for
      // keeps its answer bit-for-bit. `delete fn.name`/`fn.length` on a builtin
      // stays with `__builtinfn_delete` and never reaches here — that stratum is
      // the ~700 files whose regression cost #4055 v1 its -684.
      then: [
        ...boundaryArm,
        ...bagArm,
        ...buildInstanceTombstoneDeleteArm(ctx),
        { op: "i32.const", value: 1 },
        { op: "return" },
      ],
    },
  ];
}

/**
 * `BAG` remains null until an exact anonymous-shape arm finds the receiver's
 * existing identity bag. The candidate ordinal is set only with a non-null
 * lookup result, so the common tail can decide whether stored-key physical
 * collision screening applies without widening the closure/vec/Error routes.
 */
function buildAnonymousExpandoLookupArm(
  candidates: readonly AnonymousExpandoDeleteCandidate[],
  lookupIdx: number,
  anyLocal: number,
  candidateLocal: number,
): Instr[] {
  let dispatch: Instr[] = [];
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index]!;
    const ordinal = index + 1;
    const hit: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: BAG },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [],
        else: [
          { op: "i32.const", value: ordinal },
          { op: "local.set", index: candidateLocal },
        ],
      },
    ];
    dispatch = buildShapeGuardedArm(anyLocal, candidate.typeIdx, candidate, { kind: "empty" }, hit, dispatch);
  }
  return [
    { op: "local.get", index: BAG },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: anyLocal },
        ...dispatch,
      ],
    },
  ];
}

/**
 * Return `-1` when the found bag entry overlays a physical field of the
 * admitted anonymous receiver. The entry's field 0 is the stored key; using it
 * here (and for the delegated delete) avoids adding a caller-key coercion
 * replay after this lookup and preserves Symbol identity.
 */
function buildAnonymousPhysicalCollisionScreen(
  ctx: CodegenContext,
  candidates: readonly AnonymousExpandoDeleteCandidate[],
  args: {
    candidateLocal: number;
    entryLocal: number;
    flatKeyLocal: number;
    propEntryTypeIdx: number;
    flattenIdx: number;
    equalsIdx: number;
  },
): Instr[] {
  const notHandled = (): Instr[] => [{ op: "i32.const", value: -1 }, { op: "return" }];
  let candidateChecks: Instr[] = [];
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index]!;
    const physicalNameChecks: Instr[] = [];
    for (const physicalField of candidate.physicalFields) {
      physicalNameChecks.push(
        { op: "local.get", index: args.flatKeyLocal },
        { op: "ref.as_non_null" },
        ...preexistingNativeStringLiteralInstrs(physicalField.literal),
        { op: "call", funcIdx: args.equalsIdx },
        { op: "if", blockType: { kind: "empty" }, then: notHandled() },
      );
    }
    candidateChecks = [
      { op: "local.get", index: args.candidateLocal },
      { op: "i32.const", value: index + 1 },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: physicalNameChecks, else: candidateChecks },
    ];
  }
  return [
    { op: "local.get", index: args.candidateLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Symbols are not strings, and therefore cannot equal any physical
        // field name. They keep the ordinary bag-delete path without a cast.
        { op: "local.get", index: args.entryLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: args.propEntryTypeIdx, fieldIdx: 0 },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: args.entryLocal },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: args.propEntryTypeIdx, fieldIdx: 0 },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "call", funcIdx: args.flattenIdx },
            { op: "local.set", index: args.flatKeyLocal },
            ...candidateChecks,
          ],
        },
      ],
    },
  ];
}

/**
 * Fill `__carrier_bag_delete` at FINALIZE, once `__delete_property` /
 * `__obj_find` and the carrier substrates are in `funcMap`:
 *
 * ```
 * bag = closure-carrier ? __closure_bag_lookup(obj)
 *     : vec-carrier     ? __vec_bag_lookup(obj)
 *     : null;                                  // LOOKUP, never ensure
 * if (bag == null || !(bag is $Object)) return -1;
 * if (__obj_find(bag, key) == null) return -1; // the bag does not hold it
 * return __delete_property(bag, key);          // §10.1.10, already correct
 * ```
 *
 * Leaves the `-1` placeholder in place when any dependency is missing.
 */
export function fillCarrierBagDelete(ctx: CodegenContext): void {
  const cbdIdx = ctx.funcMap.get(CARRIER_BAG_DELETE);
  if (cbdIdx === undefined) return;
  const fn = definedFuncAt(ctx, cbdIdx);
  if (!fn) return;
  const runtimeTypes = ctx.objectRuntimeTypes;
  const objectTypeIdx = runtimeTypes?.objectTypeIdx;
  const propEntryTypeIdx = runtimeTypes?.propEntryTypeIdx;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const deleteIdx = ctx.funcMap.get("__delete_property");
  // `propEntryTypeIdx` is required only by the anonymous data-expando arm
  // below. The existing closure/vec/Error arms must retain their historical
  // early return when an older or partial runtime has no `$PropEntry` layout.
  if (objectTypeIdx === undefined || objFindIdx === undefined || deleteIdx === undefined) return;

  /** `if (<carrier predicate>) bag = <lookup>(obj);` guarded on bag still being null. */
  const lookupArm = (isIdx: number | undefined, lookupIdx: number | undefined): Instr[] =>
    isIdx === undefined || lookupIdx === undefined
      ? []
      : [
          { op: "local.get", index: BAG },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: isIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "call", funcIdx: lookupIdx },
                  { op: "local.set", index: BAG },
                ],
              },
            ],
          },
        ];

  const closureArm = lookupArm(ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER), ctx.funcMap.get(CLOSURE_BAG_LOOKUP));
  // Native generator states deliberately use the same identity-keyed bag as
  // closures for ordinary own properties, but they are not callable closure
  // wrappers.  Their reads and writes are claimed by the generator protocol /
  // instance-expando arms before this generic fallback.  Deletion needs the
  // matching exact-state admission here: otherwise `gen.next = undefined;
  // delete gen.next` leaves the shadowing bag entry live and permanently
  // suppresses the inherited Generator.prototype method.  Do not widen the
  // closure predicate: that would also route unrelated dynamic method calls
  // through Function.prototype machinery.  The generator type registry is
  // complete at this FINALIZE seam, and `__closure_bag_lookup`'s slotless
  // registry path is already the canonical storage for these state objects.
  const nativeGeneratorStateTypeIdxs = [
    ...new Set([...ctx.nativeGenerators.values()].map((info) => info.stateTypeIdx)),
  ];
  const nativeGeneratorArm: Instr[] =
    nativeGeneratorStateTypeIdxs.length === 0 || ctx.funcMap.get(CLOSURE_BAG_LOOKUP) === undefined
      ? []
      : [
          { op: "local.get", index: BAG },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: nativeGeneratorStateTypeIdxs.flatMap((typeIdx): Instr[] => [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "call", funcIdx: ctx.funcMap.get(CLOSURE_BAG_LOOKUP)! },
                  { op: "local.set", index: BAG },
                ],
              },
            ]),
          },
        ];
  const vecArm = lookupArm(ctx.funcMap.get(IS_VEC_PROP_CARRIER), ctx.funcMap.get(VEC_BAG_LOOKUP));
  const errorArm = lookupArm(ctx.funcMap.get(IS_ERROR_PROP_CARRIER), ctx.funcMap.get(ERROR_PROP_BAG_LOOKUP));
  const anonymousCandidates = collectAnonymousExpandoDeleteCandidates(ctx);
  const anonymousLookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);
  const flattenIdx = ctx.funcMap.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  // This is eligibility only. It deliberately allocates no locals before the
  // common arm gate: #5753's class retained-marker arm replaces its local list
  // after that gate, so a composed tree must form that class arm first and then
  // append this slice's scratch locals below it.
  const anonymousPlan =
    propEntryTypeIdx === undefined ||
    anonymousCandidates.length === 0 ||
    anonymousLookupIdx === undefined ||
    flattenIdx === undefined ||
    equalsIdx === undefined ||
    ctx.anyStrTypeIdx < 0 ||
    ctx.nativeStrTypeIdx < 0
      ? undefined
      : {
          candidates: anonymousCandidates,
          lookupIdx: anonymousLookupIdx,
          flattenIdx,
          equalsIdx,
          propEntryTypeIdx,
          nativeStrTypeIdx: ctx.nativeStrTypeIdx,
        };

  // `reserveClosurePropHelpers` is unconditional inside standalone/WASI
  // `ensureObjectRuntime`, so `__carrier_bag_delete` is already reserved before
  // `__delete_property` bakes its call even in an anonymous-only module. Keep
  // anonymous eligibility in this gate explicitly: closure/vec/Error arms must
  // not be the accidental reason an anonymous-only finalizer appears filled.
  if (
    closureArm.length === 0 &&
    nativeGeneratorArm.length === 0 &&
    vecArm.length === 0 &&
    errorArm.length === 0 &&
    anonymousPlan === undefined
  )
    return;

  let anonymousArm: Instr[] = [];
  let anonymousState:
    | {
        candidateLocal: number;
        entryLocal: number;
        flatKeyLocal: number;
      }
    | undefined;
  if (anonymousPlan !== undefined) {
    // This is the composition point after the common gate. When #5753's class
    // retained-marker arm is present, it forms and replaces `fn.locals` above
    // this point (owning 3/4/5); this slice only appends to that final list.
    const anyLocal = 2 + fn.locals.length;
    const candidateLocal = anyLocal + 1;
    const entryLocal = candidateLocal + 1;
    const flatKeyLocal = entryLocal + 1;
    fn.locals.push(
      { name: "anonAny", type: { kind: "anyref" } },
      { name: "anonCandidate", type: { kind: "i32" } },
      { name: "anonEntry", type: { kind: "ref_null", typeIdx: anonymousPlan.propEntryTypeIdx } },
      { name: "anonFlatKey", type: { kind: "ref_null", typeIdx: anonymousPlan.nativeStrTypeIdx } },
    );
    anonymousArm = buildAnonymousExpandoLookupArm(
      anonymousPlan.candidates,
      anonymousPlan.lookupIdx,
      anyLocal,
      candidateLocal,
    );
    anonymousState = { candidateLocal, entryLocal, flatKeyLocal };
  }

  const notHandled: Instr[] = [{ op: "i32.const", value: -1 }, { op: "return" }];
  fn.body = [
    ...closureArm,
    ...nativeGeneratorArm,
    ...vecArm,
    ...errorArm,
    ...anonymousArm,
    { op: "local.get", index: BAG },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: notHandled.map((i) => ({ ...i })) },
    // The `ref.test` is not decoration: a bag is a `__new_plain_object` product
    // today, but a bare `ref.cast` would turn any future substrate change into a
    // trap inside a helper that must never throw (#3468 S1 discipline).
    { op: "local.get", index: BAG },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: notHandled.map((i) => ({ ...i })) },
    // Presence in the bag is what makes this arm additive — see the tri-state
    // table above. `__obj_find` already skips tombstoned entries, so a key
    // deleted twice reports "not handled" and the caller's `return 1` (delete of
    // an absent own property succeeds, §10.1.10 step 2) stands.
    { op: "local.get", index: BAG },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: objFindIdx },
    ...(anonymousState === undefined ? [] : [{ op: "local.tee", index: anonymousState.entryLocal }]),
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: notHandled.map((i) => ({ ...i })) },
    ...(anonymousState === undefined
      ? []
      : buildAnonymousPhysicalCollisionScreen(ctx, anonymousPlan!.candidates, {
          candidateLocal: anonymousState.candidateLocal,
          entryLocal: anonymousState.entryLocal,
          flatKeyLocal: anonymousState.flatKeyLocal,
          propEntryTypeIdx: anonymousPlan!.propEntryTypeIdx,
          flattenIdx: anonymousPlan!.flattenIdx,
          equalsIdx: anonymousPlan!.equalsIdx,
        })),
    { op: "local.get", index: BAG },
    ...(anonymousState === undefined
      ? [{ op: "local.get", index: 1 }]
      : [
          // Anonymous candidates delegated through a found `$PropEntry`; use
          // that entry's stored key rather than replaying an arbitrary caller
          // coercion in the ordinary-delete helper. Legacy carrier arms retain
          // their original key verbatim.
          { op: "local.get", index: anonymousState.candidateLocal },
          { op: "i32.const", value: 0 },
          { op: "i32.ne" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              { op: "local.get", index: anonymousState.entryLocal },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: anonymousPlan!.propEntryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
            ],
            else: [{ op: "local.get", index: 1 }],
          },
        ]),
    { op: "call", funcIdx: deleteIdx },
  ];
}
