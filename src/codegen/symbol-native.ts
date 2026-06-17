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
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType, getOrRegisterArrayType } from "./registry/types.js";

/** Initial capacity of the description table (covers small symbol counts without
 *  a grow; ids start at 100 so the very first user symbol already forces one
 *  grow regardless — see emitSymbolDescStore). */
const INITIAL_CAP = 128;

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
    init: [{ op: "ref.null", typeIdx: arrTypeIdx } as Instr],
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
      { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
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
          { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
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
          { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
          // tbl = grow; global = tbl
          { op: "local.get", index: growLocal },
          { op: "local.set", index: tblLocal },
          { op: "local.get", index: tblLocal },
          { op: "global.set", index: globalIdx },
          { op: "br", depth: 0 },
        ],
      } as Instr,
    ],
  });

  // tbl[id] = desc
  fctx.body.push({ op: "local.get", index: tblLocal });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "local.get", index: idLocal });
  fctx.body.push({ op: "local.get", index: descLocal });
  fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx } as Instr);
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
    then: [{ op: "ref.null", typeIdx: ctx.anyStrTypeIdx } as Instr],
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
          { op: "local.get", index: tblLocal } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "local.get", index: idLocal } as Instr,
          { op: "array.get", typeIdx: arrTypeIdx } as Instr,
        ],
        else: [{ op: "ref.null", typeIdx: ctx.anyStrTypeIdx } as Instr],
      } as Instr,
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
      init: [{ op: "ref.null", typeIdx: keysArrTypeIdx } as Instr],
    });
    ctx.symbolRegIdsGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: "__symbol_reg_ids",
      type: idsArrNull,
      mutable: true,
      init: [{ op: "ref.null", typeIdx: idsArrTypeIdx } as Instr],
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
    forIdx = ctx.numImportFuncs + ctx.mod.functions.length;
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
              { op: "array.get", typeIdx: keysArrTypeIdx } as Instr,
              { op: "ref.as_non_null" },
              { op: "local.get", index: KEY },
              { op: "call", funcIdx: strEqIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: IDS } as Instr,
                  { op: "ref.as_non_null" } as Instr,
                  { op: "local.get", index: I } as Instr,
                  { op: "array.get", typeIdx: idsArrTypeIdx } as Instr,
                  { op: "return" } as Instr,
                ],
                else: [],
              } as Instr,
              // i++
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: I },
              { op: "br", depth: 0 },
            ],
          } as Instr,
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
          { op: "array.new_default", typeIdx: keysArrTypeIdx } as Instr,
          { op: "local.set", index: KEYS } as Instr,
          { op: "local.get", index: KEYS } as Instr,
          { op: "global.set", index: keysG } as Instr,
          { op: "i32.const", value: REG_INITIAL_CAP } as Instr,
          { op: "array.new_default", typeIdx: idsArrTypeIdx } as Instr,
          { op: "local.set", index: IDS } as Instr,
          { op: "local.get", index: IDS } as Instr,
          { op: "global.set", index: idsG } as Instr,
        ],
        else: [
          // if n == keys.len → grow
          { op: "local.get", index: N } as Instr,
          { op: "local.get", index: KEYS } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "array.len" } as Instr,
          { op: "i32.eq" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // newCap = keys.len * 2
              { op: "local.get", index: KEYS } as Instr,
              { op: "ref.as_non_null" } as Instr,
              { op: "array.len" } as Instr,
              { op: "i32.const", value: 2 } as Instr,
              { op: "i32.mul" } as Instr,
              { op: "local.set", index: NEWCAP } as Instr,
              // newKeys = new[newCap]; copy; keys=newKeys; global=keys
              { op: "local.get", index: NEWCAP } as Instr,
              { op: "array.new_default", typeIdx: keysArrTypeIdx } as Instr,
              { op: "local.set", index: NEWKEYS } as Instr,
              { op: "local.get", index: NEWKEYS } as Instr,
              { op: "ref.as_non_null" } as Instr,
              { op: "i32.const", value: 0 } as Instr,
              { op: "local.get", index: KEYS } as Instr,
              { op: "ref.as_non_null" } as Instr,
              { op: "i32.const", value: 0 } as Instr,
              { op: "local.get", index: N } as Instr,
              { op: "array.copy", dstTypeIdx: keysArrTypeIdx, srcTypeIdx: keysArrTypeIdx } as Instr,
              { op: "local.get", index: NEWKEYS } as Instr,
              { op: "local.set", index: KEYS } as Instr,
              { op: "local.get", index: KEYS } as Instr,
              { op: "global.set", index: keysG } as Instr,
              // newIds = new[newCap]; copy; ids=newIds; global=ids
              { op: "local.get", index: NEWCAP } as Instr,
              { op: "array.new_default", typeIdx: idsArrTypeIdx } as Instr,
              { op: "local.set", index: NEWIDS } as Instr,
              { op: "local.get", index: NEWIDS } as Instr,
              { op: "ref.as_non_null" } as Instr,
              { op: "i32.const", value: 0 } as Instr,
              { op: "local.get", index: IDS } as Instr,
              { op: "ref.as_non_null" } as Instr,
              { op: "i32.const", value: 0 } as Instr,
              { op: "local.get", index: N } as Instr,
              { op: "array.copy", dstTypeIdx: idsArrTypeIdx, srcTypeIdx: idsArrTypeIdx } as Instr,
              { op: "local.get", index: NEWIDS } as Instr,
              { op: "local.set", index: IDS } as Instr,
              { op: "local.get", index: IDS } as Instr,
              { op: "global.set", index: idsG } as Instr,
            ],
            else: [],
          } as Instr,
        ],
      } as Instr,
      // keys[n] = key; ids[n] = id; count = n+1
      { op: "local.get", index: KEYS },
      { op: "ref.as_non_null" },
      { op: "local.get", index: N },
      { op: "local.get", index: KEY },
      { op: "array.set", typeIdx: keysArrTypeIdx } as Instr,
      { op: "local.get", index: IDS },
      { op: "ref.as_non_null" },
      { op: "local.get", index: N },
      { op: "local.get", index: ID },
      { op: "array.set", typeIdx: idsArrTypeIdx } as Instr,
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

    ctx.mod.functions.push({
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
    keyForIdx = ctx.numImportFuncs + ctx.mod.functions.length;
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
        then: [{ op: "ref.null", typeIdx: anyStrTypeIdx } as Instr, { op: "return" } as Instr],
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
              { op: "array.get", typeIdx: idsArrTypeIdx } as Instr,
              { op: "local.get", index: ID },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: KEYS } as Instr,
                  { op: "ref.as_non_null" } as Instr,
                  { op: "local.get", index: I } as Instr,
                  { op: "array.get", typeIdx: keysArrTypeIdx } as Instr,
                  { op: "return" } as Instr,
                ],
                else: [],
              } as Instr,
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: I },
              { op: "br", depth: 0 },
            ],
          } as Instr,
        ],
      },
      // not found → undefined
      { op: "ref.null", typeIdx: anyStrTypeIdx } as Instr,
    ];
    ctx.mod.functions.push({
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
        { op: "local.get", index: idLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "array.new_default", typeIdx: descArrTypeIdx } as Instr,
        { op: "local.set", index: tblLocal } as Instr,
        { op: "local.get", index: tblLocal } as Instr,
        { op: "global.set", index: descG } as Instr,
      ],
      else: [],
    } as Instr,
    // if (id >= tbl.len) { grow = new[id+1]; array.copy grow[0..tbl.len]=tbl; tbl=grow; global=tbl }
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        // if id < tbl.len → nothing to do (break)
        { op: "local.get", index: idLocal } as Instr,
        { op: "local.get", index: tblLocal } as Instr,
        { op: "ref.as_non_null" } as Instr,
        { op: "array.len" } as Instr,
        { op: "i32.lt_s" } as Instr,
        { op: "br_if", depth: 0 } as Instr,
        // grow = new[id+1]
        { op: "local.get", index: idLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "array.new_default", typeIdx: descArrTypeIdx } as Instr,
        { op: "local.set", index: growLocal } as Instr,
        // array.copy grow[0 ..] = tbl[0 .. tbl.len]
        { op: "local.get", index: growLocal } as Instr,
        { op: "ref.as_non_null" } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: tblLocal } as Instr,
        { op: "ref.as_non_null" } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: tblLocal } as Instr,
        { op: "ref.as_non_null" } as Instr,
        { op: "array.len" } as Instr,
        { op: "array.copy", dstTypeIdx: descArrTypeIdx, srcTypeIdx: descArrTypeIdx } as Instr,
        // tbl = grow; global = tbl
        { op: "local.get", index: growLocal } as Instr,
        { op: "local.set", index: tblLocal } as Instr,
        { op: "local.get", index: tblLocal } as Instr,
        { op: "global.set", index: descG } as Instr,
      ],
    } as Instr,
    // tbl[id] = key
    { op: "local.get", index: tblLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: idLocal },
    { op: "local.get", index: keyLocal },
    { op: "array.set", typeIdx: descArrTypeIdx } as Instr,
  ];
}
