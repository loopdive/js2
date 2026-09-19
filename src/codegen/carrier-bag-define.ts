// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4161, #4098) DEFINE-side carrier-bag arms —
 * `Object.defineProperty(receiver, k, desc)` / `Object.defineProperties`
 * store into the authoritative own-property bag for closures and native Error
 * values (`--target standalone` / `--target wasi` only).
 *
 * ## The gap this closes
 * #4010 S2/S3 and #4055 made the READ half of the MOP see the carrier bags
 * (hasOwnProperty / `in` / gOPD / keys / delete), but the DEFINE appliers never
 * got an arm: `__defineProperty_value` / `__defineProperty_accessor` hit their
 * lenient terminal no-op for a closure receiver, so
 * `Object.defineProperty(fn, "p", { value: 12 })` stored NOTHING — while
 * `fn.p = 12` round-trips through `__extern_set`/`__extern_get` fine. Both
 * `carrier-bag-visibility.ts` ("`Object.defineProperty(fn, k, d)` still lands
 * nowhere") and the `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` comment in
 * `object-runtime-descriptors.ts` ("A narrower prerequisite for the Function
 * half alone: give `__defineProperty_value` / `_accessor` a closure arm that
 * recurses on `__closure_bag_ensure`") name this as the missing prerequisite.
 *
 * Harvested from fork PR #4124's #3979 slice (its ids clash with main's; see
 * plan/issues/4161-….md), re-derived against current main: most of that PR's
 * reflective-MOP wiring is superseded by #4010 S2/S3 + #4055, and its
 * `__closure_prop_set` writable-gate is superseded by
 * `buildBuiltinFnSetRefusalArm`. The define arms are the surviving piece.
 *
 * ## The mechanism: SUBSTITUTION, not re-implementation
 * A closure receiver's own NAMED properties live in an identity-keyed `$Object`
 * "bag" (`closure-props.ts`) — the exact table `__extern_get`/`__extern_set`
 * and the #4010 S3 read surfaces consult. The bag IS, for own-property
 * purposes, the receiver. So the appliers' non-`$Object` arm re-points their
 * cached `any` local at the bag and FALLS THROUGH into their unchanged
 * `$Object` path — one lookup, zero duplicated define semantics, and the
 * #2042-S4 ValidateAndApplyPropertyDescriptor preflight (which the lenient
 * no-op skipped entirely) now runs for closure receivers too.
 *
 * ## ENSURE on the define side, LOOKUP on the read side
 * The carrier-bag-* read modules follow "LOOKUP, never ENSURE" (a query must
 * not allocate). A DEFINE is a write: allocating the bag on demand is exactly
 * what `__extern_set` does for an assignment, so `closureBagSubstitutionArm`
 * uses `__closure_bag_ensure`. The read-only builder for the `Properties`
 * gate ({@link closurePropertiesBagArm}) keeps the lookup rule.
 *
 * ## Deliberately bounded carriers
 * `$Vec` receivers are owned by the #3251 overlay (which knows about index
 * keys and `length`) — the appliers consult `vecOverlayArm` BEFORE this arm.
 * And a `$Vec` `Properties` bag stays NON-authoritative (defines on an array
 * land in the overlay, not the bag — the #4047 soundness argument), so the
 * `Properties` widening here admits closures and native Error values only.
 * Error uses its existing `$Error_struct.$props` slot; Date, RegExp and other
 * closed carriers still have no authoritative bag and remain out of scope.
 *
 * ## Byte-neutrality
 * Every builder returns `undefined` when the #3468 substrate is absent
 * (gc/host mode, or a module whose object runtime was never built); callers
 * then emit their exact pre-existing body AND local vector, so non-standalone
 * output stays byte-identical. Bag locals are always APPENDED, so no existing
 * local index shifts.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { buildBagMarkerTestInstrs } from "./carrier-bag-visibility.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { IS_CLASS_INSTANCE_CARRIER } from "./instance-tombstones.js";
import { fnIntrinsicSeedInstrs } from "./fn-intrinsic-seed.js"; // (#4562) intrinsic length/name record

/** Existing accessor preflight for carrier physical fields, unchanged by marker admission. */
export function accessorCarrierNonExtensibleArm(
  ownKeyIdx: number | undefined,
  objectTypeIdx: number,
  integrityMask: number,
  throwError: (message: string) => Instr[],
): Instr[] {
  // (#5316 r6) OWN-key predicate for the non-extensible arm below; see
  // OWN_KEY_PREDICATE for why it is this native and not `__desc_has_own`.
  // Absent on the host/gc lanes, where `env::__defineProperty_accessor` owns
  // this path and the native is never emitted — the arm then keeps the plain
  // throw, which is why host output stays byte-identical.
  const accOwnKeyIdx = ownKeyIdx;
  // (#5316 r6) `__obj_find` answers the `$Object` prop table ONLY. On a #4194
  // instance carrier — a class instance, or the `__anon_*` struct an object
  // LITERAL lowers to — the receiver's own DATA properties are physical STRUCT
  // FIELDS, not bag entries, so an EXISTING key reads as "new" here and the
  // §10.1.6.3 step 2 throw fires on a define that must succeed. Consult the
  // receiver `O` (local 0), not the substituted bag `o` (local 5): only the
  // receiver can answer for its fields.
  //   owns  → the property EXISTS; a sealed/frozen carrier makes it
  //           non-configurable, so the data→accessor conversion is the
  //           §10.1.6.3 step 7 rejection; otherwise fall through to the insert,
  //           which shadows the field with a bag accessor entry exactly as it
  //           did before #5316 recorded the flag on these carriers at all.
  //   !owns → genuinely new; throw as before.
  // For a plain `$Object` receiver this guard is a NO-OP: `__obj_find` null
  // implies own-key absent, so the predicate answers false and control reaches
  // the same throw.
  return accOwnKeyIdx === undefined
    ? throwError("TypeError: Cannot define property, object is not extensible")
    : [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: accOwnKeyIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 5 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
            { op: "i32.const", value: integrityMask },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: throwError(
                "TypeError: Cannot redefine property: cannot convert a non-configurable data property to an accessor",
              ),
            },
          ],
          else: throwError("TypeError: Cannot define property, object is not extensible"),
        },
      ];
}

