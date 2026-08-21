// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3251 S1) Standalone array-descriptor OVERLAY substrate.
 *
 * Under `--target standalone`, arrays are WasmGC `__vec_<k>` structs
 * (`{length: i32, data: (ref $arr)}` subtyping `$__vec_base`) with NO
 * per-index / expando property-descriptor storage. Every descriptor-bearing
 * array operation (`Object.defineProperty(arr, idx, d)`, accessor get on an
 * index, `getOwnPropertyDescriptor`, redefine-legality TypeErrors) was a
 * silent lenient no-op — the `ref.test $Object` gate at the top of the
 * `__defineProperty_value` / `__defineProperty_accessor` /
 * `__getOwnPropertyDescriptor` natives returned early for vec receivers.
 *
 * ## Design (see plan/issues/3251-*.md "Implementation Plan")
 *
 * Each vec receiver that is the target of a descriptor operation gets a
 * **companion plain `$Object`**, held in a module-global side table keyed by
 * vec identity (`ref.eq` scan; defineProperty-on-array is rare, so the table
 * is almost always empty/tiny and gated behind a single
 * `global.get $__vec_overlay_state ; ref.is_null` fast check). Because the
 * companion is an ordinary `$Object`, the vec arms DELEGATE every hard part —
 * §10.1.6.3 ValidateAndApplyPropertyDescriptor (the #2042 S4 preflight),
 * partial-descriptor merge (#2992 S3), CompletePropertyDescriptor defaults,
 * and descriptor materialisation — to the already-correct `$Object` natives.
 *
 * Coherence rules:
 *  - Data-define VALUES are written back INTO the vec element (per-carrier
 *    `__vec_elem_set_<t>`, which also handles OOB growth + length update) so
 *    the typed inline `array.get` fast path stays coherent with zero read
 *    overhead — the #3116 host-mode trick, natively. Kind-incompatible values
 *    (a string value into a `__vec_f64`) skip the write-back and set
 *    `FLAG_COMPANION_VALUE` on the companion `$PropEntry` so dynamic readers
 *    prefer the companion value.
 *  - An IN-BOUNDS index with no companion entry is a REAL element: it is
 *    SEEDED into the companion as `{value: vec[i], w/e/c: true}` before the
 *    delegated define, so redefine-legality validates against the spec's
 *    implicit element descriptor. Fresh (out-of-bounds) indices are first
 *    definitions → CompletePropertyDescriptor defaults (all false) — which is
 *    why the typed call-site vec pre-growth is standalone-gated off in
 *    object-ops.ts (it destroyed the real-element/fresh-hole distinction,
 *    #3116 regression class 1).
 *  - Dynamic reads (`__extern_get_idx` — the single chokepoint the `arr[i]`
 *    any-lane AND every `__hof_*` loop read through; plus the `__extern_get`
 *    string-key lane) get a finalize-spliced overlay prologue: accessor
 *    entries invoke their getter via `__call_accessor_get` with the ORIGINAL
 *    vec receiver as `this`; `FLAG_COMPANION_VALUE` entries answer from the
 *    companion; plain data entries FALL THROUGH to the vec read (the vec is
 *    authoritative — synced at define time, and later plain writes keep it
 *    fresh where the companion would go stale).
 *  - `"length"` keys keep the legacy no-op/miss — ArraySetLength (§10.4.2.1)
 *    is slice 3.
 *  - Accessor defines do NOT extend the vec length for OOB indices (the
 *    #3116 15.2.3.6-4-312 hole-materialisation lesson) — deferred with
 *    ArraySetLength.
 *
 * ## Emission-order discipline
 *
 * The descriptor natives are built EARLY (`ensureObjectRuntime` →
 * `buildObjectDescriptorHelpers`), but the per-carrier vec types and index
 * helpers are only complete at FINALIZE. So the arms baked early are a single
 * `ref.test $__vec_base → call <reserved helper> → return`, with the helper
 * funcIdx reserved via the proven accessor-driver pattern (mintDefinedFunc +
 * placeholder body + funcMap routing, #1888 S5b / #329 / #1899 contract). The
 * placeholders are SAFE NO-OPS (`return obj` / `return null-extern`), NOT
 * `unreachable`, so a skipped fill degrades to today's lenient behaviour
 * instead of trapping. `fillVecOverlayHelpers` (index.ts finalize, after
 * `fillDynamicForinVecArms`) fills the real bodies, mints the overlay-core
 * lookup/ensure natives (append-only defined funcs — no funcIdx shifts, the
 * `ensureVecElemSet` discipline), registers the overlay types + state global,
 * and splices the read prologues (append-locals, splice-front, fresh Instr
 * factories per `reference_shared_instr_object_dce_double_remap`).
 *
 * Host/gc mode: `reserveVecOverlayHelpers` is only invoked under
 * `ctx.standalone` (see buildObjectDescriptorHelpers) and the fill gates on
 * the reserve flag — host output is byte-identical.
 */
import { inheritedSetAnyDirty } from "./inherited-set-gate.js"; // (#4602) per-key #4504 gate
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecBaseType } from "./registry/types.js";
import { ensureExnTag, nextModuleGlobalIdx } from "./registry/imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { reserveAccessorGetDriver } from "./accessor-driver.js";
import { ensureVecElemSet } from "./vec-elem-set.js";
import {
  buildBagGopdOrMiss,
  buildBagValueSeed,
  buildRealElementSeed,
  buildVecDeletePrologue,
  fillVecHasOwnHelpers,
} from "./vec-bag-seed.js";
import { buildVecHasIdxPresencePrologue } from "./vec-overlay-presence.js";
import {
  protoIndexGetIdxMissInstrs,
  protoIndexHasIdxInstrs,
  SET_DECISION_HANDLED,
  SET_DECISION_REFUSED,
} from "./proto-index-store.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { nonExtensibleFreshIndexGuard, nonWritableLengthIndexGuard } from "./vec-define-rejections.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { canonicalNumericKeyGuard } from "./vec-index-domain.js"; // (#4434) index domain + sparse tail
import { holeTestInstrs } from "./array-holes.js";

/**
 * `$PropEntry.$flags` bit claimed by the overlay (see the flag table in
 * object-runtime.ts — 0x01/0x02/0x04 = W/E/C, 0x08 = ACCESSOR, 0x10 =
 * INTERNAL, 0x40 = DELETED_INDEX, 0x80 = TOMBSTONE): set on a companion DATA
 * entry whose [[Value]] could NOT be written back into the vec element
 * (kind-incompatible with the carrier), so dynamic readers must answer from
 * the companion instead of the vec.
 */
export const FLAG_COMPANION_VALUE = 0x20;
const FLAG_DELETED_INDEX = 0x40;

// Mirrors of the (unexported) object-runtime flag ABI — stable since #1888.
const FLAG_WRITABLE = 0x01;
const FLAG_ENUMERABLE = 0x02;
const FLAG_CONFIGURABLE = 0x04;
const FLAG_ACCESSOR = 0x08;

/** Host f64 flag-word bits (computeRuntimeFlags, object-ops.ts). */
const HOST_HAS_VALUE = 1 << 7;
/**
 * Flag word for SEEDING an implicit array element into the companion:
 * `{value, writable: true, enumerable: true, configurable: true}` with all
 * three attributes + the value marked as specified
 * (bits 0-2 values, 3-5 specified, 7 hasValue = 0xBF).
 */
const SEED_FLAGS = 0xbf;

/**
 * WasmGC `none` abstract heap type (bottom of the anyref hierarchy, binary
 * 0x71 = signed-LEB -15). NOTE: object-runtime.ts' `NONE_HEAP = -18` is the
 * `any` heap type (valid there only because it feeds anyref-typed slots); a
 * `ref.null any` does NOT satisfy a concrete `(ref null $T)` global/result —
 * V8 rejects the constant expression. `ref.null none` is `(ref null none)`,
 * a subtype of every nullable ref type.
 */
const NONE_HEAP = -15;

const DP_VALUE_NAME = "__vec_dp_value";
const DP_ACCESSOR_NAME = "__vec_dp_accessor";
const GOPD_NAME = "__vec_gopd";
const LOOKUP_NAME = "__vec_overlay_lookup";
const ENSURE_NAME = "__vec_overlay_ensure";
const ENSURE_FRESH_NAME = "__vec_overlay_ensure_fresh"; // (#3673 round 15)
const PRIME_NAME = "__vec_overlay_prime"; // (#3673 round 15)

/** Reserved helper funcIdxs handed to the descriptor-native builders. */
export interface VecOverlayReserved {
  dpValueIdx: number;
  dpAccessorIdx: number;
  gopdIdx: number;
}

/**
 * Reserve the three overlay entry points as placeholder defined funcs so the
 * `__defineProperty_value` / `__defineProperty_accessor` /
 * `__getOwnPropertyDescriptor` vec arms can bake their `call` at
 * object-runtime-emit time. Idempotent. Standalone callers only.
 */
export function reserveVecOverlayHelpers(ctx: CodegenContext): VecOverlayReserved {
  const existing = ctx.funcMap.get(DP_VALUE_NAME);
  if (existing !== undefined) {
    return {
      dpValueIdx: existing,
      dpAccessorIdx: ctx.funcMap.get(DP_ACCESSOR_NAME)!,
      gopdIdx: ctx.funcMap.get(GOPD_NAME)!,
    };
  }
  const ext: ValType = { kind: "externref" };
  const f64: ValType = { kind: "f64" };
  const reserve = (name: string, params: ValType[], placeholderBody: Instr[]): number => {
    const sigIdx = addFuncType(ctx, params, [ext], `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const placeholder: WasmFunction = {
      name,
      typeIdx: sigIdx,
      locals: [],
      // SAFE NO-OP placeholder (NOT `unreachable`): if the finalize fill is
      // skipped (missing deps), a vec define degrades to the legacy lenient
      // no-op and gOPD to the legacy undefined-miss — never a trap.
      body: placeholderBody,
      exported: false,
    };
    pushDefinedFunc(ctx, funcIdx, placeholder);
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  };
  const dpValueIdx = reserve(DP_VALUE_NAME, [ext, ext, ext, f64], [{ op: "local.get", index: 0 }]);
  const dpAccessorIdx = reserve(DP_ACCESSOR_NAME, [ext, ext, ext, ext, f64], [{ op: "local.get", index: 0 }]);
  const gopdIdx = reserve(GOPD_NAME, [ext, ext], [{ op: "ref.null.extern" }]);
  ctx.vecOverlayReserved = true;
  // The read-prologue fill invokes stored getters through the accessor-get
  // driver — reserve it now (idempotent) so its funcIdx is stable.
  reserveAccessorGetDriver(ctx);
  return { dpValueIdx, dpAccessorIdx, gopdIdx };
}

/** JS-array element carriers the overlay serves (TypedArray storage + subviews
 *  keep the legacy no-op — integer-indexed-exotic semantics are out of scope). */
interface OverlayCarrier {
  vecTypeIdx: number;
  arrTypeIdx: number;
  elemType: ValType;
  kind: "f64" | "externref" | "anystr";
}

function allowedCarriers(ctx: CodegenContext): OverlayCarrier[] {
  const seen = new Set<number>();
  const out: OverlayCarrier[] = [];
  const addCarrier = (vecTypeIdx: number): void => {
    if (seen.has(vecTypeIdx)) return;
    seen.add(vecTypeIdx);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) return;
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") return;
    const elemType = arrDef.element as ValType;
    if (elemType.kind === "f64") {
      out.push({ vecTypeIdx, arrTypeIdx, elemType, kind: "f64" });
    } else if (elemType.kind === "externref") {
      out.push({ vecTypeIdx, arrTypeIdx, elemType, kind: "externref" });
    } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
      const ti = (elemType as { typeIdx: number }).typeIdx;
      if (ti >= 0 && (ti === ctx.anyStrTypeIdx || ti === ctx.nativeStrTypeIdx)) {
        out.push({ vecTypeIdx, arrTypeIdx, elemType, kind: "anystr" });
      }
    }
  };
  for (const vecTypeIdx of ctx.vecTypeMap.values()) {
    addCarrier(vecTypeIdx);
  }
  // `$ObjVec` is the growable externref-array carrier used by Object
  // enumeration and RegExp `d`-flag indices. It deliberately lives outside
  // `vecTypeMap`, but is still a genuine Array and therefore participates in
  // the same dense-index and named-property descriptor overlay.
  const objVec = ctx.objectRuntimeTypes;
  if (objVec) addCarrier(objVec.objVecTypeIdx);
  // RegExp exec results are an extended native-string vec subtype rather than
  // a direct `vecTypeMap` entry. Include that exact exotic so its spec own
  // properties (`index`, `input`, `groups`, `indices`) can be materialised in
  // the overlay without broadening the carrier whitelist to arbitrary structs.
  const regexpMatchVecTypeIdx = ctx.structMap.get("__regexp_match_vec");
  if (regexpMatchVecTypeIdx !== undefined) {
    addCarrier(regexpMatchVecTypeIdx);
  }
  out.sort((a, b) => a.vecTypeIdx - b.vecTypeIdx);
  return out;
}

/** Overlay-core state minted by the fill (types, global, lookup/ensure). */
interface OverlayCore {
  stateTypeIdx: number;
  stateGlobalIdx: number;
  /**
   * (#3673) i32 flag global: 1 once ANY companion define used a NUMERIC
   * (array-index) key. The `__extern_get_idx` prologue gates on THIS instead
   * of the state global: string-key-only companions (the standalone RegExp
   * result arrays define `index`/`input`/`groups`/`indices` per exec, growing
   * the scan table unboundedly) then cost indexed reads nothing. The
   * `__extern_get` string lane keeps gating on the state global.
   */
  numericFlagGlobalIdx: number;
  lookupIdx: number;
  ensureIdx: number;
}

/**
 * Register the overlay side-table types + state global and mint the
 * `__vec_overlay_lookup` / `__vec_overlay_ensure` natives. FINALIZE-time only
 * (append-only defined funcs — no existing funcIdx shifts; types referenced
 * exclusively from bodies written in this same pass). Idempotent.
 */
function ensureOverlayCore(ctx: CodegenContext, objectTypeIdx: number, newPlainObjectIdx: number): OverlayCore {
  const existingLookup = ctx.funcMap.get(LOOKUP_NAME);
  if (existingLookup !== undefined && ctx.vecOverlayStateGlobalIdx !== undefined) {
    return {
      stateTypeIdx: ctx.vecOverlayStateTypeIdx!,
      stateGlobalIdx: ctx.vecOverlayStateGlobalIdx,
      numericFlagGlobalIdx: ctx.vecOverlayNumericGlobalIdx!,
      lookupIdx: existingLookup,
      ensureIdx: ctx.funcMap.get(ENSURE_NAME)!,
    };
  }

  // ── Types ────────────────────────────────────────────────────────────────
  const pairTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__overlay_pair",
    fields: [
      // The vec receiver, held as anyref for identity-only `ref.eq` compares.
      { name: "vec", type: { kind: "anyref" }, mutable: false },
      { name: "companion", type: { kind: "ref", typeIdx: objectTypeIdx }, mutable: false },
    ],
  });
  const tabTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "$__overlay_tab",
    element: { kind: "ref_null", typeIdx: pairTypeIdx },
    mutable: true,
  });
  const stateTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__overlay_state",
    fields: [
      { name: "count", type: { kind: "i32" }, mutable: true },
      { name: "tab", type: { kind: "ref", typeIdx: tabTypeIdx }, mutable: true },
    ],
  });

  // ── State global (null until the first companion is created) ────────────
  const stateGlobalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__vec_overlay_state",
    type: { kind: "ref_null", typeIdx: stateTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: NONE_HEAP }],
  });
  ctx.vecOverlayStateGlobalIdx = stateGlobalIdx;
  ctx.vecOverlayStateTypeIdx = stateTypeIdx;

  // (#3673) numeric-key-companion flag — see OverlayCore.numericFlagGlobalIdx.
  const numericFlagGlobalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__vec_overlay_numeric",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.vecOverlayNumericGlobalIdx = numericFlagGlobalIdx;

  const objRefNull: ValType = { kind: "ref_null", typeIdx: objectTypeIdx };

  // ── __vec_overlay_lookup(anyref vec) -> (ref null $Object) ──────────────
  // params: 0=vec(anyref); locals: 1=st 2=tab 3=i 4=count 5=pair
  {
    const sigIdx = addFuncType(ctx, [{ kind: "anyref" }], [objRefNull], `$${LOOKUP_NAME}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const body: Instr[] = [
      // st = state ; if st == null → null (the fast path for overlay-free runs)
      { op: "global.get", index: stateGlobalIdx },
      { op: "local.tee", index: 1 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null", typeIdx: NONE_HEAP }, { op: "return" }],
      },
      { op: "local.get", index: 1 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 1 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // (#3673 round 14) Scan NEWEST-FIRST (count-1 → 0). `__vec_overlay_ensure`
      // appends at tab[count], and the hot probes — the standalone regex-exec
      // path defining/reading `index`/`input` on a FRESH match array — always
      // target the most recently ensured pair, which the old forward scan
      // reached only after walking every older (usually dead) entry. The table
      // is append-only (identity pairs, no eviction), so as it grows across a
      // run the forward scan degraded superlinearly; newest-first makes the
      // common hit O(1) regardless of table size. Identities are unique, so
      // scan order cannot change which pair matches.
      { op: "local.get", index: 4 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 0 },
              { op: "i32.lt_s" },
              { op: "br_if", depth: 1 },
              // pair = tab[i] ; if (pair.vec ref.eq vec) → pair.companion
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 3 },
              { op: "array.get", typeIdx: tabTypeIdx },
              { op: "local.tee", index: 5 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: pairTypeIdx, fieldIdx: 0 },
              // ref.eq operands must be eqref — struct refs are.
              { op: "ref.cast", typeIdx: -19 /* eq */ },
              { op: "local.get", index: 0 },
              { op: "ref.cast", typeIdx: -19 /* eq */ },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 5 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: pairTypeIdx, fieldIdx: 1 },
                  { op: "return" },
                ],
              },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "ref.null", typeIdx: NONE_HEAP },
    ];
    pushDefinedFunc(ctx, funcIdx, {
      name: LOOKUP_NAME,
      typeIdx: sigIdx,
      locals: [
        { name: "st", type: { kind: "ref_null", typeIdx: stateTypeIdx } },
        { name: "tab", type: { kind: "ref_null", typeIdx: tabTypeIdx } },
        { name: "i", type: { kind: "i32" } },
        { name: "count", type: { kind: "i32" } },
        { name: "pair", type: { kind: "ref_null", typeIdx: pairTypeIdx } },
      ],
      body,
      exported: false,
    });
    ctx.funcMap.set(LOOKUP_NAME, funcIdx);
  }
  const lookupIdx = ctx.funcMap.get(LOOKUP_NAME)!;

  // Shared append tail for `__vec_overlay_ensure` (post-lookup-miss) and
  // (#3673 round 15) `__vec_overlay_ensure_fresh` (no lookup — the caller
  // GUARANTEES the vec is brand-new, e.g. a regex match result right after
  // construction, so a table scan would only ever miss). Built per call so
  // the two natives never share Instr object identities.
  const buildEnsureAppendBody = (): Instr[] => [
    // st = state ; if null → state = {count: 0, tab: new [4]}
    { op: "global.get", index: stateGlobalIdx },
    { op: "local.tee", index: 2 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "i32.const", value: 4 },
        { op: "array.new_default", typeIdx: tabTypeIdx },
        { op: "struct.new", typeIdx: stateTypeIdx },
        { op: "local.tee", index: 2 },
        { op: "global.set", index: stateGlobalIdx },
      ],
    },
    // count / tab / cap
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: 3 },
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "array.len" },
    { op: "local.set", index: 5 },
    // grow when count == cap
    { op: "local.get", index: 4 },
    { op: "local.get", index: 5 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 5 },
        { op: "i32.const", value: 2 },
        { op: "i32.mul" },
        { op: "array.new_default", typeIdx: tabTypeIdx },
        { op: "local.set", index: 6 },
        { op: "local.get", index: 6 },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 3 },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 4 },
        { op: "array.copy", dstTypeIdx: tabTypeIdx, srcTypeIdx: tabTypeIdx },
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 6 },
        { op: "ref.as_non_null" },
        { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 6 },
        { op: "local.set", index: 3 },
      ],
    },
    // compNN = fresh $Object (via the plain-object native, cast back down)
    { op: "call", funcIdx: newPlainObjectIdx },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: 7 },
    // tab[count] = {vec, compNN} ; state.count = count + 1
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 4 },
    { op: "local.get", index: 0 },
    { op: "local.get", index: 7 },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: pairTypeIdx },
    { op: "array.set", typeIdx: tabTypeIdx },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 4 },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: 7 },
    { op: "ref.as_non_null" },
  ];
  const ensureLocals = (): { name: string; type: ValType }[] => [
    { name: "comp", type: objRefNull },
    { name: "st", type: { kind: "ref_null", typeIdx: stateTypeIdx } },
    { name: "tab", type: { kind: "ref_null", typeIdx: tabTypeIdx } },
    { name: "count", type: { kind: "i32" } },
    { name: "cap", type: { kind: "i32" } },
    { name: "newTab", type: { kind: "ref_null", typeIdx: tabTypeIdx } },
    { name: "compNN", type: objRefNull },
  ];

  // ── __vec_overlay_ensure(anyref vec) -> (ref $Object) ────────────────────
  // params: 0=vec; locals: 1=comp 2=st 3=tab 4=count 5=cap 6=newTab 7=compNN
  {
    const sigIdx = addFuncType(
      ctx,
      [{ kind: "anyref" }],
      [{ kind: "ref", typeIdx: objectTypeIdx }],
      `$${ENSURE_NAME}_type`,
    );
    const funcIdx = mintDefinedFunc(ctx);
    const body: Instr[] = [
      // comp = lookup(vec) ; hit → return
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: 1 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 1 }, { op: "ref.as_non_null" }, { op: "return" }],
      },
      ...buildEnsureAppendBody(),
    ];
    pushDefinedFunc(ctx, funcIdx, {
      name: ENSURE_NAME,
      typeIdx: sigIdx,
      locals: ensureLocals(),
      body,
      exported: false,
    });
    ctx.funcMap.set(ENSURE_NAME, funcIdx);
  }

  // ── (#3673 round 15) __vec_overlay_ensure_fresh(anyref vec) -> (ref $Object)
  // The append tail WITHOUT the lookup. Sound only when the vec provably has
  // no existing companion — the regex match-result builder calls it via the
  // reserved `__vec_overlay_prime` immediately after constructing the result,
  // so the subsequent per-match `index`/`input`/`groups` defines hit the
  // freshly appended pair at tab[count-1] on the newest-first scan (O(1))
  // instead of each paying a full-table miss scan.
  {
    const sigIdx = addFuncType(
      ctx,
      [{ kind: "anyref" }],
      [{ kind: "ref", typeIdx: objectTypeIdx }],
      `$${ENSURE_FRESH_NAME}_type`,
    );
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: ENSURE_FRESH_NAME,
      typeIdx: sigIdx,
      locals: ensureLocals(),
      body: buildEnsureAppendBody(),
      exported: false,
    });
    ctx.funcMap.set(ENSURE_FRESH_NAME, funcIdx);
  }

  // Fill the reserved `__vec_overlay_prime` placeholder (reserved at regex
  // match-result compile time; no-op body until the core exists).
  {
    const primeFn = ctx.mod.functions.find((f) => f.name === PRIME_NAME);
    const freshIdx = ctx.funcMap.get(ENSURE_FRESH_NAME);
    if (primeFn && freshIdx !== undefined) {
      primeFn.body = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "call", funcIdx: freshIdx },
        { op: "drop" },
      ];
    }
  }

  return { stateTypeIdx, stateGlobalIdx, numericFlagGlobalIdx, lookupIdx, ensureIdx: ctx.funcMap.get(ENSURE_NAME)! };
}

