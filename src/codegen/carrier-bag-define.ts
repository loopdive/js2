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
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Reserved helper names owned by `closure-props.ts` (#3468). */
const IS_CLOSURE_PROP_CARRIER = "__is_closure_prop_carrier";
const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";
const CLOSURE_BAG_ENSURE = "__closure_bag_ensure";
/** (#4098) Native `$Error_struct.$props` substrate (`error-props.ts`). */
const IS_ERROR_PROP_CARRIER = "__is_error_prop_carrier";
const ERROR_PROP_BAG_LOOKUP = "__error_prop_bag_lookup";
const ERROR_PROP_BAG_ENSURE = "__error_prop_bag_ensure";

/**
 * Emit `[] -> [externref]`: a supported define carrier's own-property bag,
 * CREATING it when absent, or a null externref for another receiver.
 * `undefined` when the substrate is absent.
 */
export function defineCarrierBagEnsureInstrs(ctx: CodegenContext, recvLocalIdx: number): Instr[] | undefined {
  const isClosureIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  const ensureIdx = ctx.funcMap.get(CLOSURE_BAG_ENSURE);
  const errorEnsureIdx = ctx.funcMap.get(ERROR_PROP_BAG_ENSURE);
  const errorFallback: Instr[] =
    errorEnsureIdx === undefined
      ? [{ op: "ref.null.extern" }]
      : [
          { op: "local.get", index: recvLocalIdx },
          { op: "call", funcIdx: errorEnsureIdx },
        ];
  if (isClosureIdx === undefined || ensureIdx === undefined) {
    return errorEnsureIdx === undefined ? undefined : errorFallback;
  }
  return [
    { op: "local.get", index: recvLocalIdx },
    { op: "call", funcIdx: isClosureIdx },
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
  opts: { recvLocalIdx: number; anyLocalIdx: number; bagLocalIdx: number; fallback: Instr[] },
): Instr[] | undefined {
  const ensure = defineCarrierBagEnsureInstrs(ctx, opts.recvLocalIdx);
  if (ensure === undefined) return undefined;
  return [
    ...ensure,
    { op: "local.tee", index: opts.bagLocalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: opts.fallback },
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
  const isErrorIdx = ctx.funcMap.get(IS_ERROR_PROP_CARRIER);
  if (isClosureIdx === undefined && isErrorIdx === undefined) return undefined;
  const test = (idx: number | undefined): Instr[] =>
    idx === undefined
      ? [{ op: "i32.const", value: 0 }]
      : [
          { op: "local.get", index: localIdx },
          { op: "call", funcIdx: idx },
        ];
  return [...test(isClosureIdx), ...test(isErrorIdx), { op: "i32.or" }];
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
  const lookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);
  const isErrorIdx = ctx.funcMap.get(IS_ERROR_PROP_CARRIER);
  const errorLookupIdx = ctx.funcMap.get(ERROR_PROP_BAG_LOOKUP);
  if (
    (isClosureIdx === undefined || lookupIdx === undefined) &&
    (isErrorIdx === undefined || errorLookupIdx === undefined)
  ) {
    return undefined;
  }
  const carrierTest = isDefineCarrierInstrs(ctx, opts.propsLocalIdx);
  if (carrierTest === undefined) return undefined;
  const lookup: Instr[] =
    isClosureIdx !== undefined && lookupIdx !== undefined
      ? [
          { op: "local.get", index: opts.propsLocalIdx },
          { op: "call", funcIdx: isClosureIdx },
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
