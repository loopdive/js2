// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2163) Native (host-free) storage for Symbol descriptions.
 *
 * Standalone / WASI modules have no JS host, so the `__symbol_register_desc` /
 * `__symbol_description` host imports (#1467) are unsatisfiable — every
 * `Symbol(desc)` / `sym.description` either failed to instantiate or leaked an
 * `env::*` import. The symbol value itself is a bare i32 counter id
 * (`compileSymbolCall`, literals.ts), so the description just needs an
 * id→string side table the module owns.
 *
 * Representation: a single mutable module global holding a growable
 * `(array (mut (ref null $AnyString)))`, indexed directly by the symbol id.
 * The array is lazily allocated on first store and grown ×2 (copying) when a
 * larger id arrives. A null slot (or id past the current length) reads back as
 * `undefined`, matching `Symbol().description === undefined`.
 *
 * Only used in `noJsHost` mode; JS-host mode keeps the spec-accurate host
 * accessor path unchanged.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureSymbolCounter } from "./literals.js";
import { ensureNativeStringBoundaryBridge, ensureNativeStringHelpers, nativeStringType } from "./native-strings.js";
import { addFuncType, getOrRegisterArrayType } from "./registry/types.js";
import { compileNativeStringLiteral } from "./string-ops.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting

/** Initial capacity of the description table (covers small symbol counts without
 *  a grow; ids start at 100 so the very first user symbol already forces one
 *  grow regardless — see emitSymbolDescStore). */
const INITIAL_CAP = 128;

/** Select the Wasm-owned Symbol provider independently of the host environment. */
export function usesNativeSymbolProvider(ctx: CodegenContext): boolean {
  return ctx.targetProfile.semanticProviders === "native-first";
}

/**
 * (#2866) Ensure the native `$Symbol` carrier struct and the host-free
 * `__box_symbol(i32 id) -> externref` builder exist. Idempotent. Sets
 * `ctx.symbolTypeIdx` and registers `__box_symbol` in `ctx.funcMap` as a DEFINED
 * function (no import → no index shift, same invariant as the #1471 boxing
 * helpers and the #1472 object-runtime helpers).
 *
 * A standalone/WASI Symbol VALUE is a bare i32 counter id (`compileSymbolCall`,
 * literals.ts); its description lives in the id→string side table
 * (`ensureSymbolDescTable`). The carrier is needed only when a Symbol must cross
 * an **externref channel** — chiefly entering the `$Object` property key path
 * (externref-typed), where the host-only `env::__box_symbol` import would
 * otherwise leak (#2866). Identity is decided by the i32 `$id` (id-compare in
 * `__obj_find`/`__key_equals`), so NO interning of carriers is required: a fresh
 * `$Symbol` struct per box is fine because two carriers with the same id compare
 * equal and the same well-known/registry id always reproduces the same id.
 *
 * `$desc` is carried for forward use (getOwnPropertySymbols → `.description`) but
 * left null here; the description is always recoverable from the side table by
 * id, so the box path stays trivial and side-table-free.
 *
 * MUST only be called in `ctx.standalone || ctx.wasi` (host/gc mode keeps the
 * spec-accurate `env::__box_symbol` host import; registering a native carrier
 * there would both collide with that import and shift host type indices).
 */
