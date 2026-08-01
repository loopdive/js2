// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared own-property BAG lookup for the reflective MOP helpers
 * (`--target standalone` / `--target wasi` only).
 *
 * ## Why this exists
 * #3468 (closures) and #3537 (arrays) each gave a non-`$Object` receiver a
 * runtime, identity-keyed side table mapping the receiver to a fresh `$Object`
 * "bag" that holds its named own properties. Both wired that bag into exactly
 * three helpers — `__extern_get`, `__extern_set`, `__extern_method_call` — so a
 * function/array expando WRITE sticks and a READ answers.
 *
 * The REFLECTIVE half of the MOP was never wired up. `__hasOwnProperty`,
 * `__object_hasOwn`, `__propertyIsEnumerable`, `__getOwnPropertyDescriptor` and
 * `__delete_property` all still open with `ref.test $Object` → early-return
 * "absent". Measured on 2026-08-01 (standalone, real runner):
 *
 * ```
 *  receiver            write→read  hasOwnProperty  gOPD  for-in
 *  {}                      R             H          D      E
 *  function(){}            R             .          .      .    ← bag exists, invisible
 *  []                      R             .          .      .    ← bag exists, invisible
 * ```
 *
 * That split is directly observable and directly breaks
 * `ToPropertyDescriptor` (§6.2.5.6): `__obj_define_from_desc` probes each
 * descriptor field with `__hasOwnProperty(desc, "get"|"set"|"value"|…)`, so a
 * descriptor object that is a FUNCTION or an ARRAY reads as the empty
 * descriptor even though `__extern_get` can see its fields — the test262
 * `Object.defineProperty(obj, "property", funObj)` / `Object.create(o, {p:
 * arrObj})` families (§8.10.5 step 8.a) silently define nothing.
 *
 * ## The fix
 * A receiver that carries a bag IS, for own-property purposes, that bag. So
 * instead of duplicating the `$Object` own-property logic per helper, each
 * non-`$Object` arm SUBSTITUTES the bag for the receiver and falls through into
 * the helper's existing, already-correct `$Object` path. One lookup, zero new
 * semantics.
 *
 * ## Byte-neutrality
 * `ownPropBagLookupInstrs` returns `undefined` unless at least one side table
 * was reserved — which only happens under `ctx.standalone || ctx.wasi`
 * (`ensureObjectRuntime`). Every call site keeps its exact pre-existing body
 * (and local vector) in gc/host mode, so host output stays byte-identical.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Reserved helper names owned by `vec-props.ts` (#3537). */
const IS_VEC_PROP_CARRIER = "__is_vec_prop_carrier";
const VEC_BAG_LOOKUP = "__vec_bag_lookup";
/** Reserved helper names owned by `closure-props.ts` (#3468). */
const IS_CLOSURE_PROP_CARRIER = "__is_closure_prop_carrier";
const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";

/**
 * Emit `[] -> [externref]`: the own-property bag `$Object` for the receiver in
 * local `recvLocalIdx`, or a NULL externref when the receiver carries no bag.
 *
 * Both underlying `*_bag_lookup` helpers are read-only (they never mint a bag)
 * and answer `ref.null.extern` on a miss, so a null result means "this receiver
 * has no own properties in a side table" — never "undefined".
 *
 * Returns `undefined` when neither side table is reserved (gc/host mode, or a
 * module whose object runtime was never built) — callers must then keep their
 * original body verbatim.
 */
export function ownPropBagLookupInstrs(ctx: CodegenContext, recvLocalIdx: number): Instr[] | undefined {
  const isVecIdx = ctx.funcMap.get(IS_VEC_PROP_CARRIER);
  const vecLookupIdx = ctx.funcMap.get(VEC_BAG_LOOKUP);
  const isClosureIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  const closureLookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);

  const hasVec = isVecIdx !== undefined && vecLookupIdx !== undefined;
  const hasClosure = isClosureIdx !== undefined && closureLookupIdx !== undefined;
  if (!hasVec && !hasClosure) return undefined;

  // closure branch (innermost fallback), then the vec branch wrapped around it.
  const closureArm: Instr[] = hasClosure
    ? [
        { op: "local.get", index: recvLocalIdx },
        { op: "call", funcIdx: isClosureIdx as number },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [
            { op: "local.get", index: recvLocalIdx },
            { op: "call", funcIdx: closureLookupIdx as number },
          ],
          else: [{ op: "ref.null.extern" }],
        },
      ]
    : [{ op: "ref.null.extern" }];

  if (!hasVec) return closureArm;

  return [
    { op: "local.get", index: recvLocalIdx },
    { op: "call", funcIdx: isVecIdx as number },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: recvLocalIdx },
        { op: "call", funcIdx: vecLookupIdx as number },
      ],
      else: closureArm,
    },
  ];
}

/**
 * Emit `[] -> [i32]`: is the receiver in `recvLocalIdx` a `$Vec` carrier
 * (#3537)? `undefined` when the array side table is absent.
 *
 * Used where a vec receiver must be routed to machinery that already knows
 * about vecs (the `__defineProperty_value` / `_accessor` #3251 overlay arms)
 * rather than to the bag.
 */