/** Reserved helper names owned by `closure-props.ts` (#3468). */
const IS_CLOSURE_PROP_CARRIER = "__is_closure_prop_carrier";
const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";
const CLOSURE_BAG_ENSURE = "__closure_bag_ensure";
/**
 * User-class / anonymous-instance carriers share the identity-keyed closure
 * bag.  In particular, Deno's `class SafeMap extends Map {}` prototype is a
 * legacy user-class struct rather than `$Object`, but it is still an ordinary
 * extensible ECMAScript object and Reflect.defineProperty must be able to copy
 * descriptors onto it.
 */
const IS_INSTANCE_EXPANDO_CARRIER = "__is_instance_expando_carrier";
/** (#4098) Native `$Error_struct.$props` substrate (`error-props.ts`). */
const IS_ERROR_PROP_CARRIER = "__is_error_prop_carrier";
const ERROR_PROP_BAG_LOOKUP = "__error_prop_bag_lookup";
const ERROR_PROP_BAG_ENSURE = "__error_prop_bag_ensure";

/** Authenticate semantic absence without changing the physically live marker. */
export function classMarkerDefineState(
  ctx: CodegenContext,
  opts: { firstLocal: number; objectLocal: number; currentLocal: number },
) {
  const classIdx = ctx.funcMap.get(IS_CLASS_INSTANCE_CARRIER);
  const lookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);
  const types = ctx.objectRuntimeTypes;
  if (classIdx === undefined || lookupIdx === undefined || !types) return undefined;
  const { objectTypeIdx, propEntryTypeIdx } = types;
  const retained = opts.firstLocal;
  const bag = retained + 1;
  const scratch = retained + 2;
  const locals: { name: string; type: ValType }[] = [
    { name: "classMarkerEntry", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
    { name: "classMarkerBag", type: { kind: "externref" } },
    { name: "classMarkerValue", type: { kind: "anyref" } },
  ];
  const present: Instr[] = [{ op: "local.get", index: retained }, { op: "ref.is_null" }, { op: "i32.eqz" }];
  const authenticate: Instr[] = [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        { op: "local.get", index: opts.currentLocal },
        { op: "ref.is_null" },
        { op: "br_if", depth: 0 },
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: classIdx },
        { op: "i32.eqz" },
        { op: "br_if", depth: 0 },
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: lookupIdx },
        { op: "local.tee", index: bag },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: objectTypeIdx },
        { op: "i32.eqz" },
        { op: "br_if", depth: 0 },
        { op: "local.get", index: bag },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "local.get", index: opts.objectLocal },
        { op: "ref.eq" },
        { op: "i32.eqz" },
        { op: "br_if", depth: 0 },
        ...buildBagMarkerTestInstrs(ctx, { entryLocal: opts.currentLocal, bagLocal: bag, tmpAnyLocal: scratch }),
        { op: "i32.eqz" },
        { op: "br_if", depth: 0 },
        { op: "local.get", index: opts.currentLocal },
        { op: "local.set", index: retained },
        { op: "ref.null", typeIdx: propEntryTypeIdx },
        { op: "local.set", index: opts.currentLocal },
      ],
    },
  ];
  return {
    locals,
    present,
    authenticate: [
      { op: "local.set", index: opts.currentLocal } as Instr,
      ...authenticate,
      { op: "local.get", index: opts.currentLocal } as Instr,
    ],
    commit: (value: Instr[], flagsLocal: number, getter: Instr[], setter: Instr[]): Instr[] => [
      ...present.map((i) => ({ ...i })),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: retainedClassMarkerCommit(
          objectTypeIdx,
          propEntryTypeIdx,
          opts.objectLocal,
          retained,
          value,
          flagsLocal,
          getter,
          setter,
        ),
      },
    ],
  };
}