export function ensureSymbolCarrier(ctx: CodegenContext): number {
  if (ctx.symbolTypeIdx < 0) {
    // `ensureNativeStringHelpers` registers the native string types and sets
    // `ctx.anyStrTypeIdx` (the carrier's `$desc` field type).
    ensureNativeStringHelpers(ctx);
    const anyStrTypeIdx = ctx.anyStrTypeIdx;
    const idx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name: "$Symbol",
      fields: [
        { name: "id", type: { kind: "i32" }, mutable: false },
        { name: "desc", type: { kind: "ref_null", typeIdx: anyStrTypeIdx }, mutable: false },
      ],
    });
    ctx.symbolTypeIdx = idx;
  }
  if (ctx.funcMap.get("__box_symbol") === undefined) {
    const symIdx = ctx.symbolTypeIdx;
    const anyStrTypeIdx = ctx.anyStrTypeIdx;
    // (#2866 slice 3) INTERN carriers by id. A standalone symbol VALUE is a bare
    // i32 id; whenever it crosses an externref channel (`$Object` key, `symbol[]`
    // element, an `any`-typed argument such as `assert.sameValue(syms[0], sym)`)
    // it is boxed via `__box_symbol`. Identity is decided by the i32 id, but the
    // generic externref `===` paths (`__extern_strict_eq`/`__any_strict_eq`,
    // array `indexOf`) compare boxed objects with `ref.eq`. A fresh struct per box
    // made two boxings of the SAME symbol compare unequal (`getOwnPropertySymbols`
    // identity, `sym in obj`, `[sym].indexOf(sym)`). Interning — one canonical
    // `$Symbol` per id in a growable id→carrier table — makes `ref.eq` hold for
    // same-id boxings, so symbol identity works uniformly with no change to the
    // central equality helpers. The table is lazily allocated and grown ×2.
    const internArrTypeIdx = getOrRegisterArrayType(ctx, `symref_${symIdx}`, {
      kind: "ref_null",
      typeIdx: symIdx,
    });
    const internGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: "__symbol_intern_table",
      type: { kind: "ref_null", typeIdx: internArrTypeIdx },
      mutable: true,
      init: [{ op: "ref.null", typeIdx: internArrTypeIdx }],
    });
    const symNull: ValType = { kind: "ref_null", typeIdx: symIdx };
    const arrNull: ValType = { kind: "ref_null", typeIdx: internArrTypeIdx };
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "externref" }]);
    const funcIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
    ctx.funcMap.set("__box_symbol", funcIdx);
    // params: 0=id(i32). locals: 1=tbl 2=existing 3=grow
    const TBL = 1;
    const EXISTING = 2;
    const GROW = 3;
    pushDefinedFunc(ctx, funcIdx, {
      name: "__box_symbol",
      typeIdx,
      locals: [
        { name: "tbl", type: arrNull },
        { name: "existing", type: symNull },
        { name: "grow", type: arrNull },
      ],
      body: [
        // tbl = global; allocate (id+1, min 16) slots if null.
        { op: "global.get", index: internGlobalIdx },
        { op: "local.tee", index: TBL },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // allocate id+1 slots; the grow loop below extends ×2 as ids climb.
            { op: "local.get", index: 0 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.new_default", typeIdx: internArrTypeIdx },
            { op: "local.set", index: TBL },
            { op: "local.get", index: TBL },
            { op: "global.set", index: internGlobalIdx },
          ],
        },
        // grow ×2 until id < tbl.len
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: TBL },
                { op: "ref.as_non_null" },
                { op: "array.len" },
                { op: "i32.lt_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: TBL },
                { op: "ref.as_non_null" },
                { op: "array.len" },
                { op: "i32.const", value: 2 },
                { op: "i32.mul" },
                { op: "array.new_default", typeIdx: internArrTypeIdx },
                { op: "local.set", index: GROW },
                { op: "local.get", index: GROW },
                { op: "ref.as_non_null" },
                { op: "i32.const", value: 0 },
                { op: "local.get", index: TBL },
                { op: "ref.as_non_null" },
                { op: "i32.const", value: 0 },
                { op: "local.get", index: TBL },
                { op: "ref.as_non_null" },
                { op: "array.len" },
                { op: "array.copy", dstTypeIdx: internArrTypeIdx, srcTypeIdx: internArrTypeIdx },
                { op: "local.get", index: GROW },
                { op: "local.set", index: TBL },
                { op: "local.get", index: TBL },
                { op: "global.set", index: internGlobalIdx },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // existing = tbl[id]; if null create + store; return extern(existing).
        { op: "local.get", index: TBL },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 0 },
        { op: "array.get", typeIdx: internArrTypeIdx },
        { op: "local.tee", index: EXISTING },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [
            // tbl[id] = new $Symbol{id, null}; tee into `existing`
            { op: "local.get", index: TBL },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 0 },
            { op: "local.get", index: 0 },
            { op: "ref.null", typeIdx: anyStrTypeIdx },
            { op: "struct.new", typeIdx: symIdx },
            { op: "local.tee", index: EXISTING },
            { op: "array.set", typeIdx: internArrTypeIdx },
            { op: "local.get", index: EXISTING },
            { op: "ref.as_non_null" },
            { op: "extern.convert_any" },
          ],
          else: [{ op: "local.get", index: EXISTING }, { op: "ref.as_non_null" }, { op: "extern.convert_any" }],
        },
      ],
      exported: false,
    });
  }
  return ctx.symbolTypeIdx;
}

