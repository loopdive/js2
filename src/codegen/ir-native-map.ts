// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4461 — externref-ABI adapters over the native `$Map` runtime (#1103a).
 *
 * The IR models a host `Map` module binding as an `extern<Map>` handle whose
 * every operation is an externref-in / externref-out host call. Host-free lanes
 * lower the same source `Map` to the WasmGC `$Map` struct, whose helper ABI is
 * `(ref $Map, anyref, …)`. Those two shapes cannot meet inside the IR without
 * either teaching the middle end a new reference kind or teaching it to box.
 *
 * These three adapters are the third option, and the cheapest one that keeps
 * **selector claim ⇔ lowering parity** honest: each is a thin Wasm function
 * with an ABI the IR already speaks, whose body performs exactly the
 * conversions legacy's own `compileCollectionElementArg` / `coerceArgToAnyref`
 * perform at the same sites. No new IR type, no new IR boxing primitive, and —
 * critically — the SAME `__map_new` / `__map_get` / `__map_set` helpers legacy
 * calls, so the IR and direct paths share one hash table implementation rather
 * than two that can drift.
 *
 * ABI (deliberately f64-keyed, not anyref-keyed):
 *
 *   __ir_map_new()                                 -> (ref $Map)
 *   __ir_map_get_num((ref null $Map), f64)         -> externref
 *   __ir_map_set_num((ref null $Map), f64, f64)    -> externref   (the map)
 *
 * The numeric key/value ABI is a capability statement, not a shortcut: the
 * selector admits a native-map `.get`/`.set` only where the checker proves
 * every key and value is a number, so the adapter surface and the claim
 * surface are the same set. Widening to string keys means adding an adapter
 * AND widening the selector proof, together.
 *
 * `ref.as_non_null` on the receiver mirrors legacy's brand check: a null
 * `__mod_<name>` slot is unreachable after module init, and both paths trap
 * rather than silently reading a missing table.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { COLLECTION_KIND, ensureMapHelpers } from "./map-runtime.js";
import { addUnionImports } from "./registry/imports.js";

/** Allocate the native `$Map` backing an IR-owned module binding. */
export const IR_NATIVE_MAP_NEW_FN = "__ir_map_new";
/** `map.get(numberKey)` with the IR's externref result ABI. */
export const IR_NATIVE_MAP_GET_NUM_FN = "__ir_map_get_num";
/** `map.set(numberKey, numberValue)`, returning the receiver (chainable). */
export const IR_NATIVE_MAP_SET_NUM_FN = "__ir_map_set_num";

function addAdapter(ctx: CodegenContext, name: string, params: ValType[], results: ValType[], body: Instr[]): void {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined && definedFuncAt(ctx, existing) !== undefined) return;
  const typeIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: [], body, exported: false });
}

/**
 * Emit the #4461 adapters. Idempotent, and safe to call from the IR
 * integration reserve pass: it registers the `$Map` runtime and the
 * box/unbox family FIRST (both may add imports / shift defined-function
 * indices) and only then mints append-only adapter functions, so no funcIdx
 * read after this call can be stale.
 */
export function ensureIrNativeMapAdapters(ctx: CodegenContext): void {
  // Ordering is load-bearing: `addUnionImports` can add an import batch (host
  // lanes) whose flush shifts every defined-function index. Run the shifting
  // registrations before minting anything of our own.
  addUnionImports(ctx);
  ensureMapHelpers(ctx);
  if (ctx.mapTypeIdx < 0) return;

  const mapRef: ValType = { kind: "ref", typeIdx: ctx.mapTypeIdx };
  const mapRefNull: ValType = { kind: "ref_null", typeIdx: ctx.mapTypeIdx };
  const externref: ValType = { kind: "externref" };
  const f64: ValType = { kind: "f64" };

  const mapNewIdx = ctx.mapHelpers.get("__map_new");
  const mapGetIdx = ctx.mapHelpers.get("__map_get");
  const mapSetIdx = ctx.mapHelpers.get("__map_set");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  if (mapNewIdx === undefined || mapGetIdx === undefined || mapSetIdx === undefined || boxNumberIdx === undefined) {
    return;
  }

  // f64 → anyref, the exact sequence `coerceArgToAnyref` emits for a number.
  const boxNumberAt = (localIndex: number): Instr[] => [
    { op: "local.get", index: localIndex },
    { op: "call", funcIdx: boxNumberIdx },
    { op: "any.convert_extern" },
  ];

  addAdapter(
    ctx,
    IR_NATIVE_MAP_NEW_FN,
    [],
    [mapRef],
    [
      { op: "i32.const", value: COLLECTION_KIND.MAP },
      { op: "call", funcIdx: mapNewIdx },
    ],
  );

  addAdapter(
    ctx,
    IR_NATIVE_MAP_GET_NUM_FN,
    [mapRefNull, f64],
    [externref],
    [
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      ...boxNumberAt(1),
      { op: "call", funcIdx: mapGetIdx },
      // `__map_get` answers with the #2106 `$undefined` singleton on a miss, so
      // the retag preserves the producer-honest miss the IR's strict
      // `!== undefined` check then tests via `__extern_is_undefined`.
      { op: "extern.convert_any" },
    ],
  );

  addAdapter(
    ctx,
    IR_NATIVE_MAP_SET_NUM_FN,
    [mapRefNull, f64, f64],
    [externref],
    [
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      ...boxNumberAt(1),
      ...boxNumberAt(2),
      { op: "call", funcIdx: mapSetIdx },
      // `__map_set` returns the receiver; retagging keeps the IR's uniform
      // externref result for a discarded/ chained method call.
      { op: "extern.convert_any" },
    ],
  );
}