/**
 * (#3673 round 15) Reserve the `__vec_overlay_prime(externref) -> ()` no-op
 * placeholder at a match-result construction site. Filled by
 * `ensureOverlayCore` at finalize to call `__vec_overlay_ensure_fresh` —
 * pre-appending the fresh vec's companion so the immediately following
 * descriptor defines skip the full-table miss scan. When the overlay core is
 * never built (no descriptor ops anywhere), the placeholder stays a no-op.
 */
export function reserveVecOverlayPrime(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(PRIME_NAME);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(ctx, [{ kind: "externref" }], [], `$${PRIME_NAME}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: PRIME_NAME,
    typeIdx: sigIdx,
    locals: [],
    body: [],
    exported: false,
  });
  ctx.funcMap.set(PRIME_NAME, funcIdx);
  return funcIdx;
}

/**
 * Finalize fill for the #3251 overlay: real bodies for the reserved
 * `__vec_dp_value` / `__vec_dp_accessor` / `__vec_gopd`, plus the overlay
 * read prologues in `__extern_get_idx` / `__extern_get`. Runs after
 * `fillDynamicForinVecArms` in index.ts so every carrier type + index helper
 * exists; no funcIdx churn (in-place body edits + append-only mints).
 */
export function fillVecOverlayHelpers(ctx: CodegenContext): void {
  if (!ctx.vecOverlayReserved || !ctx.standalone) return;
  const types = ctx.objectRuntimeTypes;
  if (!types) return;
  const { objectTypeIdx, propEntryTypeIdx } = types;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx < 0) return;
  // Required deps — resolved by NAME so late-import shifts can never desync.
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const dpValueIdx = ctx.funcMap.get("__defineProperty_value");
  const dpAccessorIdx = ctx.funcMap.get("__defineProperty_accessor");
  const gopdObjectIdx = ctx.funcMap.get("__getOwnPropertyDescriptor");
  const deletePropertyIdx = ctx.funcMap.get("__delete_property");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externIsUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
  const unboxBoolIdx = ctx.funcMap.get("__unbox_boolean");
  const toPropertyKeyIdx = ctx.funcMap.get("__to_property_key");
  const objIndexOfKeyIdx = ctx.funcMap.get("__obj_index_of_key");
  const numToStringIdx = ctx.funcMap.get("number_toString");
  const callAccessorGetIdx = ctx.funcMap.get("__call_accessor_get");
  const callAccessorSetIdx = ctx.funcMap.get("__call_accessor_set");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (
    objFindIdx === undefined ||
    dpValueIdx === undefined ||
    dpAccessorIdx === undefined ||
    gopdObjectIdx === undefined ||
    deletePropertyIdx === undefined ||
    externGetIdx === undefined ||
    externIsUndefinedIdx === undefined ||
    externGetIdxIdx === undefined ||
    externSetIdx === undefined ||
    newPlainObjectIdx === undefined ||
    boxBoolIdx === undefined ||
    unboxBoolIdx === undefined ||
    toPropertyKeyIdx === undefined ||
    objIndexOfKeyIdx === undefined ||
    numToStringIdx === undefined ||
    callAccessorGetIdx === undefined ||
    callAccessorSetIdx === undefined ||
    strFlattenIdx === undefined ||
    strEqualsIdx === undefined
  ) {
    return; // placeholders stay as safe no-ops
  }

  const carriers = allowedCarriers(ctx);
  if (carriers.length === 0) return;
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  const core = ensureOverlayCore(ctx, objectTypeIdx, newPlainObjectIdx);
  // #4504 only needs this extra logical-own screen in modules that can observe
  // an inherited descriptor. Keep the historical gOPD/hasOwn tree untouched
  // otherwise; the existing `$Hole` carrier is still used by the write path
  // below when this gate is armed.
  const inheritedSetHolePresenceActive = inheritedSetAnyDirty(ctx) && ctx.usesArrayHoles;

  const findFn = (name: string) => ctx.mod.functions.find((f) => f.name === name);
  const missExtern = (): Instr[] => undefinedExternInstrs(ctx)?.map((i) => ({ ...i })) ?? [{ op: "ref.null.extern" }];

  /** `if !(any-local is an allowed JS-array carrier) → <bail>` */
  const carrierWhitelistGuard = (anyLocal: number, bail: Instr[]): Instr[] => {
    const orChain: Instr[] = [];
    carriers.forEach((c, i) => {
      orChain.push({ op: "local.get", index: anyLocal }, { op: "ref.test", typeIdx: c.vecTypeIdx });
      if (i > 0) orChain.push({ op: "i32.or" });
    });
    return [...orChain, { op: "i32.eqz" }, { op: "if", blockType: { kind: "empty" }, then: bail }];
  };

  /** `if key (externref local) is not an $AnyString → <bail>` */
  const stringKeyGuard = (keyLocal: number, bail: Instr[]): Instr[] => [
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: bail },
  ];

  /** `if key == "length" → <bail>` (key known to be $AnyString). */
  const lengthKeyGuard = (keyLocal: number, bail: Instr[]): Instr[] => [
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: strFlattenIdx },
    ...nativeStringLiteralInstrs(ctx, "length"),
    { op: "call", funcIdx: strEqualsIdx },
    { op: "if", blockType: { kind: "empty" }, then: bail },
  ];

  /** Push the `"length"` property key as an externref `$AnyString`. */
  const lengthLitExtern = (): Instr[] => [...nativeStringLiteralInstrs(ctx, "length"), { op: "extern.convert_any" }];

  /**
   * (#3251 S3) Run `inner` only when the (non-null, $AnyString) key at
   * `keyLocal` is NOT `"length"` — the overlay read prologues must never
   * answer `"length"` from a companion entry (the live vec length field is
   * authoritative; a companion copy goes stale on push/pop/plain writes).
   * Inverse of `lengthKeyGuard`.
   */
  const notLengthWrap = (keyLocal: number, inner: Instr[]): Instr[] => [
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: strFlattenIdx },
    ...nativeStringLiteralInstrs(ctx, "length"),
    { op: "call", funcIdx: strEqualsIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: inner },
  ];

  /**
   * (#4434) Mark the module as carrying an indexed-lane-reachable companion
   * entry when the key is a canonical numeric STRING that is not an array
   * index (`"4294967295"`, `"4294967296"`, `"1e21"`).
   *
   * The `__extern_get_idx` prologue is gated on this flag, and the define path
   * set it only for keys with an index `>= 0` — but `arr[4294967295]` reaches
   * that same prologue as an f64 whose `number_toString` is the stored key. So
   * the flag has to follow reachability, not index-ness; see
   * `canonicalNumericKeyGuard`'s doc comment. Returns `[]` (no-op) when
   * `__str_to_number` is unavailable, leaving today's behaviour.
   */
  const markNumericLikeNamedKey = (keyLocal: number, scratchF64: number): Instr[] => {
    const strToNumberIdx = ctx.funcMap.get("__str_to_number");
    if (strToNumberIdx === undefined) return [];
    return canonicalNumericKeyGuard(
      keyLocal,
      scratchF64,
      {
        strToNumber: strToNumberIdx,
        numberToString: numToStringIdx,
        strFlatten: strFlattenIdx,
        strEquals: strEqualsIdx,
        anyStrTypeIdx,
      },
      [
        { op: "i32.const", value: 1 },
        { op: "global.set", index: core.numericFlagGlobalIdx },
      ],
    );
  };

  /** `idxLocal = __obj_index_of_key(cast key)` — canonical array index or -1. */
  const parseIndex = (keyLocal: number, idxLocal: number): Instr[] => [
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: objIndexOfKeyIdx },
    { op: "local.set", index: idxLocal },
  ];

  /** vec length via the `$__vec_base` supertype (field 0). */
  const vecLen = (anyLocal: number, lenLocal: number): Instr[] => [
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: vecBaseIdx },
    { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
    { op: "local.set", index: lenLocal },
  ];

  /**
   * (#4434) The BACKED length — `min(vec.length, array.len(vec.data))`.
   *
   * `vecLen` answers the LOGICAL length, which is what §10.4.2.2's
   * at-or-beyond-length rejections must compare against, so it deliberately
   * stays as it is. But the two places that ask "is index `i` a REAL, already
   * existing element?" must use the physical bound instead: the `a.length = N`
   * setter can push the logical length past the backing (vec-index-domain.ts
   * §2), and an index in that tail is a HOLE — it has no implicit
   * `{value, w/e/c: true}` descriptor to seed or to report, and reading it to
   * find one is exactly the `array.get` that trapped.
   *
   * Per-carrier because `data`'s array type is not on `$__vec_base`. The
   * fallthrough (no carrier matched) leaves `lenLocal` at the logical length —
   * unreachable in practice, since every caller sits behind
   * `carrierWhitelistGuard`, and it degrades to the previous behaviour rather
   * than to zero.
   */
  const vecBackedLen = (anyLocal: number, lenLocal: number): Instr[] => {
    const arms: Instr[] = [];
    for (const c of carriers) {
      const capacity = (): Instr[] => [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: c.vecTypeIdx },
        { op: "struct.get", typeIdx: c.vecTypeIdx, fieldIdx: 1 },
        { op: "array.len", typeIdx: c.arrTypeIdx } as Instr,
      ];
      arms.push(
        { op: "local.get", index: anyLocal },
        { op: "ref.test", typeIdx: c.vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // if array.len(data) < len → len = array.len(data)
            ...capacity(),
            { op: "local.get", index: lenLocal },
            { op: "i32.lt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...capacity(), { op: "local.set", index: lenLocal }],
            },
          ],
        },
      );
    }
    return [...vecLen(anyLocal, lenLocal), ...arms];
  };

  const clearDeletedIndexMarker = (l: {
    comp: number;
    compExt: number;
    key: number;
    entry: number;
    wasDeleted: number;
  }): Instr[] => [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: l.wasDeleted },
    { op: "local.get", index: l.comp },
    { op: "ref.as_non_null" },
    { op: "local.get", index: l.key },
    { op: "call", funcIdx: objFindIdx },
    { op: "local.tee", index: l.entry },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: l.entry },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
        { op: "i32.const", value: FLAG_DELETED_INDEX },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 1 },
            { op: "local.set", index: l.wasDeleted },
            { op: "local.get", index: l.compExt },
            { op: "local.get", index: l.key },
            { op: "call", funcIdx: deletePropertyIdx },
            { op: "drop" },
          ],
        },
      ],
    },
  ];

  /**
   * Per-carrier "grow to index i with the carrier default" arms —
   * `__vec_elem_set_<t>(vec, i, default)` extends the backing array + length
   * to i+1 (§10.4.2 [[DefineOwnProperty]] at an index ≥ length sets length to
   * index+1 REGARDLESS of descriptor kind). Used for OOB ACCESSOR defines and
   * OOB kind-incompatible DATA defines, whose value lives in the companion —
   * the vec slot itself is dead (the read prologue answers first), it only
   * has to exist so length/iteration see the index. Intermediate holes read
   * as the carrier default (null/0) rather than undefined — the documented
   * S1/S3 boundary (real hole semantics ride with ArraySetLength, and the
   * dominant cluster shape `var arr = []` is an externref carrier whose null
   * default observes as undefined-ish).
   */
  const growDefaultArms = (anyLocal: number, idxLocal: number, externAsUndefined = false): Instr[] => {
    const arms: Instr[] = [];
    for (const c of carriers) {
      const elemSetIdx = ensureVecElemSet(ctx, c.vecTypeIdx);
      if (elemSetIdx === null) continue;
      const defaultVal: Instr[] =
        c.kind === "f64"
          ? [{ op: "f64.const", value: 0 }]
          : c.kind === "externref"
            ? // (#4491) A DATA define with no [[Value]] gives the property
              // `undefined` (CompletePropertyDescriptor), not the carrier's
              // null hole — `arr[0]` must read `undefined`. Opt-in, so the
              // accessor arm (whose slot is dead, the getter answers) and the
              // ArraySetLength growth keep the null default.
              externAsUndefined
              ? missExtern()
              : [{ op: "ref.null.extern" }]
            : [{ op: "ref.null", typeIdx: NONE_HEAP }];
      arms.push(
        { op: "local.get", index: anyLocal },
        { op: "ref.test", typeIdx: c.vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: c.vecTypeIdx },
            { op: "local.get", index: idxLocal },
            ...defaultVal,
            { op: "call", funcIdx: elemSetIdx },
          ],
        },
      );
    }
    return arms;
  };

  // ── (#3251 S3) ArraySetLength (§10.4.2.1) support ────────────────────────
  // The companion holds a reserved `"length"` entry carrying the length's
  // WRITABLE bit (enumerable/configurable are spec-fixed false); §10.1.6.3
  // transition legality is delegated to the $Object define natives against a
  // SEEDED current descriptor `{value: len, writable: true, e: false,
  // c: false}` (host flag word 0xB9 — W value bit + W/E/C specified +
  // hasValue). Shrink walks indices down, stopping at (and throwing on) a
  // non-configurable companion entry per step 15; growth reuses the
  // per-carrier grow-with-default arms. Length values ≥ 2^31 keep the legacy
  // no-op (the i32 vec length field cannot represent them — documented
  // boundary).
  const s3UnboxNumIdx = ctx.funcMap.get("__unbox_number");
  const s3BoxNumIdx = ctx.funcMap.get("__box_number");
  const s3DeleteIdx = ctx.funcMap.get("__delete_property");
  let s3: {
    throwRange: () => Instr[];
    throwType: () => Instr[];
    throwTypeMsg: (message: string) => Instr[];
    boxNumIdx: number;
    unboxNumIdx: number;
    deleteIdx: number;
  } | null = null;
  if (s3UnboxNumIdx !== undefined && s3BoxNumIdx !== undefined && s3DeleteIdx !== undefined) {
    emitWasiErrorConstructor(ctx, "RangeError", 1);
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    const rangeCtorIdx = ctx.funcMap.get("__new_RangeError");
    const typeCtorIdx = ctx.funcMap.get("__new_TypeError");
    if (rangeCtorIdx !== undefined && typeCtorIdx !== undefined) {
      const tagIdx = ensureExnTag(ctx);
      const throwTypeMsg = (message: string): Instr[] => [
        ...nativeStringLiteralInstrs(ctx, message),
        { op: "extern.convert_any" },
        { op: "call", funcIdx: typeCtorIdx },
        { op: "throw", tagIdx },
      ];
      s3 = {
        throwRange: () => [
          ...nativeStringLiteralInstrs(ctx, "RangeError: Invalid array length"),
          { op: "extern.convert_any" },
          { op: "call", funcIdx: rangeCtorIdx },
          { op: "throw", tagIdx },
        ],
        throwType: () => throwTypeMsg("TypeError: Cannot redefine property: length"),
        throwTypeMsg,
        boxNumIdx: s3BoxNumIdx,
        unboxNumIdx: s3UnboxNumIdx,
        deleteIdx: s3DeleteIdx,
      };
    }
  }
  const LENGTH_SEED_FLAGS = 0xb9; // {writable:true} value bit + W/E/C specified + hasValue

  /** Seed the companion `"length"` entry when absent. `any`/`comp`/`compExt`
   *  locals per caller; the seeded value is the CURRENT vec length. */
  const seedLengthEntry = (l: { any: number; comp: number; compExt: number }): Instr[] =>
    s3 === null
      ? []
      : [
          { op: "local.get", index: l.comp },
          { op: "ref.as_non_null" },
          ...lengthLitExtern(),
          { op: "call", funcIdx: objFindIdx },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: l.compExt },
              ...lengthLitExtern(),
              { op: "local.get", index: l.any },
              { op: "ref.cast", typeIdx: vecBaseIdx },
              { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: s3.boxNumIdx },
              { op: "f64.const", value: LENGTH_SEED_FLAGS },
              { op: "call", funcIdx: dpValueIdx },
              { op: "drop" },
            ],
          },
        ];

  /** Shared deps for the #4227 rejection guards (see vec-define-rejections.ts). */
  const rejectionDeps = {
    lengthLitExtern,
    objFindIdx,
    propEntryTypeIdx,
    throwTypeMsg: s3 === null ? null : s3.throwTypeMsg,
  };

  // ── __vec_dp_value ────────────────────────────────────────────────────────
  // params: 0=vec 1=key 2=value 3=flags(f64)
  // locals: 4=any 5=comp 6=compExt 7=i 8=len 9=e 10=hf 11=wrote
  // 12=valAny 13=wasDeleted 14=nLen(f64) 15=uLen(f64) 16=newLenI 17=k — #3251 S3
  {
    const fn = findFn(DP_VALUE_NAME);
    if (fn) {
      fn.locals = [
        { name: "any", type: { kind: "anyref" } },
        { name: "comp", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
        { name: "compExt", type: { kind: "externref" } },
        { name: "i", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
        { name: "hf", type: { kind: "i32" } },
        { name: "wrote", type: { kind: "i32" } },
        { name: "valAny", type: { kind: "anyref" } },
        { name: "wasDeleted", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "f64" } }, // #3251 S3
        { name: "uLen", type: { kind: "f64" } },
        { name: "newLenI", type: { kind: "i32" } },
        { name: "k", type: { kind: "i32" } },
        { name: "lenPrim", type: { kind: "externref" } },
        // (#4434) min(length, array.len(data)) — the "is this a REAL element?"
        // bound. Distinct from `len` because §10.4.2.2's rejections compare
        // against the LOGICAL length; only the seed asks about backing.
        { name: "backedLen", type: { kind: "i32" } },
        // (#4434) f64 scratch for the canonical-numeric-string key test.
        { name: "keyNum", type: { kind: "f64" } },
      ];
      // (#3251 S3) Full §7.1.4 ToNumber for the length value — ArraySetLength
      // must accept `{value: "2"}` and `{value: {toString(){return "2"}}}`
      // (the 15.2.3.6-4-142..151 family): ToPrimitive(number hint) first, then
      // StringToNumber for a string primitive, `__unbox_number` otherwise.
      // Any helper missing → plain unbox (numbers-only under-fix, no throw).
      const s3ToPrimIdx = ctx.funcMap.get("__to_primitive");
      const s3TypeofStringIdx = ctx.funcMap.get("__typeof_string");
      const s3StrToNumIdx = ctx.funcMap.get("__str_to_number");
      const lengthToNumber: Instr[] =
        s3 === null
          ? []
          : s3ToPrimIdx !== undefined && s3TypeofStringIdx !== undefined && s3StrToNumIdx !== undefined
            ? [
                { op: "local.get", index: 2 },
                { op: "ref.null.extern" }, // hint: number/default
                { op: "call", funcIdx: s3ToPrimIdx },
                { op: "local.tee", index: 18 },
                { op: "call", funcIdx: s3TypeofStringIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "f64" } },
                  then: [
                    { op: "local.get", index: 18 },
                    { op: "call", funcIdx: s3StrToNumIdx },
                  ],
                  else: [
                    { op: "local.get", index: 18 },
                    { op: "call", funcIdx: s3.unboxNumIdx },
                  ],
                },
              ]
            : [
                { op: "local.get", index: 2 },
                { op: "call", funcIdx: s3.unboxNumIdx },
              ];
      const bailReturnVec: Instr[] = [{ op: "local.get", index: 0 }, { op: "return" }];

      // (#3251 S3) The `"length"` define body — ArraySetLength §10.4.2.1.
      // Runs INSTEAD of the index path when key == "length"; always returns.
      const lengthDefineBody: Instr[] =
        s3 === null
          ? bailReturnVec.map((i) => ({ ...i }))
          : [
              // comp / compExt + seed the length descriptor
              { op: "local.get", index: 4 },
              { op: "call", funcIdx: core.ensureIdx },
              { op: "local.set", index: 5 },
              { op: "local.get", index: 5 },
              { op: "extern.convert_any" },
              { op: "local.set", index: 6 },
              ...seedLengthEntry({ any: 4, comp: 5, compExt: 6 }),
              // hf = trunc(flags)
              { op: "local.get", index: 3 },
              { op: "i32.trunc_f64_s" },
              { op: "local.set", index: 10 },
              { op: "local.get", index: 10 },
              { op: "i32.const", value: HOST_HAS_VALUE },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // n = ToNumber(value) ; u = ToUint32(n) as f64 ; mismatch → RangeError (step 5)
                  ...lengthToNumber,
                  { op: "local.tee", index: 14 },
                  { op: "i64.trunc_sat_f64_s" },
                  { op: "i64.const", value: 0xffffffffn },
                  { op: "i64.and" },
                  { op: "f64.convert_i64_u" },
                  { op: "local.tee", index: 15 },
                  { op: "local.get", index: 14 },
                  { op: "f64.ne" },
                  { op: "if", blockType: { kind: "empty" }, then: s3.throwRange() },
                  // (#4491 bucket D) u ≥ 2^31 → SPARSE-LENGTH arm, not the old
                  // no-op. The `$__vec_base` length field is an i32, but §10.4.2
                  // lengths are uint32, and the field round-trips the whole u32
                  // domain as a BIT PATTERN — the dynamic read arm in
                  // `object-runtime.ts` (and the static one below) widen it with
                  // `f64.convert_i32_u`, so 0xFFFFFFFF reads back as 4294967295
                  // rather than -1. Bailing here left `arr.length` at its old
                  // value with no error at all (measured: `defineProperty(arr,
                  // "length", {value: 2**32-2})` answered 0), which is a WRONG
                  // ANSWER rather than an unimplemented one.
                  //
                  // The element machinery below is skipped deliberately: a
                  // length ≥ 2^31 is unbackable (the backing `$data` array is
                  // capped far lower, and the static paths refuse to allocate
                  // above 16M), so this is always a grow into sparse territory
                  // with no real elements to create — exactly what the static
                  // `maybeEmitVecLengthDefine` does above its own 16M ceiling.
                  // It also cannot use the signed shrink loop: `i32.lt_s`
                  // against a newLen whose bit pattern is negative never
                  // terminates.
                  { op: "local.get", index: 15 },
                  { op: "f64.const", value: 2147483647 },
                  { op: "f64.gt" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // Same §10.1.6.3 legality delegate as the in-range path —
                      // a non-writable / non-configurable `length` still refuses.
                      { op: "local.get", index: 6 },
                      ...lengthLitExtern(),
                      { op: "local.get", index: 15 },
                      { op: "call", funcIdx: s3.boxNumIdx },
                      { op: "local.get", index: 3 },
                      { op: "call", funcIdx: dpValueIdx },
                      { op: "drop" },
                      // vec.length = ToUint32(u) as the raw 32-bit pattern.
                      { op: "local.get", index: 4 },
                      { op: "ref.cast", typeIdx: vecBaseIdx },
                      { op: "local.get", index: 15 },
                      { op: "i32.trunc_sat_f64_u" },
                      { op: "struct.set", typeIdx: vecBaseIdx, fieldIdx: 0 },
                      ...bailReturnVec.map((i) => ({ ...i })),
                    ],
                  },
                  // Delegate {value: u, ...attrs} — §10.1.6.3 legality against
                  // the seeded current (non-writable value change → TypeError,
                  // configurable/enumerable flips → TypeError). Throws propagate.
                  { op: "local.get", index: 6 },
                  ...lengthLitExtern(),
                  { op: "local.get", index: 15 },
                  { op: "call", funcIdx: s3.boxNumIdx },
                  { op: "local.get", index: 3 },
                  { op: "call", funcIdx: dpValueIdx },
                  { op: "drop" },
                  // Apply to the vec: shrink (stop at non-configurable) or grow.
                  { op: "local.get", index: 15 },
                  { op: "i32.trunc_sat_f64_s" },
                  { op: "local.set", index: 16 },
                  ...vecLen(4, 8),
                  { op: "local.get", index: 16 },
                  { op: "local.get", index: 8 },
                  { op: "i32.lt_s" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // k = oldLen - 1 ; while (k >= newLen) …
                      { op: "local.get", index: 8 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.sub" },
                      { op: "local.set", index: 17 },
                      {
                        op: "block",
                        blockType: { kind: "empty" },
                        body: [
                          {
                            op: "loop",
                            blockType: { kind: "empty" },
                            body: [
                              { op: "local.get", index: 17 },
                              { op: "local.get", index: 16 },
                              { op: "i32.lt_s" },
                              { op: "br_if", depth: 1 },
                              // e = __obj_find(comp, ToString(k))
                              { op: "local.get", index: 5 },
                              { op: "ref.as_non_null" },
                              { op: "local.get", index: 17 },
                              { op: "f64.convert_i32_s" },
                              { op: "call", funcIdx: numToStringIdx },
                              { op: "call", funcIdx: objFindIdx },
                              { op: "local.tee", index: 9 },
                              { op: "ref.is_null" },
                              { op: "i32.eqz" },
                              {
                                op: "if",
                                blockType: { kind: "empty" },
                                then: [
                                  { op: "local.get", index: 9 },
                                  { op: "ref.as_non_null" },
                                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                                  { op: "i32.const", value: FLAG_CONFIGURABLE },
                                  { op: "i32.and" },
                                  { op: "i32.eqz" },
                                  {
                                    op: "if",
                                    blockType: { kind: "empty" },
                                    then: [
                                      // step 15.b–d: stop — length = k+1, sync the
                                      // companion "length" value, throw TypeError.
                                      { op: "local.get", index: 4 },
                                      { op: "ref.cast", typeIdx: vecBaseIdx },
                                      { op: "local.get", index: 17 },
                                      { op: "i32.const", value: 1 },
                                      { op: "i32.add" },
                                      { op: "struct.set", typeIdx: vecBaseIdx, fieldIdx: 0 },
                                      { op: "local.get", index: 5 },
                                      { op: "ref.as_non_null" },
                                      ...lengthLitExtern(),
                                      { op: "call", funcIdx: objFindIdx },
                                      { op: "local.tee", index: 9 },
                                      { op: "ref.is_null" },
                                      { op: "i32.eqz" },
                                      {
                                        op: "if",
                                        blockType: { kind: "empty" },
                                        then: [
                                          { op: "local.get", index: 9 },
                                          { op: "ref.as_non_null" },
                                          { op: "local.get", index: 17 },
                                          { op: "i32.const", value: 1 },
                                          { op: "i32.add" },
                                          { op: "f64.convert_i32_s" },
                                          { op: "call", funcIdx: s3.boxNumIdx },
                                          { op: "any.convert_extern" },
                                          { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                                        ],
                                      },
                                      ...s3.throwType(),
                                    ],
                                  },
                                  // configurable entry → remove it from the companion
                                  { op: "local.get", index: 6 },
                                  { op: "local.get", index: 17 },
                                  { op: "f64.convert_i32_s" },
                                  { op: "call", funcIdx: numToStringIdx },
                                  { op: "call", funcIdx: s3.deleteIdx },
                                  { op: "drop" },
                                ],
                              },
                              { op: "local.get", index: 17 },
                              { op: "i32.const", value: 1 },
                              { op: "i32.sub" },
                              { op: "local.set", index: 17 },
                              { op: "br", depth: 0 },
                            ],
                          },
                        ],
                      },
                      // vec.length = newLen
                      { op: "local.get", index: 4 },
                      { op: "ref.cast", typeIdx: vecBaseIdx },
                      { op: "local.get", index: 16 },
                      { op: "struct.set", typeIdx: vecBaseIdx, fieldIdx: 0 },
                    ],
                    else: [
                      // growth: extend capacity + length via the per-carrier
                      // grow-with-default arms (k = newLen - 1).
                      { op: "local.get", index: 16 },
                      { op: "local.get", index: 8 },
                      { op: "i32.gt_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 16 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.sub" },
                          { op: "local.set", index: 17 },
                          ...growDefaultArms(4, 17),
                        ],
                      },
                    ],
                  },
                ],
                else: [
                  // flags-only define ({writable:false} etc.) — merge via the
                  // $Object native; no length change.
                  { op: "local.get", index: 6 },
                  ...lengthLitExtern(),
                  { op: "local.get", index: 2 },
                  { op: "local.get", index: 3 },
                  { op: "call", funcIdx: dpValueIdx },
                  { op: "drop" },
                ],
              },
              { op: "local.get", index: 0 },
              { op: "return" },
            ];

      // Per-carrier value write-back arms. Value must match the carrier's
      // element kind STRICTLY (defineProperty must not ToNumber-coerce);
      // `__vec_elem_set_<t>` handles in-bounds store, OOB growth, and the
      // length update in one call.
      const writeBackArms: Instr[] = [];
      for (const c of carriers) {
        const elemSetIdx = ensureVecElemSet(ctx, c.vecTypeIdx);
        if (elemSetIdx === null) continue;
        const castVecAndIdx: Instr[] = [
          { op: "local.get", index: 4 },
          { op: "ref.cast", typeIdx: c.vecTypeIdx },
          { op: "local.get", index: 7 },
        ];
        const wrote: Instr[] = [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: 11 },
        ];
        let inner: Instr[];
        if (c.kind === "externref") {
          // Any value is representable.
          inner = [...castVecAndIdx, { op: "local.get", index: 2 }, { op: "call", funcIdx: elemSetIdx }, ...wrote];
        } else if (c.kind === "f64") {
          // Strict number: the native `__box_number_struct` box, or an
          // `$AnyValue` with tag 2 (i32 payload) / 3 (f64 payload).
          const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
          const anyValTypeIdx = ctx.anyValueTypeIdx;
          const arms: Instr[] = [];
          if (boxNumTypeIdx !== undefined && boxNumTypeIdx >= 0) {
            arms.push(
              { op: "local.get", index: 12 },
              { op: "ref.test", typeIdx: boxNumTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...castVecAndIdx,
                  { op: "local.get", index: 12 },
                  { op: "ref.cast", typeIdx: boxNumTypeIdx },
                  { op: "struct.get", typeIdx: boxNumTypeIdx, fieldIdx: 0 },
                  { op: "call", funcIdx: elemSetIdx },
                  ...wrote.map((i) => ({ ...i })),
                ],
              },
              // (#3673) i31-boxed small int is a strict number too.
              { op: "local.get", index: 12 },
              { op: "ref.test", typeIdx: -20 },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...castVecAndIdx.map((i) => ({ ...i })),
                  { op: "local.get", index: 12 },
                  { op: "ref.cast", typeIdx: -20 },
                  { op: "i31.get_s" },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: elemSetIdx },
                  ...wrote.map((i) => ({ ...i })),
                ],
              },
            );
          }
          if (anyValTypeIdx !== undefined && anyValTypeIdx >= 0) {
            const tagIs = (tag: number): Instr[] => [
              { op: "local.get", index: 12 },
              { op: "ref.cast", typeIdx: anyValTypeIdx },
              { op: "struct.get", typeIdx: anyValTypeIdx, fieldIdx: 0 },
              { op: "i32.const", value: tag },
              { op: "i32.eq" },
            ];
            arms.push(
              { op: "local.get", index: 12 },
              { op: "ref.test", typeIdx: anyValTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...tagIs(2),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      ...castVecAndIdx.map((i) => ({ ...i })),
                      { op: "local.get", index: 12 },
                      { op: "ref.cast", typeIdx: anyValTypeIdx },
                      { op: "struct.get", typeIdx: anyValTypeIdx, fieldIdx: 1 },
                      { op: "f64.convert_i32_s" },
                      { op: "call", funcIdx: elemSetIdx },
                      ...wrote.map((i) => ({ ...i })),
                    ],
                  },
                  ...tagIs(3),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      ...castVecAndIdx.map((i) => ({ ...i })),
                      { op: "local.get", index: 12 },
                      { op: "ref.cast", typeIdx: anyValTypeIdx },
                      { op: "struct.get", typeIdx: anyValTypeIdx, fieldIdx: 2 },
                      { op: "call", funcIdx: elemSetIdx },
                      ...wrote.map((i) => ({ ...i })),
                    ],
                  },
                ],
              },
            );
          }
          inner = arms;
        } else {
          // anystr carrier: value must be an $AnyString.
          inner = [
            { op: "local.get", index: 12 },
            { op: "ref.test", typeIdx: anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...castVecAndIdx,
                { op: "local.get", index: 12 },
                { op: "ref.cast", typeIdx: anyStrTypeIdx },
                { op: "call", funcIdx: elemSetIdx },
                ...wrote,
              ],
            },
          ];
        }
        writeBackArms.push(
          { op: "local.get", index: 4 },
          { op: "ref.test", typeIdx: c.vecTypeIdx },
          { op: "if", blockType: { kind: "empty" }, then: inner },
        );
      }

      fn.body = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: 4 },
        ...carrierWhitelistGuard(
          4,
          bailReturnVec.map((i) => ({ ...i })),
        ),
        ...stringKeyGuard(
          1,
          bailReturnVec.map((i) => ({ ...i })),
        ),
        // (#3251 S3) "length" → ArraySetLength (always returns inside).
        ...lengthKeyGuard(1, lengthDefineBody),
        { op: "local.get", index: 4 },
        { op: "call", funcIdx: core.ensureIdx },
        { op: "local.set", index: 5 },
        { op: "local.get", index: 5 },
        { op: "extern.convert_any" },
        { op: "local.set", index: 6 },
        ...parseIndex(1, 7),
        ...vecLen(4, 8),
        ...vecBackedLen(4, 19),
        // (#4227) §10.4.2.2 step 3 — frozen `length` blocks an index at/after it.
        ...nonWritableLengthIndexGuard(rejectionDeps, { comp: 5, i: 7, len: 8, entry: 9 }),
        // (#4227) §10.1.6.3 step 2 — a non-extensible array takes no new index.
        ...nonExtensibleFreshIndexGuard(ctx, rejectionDeps, { recvLocalIdx: 0, i: 7, len: 8 }),
        // if (i >= 0) mark numeric-companion presence (#3673) + seed-if-real-element
        { op: "local.get", index: 7 },
        { op: "i32.const", value: 0 },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 1 },
            { op: "global.set", index: core.numericFlagGlobalIdx },
            ...clearDeletedIndexMarker({
              comp: 5,
              compExt: 6,
              key: 1,
              entry: 9,
              wasDeleted: 13,
            }),
            { op: "local.get", index: 13 },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              // (#4434) BACKED length, not logical: an index in the unbacked
              // tail is a hole, so the define is a FIRST definition (defaults
              // all false) rather than a redefine of an implicit
              // `{value, w/e/c: true}` element — and seeding it would have
              // read `data[i]` past the backing, which is what trapped.
              then: buildRealElementSeed(
                { comp: 5, compExt: 6, key: 1, vec: 0, i: 7, len: 19 },
                objFindIdx,
                dpValueIdx,
                externGetIdxIdx,
                SEED_FLAGS,
              ),
            },
          ],
        },
        // (#4434) A named key that is nonetheless a canonical numeric STRING is
        // reachable through the INDEXED read lane, so it has to arm the
        // numeric-companion flag the same way an index define does.
        { op: "local.get", index: 7 },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: markNumericLikeNamedKey(1, 20),
        },
        // (#4010 S1′) Named-key twin of the index seed above — see `vec-bag-seed.ts`.
        // Deliberately NOT applied on the accessor path: converting a data
        // property to an accessor does not preserve [[Value]] (§10.1.6.3).
        ...buildBagValueSeed(ctx, { comp: 5, compExt: 6, key: 1, vec: 0, i: 7 }, objFindIdx, dpValueIdx, SEED_FLAGS),
        // Delegate the define to the $Object native (validation throws propagate).
        { op: "local.get", index: 6 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 3 },
        { op: "call", funcIdx: dpValueIdx },
        { op: "drop" },
        // Write-back for index-keyed DATA defines carrying a [[Value]].
        { op: "local.get", index: 3 },
        { op: "i32.trunc_f64_s" },
        { op: "local.set", index: 10 },
        { op: "local.get", index: 10 },
        { op: "i32.const", value: HOST_HAS_VALUE },
        { op: "i32.and" },
        { op: "i32.const", value: 0 },
        { op: "i32.ne" },
        { op: "local.get", index: 7 },
        { op: "i32.const", value: 0 },
        { op: "i32.ge_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 5 },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: objFindIdx },
            { op: "local.set", index: 9 },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: 11 },
            { op: "local.get", index: 2 },
            { op: "any.convert_extern" },
            { op: "local.set", index: 12 },
            ...writeBackArms,
            // OOB define whose value could NOT be written back (kind-
            // incompatible): still extend length to i+1 with the carrier
            // default (§10.4.2) — the companion holds the real value.
            { op: "local.get", index: 11 },
            { op: "i32.eqz" },
            { op: "local.get", index: 7 },
            { op: "local.get", index: 8 },
            { op: "i32.ge_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: growDefaultArms(4, 7),
            },
            // Companion-value marker: set when the write-back was impossible,
            // cleared when the vec now holds the authoritative value.
            { op: "local.get", index: 9 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 9 },
                { op: "ref.as_non_null" },
                { op: "local.get", index: 9 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                { op: "local.get", index: 11 },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [{ op: "i32.const", value: ~FLAG_COMPANION_VALUE }],
                  else: [{ op: "i32.const", value: -1 }],
                },
                { op: "i32.and" },
                { op: "local.get", index: 11 },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [{ op: "i32.const", value: 0 }],
                  else: [{ op: "i32.const", value: FLAG_COMPANION_VALUE }],
                },
                { op: "i32.or" },
                { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              ],
            },
          ],
        },
        // (#4491) A value-LESS data define at an OOB index extends length too.
        // §10.4.2.2 step 3.c sets length to index+1 after ANY successful index
        // define, regardless of descriptor kind. The accessor arm below already
        // does this and the value arm above gets it via the element write-back,
        // which left exactly one shape unhandled — attributes only:
        //
        //   var a = [];
        //   Object.defineProperty(a, "0", { enumerable: true });
        //   a.length;              // was 0, want 1
        //   for (k in a) …         // saw nothing, so `isEnumerable` was false
        //
        // `hasOwnProperty("0")` already answered true off the companion, so the
        // index existed while `length` denied it (15.2.3.7-6-a-195, and the
        // singular twin). Same `growDefaultArms` + same hole-default boundary as
        // the accessor arm.
        { op: "local.get", index: 10 },
        { op: "i32.const", value: HOST_HAS_VALUE },
        { op: "i32.and" },
        { op: "i32.eqz" },
        { op: "local.get", index: 7 },
        { op: "i32.const", value: 0 },
        { op: "i32.ge_s" },
        { op: "i32.and" },
        { op: "local.get", index: 7 },
        { op: "local.get", index: 8 },
        { op: "i32.ge_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: growDefaultArms(4, 7, /* externAsUndefined */ true),
        },
        { op: "local.get", index: 0 },
      ];
    }
  }

  // ── __vec_dp_accessor ────────────────────────────────────────────────────
  // params: 0=vec 1=key 2=get 3=set 4=flags(f64)
  // locals: 5=any 6=comp 7=compExt 8=i 9=len 10=e 11=wasDeleted
  {
    const fn = findFn(DP_ACCESSOR_NAME);
    if (fn) {
      fn.locals = [
        { name: "any", type: { kind: "anyref" } },
        { name: "comp", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
        { name: "compExt", type: { kind: "externref" } },
        { name: "i", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
        { name: "wasDeleted", type: { kind: "i32" } },
        // (#4434) min(length, array.len(data)) — see the `__vec_dp_value` twin.
        { name: "backedLen", type: { kind: "i32" } },
        // (#4434) f64 scratch for the canonical-numeric-string key test.
        { name: "keyNum", type: { kind: "f64" } },
      ];
      const bailReturnVec = (): Instr[] => [{ op: "local.get", index: 0 }, { op: "return" }];
      fn.body = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: 5 },
        ...carrierWhitelistGuard(5, bailReturnVec()),
        ...stringKeyGuard(1, bailReturnVec()),
        // (#3251 S3) accessor define on "length": §10.4.2.1 step 2 — always a
        // TypeError. Seed the length descriptor and delegate; the $Object S4
        // accessor preflight rejects the data→accessor conversion on the
        // seeded non-configurable current. (s3 unavailable → legacy no-op.)
        ...lengthKeyGuard(
          1,
          s3 === null
            ? bailReturnVec()
            : [
                { op: "local.get", index: 5 },
                { op: "call", funcIdx: core.ensureIdx },
                { op: "local.set", index: 6 },
                { op: "local.get", index: 6 },
                { op: "extern.convert_any" },
                { op: "local.set", index: 7 },
                ...seedLengthEntry({ any: 5, comp: 6, compExt: 7 }),
                { op: "local.get", index: 7 },
                ...lengthLitExtern(),
                { op: "local.get", index: 2 },
                { op: "local.get", index: 3 },
                { op: "local.get", index: 4 },
                { op: "call", funcIdx: dpAccessorIdx },
                { op: "drop" },
                ...bailReturnVec(),
              ],
        ),
        { op: "local.get", index: 5 },
        { op: "call", funcIdx: core.ensureIdx },
        { op: "local.set", index: 6 },
        { op: "local.get", index: 6 },
        { op: "extern.convert_any" },
        { op: "local.set", index: 7 },
        ...parseIndex(1, 8),
        ...vecLen(5, 9),
        ...vecBackedLen(5, 12),
        { op: "local.get", index: 8 },
        { op: "i32.const", value: 0 },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // (#3673) numeric-companion presence — see OverlayCore.numericFlagGlobalIdx.
            { op: "i32.const", value: 1 },
            { op: "global.set", index: core.numericFlagGlobalIdx },
            ...clearDeletedIndexMarker({
              comp: 6,
              compExt: 7,
              key: 1,
              entry: 10,
              wasDeleted: 11,
            }),
            { op: "local.get", index: 11 },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              // (#4434) BACKED length — see the `__vec_dp_value` twin.
              then: buildRealElementSeed(
                { comp: 6, compExt: 7, key: 1, vec: 0, i: 8, len: 12 },
                objFindIdx,
                dpValueIdx,
                externGetIdxIdx,
                SEED_FLAGS,
              ),
            },
          ],
        },
        // (#4434) canonical-numeric named key → arm the indexed-lane flag.
        { op: "local.get", index: 8 },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: markNumericLikeNamedKey(1, 13),
        },
        // Delegate the accessor define (validation + merge live in the native).
        { op: "local.get", index: 7 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 3 },
        { op: "local.get", index: 4 },
        { op: "call", funcIdx: dpAccessorIdx },
        { op: "drop" },
        // OOB accessor define: extend length to i+1 with the carrier default
        // (§10.4.2 — the `var arr = []; defineProperty(arr, "2", {get})` +
        // iterate cluster requires the index to be *visited*; the accessor
        // itself answers through the read prologue). Runs only when the
        // delegated define did not throw.
        { op: "local.get", index: 8 },
        { op: "i32.const", value: 0 },
        { op: "i32.ge_s" },
        { op: "local.get", index: 8 },
        { op: "local.get", index: 9 },
        { op: "i32.ge_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: growDefaultArms(5, 8),
        },
        { op: "local.get", index: 0 },
      ];
    }
  }

  // ── __vec_gopd ───────────────────────────────────────────────────────────
  // params: 0=vec 1=key
  // locals: 2=any 3=comp 4=i 5=len 6=d 7=e
  {
    const fn = findFn(GOPD_NAME);
    if (fn) {
      fn.locals = [
        { name: "any", type: { kind: "anyref" } },
        { name: "comp", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
        { name: "i", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "d", type: { kind: "externref" } },
        { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
      ];
      const bailMiss = (): Instr[] => [...missExtern(), { op: "return" }];
      // A backed externref `$Hole` is storage, not an implicit array-element
      // descriptor. `__vec_gopd` feeds both getOwnPropertyDescriptor and the
      // vec hasOwn prologue, so screening it here keeps the public own view in
      // step with the active #4504 write decision. This runs only after the
      // index has passed the backed-length test below.
      const holeBail = (): Instr[] => {
        if (!inheritedSetHolePresenceActive) return [];
        const arms: Instr[] = [];
        for (const carrier of carriers) {
          if (carrier.kind !== "externref") continue;
          arms.push(
            { op: "local.get", index: 2 },
            { op: "ref.test", typeIdx: carrier.vecTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 2 },
                { op: "ref.cast", typeIdx: carrier.vecTypeIdx },
                { op: "struct.get", typeIdx: carrier.vecTypeIdx, fieldIdx: 1 },
                { op: "local.get", index: 4 },
                { op: "array.get", typeIdx: carrier.arrTypeIdx },
                ...holeTestInstrs(ctx),
                { op: "if", blockType: { kind: "empty" }, then: bailMiss() },
              ],
            },
          );
        }
        return arms;
      };
      const setKey = (key: string, valueInstrs: Instr[]): Instr[] => [
        { op: "local.get", index: 6 },
        ...nativeStringLiteralInstrs(ctx, key),
        { op: "extern.convert_any" },
        ...valueInstrs,
        { op: "call", funcIdx: externSetIdx },
      ];
      // (#3251 S3) gOPD("length") — synthesize the array-length descriptor
      // {value: <LIVE vec length>, writable: <companion bit, default true>,
      // enumerable: false, configurable: false}. The VALUE always comes from
      // the live length field, never the companion (a companion copy goes
      // stale on push/pop/plain writes). (s3 unavailable → legacy miss.)
      const lengthGopdBody: Instr[] =
        s3 === null
          ? bailMiss()
          : [
              // wbit (reuse local 4): default 1, else the companion entry's bit
              { op: "i32.const", value: 1 },
              { op: "local.set", index: 4 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: core.lookupIdx },
              { op: "local.tee", index: 3 },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  ...lengthLitExtern(),
                  { op: "call", funcIdx: objFindIdx },
                  { op: "local.tee", index: 7 },
                  { op: "ref.is_null" },
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: 7 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                      { op: "i32.const", value: FLAG_WRITABLE },
                      { op: "i32.and" },
                      { op: "i32.const", value: 0 },
                      { op: "i32.ne" },
                      { op: "local.set", index: 4 },
                    ],
                  },
                ],
              },
              { op: "call", funcIdx: newPlainObjectIdx },
              { op: "local.set", index: 6 },
              ...setKey("value", [
                { op: "local.get", index: 2 },
                { op: "ref.cast", typeIdx: vecBaseIdx },
                { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
                { op: "f64.convert_i32_s" },
                { op: "call", funcIdx: s3.boxNumIdx },
              ]),
              ...setKey("writable", [
                { op: "local.get", index: 4 },
                { op: "call", funcIdx: boxBoolIdx },
              ]),
              ...setKey("enumerable", [
                { op: "i32.const", value: 0 },
                { op: "call", funcIdx: boxBoolIdx },
              ]),
              ...setKey("configurable", [
                { op: "i32.const", value: 0 },
                { op: "call", funcIdx: boxBoolIdx },
              ]),
              { op: "local.get", index: 6 },
              { op: "return" },
            ];
      fn.body = [
        // Public reflection helpers receive the original key. Normalize it
        // once before the vec overlay's string/index classifiers so numeric
        // property keys such as 0 observe the same "0" element as ordinary
        // object reflection.
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: toPropertyKeyIdx },
        { op: "local.set", index: 1 },
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: 2 },
        ...carrierWhitelistGuard(2, bailMiss()),
        ...stringKeyGuard(1, bailMiss()),
        // (#3251 S3) "length" → synthesized length descriptor (always returns).
        ...lengthKeyGuard(1, lengthGopdBody),
        // Companion entry → delegate to the $Object descriptor builder.
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: core.lookupIdx },
        { op: "local.tee", index: 3 },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 3 },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: objFindIdx },
            { op: "local.tee", index: 7 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 7 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                { op: "i32.const", value: FLAG_DELETED_INDEX },
                { op: "i32.and" },
                { op: "if", blockType: { kind: "empty" }, then: bailMiss() },
                { op: "local.get", index: 3 },
                { op: "extern.convert_any" },
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: gopdObjectIdx },
                { op: "return" },
              ],
            },
          ],
        },
        // No entry: synthesize the implicit element descriptor for an
        // in-bounds index — {value: vec[i], w/e/c: true}. Do NOT seed on reads.
        // (#4434) BACKED length: an index in the unbacked tail left by
        // `a.length = N` is a hole, and a hole has no own descriptor — gOPD
        // must answer `undefined`, not `{value: undefined, w/e/c: true}`.
        ...parseIndex(1, 4),
        ...vecBackedLen(2, 5),
        { op: "local.get", index: 4 },
        { op: "i32.const", value: 0 },
        { op: "i32.ge_s" },
        { op: "local.get", index: 4 },
        { op: "local.get", index: 5 },
        { op: "i32.lt_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...holeBail(),
            { op: "call", funcIdx: newPlainObjectIdx },
            { op: "local.set", index: 6 },
            ...setKey("value", [
              { op: "local.get", index: 0 },
              { op: "local.get", index: 4 },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: externGetIdxIdx },
            ]),
            ...setKey("writable", [
              { op: "i32.const", value: 1 },
              { op: "call", funcIdx: boxBoolIdx },
            ]),
            ...setKey("enumerable", [
              { op: "i32.const", value: 1 },
              { op: "call", funcIdx: boxBoolIdx },
            ]),
            ...setKey("configurable", [
              { op: "i32.const", value: 1 },
              { op: "call", funcIdx: boxBoolIdx },
            ]),
            { op: "local.get", index: 6 },
            { op: "return" },
          ],
        },
        ...buildBagGopdOrMiss(ctx, 6, missExtern()), // (#4010 S3) the #3537 bag, then the miss
      ];
    }
  }

  {
    const fn = findFn("__extern_set");
    const vecDpValueIdx = ctx.funcMap.get(DP_VALUE_NAME);
    if (fn && vecDpValueIdx !== undefined) {
      // The overlay is a second non-$Object own layer in front of the normal
      // vec expando bag.  In descriptor-dirty standalone modules its direct
      // writes must publish the same final [[Set]] state as every other
      // carrier, and an absent/deleted numeric entry must ask the shared
      // resolver before it recreates storage.
      const setResultGlobalIdx = ctx.externSetResultGlobalIdx;
      const setDecideIdx = ctx.funcMap.get("__extern_set_decide");
      const descriptorDecisionAvailable =
        ctx.standalone && inheritedSetAnyDirty(ctx) && setResultGlobalIdx !== undefined && setDecideIdx !== undefined;
      const holeAwarePresence =
        descriptorDecisionAvailable && ctx.usesArrayHoles && carriers.some((carrier) => carrier.kind === "externref");
      const base = 3 + fn.locals.length;
      const anyLocal = base;
      const keyLocal = base + 1;
      const compLocal = base + 2;
      const entryLocal = base + 3;
      const indexLocal = base + 4;
      const setterLocal = base + 5;
      const decisionLocal = base + 6;
      const backedLenLocal = base + 7;
      const presenceLocal = base + 8;
      fn.locals.push(
        { name: "__ov_set_any", type: { kind: "anyref" } },
        { name: "__ov_set_key", type: { kind: "externref" } },
        { name: "__ov_set_comp", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
        { name: "__ov_set_entry", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
        { name: "__ov_set_index", type: { kind: "i32" } },
        { name: "__ov_set_setter", type: { kind: "externref" } },
        ...(descriptorDecisionAvailable
          ? ([
              { name: "__ov_set_decision", type: { kind: "i32" } },
              { name: "__ov_set_backed_len", type: { kind: "i32" } },
              ...(holeAwarePresence ? ([{ name: "__ov_set_present", type: { kind: "i32" } }] as const) : []),
            ] as const)
          : []),
      );
      const publishSuccess = (): Instr[] =>
        !descriptorDecisionAvailable
          ? []
          : ([
              { op: "i32.const", value: 1 },
              { op: "global.set", index: setResultGlobalIdx! },
            ] satisfies Instr[]);
      const publishRefusalAndReturn = (): Instr[] => [
        { op: "i32.const", value: 2 },
        { op: "global.set", index: setResultGlobalIdx! },
        { op: "return" },
      ];
      const overlayStore = (flags: number): Instr[] => [
        { op: "local.get", index: 0 },
        { op: "local.get", index: keyLocal },
        { op: "local.get", index: 2 },
        { op: "f64.const", value: flags },
        { op: "call", funcIdx: vecDpValueIdx },
        { op: "drop" },
        ...publishSuccess(),
        { op: "return" },
      ];
      const resolveThenStore = (ownLayer: () => Instr[], flags: number): Instr[] => [
        { op: "local.get", index: 0 },
        ...ownLayer(),
        { op: "local.get", index: keyLocal },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: setDecideIdx! },
        { op: "local.tee", index: decisionLocal },
        { op: "i32.const", value: SET_DECISION_HANDLED },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...publishSuccess(), { op: "return" }],
        },
        { op: "local.get", index: decisionLocal },
        { op: "i32.const", value: SET_DECISION_REFUSED },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: publishRefusalAndReturn() },
        ...overlayStore(flags),
      ];
      const nullOwnLayer = (): Instr[] => [{ op: "ref.null.extern" }];
      const companionOwnLayer = (): Instr[] => [
        { op: "local.get", index: compLocal },
        { op: "ref.as_non_null" },
        { op: "extern.convert_any" },
      ];
      const backedIndexIsPresent = (): Instr[] => {
        if (!holeAwarePresence) return [{ op: "i32.const", value: 1 }];
        const body: Instr[] = [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: presenceLocal },
        ];
        for (const carrier of carriers) {
          if (carrier.kind !== "externref") continue;
          body.push(
            { op: "local.get", index: anyLocal },
            { op: "ref.test", typeIdx: carrier.vecTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: anyLocal },
                { op: "ref.cast", typeIdx: carrier.vecTypeIdx },
                { op: "struct.get", typeIdx: carrier.vecTypeIdx, fieldIdx: 1 },
                { op: "local.get", index: indexLocal },
                { op: "array.get", typeIdx: carrier.arrTypeIdx },
                ...holeTestInstrs(ctx),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 0 },
                    { op: "local.set", index: presenceLocal },
                  ],
                },
              ],
            },
          );
        }
        body.push({ op: "local.get", index: presenceLocal });
        return body;
      };
      fn.body.unshift(
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: anyLocal },
        { op: "ref.test", typeIdx: vecBaseIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: toPropertyKeyIdx },
            { op: "local.set", index: keyLocal },
            { op: "local.get", index: anyLocal },
            { op: "call", funcIdx: core.lookupIdx },
            { op: "local.tee", index: compLocal },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: compLocal },
                { op: "ref.as_non_null" },
                { op: "local.get", index: keyLocal },
                { op: "call", funcIdx: objFindIdx },
                { op: "local.tee", index: entryLocal },
                { op: "ref.is_null" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryLocal },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                    { op: "i32.const", value: FLAG_DELETED_INDEX },
                    { op: "i32.and" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: descriptorDecisionAvailable
                        ? resolveThenStore(nullOwnLayer, SEED_FLAGS)
                        : [
                            // Ordinary assignment recreates a deleted array index
                            // as a fresh writable/enumerable/configurable data
                            // property. __vec_dp_value clears the tombstone first,
                            // deliberately avoiding a seed from the stale carrier.
                            { op: "local.get", index: 0 },
                            { op: "local.get", index: keyLocal },
                            { op: "local.get", index: 2 },
                            { op: "f64.const", value: SEED_FLAGS },
                            { op: "call", funcIdx: vecDpValueIdx },
                            { op: "drop" },
                            { op: "return" },
                          ],
                    },
                    ...(descriptorDecisionAvailable
                      ? resolveThenStore(companionOwnLayer, HOST_HAS_VALUE)
                      : ([
                          { op: "local.get", index: entryLocal },
                          { op: "ref.as_non_null" },
                          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                          { op: "i32.const", value: FLAG_ACCESSOR },
                          { op: "i32.and" },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            // (#3251 S2) accessor entry → invoke `e.set` with the
                            // ORIGINAL vec receiver as `this`; a null setter is a
                            // sloppy no-op (strict-throw is a documented boundary,
                            // same discipline as the frozen-gate).
                            then: [
                              { op: "local.get", index: entryLocal },
                              { op: "ref.as_non_null" },
                              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
                              { op: "extern.convert_any" },
                              { op: "local.tee", index: setterLocal },
                              { op: "ref.is_null" },
                              { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
                              { op: "local.get", index: 0 },
                              { op: "local.get", index: setterLocal },
                              { op: "local.get", index: 2 },
                              { op: "call", funcIdx: callAccessorSetIdx },
                              { op: "return" },
                            ],
                          },
                          { op: "local.get", index: entryLocal },
                          { op: "ref.as_non_null" },
                          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                          { op: "i32.const", value: FLAG_WRITABLE },
                          { op: "i32.and" },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            then: [
                              { op: "local.get", index: 0 },
                              { op: "local.get", index: keyLocal },
                              { op: "local.get", index: 2 },
                              { op: "f64.const", value: HOST_HAS_VALUE },
                              { op: "call", funcIdx: vecDpValueIdx },
                              { op: "drop" },
                              { op: "return" },
                            ],
                            else: [{ op: "return" }],
                          },
                        ] satisfies Instr[])),
                  ],
                },
              ],
            },
            { op: "local.get", index: keyLocal },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...parseIndex(keyLocal, indexLocal),
                { op: "local.get", index: indexLocal },
                { op: "i32.const", value: 0 },
                { op: "i32.ge_s" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: descriptorDecisionAvailable
                    ? [
                        // A backed element is a physical own property and
                        // wins before any inherited descriptor. A logical
                        // tail hole is absent, however, so it takes the
                        // shared nearest-descriptor decision before storage
                        // is allocated/recreated in the overlay.
                        ...vecBackedLen(anyLocal, backedLenLocal),
                        { op: "local.get", index: indexLocal },
                        { op: "local.get", index: backedLenLocal },
                        { op: "i32.lt_s" },
                        {
                          op: "if",
                          blockType: { kind: "val", type: { kind: "i32" } },
                          // A backed `$Hole` sentinel is storage, not an own
                          // property. It must behave like a numeric miss so an
                          // inherited setter/non-writable data descriptor wins
                          // before the ordinary assignment can fill it.
                          then: backedIndexIsPresent(),
                          else: [{ op: "i32.const", value: 0 }],
                        },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: overlayStore(SEED_FLAGS),
                          else: resolveThenStore(nullOwnLayer, SEED_FLAGS),
                        },
                      ]
                    : [
                        { op: "local.get", index: 0 },
                        { op: "local.get", index: keyLocal },
                        { op: "local.get", index: 2 },
                        // (#2668) SEED_FLAGS, not HOST_HAS_VALUE. This is an ORDINARY set and
                        // every non-null-entry arm above returns, so the index is either brand
                        // new (§10.1.6.3 CreateDataProperty ⇒ all-true W/E/C) or an implicit
                        // dense element (already all-true). HOST_HAS_VALUE specifies none of the
                        // three, so `var a = []; a[0] = 101` defaulted them FALSE. See
                        // tests/issue-2668-vec-ordinary-set-creates-default-data.test.ts.
                        { op: "f64.const", value: SEED_FLAGS },
                        { op: "call", funcIdx: vecDpValueIdx },
                        { op: "drop" },
                        { op: "return" },
                      ],
                },
              ],
            },
          ],
        },
      );
    }
  }

  // (#4010 S1′/S2) The vec arm of `__delete_property` lives in vec-bag-seed.ts —
  // ONE owner for both directions of the overlay↔bag seam (seed a value in,
  // delete a property out). See that module for the S2 bag consult + shadow.
  {
    const fn = findFn("__delete_property");
    const vecGopdIdx = ctx.funcMap.get(GOPD_NAME);
    if (fn && vecGopdIdx !== undefined) {
      buildVecDeletePrologue(ctx, fn, {
        objectTypeIdx,
        propEntryTypeIdx,
        vecBaseIdx,
        vecGopdIdx,
        toPropertyKeyIdx,
        externIsUndefinedIdx,
        externGetIdx,
        unboxBoolIdx,
        deletePropertyIdx,
        dpValueIdx,
        objFindIdx,
        ensureIdx: core.ensureIdx,
        numericFlagGlobalIdx: core.numericFlagGlobalIdx,
        deletedIndexFlags: FLAG_DELETED_INDEX | FLAG_COMPANION_VALUE,
        missExtern,
        parseIndex,
      });
    }
  }
  fillVecHasOwnHelpers(ctx, vecBaseIdx);

  // ── Overlay read prologue: __extern_get_idx ──────────────────────────────
  // Splice-front, append-locals (#2190/#3183 fill discipline). Gated on the
  // state global being non-null → overlay-free modules pay one global.get.
  {
    const fn = findFn("__extern_get_idx");
    if (fn) {
      const base = 2 + fn.locals.length;
      const pAny = base;
      const pComp = base + 1;
      const pE = base + 2;
      const pGetter = base + 3;
      const pIdx = base + 4;
      const pBacked = base + 5;
      fn.locals.push(
        { name: "__ov_any", type: { kind: "anyref" } },
        { name: "__ov_comp", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
        { name: "__ov_e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
        { name: "__ov_getter", type: { kind: "externref" } },
        // (#4434) the truncated index and the BACKED length, for the
        // companion-vs-vec authority decision on a plain data entry.
        { name: "__ov_idx", type: { kind: "i32" } },
        { name: "__ov_backed", type: { kind: "i32" } },
      );
      const prologue: Instr[] = [
        // (#3673) Gate on the numeric-companion flag, NOT the state global: a
        // table holding only string-key companions (standalone RegExp result
        // arrays — one per exec) is irrelevant to an INDEXED read, and the
        // per-read linear table scan was 29% of a standalone compiled-acorn
        // parse. Flag set ⇒ state global is non-null.
        { op: "global.get", index: core.numericFlagGlobalIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: pAny },
            { op: "ref.test", typeIdx: vecBaseIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: pAny },
                { op: "call", funcIdx: core.lookupIdx },
                { op: "local.tee", index: pComp },
                { op: "ref.is_null" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // e = __obj_find(comp, number_toString(idx))
                    { op: "local.get", index: pComp },
                    { op: "ref.as_non_null" },
                    { op: "local.get", index: 1 },
                    { op: "call", funcIdx: numToStringIdx },
                    { op: "call", funcIdx: objFindIdx },
                    { op: "local.tee", index: pE },
                    { op: "ref.is_null" },
                    { op: "i32.eqz" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        // A deleted own index does not terminate prototype
                        // lookup. Get must continue at Array.prototype (then
                        // Object.prototype); only a true chain miss is
                        // undefined. Check this before COMPANION_VALUE because
                        // tombstones deliberately carry both flags.
                        { op: "local.get", index: pE },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                        { op: "i32.const", value: FLAG_DELETED_INDEX },
                        { op: "i32.and" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [...(protoIndexGetIdxMissInstrs(ctx, 0, 1, 1) ?? missExtern()), { op: "return" }],
                        },
                        // accessor → invoke getter with the VEC as `this`
                        { op: "local.get", index: pE },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                        { op: "i32.const", value: FLAG_ACCESSOR },
                        { op: "i32.and" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: pE },
                            { op: "ref.as_non_null" },
                            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                            { op: "extern.convert_any" },
                            { op: "local.tee", index: pGetter },
                            { op: "ref.is_null" },
                            {
                              op: "if",
                              blockType: { kind: "empty" },
                              then: [...missExtern(), { op: "return" }],
                            },
                            { op: "local.get", index: 0 },
                            { op: "local.get", index: pGetter },
                            { op: "call", funcIdx: callAccessorGetIdx },
                            { op: "return" },
                          ],
                        },
                        // companion-authoritative value (unrepresentable in vec)
                        { op: "local.get", index: pE },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                        { op: "i32.const", value: FLAG_COMPANION_VALUE },
                        { op: "i32.and" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: pE },
                            { op: "ref.as_non_null" },
                            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                            { op: "extern.convert_any" },
                            { op: "return" },
                          ],
                        },
                        // (#4434) A plain data entry normally falls through to
                        // the vec read, because the define wrote its [[Value]]
                        // back into the element and later plain writes keep
                        // that fresh. That reasoning holds ONLY where the vec
                        // physically backs the index. Two cases where it does
                        // not, both of which read as `undefined` before this:
                        //
                        //   - a key outside the canonical array-index domain
                        //     (`arr[4294967295]` — the write-back is skipped
                        //     because `__obj_index_of_key` reports -1, so the
                        //     companion is the only copy);
                        //   - an index in the unbacked tail left by
                        //     `a.length = N` (vec-index-domain.ts §2).
                        //
                        // In both, the companion is authoritative. Decided at
                        // READ time rather than by marking the entry at define
                        // time, so a later `a.length = …` that grows or shrinks
                        // the backing cannot leave a stale authority bit.
                        { op: "local.get", index: 1 },
                        { op: "i32.trunc_sat_f64_s" },
                        { op: "local.set", index: pIdx },
                        ...vecBackedLen(pAny, pBacked),
                        { op: "local.get", index: pIdx },
                        { op: "local.get", index: pBacked },
                        { op: "i32.ge_u" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: pE },
                            { op: "ref.as_non_null" },
                            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                            { op: "extern.convert_any" },
                            { op: "return" },
                          ],
                        },
                        // backed data entry → fall through to the vec read
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];
      fn.body.splice(0, 0, ...prologue);
    }
  }

  // ── Overlay read prologue: __extern_get (string-key lane) ────────────────
  // Answers accessor + companion-value + named-expando keys on vec receivers;
  // plain index-keyed data entries fall through to the #3183 numeric arm (the
  // vec is authoritative there). Runs BEFORE the #3183 arm (spliced after it).
  // (#4491 D-a) The SAME prologue is spliced into `__vec_prop_get`.
  //
  // Standalone does not route a non-index named read on an array through
  // `__extern_get`: `resolveNamedPropHelper` (array-nonindex-key.ts) returns
  // `VEC_PROP_GET`, deliberately, because the `__extern_*` vec prologue would
  // otherwise swallow the key as an element. So `__vec_prop_get` is the
  // standalone twin of this lane — and it never got the overlay prologue,
  // while `__extern_get` (the gc/host lane) has had it since #3251. That
  // asymmetry IS the bug: measured standalone, `Object.defineProperty(a,
  // "4294967295", {value:7})` then `a[4294967295]` answered `undefined`, while
  // `gOPD` / `gOPN` / `in` / `Object.hasOwn` all found it — they span both the
  // #3537 bag and the #3251 companion, and only the element read did not.
  //
  // Spliced by ITERATION rather than copied so the two lanes cannot drift: a
  // future fix to one is a fix to both by construction. `findFn` returning
  // undefined (the native was never reserved) skips that lane, so a module
  // without the substrate is byte-identical.
  //
  // NOT wired at `__vec_prop_get`'s build site: `__vec_overlay_lookup` does not
  // exist yet there (measured — `overlayLookup=undefined`), which is precisely
  // why the overlay read prologues are FINALIZE-time splices in the first place.
  for (const overlayGetLane of ["__extern_get", "__vec_prop_get"]) {
    const fn = findFn(overlayGetLane);
    if (fn) {
      const base = 2 + fn.locals.length;
      const gAny = base;
      const gComp = base + 1;
      const gE = base + 2;
      const gGetter = base + 3;
      fn.locals.push(
        { name: "__ov_any", type: { kind: "anyref" } },
        { name: "__ov_comp", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
        { name: "__ov_e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
        { name: "__ov_getter", type: { kind: "externref" } },
      );
      const prologue: Instr[] = [
        { op: "global.get", index: core.stateGlobalIdx },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: gAny },
            { op: "ref.test", typeIdx: vecBaseIdx },
            // The consult keys `__obj_find` with the raw externref key —
            // restrict to $AnyString keys (a boxed-number key is the #3183
            // numeric arm's job; a Symbol key has no overlay entry).
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: anyStrTypeIdx },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              // (#3251 S3) "length" is EXCLUDED from the companion consult —
              // the live vec length field is authoritative (a companion copy
              // goes stale on push/plain writes); the pre-existing length arm
              // below answers it.
              then: notLengthWrap(1, [
                { op: "local.get", index: gAny },
                { op: "call", funcIdx: core.lookupIdx },
                { op: "local.tee", index: gComp },
                { op: "ref.is_null" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: gComp },
                    { op: "ref.as_non_null" },
                    { op: "local.get", index: 1 },
                    { op: "call", funcIdx: objFindIdx },
                    { op: "local.tee", index: gE },
                    { op: "ref.is_null" },
                    { op: "i32.eqz" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: gE },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                        { op: "i32.const", value: FLAG_ACCESSOR },
                        { op: "i32.and" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: gE },
                            { op: "ref.as_non_null" },
                            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                            { op: "extern.convert_any" },
                            { op: "local.tee", index: gGetter },
                            { op: "ref.is_null" },
                            {
                              op: "if",
                              blockType: { kind: "empty" },
                              then: [...missExtern(), { op: "return" }],
                            },
                            { op: "local.get", index: 0 },
                            { op: "local.get", index: gGetter },
                            { op: "call", funcIdx: callAccessorGetIdx },
                            { op: "return" },
                          ],
                        },
                        // Data entry: for an index key the vec read below is
                        // authoritative unless the companion holds the value;
                        // a NON-index (named expando) key has no vec source —
                        // the companion is always the answer.
                        { op: "local.get", index: gE },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                        { op: "i32.const", value: FLAG_COMPANION_VALUE },
                        { op: "i32.and" },
                        { op: "i32.const", value: 0 },
                        { op: "i32.ne" },
                        { op: "local.get", index: 1 },
                        { op: "any.convert_extern" },
                        { op: "ref.test", typeIdx: anyStrTypeIdx },
                        {
                          op: "if",
                          blockType: { kind: "val", type: { kind: "i32" } },
                          then: [
                            { op: "local.get", index: 1 },
                            { op: "any.convert_extern" },
                            { op: "ref.cast", typeIdx: anyStrTypeIdx },
                            { op: "call", funcIdx: objIndexOfKeyIdx },
                            { op: "i32.const", value: 0 },
                            { op: "i32.lt_s" },
                          ],
                          else: [{ op: "i32.const", value: 1 }],
                        },
                        { op: "i32.or" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: gE },
                            { op: "ref.as_non_null" },
                            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                            { op: "extern.convert_any" },
                            { op: "return" },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ]),
            },
          ],
        },
      ];
      fn.body.splice(0, 0, ...prologue);
    }
  }

  // ── (#4222) Overlay PRESENCE prologue: __extern_has_idx ───────────────────
  // The read prologues above make Get see a deleted index as `undefined`; this
  // makes HasProperty agree. Body lives in `vec-overlay-presence.ts` (the same
  // split as the delete prologue in `vec-bag-seed.ts`).
  {
    const fn = findFn("__extern_has_idx");
    if (fn) {
      buildVecHasIdxPresencePrologue(fn, {
        objectTypeIdx,
        propEntryTypeIdx,
        vecBaseIdx,
        lookupIdx: core.lookupIdx,
        numericFlagGlobalIdx: core.numericFlagGlobalIdx,
        numToStringIdx,
        objFindIdx,
        deletedIndexFlag: FLAG_DELETED_INDEX,
        deletedIndexMiss: protoIndexHasIdxInstrs(ctx, 1, 1),
      });
    }
  }
}