/**
 * Publish the narrow value adapter used when a native Symbol crosses a
 * JavaScript boundary. Symbol identity, descriptions, and the global registry
 * remain module-owned; the host adapter only maps the canonical i32 id to/from
 * the corresponding JavaScript Symbol primitive.
 */
export function ensureNativeSymbolBoundaryBridge(ctx: CodegenContext): void {
  if (!usesNativeSymbolProvider(ctx) || !ctx.emitHostBridge || ctx.targetProfile.hostValueInterop === "off") return;

  ensureNativeStringHelpers(ctx);
  ensureNativeStringBoundaryBridge(ctx);
  const symbolTypeIdx = ensureSymbolCarrier(ctx);
  ensureSymbolDescTable(ctx);
  const { forIdx, keyForIdx } = ensureSymbolRegistry(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const anyStrNull: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  const descArrTypeIdx = ctx.symbolDescArrTypeIdx;
  const descGlobalIdx = ctx.symbolDescGlobalIdx;
  const descArrNull: ValType = { kind: "ref_null", typeIdx: descArrTypeIdx };

  const register = (
    name: string,
    params: ValType[],
    results: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ): number => {
    const existing = ctx.funcMap.get(name);
    if (existing !== undefined) return existing;
    const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, funcIdx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: true });
    return funcIdx;
  };

  const isNativeIdx = register(
    "__symbol_boundary_is_native",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    [],
    [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: symbolTypeIdx }],
  );
  const idIdx = register(
    "__symbol_boundary_id",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: symbolTypeIdx },
      { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 },
    ],
  );
  const descriptionIdx = register(
    "__symbol_boundary_description",
    [{ kind: "i32" }],
    [anyStrNull],
    [{ name: "table", type: descArrNull }],
    [
      { op: "global.get", index: descGlobalIdx },
      { op: "local.tee", index: 1 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: anyStrNull },
        then: [{ op: "ref.null", typeIdx: anyStrTypeIdx }],
        else: [
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "ref.as_non_null" },
          { op: "array.len" },
          { op: "i32.lt_s" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: anyStrNull },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 0 },
              { op: "array.get", typeIdx: descArrTypeIdx },
            ],
            else: [{ op: "ref.null", typeIdx: anyStrTypeIdx }],
          },
        ],
      },
    ],
  );

  const counterIdx = ensureSymbolCounter(ctx);
  const newIdx = register(
    "__symbol_boundary_new",
    [anyStrNull],
    [{ kind: "i32" }],
    [
      { name: "id", type: { kind: "i32" } },
      { name: "table", type: descArrNull },
      { name: "grow", type: descArrNull },
    ],
    [
      { op: "global.get", index: counterIdx },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "global.set", index: counterIdx },
      { op: "global.get", index: counterIdx },
      { op: "local.set", index: 1 },
      ...emitDescStoreInline(descGlobalIdx, descArrTypeIdx, 1, 0, 2, 3),
      { op: "local.get", index: 1 },
    ],
  );

  const expose = (name: string, funcIdx: number): void => {
    const func = definedFuncAt(ctx, funcIdx);
    if (func) func.exported = true;
    if (!ctx.mod.exports.some((entry) => entry.name === name)) {
      ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
    }
  };
  expose("__symbol_boundary_is_native", isNativeIdx);
  expose("__symbol_boundary_id", idIdx);
  expose("__symbol_boundary_description", descriptionIdx);
  expose("__symbol_boundary_new", newIdx);
  expose("__symbol_boundary_for", forIdx);
  expose("__symbol_boundary_key_for", keyForIdx);
  const boxIdx = ctx.funcMap.get("__box_symbol");
  if (boxIdx !== undefined) expose("__box_symbol", boxIdx);
}

/**
 * Ensure the symbol description table's array type and lazy global exist.
 * Idempotent. Sets `ctx.symbolDescArrTypeIdx` and `ctx.symbolDescGlobalIdx`.
 */
export function ensureSymbolDescTable(ctx: CodegenContext): void {
  if (ctx.symbolDescGlobalIdx >= 0) return;
  ensureNativeStringHelpers(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  // (array (mut (ref null $AnyString))) — same shape the native string runtime
  // already registers for its split/flatten worklists (keyed by `ref_<anyStr>`).
  const arrTypeIdx = getOrRegisterArrayType(ctx, `ref_${anyStrTypeIdx}`, {
    kind: "ref_null",
    typeIdx: anyStrTypeIdx,
  });
  ctx.symbolDescArrTypeIdx = arrTypeIdx;

  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__symbol_desc_table",
    type: { kind: "ref_null", typeIdx: arrTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: arrTypeIdx }],
  });
  ctx.symbolDescGlobalIdx = globalIdx;
}