/** DATA applier ABI: value2, native flags8, host flags9; omitted value is undefined. */
export function classMarkerDataCommit(ctx: CodegenContext, state: ReturnType<typeof classMarkerDefineState>): Instr[] {
  if (!state) return [];
  return state.commit(
    [
      { op: "local.get", index: 9 },
      { op: "i32.const", value: 128 },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [{ op: "local.get", index: 2 }],
        else: canonicalUndefinedExternInstrs(ctx),
      },
      { op: "any.convert_extern" },
    ],
    8,
    [{ op: "ref.null", typeIdx: -18 }],
    [{ op: "ref.null", typeIdx: -18 }],
  );
}

/** Allocation/call-free commit after validation. The marker already counts as live. */
function retainedClassMarkerCommit(
  objectTypeIdx: number,
  entryTypeIdx: number,
  objectLocal: number,
  entryLocal: number,
  value: Instr[],
  flagsLocal: number,
  getter: Instr[],
  setter: Instr[],
): Instr[] {
  const object = (): Instr[] => [{ op: "local.get", index: objectLocal }, { op: "ref.as_non_null" }];
  const entry = (): Instr[] => [{ op: "local.get", index: entryLocal }, { op: "ref.as_non_null" }];
  return [
    ...entry(),
    ...object(),
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 5 },
    { op: "struct.set", typeIdx: entryTypeIdx, fieldIdx: 3 },
    ...object(),
    ...object(),
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 5 },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 5 },
    ...entry(),
    ...value,
    { op: "struct.set", typeIdx: entryTypeIdx, fieldIdx: 1 },
    ...entry(),
    { op: "local.get", index: flagsLocal },
    { op: "struct.set", typeIdx: entryTypeIdx, fieldIdx: 2 },
    ...entry(),
    ...getter,
    { op: "struct.set", typeIdx: entryTypeIdx, fieldIdx: 4 },
    ...entry(),
    ...setter,
    { op: "struct.set", typeIdx: entryTypeIdx, fieldIdx: 5 },
    { op: "local.get", index: 0 },
    { op: "return" },
  ];
}