export function isVecCarrierInstrs(ctx: CodegenContext, recvLocalIdx: number): Instr[] | undefined {
  const isVecIdx = ctx.funcMap.get(IS_VEC_PROP_CARRIER);
  if (isVecIdx === undefined) return undefined;
  return [
    { op: "local.get", index: recvLocalIdx },
    { op: "call", funcIdx: isVecIdx },
  ];
}

/**
 * Emit `[] -> [externref]`: the closure receiver's own-property bag,
 * CREATING it when absent, or a null externref for a non-closure receiver.
 *
 * This is the write-side counterpart of {@link ownPropBagLookupInstrs} — used
 * when a define TARGET is a function object: the bag *is* the closure's own
 * property table (`__extern_get`/`__extern_set` consult exactly it), so
 * defining into the bag is defining on the function.
 */
export function closureBagEnsureInstrs(ctx: CodegenContext, recvLocalIdx: number): Instr[] | undefined {
  const isClosureIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  const ensureIdx = ctx.funcMap.get("__closure_bag_ensure");
  if (isClosureIdx === undefined || ensureIdx === undefined) return undefined;
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
      else: [{ op: "ref.null.extern" }],
    },
  ];
}

/**
 * Read-only, CLOSURE-ONLY variant of {@link bagSubstitutionArm}.
 *
 * Used by the key-ENUMERATION helpers (`__object_keys`, `__object_keys_forin`),
 * where a `$Vec` receiver must NOT be substituted: an array's enumerable own
 * keys are its indices, which live in the vec itself and are produced by the
 * dedicated vec for-in arms (#3183) — swapping in the named-expando bag would
 * hide them. A function object has no such alternative key source, so
 * substituting its bag is purely additive.
 */
export function closureBagLookupSubstitutionArm(
  ctx: CodegenContext,
  opts: { recvLocalIdx: number; anyLocalIdx: number; bagLocalIdx: number; fallback: Instr[] },
): Instr[] | undefined {
  const isClosureIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  const lookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);
  if (isClosureIdx === undefined || lookupIdx === undefined) return undefined;
  return [
    { op: "local.get", index: opts.recvLocalIdx },
    { op: "call", funcIdx: isClosureIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: opts.recvLocalIdx },
        { op: "call", funcIdx: lookupIdx },
      ],
      else: [{ op: "ref.null.extern" }],
    },
    { op: "local.tee", index: opts.bagLocalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: opts.fallback },
    { op: "local.get", index: opts.bagLocalIdx },
    { op: "any.convert_extern" },
    { op: "local.set", index: opts.anyLocalIdx },
  ];
}

/**
 * WRITE-side counterpart of {@link bagSubstitutionArm}, for the DEFINE
 * appliers: a closure receiver's own-property bag is CREATED on demand and
 * substituted for the receiver, so `Object.defineProperty(fn, k, desc)` stores
 * into the same table `__extern_get`/gOPD read from. Non-closure receivers run
 * `fallback` (the applier's pre-existing arm).
 *
 * Deliberately closure-only: `$Vec` receivers are owned by the #3251 overlay,
 * which the appliers consult BEFORE this arm and which knows about array
 * indices and `length`.
 */
export function closureBagSubstitutionArm(
  ctx: CodegenContext,
  opts: { recvLocalIdx: number; anyLocalIdx: number; bagLocalIdx: number; fallback: Instr[] },
): Instr[] | undefined {
  const ensure = closureBagEnsureInstrs(ctx, opts.recvLocalIdx);
  if (ensure === undefined) return undefined;
  return [
    ...ensure,
    { op: "local.tee", index: opts.bagLocalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: opts.fallback },
    { op: "local.get", index: opts.bagLocalIdx },
    { op: "any.convert_extern" },
    { op: "local.set", index: opts.anyLocalIdx },
  ];
}

/**
 * The standard non-`$Object` prologue for a reflective own-property helper.
 *
 * Emits (all inside the caller's existing `if (!ref.test $Object)` arm):
 *
 * ```wat
 *   bag := ownPropBagLookup(recv)
 *   if bag == null            ;; no side-table bag → the helper's original arm
 *     <fallback>              ;; (which must return / trap on its own)
 *   end
 *   any := any.convert_extern(bag)   ;; SUBSTITUTE: the bag *is* the own-prop map
 *   ;; falls through into the helper's unchanged `$Object` path
 * ```
 *
 * `anyLocalIdx` is the helper's cached `any.convert_extern(obj)` local — the one
 * its `$Object` path casts. `bagLocalIdx` must be a fresh externref local
 * APPENDED to the helper's local vector (appending never shifts an existing
 * index).
 *
 * Returns `undefined` when the substrate is absent; the caller then emits
 * `fallback` verbatim, preserving its exact pre-existing encoding.
 */
export function bagSubstitutionArm(
  ctx: CodegenContext,
  opts: { recvLocalIdx: number; anyLocalIdx: number; bagLocalIdx: number; fallback: Instr[] },
): Instr[] | undefined {
  const lookup = ownPropBagLookupInstrs(ctx, opts.recvLocalIdx);
  if (lookup === undefined) return undefined;
  return [
    ...lookup,
    { op: "local.tee", index: opts.bagLocalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: opts.fallback },
    // Bag present — re-point the helper's `$Object` receiver at it.
    { op: "local.get", index: opts.bagLocalIdx },
    { op: "any.convert_extern" },
    { op: "local.set", index: opts.anyLocalIdx },
  ];
}