/**
 * Emit code that stores a description for a symbol id into the native table.
 *
 * Stack in:  `[i32 id, ref_null $AnyString desc]`  (desc on top)
 * Stack out: `[]`
 *
 * Allocates the table on first use and grows it (×2 until it fits, copying the
 * existing slots) when `id >= table.len`.
 */
export function emitSymbolDescStore(ctx: CodegenContext, fctx: FunctionContext): void {
  ensureSymbolDescTable(ctx);
  const arrTypeIdx = ctx.symbolDescArrTypeIdx;
  const globalIdx = ctx.symbolDescGlobalIdx;
  const anyStrNull: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  const arrNull: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };

  const idLocal = allocLocal(fctx, `__symdesc_id_${fctx.locals.length}`, { kind: "i32" });
  const descLocal = allocLocal(fctx, `__symdesc_val_${fctx.locals.length}`, anyStrNull);
  const tblLocal = allocLocal(fctx, `__symdesc_tbl_${fctx.locals.length}`, arrNull);
  const capLocal = allocLocal(fctx, `__symdesc_cap_${fctx.locals.length}`, { kind: "i32" });
  const growLocal = allocLocal(fctx, `__symdesc_grow_${fctx.locals.length}`, arrNull);

  // desc and id arrive on the stack (id pushed first, desc on top).
  fctx.body.push({ op: "local.set", index: descLocal });
  fctx.body.push({ op: "local.set", index: idLocal });

  // tbl = global; if null → allocate INITIAL_CAP (grown below if id is larger).
  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "local.tee", index: tblLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: INITIAL_CAP },
      { op: "array.new_default", typeIdx: arrTypeIdx },
      { op: "local.set", index: tblLocal },
      { op: "local.get", index: tblLocal },
      { op: "global.set", index: globalIdx },
    ],
    else: [],
  });

  // Grow loop: while (id >= tbl.len) { cap = tbl.len*2; grow = new[cap];
  //   array.copy grow[0..tbl.len] = tbl[0..tbl.len]; tbl = grow; global = tbl; }
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          // if (id < tbl.len) break
          { op: "local.get", index: idLocal },
          { op: "local.get", index: tblLocal },
          { op: "ref.as_non_null" },
          { op: "array.len" },
          { op: "i32.lt_s" },
          { op: "br_if", depth: 1 },
          // cap = tbl.len * 2
          { op: "local.get", index: tblLocal },
          { op: "ref.as_non_null" },
          { op: "array.len" },
          { op: "i32.const", value: 2 },
          { op: "i32.mul" },
          { op: "local.set", index: capLocal },
          // grow = new[cap]
          { op: "local.get", index: capLocal },
          { op: "array.new_default", typeIdx: arrTypeIdx },
          { op: "local.set", index: growLocal },
          // array.copy grow[0 ..] = tbl[0 .. tbl.len]
          { op: "local.get", index: growLocal },
          { op: "ref.as_non_null" },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: tblLocal },
          { op: "ref.as_non_null" },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: tblLocal },
          { op: "ref.as_non_null" },
          { op: "array.len" },
          { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
          // tbl = grow; global = tbl
          { op: "local.get", index: growLocal },
          { op: "local.set", index: tblLocal },
          { op: "local.get", index: tblLocal },
          { op: "global.set", index: globalIdx },
          { op: "br", depth: 0 },
        ],
      },
    ],
  });

  // tbl[id] = desc
  fctx.body.push({ op: "local.get", index: tblLocal });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "local.get", index: idLocal });
  fctx.body.push({ op: "local.get", index: descLocal });
  fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
}

/**
 * Emit code that loads the description for a symbol id from the native table.
 *
 * Stack in:  `[i32 id]`
 * Stack out: `[ref_null $AnyString]`  (null when the table is unallocated, the
 *            id is out of range, or the slot was never set — all of which the
 *            `.description` accessor treats as `undefined`).
 */