/** `closure || user-instance`, whose values share the same identity bag. */
function sharedBagCarrierTest(ctx: CodegenContext, localIdx: number): Instr[] | undefined {
  const isClosureIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  const isInstanceIdx = ctx.funcMap.get(IS_INSTANCE_EXPANDO_CARRIER);
  if (isClosureIdx === undefined && isInstanceIdx === undefined) return undefined;
  const test = (idx: number | undefined): Instr[] =>
    idx === undefined
      ? [{ op: "i32.const", value: 0 }]
      : [
          { op: "local.get", index: localIdx },
          { op: "call", funcIdx: idx },
        ];
  return [...test(isClosureIdx), ...test(isInstanceIdx), { op: "i32.or" }];
}

/**
 * Emit `[] -> [externref]`: a supported define carrier's own-property bag,
 * CREATING it when absent, or a null externref for another receiver.
 * `undefined` when the substrate is absent.
 */
export function defineCarrierBagEnsureInstrs(ctx: CodegenContext, recvLocalIdx: number): Instr[] | undefined {
  const isClosureIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  const isInstanceIdx = ctx.funcMap.get(IS_INSTANCE_EXPANDO_CARRIER);
  const ensureIdx = ctx.funcMap.get(CLOSURE_BAG_ENSURE);
  const errorEnsureIdx = ctx.funcMap.get(ERROR_PROP_BAG_ENSURE);
  const errorFallback: Instr[] =
    errorEnsureIdx === undefined
      ? [{ op: "ref.null.extern" }]
      : [
          { op: "local.get", index: recvLocalIdx },
          { op: "call", funcIdx: errorEnsureIdx },
        ];
  if ((isClosureIdx === undefined && isInstanceIdx === undefined) || ensureIdx === undefined) {
    return errorEnsureIdx === undefined ? undefined : errorFallback;
  }
  const sharedBagCarrier = sharedBagCarrierTest(ctx, recvLocalIdx);
  if (sharedBagCarrier === undefined) return errorEnsureIdx === undefined ? undefined : errorFallback;
  return [
    ...sharedBagCarrier,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: recvLocalIdx },
        { op: "call", funcIdx: ensureIdx },
      ],
      else: errorFallback,
    },
  ];
}

/**
 * The define appliers' non-`$Object` arm for a supported carrier receiver:
 * ensure the bag and substitute it for the receiver, so the unchanged
 * `$Object` path (including the #2042-S4 preflight) defines into the same
 * table `__extern_get`/gOPD read from. Unsupported receivers run `fallback`
 * (the applier's pre-existing lenient no-op), which must return on its own.
 *
 * `anyLocalIdx` is the applier's cached `any.convert_extern(obj)` local — the
 * one its `$Object` path casts. `bagLocalIdx` must be a fresh externref local
 * APPENDED to the applier's local vector.
 */
export function defineCarrierBagSubstitutionArm(
  ctx: CodegenContext,
  opts: { recvLocalIdx: number; anyLocalIdx: number; bagLocalIdx: number; keyLocalIdx: number; fallback: Instr[] },
): Instr[] | undefined {
  const ensure = defineCarrierBagEnsureInstrs(ctx, opts.recvLocalIdx);
  if (ensure === undefined) return undefined;
  return [
    ...ensure,
    { op: "local.tee", index: opts.bagLocalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: opts.fallback },
    // (#4562) A function's intrinsic `length`/`name` is not a bag entry, so
    // §10.1.6.3 would see `current` undefined and rebuild the record from the
    // partial descriptor alone — losing every omitted field, including the
    // value itself when `value` is what was omitted. Materialise it first and
    // the unchanged merge below has the input it was always missing.
    ...fnIntrinsicSeedInstrs(ctx, opts.recvLocalIdx, opts.bagLocalIdx, opts.keyLocalIdx),
    // Bag present — re-point the applier's `$Object` receiver at it.
    { op: "local.get", index: opts.bagLocalIdx },
    { op: "any.convert_extern" },
    { op: "local.set", index: opts.anyLocalIdx },
  ];
}

/**
 * Emit `[] -> [i32]`: is the value in `localIdx` a supported define carrier?
 * `undefined` when the substrate is absent.
 */