export function emitSymbolDescLoad(ctx: CodegenContext, fctx: FunctionContext): void {
  ensureSymbolDescTable(ctx);
  const arrTypeIdx = ctx.symbolDescArrTypeIdx;
  const globalIdx = ctx.symbolDescGlobalIdx;
  const anyStrNull: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  const arrNull: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };

  const idLocal = allocLocal(fctx, `__symdescr_id_${fctx.locals.length}`, { kind: "i32" });
  const tblLocal = allocLocal(fctx, `__symdescr_tbl_${fctx.locals.length}`, arrNull);

  fctx.body.push({ op: "local.set", index: idLocal });
  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "local.tee", index: tblLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    // result: ref_null $AnyString
    blockType: { kind: "val", type: anyStrNull },
    // table unallocated → undefined
    then: [{ op: "ref.null", typeIdx: ctx.anyStrTypeIdx }],
    else: [
      // if (id >= 0 && id < tbl.len) return tbl[id]; else null
      { op: "local.get", index: idLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" },
      { op: "local.get", index: idLocal },
      { op: "local.get", index: tblLocal },
      { op: "ref.as_non_null" },
      { op: "array.len" },
      { op: "i32.lt_s" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: anyStrNull },
        then: [
          { op: "local.get", index: tblLocal },
          { op: "ref.as_non_null" },
          { op: "local.get", index: idLocal },
          { op: "array.get", typeIdx: arrTypeIdx },
        ],
        else: [{ op: "ref.null", typeIdx: ctx.anyStrTypeIdx }],
      },
    ],
  });
}

/** Initial registry capacity (most programs register a handful of global symbols). */
const REG_INITIAL_CAP = 16;

/**
 * (#2163) Ensure the native `Symbol.for` / `Symbol.keyFor` registry exists:
 * two parallel growable arrays (slot→key `$AnyString`, slot→symbol id i32) plus
 * a count global, and the two runtime helper functions `__symbol_for_native`
 * and `__symbol_keyfor_native`. Idempotent.
 *
 * The registry reuses the description-table key types and the native
 * `__str_equals` (content equality, flattens cons-strings) for the key lookup.
 * A registered symbol's description is its key (§20.4.2.2 step 4b), so
 * `__symbol_for_native` also stores the key in the description table.
 */
export function ensureSymbolRegistry(ctx: CodegenContext): {
  forIdx: number;
  keyForIdx: number;
} {
  ensureNativeStringHelpers(ctx);
  ensureSymbolDescTable(ctx);
  const counterIdx = ensureSymbolCounter(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const keysArrTypeIdx = ctx.symbolDescArrTypeIdx; // (array (mut (ref null $AnyString)))
  const strEqIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (strEqIdx === undefined) {
    throw new Error("ensureSymbolRegistry: __str_equals helper missing");
  }

  if (ctx.symbolRegKeysGlobalIdx < 0) {
    // ids array type: (array (mut i32))
    const idsArrTypeIdx = getOrRegisterArrayType(ctx, "i32", { kind: "i32" });
    ctx.symbolRegIdsArrTypeIdx = idsArrTypeIdx;
    const keysArrNull: ValType = { kind: "ref_null", typeIdx: keysArrTypeIdx };
    const idsArrNull: ValType = { kind: "ref_null", typeIdx: idsArrTypeIdx };

    ctx.symbolRegKeysGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: "__symbol_reg_keys",
      type: keysArrNull,
      mutable: true,
      init: [{ op: "ref.null", typeIdx: keysArrTypeIdx }],
    });
    ctx.symbolRegIdsGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: "__symbol_reg_ids",
      type: idsArrNull,
      mutable: true,
      init: [{ op: "ref.null", typeIdx: idsArrTypeIdx }],
    });
    ctx.symbolRegCountGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: "__symbol_reg_count",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
  }

  const idsArrTypeIdx = ctx.symbolRegIdsArrTypeIdx;
  const keysG = ctx.symbolRegKeysGlobalIdx;
  const idsG = ctx.symbolRegIdsGlobalIdx;
  const countG = ctx.symbolRegCountGlobalIdx;
  const descG = ctx.symbolDescGlobalIdx;
  const descArrTypeIdx = ctx.symbolDescArrTypeIdx;
  const anyStrNull: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  const keysArrNull: ValType = { kind: "ref_null", typeIdx: keysArrTypeIdx };
  const idsArrNull: ValType = { kind: "ref_null", typeIdx: idsArrTypeIdx };

  // Register helpers idempotently via ctx.funcMap.
  let forIdx = ctx.funcMap.get("__symbol_for_native");
  let keyForIdx = ctx.funcMap.get("__symbol_keyfor_native");
  if (forIdx !== undefined && keyForIdx !== undefined) return { forIdx, keyForIdx };

  // ── __symbol_for_native(key: ref $AnyString) -> i32 ─────────────────────
  {
    const typeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: anyStrTypeIdx }], [{ kind: "i32" }]);
    forIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
    ctx.funcMap.set("__symbol_for_native", forIdx);
    // params: key(0). locals: i(1), n(2), keys(3), ids(4), newCap(5), newKeys(6),
    //   newIds(7), id(8)
    const KEY = 0;
    const I = 1;
    const N = 2;
    const KEYS = 3;
    const IDS = 4;
    const NEWCAP = 5;
    const NEWKEYS = 6;
    const NEWIDS = 7;
    const ID = 8;
    const DESCTBL = 9;
    const DESCGROW = 10;

    const body: Instr[] = [
      // n = count
      { op: "global.get", index: countG },
      { op: "local.set", index: N },
      // keys = keysGlobal; ids = idsGlobal
      { op: "global.get", index: keysG },
      { op: "local.set", index: KEYS },
      { op: "global.get", index: idsG },
      { op: "local.set", index: IDS },
      // linear scan: for (i=0; i<n; i++) if __str_equals(keys[i], key) return ids[i]
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= n break
              { op: "local.get", index: I },
              { op: "local.get", index: N },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // candidate = keys[i]; if non-null && __str_equals(candidate, key) → return ids[i]
              { op: "local.get", index: KEYS },
              { op: "ref.as_non_null" },
              { op: "local.get", index: I },
              { op: "array.get", typeIdx: keysArrTypeIdx },
              { op: "ref.as_non_null" },
              { op: "local.get", index: KEY },
              { op: "call", funcIdx: strEqIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: IDS },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: I },
                  { op: "array.get", typeIdx: idsArrTypeIdx },
                  { op: "return" },
                ],
                else: [],
              },
              // i++
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Not found → create a new registered symbol.
      // id = ++counter
      { op: "global.get", index: counterIdx },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "global.set", index: counterIdx },
      { op: "global.get", index: counterIdx },
      { op: "local.set", index: ID },
      // Ensure capacity: if keys==null → allocate REG_INITIAL_CAP; else if n==keys.len → grow ×2.
      { op: "local.get", index: KEYS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: REG_INITIAL_CAP },
          { op: "array.new_default", typeIdx: keysArrTypeIdx },
          { op: "local.set", index: KEYS },
          { op: "local.get", index: KEYS },
          { op: "global.set", index: keysG },
          { op: "i32.const", value: REG_INITIAL_CAP },
          { op: "array.new_default", typeIdx: idsArrTypeIdx },
          { op: "local.set", index: IDS },
          { op: "local.get", index: IDS },
          { op: "global.set", index: idsG },
        ],
        else: [
          // if n == keys.len → grow
          { op: "local.get", index: N },
          { op: "local.get", index: KEYS },
          { op: "ref.as_non_null" },
          { op: "array.len" },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // newCap = keys.len * 2
              { op: "local.get", index: KEYS },
              { op: "ref.as_non_null" },
              { op: "array.len" },
              { op: "i32.const", value: 2 },
              { op: "i32.mul" },
              { op: "local.set", index: NEWCAP },
              // newKeys = new[newCap]; copy; keys=newKeys; global=keys
              { op: "local.get", index: NEWCAP },
              { op: "array.new_default", typeIdx: keysArrTypeIdx },
              { op: "local.set", index: NEWKEYS },
              { op: "local.get", index: NEWKEYS },
              { op: "ref.as_non_null" },
              { op: "i32.const", value: 0 },
              { op: "local.get", index: KEYS },
              { op: "ref.as_non_null" },
              { op: "i32.const", value: 0 },
              { op: "local.get", index: N },
              { op: "array.copy", dstTypeIdx: keysArrTypeIdx, srcTypeIdx: keysArrTypeIdx },
              { op: "local.get", index: NEWKEYS },
              { op: "local.set", index: KEYS },
              { op: "local.get", index: KEYS },
              { op: "global.set", index: keysG },
              // newIds = new[newCap]; copy; ids=newIds; global=ids
              { op: "local.get", index: NEWCAP },
              { op: "array.new_default", typeIdx: idsArrTypeIdx },
              { op: "local.set", index: NEWIDS },
              { op: "local.get", index: NEWIDS },
              { op: "ref.as_non_null" },
              { op: "i32.const", value: 0 },
              { op: "local.get", index: IDS },
              { op: "ref.as_non_null" },
              { op: "i32.const", value: 0 },
              { op: "local.get", index: N },
              { op: "array.copy", dstTypeIdx: idsArrTypeIdx, srcTypeIdx: idsArrTypeIdx },
              { op: "local.get", index: NEWIDS },
              { op: "local.set", index: IDS },
              { op: "local.get", index: IDS },
              { op: "global.set", index: idsG },
            ],
            else: [],
          },
        ],
      },
      // keys[n] = key; ids[n] = id; count = n+1
      { op: "local.get", index: KEYS },
      { op: "ref.as_non_null" },
      { op: "local.get", index: N },
      { op: "local.get", index: KEY },
      { op: "array.set", typeIdx: keysArrTypeIdx },
      { op: "local.get", index: IDS },
      { op: "ref.as_non_null" },
      { op: "local.get", index: N },
      { op: "local.get", index: ID },
      { op: "array.set", typeIdx: idsArrTypeIdx },
      { op: "local.get", index: N },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "global.set", index: countG },
      // Store key as the registered symbol's description (§20.4.2.2): descTable[id] = key.
      // ensureSymbolDescTable already ran; the table global is descG, lazily
      // allocated/grown here mirroring emitSymbolDescStore but standalone (id is
      // small-ish). Allocate if null, grow until id fits, then set.
      ...emitDescStoreInline(descG, descArrTypeIdx, ID, KEY, /*tbl*/ DESCTBL, /*grow*/ DESCGROW),
      // return id
      { op: "local.get", index: ID },
    ];

    pushDefinedFunc(ctx, forIdx, {
      name: "__symbol_for_native",
      typeIdx,
      locals: [
        { name: "i", type: { kind: "i32" } },
        { name: "n", type: { kind: "i32" } },
        { name: "keys", type: keysArrNull },
        { name: "ids", type: idsArrNull },
        { name: "newCap", type: { kind: "i32" } },
        { name: "newKeys", type: keysArrNull },
        { name: "newIds", type: idsArrNull },
        { name: "id", type: { kind: "i32" } },
        { name: "descTbl", type: { kind: "ref_null", typeIdx: descArrTypeIdx } },
        { name: "descGrow", type: { kind: "ref_null", typeIdx: descArrTypeIdx } },
      ],
      body,
      exported: false,
    });
  }

  // ── __symbol_keyfor_native(id: i32) -> ref_null $AnyString ──────────────
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [anyStrNull]);
    keyForIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
    ctx.funcMap.set("__symbol_keyfor_native", keyForIdx);
    // params: id(0). locals: i(1), n(2), keys(3), ids(4)
    const ID = 0;
    const I = 1;
    const N = 2;
    const KEYS = 3;
    const IDS = 4;
    const body: Instr[] = [
      { op: "global.get", index: countG },
      { op: "local.set", index: N },
      { op: "global.get", index: keysG },
      { op: "local.set", index: KEYS },
      { op: "global.get", index: idsG },
      { op: "local.set", index: IDS },
      // if keys==null → undefined
      { op: "local.get", index: KEYS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null", typeIdx: anyStrTypeIdx }, { op: "return" }],
        else: [],
      },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: I },
              { op: "local.get", index: N },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // if ids[i] == id → return keys[i]
              { op: "local.get", index: IDS },
              { op: "ref.as_non_null" },
              { op: "local.get", index: I },
              { op: "array.get", typeIdx: idsArrTypeIdx },
              { op: "local.get", index: ID },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: KEYS },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: I },
                  { op: "array.get", typeIdx: keysArrTypeIdx },
                  { op: "return" },
                ],
                else: [],
              },
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found → undefined
      { op: "ref.null", typeIdx: anyStrTypeIdx },
    ];
    pushDefinedFunc(ctx, keyForIdx, {
      name: "__symbol_keyfor_native",
      typeIdx,
      locals: [
        { name: "i", type: { kind: "i32" } },
        { name: "n", type: { kind: "i32" } },
        { name: "keys", type: keysArrNull },
        { name: "ids", type: idsArrNull },
      ],
      body,
      exported: false,
    });
  }

  return { forIdx: forIdx!, keyForIdx: keyForIdx! };
}