export function isDefineCarrierInstrs(ctx: CodegenContext, localIdx: number): Instr[] | undefined {
  const isClosureIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  const isInstanceIdx = ctx.funcMap.get(IS_INSTANCE_EXPANDO_CARRIER);
  const isErrorIdx = ctx.funcMap.get(IS_ERROR_PROP_CARRIER);
  if (isClosureIdx === undefined && isInstanceIdx === undefined && isErrorIdx === undefined) return undefined;
  const test = (idx: number | undefined): Instr[] =>
    idx === undefined
      ? [{ op: "i32.const", value: 0 }]
      : [
          { op: "local.get", index: localIdx },
          { op: "call", funcIdx: idx },
        ];
  return [...test(isClosureIdx), ...test(isInstanceIdx), { op: "i32.or" }, ...test(isErrorIdx), { op: "i32.or" }];
}

/**
 * `__defineProperties`' non-`$Object` `Properties` arm for a supported carrier
 * map: substitute its own-property bag (LOOKUP, never ensure —
 * this is a read) for the map and fall through into the unchanged
 * `$Object` key walk. Sound because, with the applier arms above, the closure
 * bag IS the complete own-NAMED-property store: assignments reach it via
 * `__extern_set` and defines via the appliers. (A closure with NO bag has no
 * own enumerable named properties — builtin `name`/`length` metadata is
 * non-enumerable — so §20.1.2.3.1's key walk is empty and returning `O`
 * unchanged is the complete spec answer, not a degraded one.)
 *
 * Emits: if the value in `propsLocalIdx` is a supported carrier — bag lookup;
 * null bag → `emptyMapFallback` (must return/throw on its own); otherwise
 * re-point `descsAnyLocalIdx` at the bag. Non-closure values run
 * `nonClosureFallback` (the pre-existing refusal), which must return/throw on
 * its own. Returns `undefined` when the substrate is absent.
 */
export function definePropertiesCarrierBagArm(
  ctx: CodegenContext,
  opts: {
    propsLocalIdx: number;
    descsAnyLocalIdx: number;
    bagLocalIdx: number;
    emptyMapFallback: Instr[];
    nonClosureFallback: Instr[];
  },
): Instr[] | undefined {
  const isClosureIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  const isInstanceIdx = ctx.funcMap.get(IS_INSTANCE_EXPANDO_CARRIER);
  const lookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);
  const isErrorIdx = ctx.funcMap.get(IS_ERROR_PROP_CARRIER);
  const errorLookupIdx = ctx.funcMap.get(ERROR_PROP_BAG_LOOKUP);
  if (
    ((isClosureIdx === undefined && isInstanceIdx === undefined) || lookupIdx === undefined) &&
    (isErrorIdx === undefined || errorLookupIdx === undefined)
  ) {
    return undefined;
  }
  const carrierTest = isDefineCarrierInstrs(ctx, opts.propsLocalIdx);
  if (carrierTest === undefined) return undefined;
  const lookup: Instr[] =
    (isClosureIdx !== undefined || isInstanceIdx !== undefined) && lookupIdx !== undefined
      ? [
          ...sharedBagCarrierTest(ctx, opts.propsLocalIdx)!,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              { op: "local.get", index: opts.propsLocalIdx },
              { op: "call", funcIdx: lookupIdx },
            ],
            else:
              errorLookupIdx === undefined
                ? [{ op: "ref.null.extern" }]
                : [
                    { op: "local.get", index: opts.propsLocalIdx },
                    { op: "call", funcIdx: errorLookupIdx },
                  ],
          },
        ]
      : [
          { op: "local.get", index: opts.propsLocalIdx },
          { op: "call", funcIdx: errorLookupIdx! },
        ];
  return [
    ...carrierTest,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...lookup,
        { op: "local.tee", index: opts.bagLocalIdx },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: opts.emptyMapFallback },
        { op: "local.get", index: opts.bagLocalIdx },
        { op: "any.convert_extern" },
        { op: "local.set", index: opts.descsAnyLocalIdx },
      ],
      else: opts.nonClosureFallback,
    },
  ];
}