/**
 * (#2163) Inline description-table store used inside `__symbol_for_native`'s
 * body (a registered function with raw local indices, not an `fctx`). Stores
 * `descTable[id] = key`, allocating/growing the table so `id` is in range.
 * Mirrors `emitSymbolDescStore` but with caller-supplied local indices.
 *
 * `tblLocal` (declared `ref_null descArrTypeIdx`) and `growLocal` (same type)
 * are scratch locals the caller reserves. The grow path copies the OLD table
 * into a fresh, larger one BEFORE reassigning, so no slots are lost.
 */
function emitDescStoreInline(
  descG: number,
  descArrTypeIdx: number,
  idLocal: number,
  keyLocal: number,
  tblLocal: number,
  growLocal: number,
): Instr[] {
  return [
    // tbl = descG; if null allocate id+1 slots.
    { op: "global.get", index: descG },
    { op: "local.set", index: tblLocal },
    { op: "local.get", index: tblLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: idLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.new_default", typeIdx: descArrTypeIdx },
        { op: "local.set", index: tblLocal },
        { op: "local.get", index: tblLocal },
        { op: "global.set", index: descG },
      ],
      else: [],
    },
    // if (id >= tbl.len) { grow = new[id+1]; array.copy grow[0..tbl.len]=tbl; tbl=grow; global=tbl }
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        // if id < tbl.len → nothing to do (break)
        { op: "local.get", index: idLocal },
        { op: "local.get", index: tblLocal },
        { op: "ref.as_non_null" },
        { op: "array.len" },
        { op: "i32.lt_s" },
        { op: "br_if", depth: 0 },
        // grow = new[id+1]
        { op: "local.get", index: idLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.new_default", typeIdx: descArrTypeIdx },
        { op: "local.set", index: growLocal },
        // array.copy grow[0 ..] = tbl[0 .. tbl.len]
        { op: "local.get", index: growLocal },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: tblLocal },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: tblLocal },
        { op: "ref.as_non_null" },
        { op: "array.len" },
        { op: "array.copy", dstTypeIdx: descArrTypeIdx, srcTypeIdx: descArrTypeIdx },
        // tbl = grow; global = tbl
        { op: "local.get", index: growLocal },
        { op: "local.set", index: tblLocal },
        { op: "local.get", index: tblLocal },
        { op: "global.set", index: descG },
      ],
    },
    // tbl[id] = key
    { op: "local.get", index: tblLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: idLocal },
    { op: "local.get", index: keyLocal },
    { op: "array.set", typeIdx: descArrTypeIdx },
  ];
}

/**
 * (#2163) Emit `Symbol.prototype.toString` (§20.4.3.3 → SymbolDescriptiveString,
 * §20.4.3.3.1) in `noJsHost` mode, producing the native string
 * `"Symbol(" + (desc ?? "") + ")"`.
 *
 * Stack in:  `[i32 id]`            (the symbol's i32 counter id)
 * Stack out: `[ref $AnyString]`    (the descriptive string)
 *
 * `desc` is read from the native description side table (`emitSymbolDescLoad`);
 * a missing description (`undefined`) contributes the empty string, matching
 * `Symbol().toString() === "Symbol()"`. Zero host imports — the prefix/suffix
 * are inline native-string literals concatenated via the native `__str_concat`
 * helper (same lowering template literals use).
 */
export function emitSymbolToString(ctx: CodegenContext, fctx: FunctionContext): void {
  ensureNativeStringHelpers(ctx);
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
  const anyStr = nativeStringType(ctx); // ref $AnyString
  const descLocal = allocLocal(fctx, `__symstr_desc_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: ctx.anyStrTypeIdx,
  });

  // desc = descTable[id]  (ref_null $AnyString; null ⇒ undefined ⇒ "")
  emitSymbolDescLoad(ctx, fctx);
  fctx.body.push({ op: "local.set", index: descLocal });

  // left = "Symbol("
  compileNativeStringLiteral(ctx, fctx, "Symbol(");

  // right = desc ?? ""  (collapse the undefined sentinel to the empty string)
  fctx.body.push({ op: "local.get", index: descLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: anyStr },
    then: [
      // undefined description → ""
      { op: "i32.const", value: 0 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "array.new_fixed", typeIdx: ctx.nativeStrDataTypeIdx, length: 0 },
      { op: "struct.new", typeIdx: ctx.nativeStrTypeIdx },
    ],
    else: [{ op: "local.get", index: descLocal }, { op: "ref.as_non_null" }],
  });

  // "Symbol(" + desc
  fctx.body.push({ op: "call", funcIdx: concatIdx });

  // + ")"
  compileNativeStringLiteral(ctx, fctx, ")");
  fctx.body.push({ op: "call", funcIdx: concatIdx });
}
