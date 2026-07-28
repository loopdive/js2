// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3172) ES2025 keyed-collection additions, Wasm-native for standalone /
 * WASI / nativeStrings mode:
 *
 *   1. **`Map.prototype.getOrInsert` / `getOrInsertComputed`** (and the
 *      WeakMap twins) — §24.1.3.7/.8 emplace semantics over the shared `$Map`
 *      hash table: present key → stored value; absent → insert `value` (or
 *      `Call(callbackfn, undefined, «canonicalKey»)`'s result) and return it.
 *      The callback path preserves spec ordering: IsCallable (compile-time
 *      shape check), key canonicalization (-0 → +0), presence check BEFORE
 *      the callback (`does-not-evaluate-callbackfn-if-key-present`), callback
 *      throw propagation with NO state change, and set-after-callback (so a
 *      callback that mutates the map is overwritten — `overwrites-mutation`).
 *      WeakMap keys run the §24.5.1 CanBeHeldWeakly gate (objects/symbols
 *      only → catchable TypeError otherwise).
 *
 *   2. **GetSetRecord + set-LIKE set-algebra arguments** — §24.2.1.2. The
 *      #2162 native kernels (`set-algebra.ts`) required a real `$Map`-backed
 *      Set argument and threw for everything else (#2607). Per spec, any
 *      object with a numeric `size` and callable `has`/`keys` is set-like:
 *      `__set_<m>_any(a, arg)` dispatches a real-collection argument to the
 *      native kernel and everything else through `__setrec_size` (ToNumber
 *      via `__to_primitive` → TypeError on NaN/BigInt/absent) + per-method
 *      `__setlike_<m>` kernels that drive the argument's `keys()` iterator
 *      (`__iterator`/`__iterator_next`) and/or `has()` (via
 *      `__apply_closure` + `__is_truthy`) in the spec's size-dependent
 *      access pattern:
 *
 *        union / symmetricDifference          keys only
 *        isSubsetOf                           has only (size short-circuit)
 *        isSupersetOf                         keys only (size short-circuit)
 *        intersection / difference /
 *        isDisjointFrom                       thisSize ≤ argSize ? has : keys
 *
 *      Element (-0 → +0) normalization and dedup ride the shared `__set_add`
 *      / `__map_set` SameValueZero machinery. Deliberately out of scope:
 *      IteratorClose on predicate early-exit (`set-like-iter-return`) and
 *      re-entrant mutation ordering (`set-like-class-mutation`).
 *
 * ANTI-BLOAT: this module is the subsystem home for the ES2025 additions —
 * the god-file collection runtimes (map-runtime.ts) stay flat; call sites
 * (extern.ts direct dispatch, collections-brand.ts reflective dispatch,
 * set-algebra.ts argument rewiring) only add thin arms.
 *
 * PRECONDITION for the set-algebra pieces: `ensureSetAlgebraHelpers` (the
 * native two-`$Map` kernels) must have run — the dispatchers read them from
 * `ctx.mapHelpers` by name (no import of set-algebra.ts here, so the module
 * graph stays acyclic: set-algebra.ts imports THIS module for the any-arm).
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { COLLECTION_KIND, compileCollectionElementArg, ensureMapHelpers } from "./map-runtime.js";
import { buildClosureRefTestArms } from "./closure-classifier.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { ensureNativeIteratorRuntime } from "./iterator-native.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { emitReceiverBrandCheck, type ReceiverBrandSpec } from "./receiver-brand.js";
import type { InnerResult } from "./shared.js";
import { addUnionImportsViaRegistry, compileArrowAsClosure, compileExpression } from "./shared.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { coercionInstrs } from "./type-coercion.js";

// ── `$Map` layout mirrors (map-runtime.ts) ──────────────────────────────
const TOMBSTONE_BIT = 0x40000000;
const M_ENTRIES = 1;
const M_ENTRYCOUNT = 2;
const M_LIVECOUNT = 3;
const F_VALUE = 1;
const F_HASH = 3;
/** WasmGC `none` bottom heap type — canonical null anyref subtype. */
const NONE_HEAP = -18;

/** Register a kernel function and record it in ctx.mapHelpers. */
function addKernel(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
): number {
  const typeIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.mapHelpers.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
  return funcIdx;
}

/** Entries-walk over `aLocal` ($Map), running `perEntry` per live entry with
 *  the current $MapEntry in `entryTmp`. Mirrors set-algebra.ts's walker.
 *  `perEntry` may `return` out of the kernel for early exits. */
function walkEntries(ctx: CodegenContext, aLocal: number, iTmp: number, entryTmp: number, perEntry: Instr[]): Instr {
  return {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: iTmp },
          { op: "local.get", index: aLocal },
          { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRYCOUNT },
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: aLocal },
          { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES },
          { op: "local.get", index: iTmp },
          { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx },
          { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
          { op: "local.set", index: entryTmp },
          { op: "local.get", index: iTmp },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: iTmp },
          { op: "local.get", index: entryTmp },
          { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH },
          { op: "i32.const", value: TOMBSTONE_BIT },
          { op: "i32.and" },
          { op: "br_if", depth: 0 },
          ...perEntry,
          { op: "br", depth: 0 },
        ],
      },
    ],
  };
}

/** entry.value (anyref) onto the stack. */
function entryValue(ctx: CodegenContext, entryTmp: number): Instr[] {
  return [
    { op: "local.get", index: entryTmp },
    { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_VALUE },
  ];
}

/** Append an `if (top-of-stack) { throw TypeError(message) }` via the #2604
 *  body-swap so emitThrowTypeError patches the right buffer. */
function emitThrowTypeErrorIfTrue(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: [] });
  const ifInstr = fctx.body[fctx.body.length - 1] as unknown as { then: Instr[] };
  const savedBody = fctx.body;
  fctx.body = ifInstr.then;
  emitThrowTypeError(ctx, fctx, message);
  fctx.body = savedBody;
}

// ═══════════════════════════════════════════════════════════════════════
// Part 1 — getOrInsert / getOrInsertComputed
// ═══════════════════════════════════════════════════════════════════════

/** Lazily emit the getOrInsert kernels (idempotent, append-only). */
export function ensureGetOrInsertKernels(ctx: CodegenContext): void {
  ensureMapHelpers(ctx);
  if (ctx.mapHelpers.has("__map_get_or_insert")) return;
  if (ctx.mapTypeIdx < 0) return;
  addUnionImportsViaRegistry(ctx); // __box_number for __canon_key

  const mref: ValType = { kind: "ref", typeIdx: ctx.mapTypeIdx };
  const anyref: ValType = { kind: "anyref" };
  const i32: ValType = { kind: "i32" };
  const lookupIdx = ctx.mapHelpers.get("__map_lookup_idx");
  const mapSetIdx = ctx.mapHelpers.get("__map_set");
  if (lookupIdx === undefined || mapSetIdx === undefined) return;

  // ── __map_get_or_insert(m, k, v) -> anyref ──
  // params m(0) k(1) v(2); locals idx(3)
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: 3 },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: anyref },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES },
          { op: "local.get", index: 3 },
          { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx },
          { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
          { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_VALUE },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: mapSetIdx },
          { op: "drop" },
          { op: "local.get", index: 2 },
        ],
      },
    ];
    addKernel(ctx, "__map_get_or_insert", [mref, anyref, anyref], [anyref], [{ name: "idx", type: i32 }], body);
  }

  // ── __canon_key(k) -> anyref — CanonicalizeKeyedCollectionKey (-0 → +0) ──
  {
    const boxT = ctx.nativeBoxNumberTypeIdx;
    const boxNumIdx = ctx.funcMap.get("__box_number");
    const body: Instr[] =
      boxT >= 0 && boxNumIdx !== undefined
        ? [
            { op: "local.get", index: 0 },
            { op: "ref.test", typeIdx: boxT },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "anyref" } },
              then: [
                { op: "local.get", index: 0 },
                { op: "ref.cast", typeIdx: boxT },
                { op: "struct.get", typeIdx: boxT, fieldIdx: 0 },
                { op: "f64.const", value: 0 },
                { op: "f64.eq" }, // true for ±0, false for NaN/others
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "anyref" } },
                  then: [
                    { op: "f64.const", value: 0 },
                    { op: "call", funcIdx: boxNumIdx },
                    { op: "any.convert_extern" },
                  ],
                  else: [{ op: "local.get", index: 0 }],
                },
              ],
              else: [{ op: "local.get", index: 0 }],
            },
          ]
        : [{ op: "local.get", index: 0 }];
    addKernel(ctx, "__canon_key", [{ kind: "anyref" }], [{ kind: "anyref" }], [], body);
  }

  // ── __weak_key_ok(k) -> i32 — §24.5.1 CanBeHeldWeakly ──
  // Objects (structs, closures, symbols) → 1; null/undefined + boxed
  // primitives (number/boolean/bigint) + strings → 0. An `$AnyValue` wrapper
  // is OK only for its tag-6 (GC-object refval) form.
  {
    const rejectTests: Instr[] = [];
    const pushRejectTest = (typeIdx: number): void => {
      rejectTests.push(
        { op: "local.get", index: 0 },
        { op: "ref.test", typeIdx },
        ...((rejectTests.length > 0 ? [{ op: "i32.or" }] : []) satisfies Instr[]),
      );
    };
    if (ctx.nativeBoxNumberTypeIdx >= 0) pushRejectTest(ctx.nativeBoxNumberTypeIdx);
    pushRejectTest(-20); // (#3673) i31-boxed small int is a number — not weakly holdable
    if (ctx.nativeBoxBooleanTypeIdx >= 0) pushRejectTest(ctx.nativeBoxBooleanTypeIdx);
    if (ctx.nativeBigIntTypeIdx >= 0) pushRejectTest(ctx.nativeBigIntTypeIdx);
    if (ctx.anyStrTypeIdx >= 0) pushRejectTest(ctx.anyStrTypeIdx);
    else if (ctx.nativeStrTypeIdx >= 0) pushRejectTest(ctx.nativeStrTypeIdx);

    const avT = ctx.anyValueTypeIdx;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 0 }],
        else: [
          ...((rejectTests.length > 0
            ? [
                ...rejectTests,
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [{ op: "i32.const", value: 0 }],
                  else:
                    avT >= 0
                      ? [
                          { op: "local.get", index: 0 },
                          { op: "ref.test", typeIdx: avT },
                          {
                            op: "if",
                            blockType: { kind: "val", type: { kind: "i32" } },
                            then: [
                              { op: "local.get", index: 0 },
                              { op: "ref.cast", typeIdx: avT },
                              { op: "struct.get", typeIdx: avT, fieldIdx: 0 }, // tag
                              { op: "i32.const", value: 6 },
                              { op: "i32.eq" },
                            ],
                            else: [{ op: "i32.const", value: 1 }],
                          },
                        ]
                      : [{ op: "i32.const", value: 1 }],
                },
              ]
            : [{ op: "i32.const", value: 1 }]) satisfies Instr[]),
        ],
      },
    ];
    addKernel(ctx, "__weak_key_ok", [{ kind: "anyref" }], [{ kind: "i32" }], [], body);
  }
}

/** True when `e` is a callback shape the computed path can compile to a Wasm
 *  closure (mirrors the forEach `willBeClosure` gate). */
function isClosureShape(ctx: CodegenContext, e: ts.Expression): boolean {
  return (
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e) ||
    (ts.isIdentifier(e) && (ctx.funcMap.has(e.text) || ctx.closureMap.has(e.text)))
  );
}

/** True when `e` is a STATICALLY non-callable literal (spec step 3 TypeError). */
function isStaticNonCallable(expr: ts.Expression): boolean {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = (e as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  return (
    ts.isNumericLiteral(e) ||
    ts.isStringLiteralLike(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && e.text === "undefined") ||
    ts.isObjectLiteralExpression(e) ||
    ts.isArrayLiteralExpression(e)
  );
}

/**
 * Compile `getOrInsert` (computed=false) / `getOrInsertComputed` (computed=true)
 * for Map (weakKeys=false) / WeakMap (weakKeys=true). `brand` set = reflective
 * `.call` receiver (brand-checked, catchable TypeError); unset = direct call
 * with a statically-typed receiver (raw cast, compile-time bail on mismatch).
 * Returns anyref, or undefined to fall through to the generic path.
 */
export function compileCollectionGetOrInsert(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExpr: ts.Expression,
  keyExpr: ts.Expression | undefined,
  valueExpr: ts.Expression | undefined,
  computed: boolean,
  weakKeys: boolean,
  brand?: ReceiverBrandSpec,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  ensureGetOrInsertKernels(ctx);
  if (ctx.mapTypeIdx < 0) return undefined;
  const goiIdx = ctx.mapHelpers.get("__map_get_or_insert");
  const canonIdx = ctx.mapHelpers.get("__canon_key");
  const weakOkIdx = ctx.mapHelpers.get("__weak_key_ok");
  const lookupIdx = ctx.mapHelpers.get("__map_lookup_idx");
  const mapSetIdx = ctx.mapHelpers.get("__map_set");
  if (
    goiIdx === undefined ||
    canonIdx === undefined ||
    weakOkIdx === undefined ||
    lookupIdx === undefined ||
    mapSetIdx === undefined
  ) {
    return undefined;
  }

  // Classify the callback shape BEFORE any emission so unsupported dynamic
  // shapes bail cleanly (no stack residue).
  let cbKind: "closure" | "static-noncallable" | undefined;
  if (computed) {
    if (valueExpr === undefined) cbKind = "static-noncallable";
    else if (isClosureShape(ctx, valueExpr)) cbKind = "closure";
    else if (isStaticNonCallable(valueExpr)) cbKind = "static-noncallable";
    else return undefined;
  }

  const anyref: ValType = { kind: "anyref" };

  // Receiver → non-null (ref $Map).
  const recvType = compileExpression(ctx, fctx, recvExpr);
  if (brand !== undefined) {
    emitReceiverBrandCheck(ctx, fctx, recvType, brand);
  } else {
    if (recvType === null) return undefined;
    if (recvType.kind === "externref") {
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
    } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
    } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
      return undefined;
    }
  }
  const mTmp = allocLocal(fctx, `__goi_m_${fctx.locals.length}`, { kind: "ref", typeIdx: ctx.mapTypeIdx });
  fctx.body.push({ op: "local.set", index: mTmp });

  // Key → anyref, canonicalized (-0 → +0 — both for the lookup and the
  // callback argument; storage normalization also rides __map_set).
  compileCollectionElementArg(ctx, fctx, keyExpr);
  fctx.body.push({ op: "call", funcIdx: canonIdx });
  const kTmp = allocLocal(fctx, `__goi_k_${fctx.locals.length}`, anyref);
  fctx.body.push({ op: "local.set", index: kTmp });

  // WeakMap: CanBeHeldWeakly(key) — catchable TypeError on a primitive key.
  if (weakKeys) {
    fctx.body.push({ op: "local.get", index: kTmp });
    fctx.body.push({ op: "call", funcIdx: weakOkIdx });
    fctx.body.push({ op: "i32.eqz" });
    emitThrowTypeErrorIfTrue(ctx, fctx, "TypeError: Invalid value used as weak map key");
  }

  if (!computed) {
    fctx.body.push({ op: "local.get", index: mTmp });
    fctx.body.push({ op: "local.get", index: kTmp });
    compileCollectionElementArg(ctx, fctx, valueExpr);
    fctx.body.push({ op: "call", funcIdx: goiIdx });
    return anyref;
  }

  if (cbKind === "static-noncallable") {
    // §24.1.3.8 step 3: IsCallable(callbackfn) false → TypeError.
    emitThrowTypeError(ctx, fctx, "TypeError: callbackfn is not a function");
    fctx.body.push({ op: "ref.null", typeIdx: NONE_HEAP });
    return anyref;
  }

  // Compile the callback closure (arrow / fn-expr / named closure ref).
  const cbArg = valueExpr!;
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return undefined;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return undefined;
  const closureTmp = allocLocal(fctx, `__goi_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const idxTmp = allocLocal(fctx, `__goi_i_${fctx.locals.length}`, { kind: "i32" });
  const vTmp = allocLocal(fctx, `__goi_v_${fctx.locals.length}`, anyref);
  const guardFuncTmp = allocLocal(fctx, `__goi_gfc_${fctx.locals.length}`, { kind: "funcref" } as ValType);

  // idx = lookup(m, k)
  fctx.body.push({ op: "local.get", index: mTmp });
  fctx.body.push({ op: "local.get", index: kTmp });
  fctx.body.push({ op: "call", funcIdx: lookupIdx });
  fctx.body.push({ op: "local.tee", index: idxTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ge_s" });

  // Present arm: entries[idx].value (callback NOT evaluated).
  const presentArm: Instr[] = [
    { op: "local.get", index: mTmp },
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES },
    { op: "local.get", index: idxTmp },
    { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx },
    { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
    { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_VALUE },
  ];

  // Absent arm: v = cb(canonKey); map.set(k, v); v. (call_ref the closure —
  // mirrors the forEach callback-invoke shape incl. the guarded funcref cast.)
  const numParams = closureInfo.paramTypes.length;
  const absentArm: Instr[] = [{ op: "local.get", index: closureTmp }];
  for (let p = 0; p < numParams; p++) {
    if (p === 0) {
      absentArm.push({ op: "local.get", index: kTmp });
      absentArm.push({ op: "extern.convert_any" });
    } else {
      absentArm.push({ op: "ref.null.extern" });
    }
    absentArm.push(...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[p] ?? anyref, fctx));
  }
  absentArm.push({ op: "local.get", index: closureTmp });
  absentArm.push({ op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 });
  absentArm.push({ op: "local.tee", index: guardFuncTmp });
  absentArm.push({ op: "ref.test", typeIdx: closureInfo.funcTypeIdx });
  absentArm.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx } as ValType },
    then: [
      { op: "local.get", index: guardFuncTmp },
      { op: "ref.cast_null", typeIdx: closureInfo.funcTypeIdx },
    ],
    else: [{ op: "ref.null", typeIdx: closureInfo.funcTypeIdx }],
  });
  absentArm.push({ op: "ref.as_non_null" });
  absentArm.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
  // Coerce the callback result to anyref.
  const rt = closureInfo.returnType;
  if (rt === null) {
    absentArm.push({ op: "ref.null", typeIdx: NONE_HEAP });
  } else if (rt.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      absentArm.push({ op: "call", funcIdx: boxIdx });
      absentArm.push({ op: "any.convert_extern" });
    } else {
      absentArm.push({ op: "drop" }, { op: "ref.null", typeIdx: NONE_HEAP });
    }
  } else if (rt.kind === "i32") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      absentArm.push({ op: "f64.convert_i32_s" });
      absentArm.push({ op: "call", funcIdx: boxIdx });
      absentArm.push({ op: "any.convert_extern" });
    } else {
      absentArm.push({ op: "drop" }, { op: "ref.null", typeIdx: NONE_HEAP });
    }
  } else if (rt.kind === "externref") {
    absentArm.push({ op: "any.convert_extern" });
  }
  // ref/ref_null/anyref results: already anyref-compatible.
  absentArm.push({ op: "local.set", index: vTmp });
  absentArm.push({ op: "local.get", index: mTmp });
  absentArm.push({ op: "local.get", index: kTmp });
  absentArm.push({ op: "local.get", index: vTmp });
  absentArm.push({ op: "call", funcIdx: mapSetIdx });
  absentArm.push({ op: "drop" });
  absentArm.push({ op: "local.get", index: vTmp });

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: anyref },
    then: presentArm,
    else: absentArm,
  });
  return anyref;
}

// ═══════════════════════════════════════════════════════════════════════
// Part 2 — GetSetRecord + set-like set-algebra arguments
// ═══════════════════════════════════════════════════════════════════════

/** The 7 set-algebra method names → [returnsSet, accessPattern]. */
const ALGEBRA_METHODS: Record<string, { returnsSet: boolean }> = {
  union: { returnsSet: true },
  intersection: { returnsSet: true },
  difference: { returnsSet: true },
  symmetricDifference: { returnsSet: true },
  isSubsetOf: { returnsSet: false },
  isSupersetOf: { returnsSet: false },
  isDisjointFrom: { returnsSet: false },
};

export function isSetAlgebraMethod(name: string): boolean {
  return name in ALGEBRA_METHODS;
}

/** The three GetSetRecord field names. */
const SETREC_FIELDS = ["size", "has", "keys"] as const;

/**
 * Reserve the `__setrec_field_<name>(obj: externref) -> externref` readers
 * (placeholder bodies; filled at FINALIZE by {@link fillSetRecFieldGetters}).
 *
 * WHY reserve-then-fill (#1719): a set-like argument is usually an OBJECT
 * LITERAL, which compiles to a CLOSED nominal struct — `__extern_get` only
 * reads the open `$Object` hash-map shape, so a compile-time-emitted reader
 * would answer null for every literal (measured: `d["size"]` → undefined).
 * The fill enumerates every registered closed struct with the field (the
 * `fillPromiseThenableHelpers` collector pattern) — which is only complete at
 * finalize.
 */
function reserveSetRecFieldGetters(ctx: CodegenContext): boolean {
  if (ctx.mapHelpers.has("__setrec_field_size")) return true;
  // Fill-time deps must be registered NOW (the fill only READS funcMap).
  addUnionImportsViaRegistry(ctx); // __box_number
  ensureObjVecBuilders(ctx); // object runtime → __extern_get for the $Object arm
  for (const f of SETREC_FIELDS) addStringConstantGlobal(ctx, f);
  const externref: ValType = { kind: "externref" };
  for (const f of SETREC_FIELDS) {
    const name = `__setrec_field_${f}`;
    addKernel(
      ctx,
      name,
      [externref],
      [externref],
      [{ name: "__any", type: { kind: "anyref" } }],
      [{ op: "ref.null.extern" }],
    );
  }
  // `__setrec_check_callable(v) -> v` — GetSetRecord steps 8/10 "If
  // IsCallable(has/keys) is false, throw a TypeError". Reserved (pass-through
  // placeholder) because the closure base-wrapper type set is only complete at
  // FINALIZE. The TypeError ctor + message string are registered NOW so the
  // fill introduces no new imports/globals behind baked indices.
  emitBrandCheckTypeError(ctx, [], SETREC_CALLABLE_MSG); // registers ctor + string (scratch body discarded)
  addKernel(
    ctx,
    "__setrec_check_callable",
    [externref],
    [externref],
    [{ name: "__any", type: { kind: "anyref" } }],
    [{ op: "local.get", index: 0 }],
  );
  (ctx as CodegenContext & { setRecFieldGettersReserved?: boolean }).setRecFieldGettersReserved = true;
  return true;
}

const SETREC_CALLABLE_MSG = "TypeError: Set-like argument's has/keys is not callable";

/**
 * FINALIZE fill for the `__setrec_field_<name>` readers: one `ref.test` arm
 * per closed struct carrying the field (externref/f64/i32/ref — boxed to
 * externref), bottom arm = `__extern_get` for the open `$Object` shape.
 * Read-only over funcMap (deps registered at reserve). No-op unless reserved.
 */
export function fillSetRecFieldGetters(ctx: CodegenContext): void {
  if (!(ctx as CodegenContext & { setRecFieldGettersReserved?: boolean }).setRecFieldGettersReserved) return;
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  for (const f of SETREC_FIELDS) {
    const fnIdx = ctx.mapHelpers.get(`__setrec_field_${f}`);
    if (fnIdx === undefined) continue;
    const fn = definedFuncAt(ctx, fnIdx);
    if (!fn) continue;

    // Bottom arm: open-$Object dynamic read (also covers null → null.extern).
    let current: Instr[] =
      externGetIdx !== undefined
        ? [
            { op: "local.get", index: 0 },
            ...stringConstantExternrefInstrs(ctx, f),
            { op: "call", funcIdx: externGetIdx },
          ]
        : [{ op: "ref.null.extern" }];

    for (const [structName, fields] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined) continue;
      if (
        structName.startsWith("Wrapper") ||
        structName === "$AnyValue" ||
        structName.startsWith("__vec_") ||
        structName.startsWith("__arr_") ||
        structName.startsWith("$") ||
        structName === "Map" ||
        structName === "MapEntry" ||
        structName === "MapIter" ||
        structName === "MapIterResult"
      )
        continue;
      const fieldIdx = fields.findIndex((fl) => fl.name === f);
      if (fieldIdx < 0) continue;
      const ft = fields[fieldIdx]!.type;
      const read: Instr[] = [
        { op: "local.get", index: 1 }, // __any local (set below)
        { op: "ref.cast", typeIdx },
        { op: "struct.get", typeIdx, fieldIdx },
      ];
      if (ft.kind === "f64") {
        if (boxNumIdx === undefined) continue;
        read.push({ op: "call", funcIdx: boxNumIdx });
      } else if (ft.kind === "i32") {
        if (boxNumIdx === undefined) continue;
        read.push({ op: "f64.convert_i32_s" });
        read.push({ op: "call", funcIdx: boxNumIdx });
      } else if (ft.kind === "ref" || ft.kind === "ref_null" || ft.kind === "anyref" || ft.kind === "eqref") {
        read.push({ op: "extern.convert_any" });
      } else if (ft.kind !== "externref") {
        continue; // unsupported field carrier (i64/v128/funcref)
      }
      current = [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx },
        { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: read, else: current },
      ];
    }

    fn.body = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }, ...current];
  }

  // ── `__setrec_check_callable(v) -> v` — the IsCallable gate (steps 8/10) ──
  // Pass through when v tests as any registered closure base wrapper; throw a
  // catchable TypeError otherwise (null/undefined, plain objects, primitives).
  // The closure base-wrapper set (closure-classifier.ts) is complete HERE.
  {
    const fnIdx = ctx.mapHelpers.get("__setrec_check_callable");
    const fn = fnIdx !== undefined ? definedFuncAt(ctx, fnIdx) : undefined;
    if (fn) {
      const throwArm: Instr[] = [];
      emitBrandCheckTypeError(ctx, throwArm, SETREC_CALLABLE_MSG); // idempotent (registered at reserve)
      const body: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: 1 },
        ...buildClosureRefTestArms(ctx, 1, [{ op: "local.get", index: 0 }, { op: "return" }]),
        ...throwArm,
      ];
      fn.body = body;
    }
  }
}

/**
 * `__setrec_size(sizeExt) -> f64` — the GetSetRecord size coercion (§24.2.1.2
 * steps 2–6): ToNumber via `__to_primitive` (runs `valueOf` exactly once for
 * object sizes), then catchable TypeError for absent/NaN/BigInt sizes.
 */
function ensureSetRecSize(ctx: CodegenContext): number | undefined {
  const existing = ctx.mapHelpers.get("__setrec_size");
  if (existing !== undefined) return existing;
  const toPrimIdx = ctx.funcMap.get("__to_primitive");
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (toPrimIdx === undefined || unboxIdx === undefined) return undefined;
  addStringConstantGlobal(ctx, "number");

  const externref: ValType = { kind: "externref" };
  const throwArm: Instr[] = [];
  emitBrandCheckTypeError(ctx, throwArm, "TypeError: invalid size for a set-like argument");
  const throwArm2: Instr[] = [];
  emitBrandCheckTypeError(ctx, throwArm2, "TypeError: size must not be a BigInt");

  // params: size(0). locals: prim(1 externref), n(2 f64)
  const body: Instr[] = [
    // prim = __to_primitive(size, "number")
    { op: "local.get", index: 0 },
    ...stringConstantExternrefInstrs(ctx, "number"),
    { op: "call", funcIdx: toPrimIdx },
    { op: "local.tee", index: 1 },
    // absent/undefined size → TypeError
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: throwArm },
    // BigInt size → TypeError
    ...((ctx.nativeBigIntTypeIdx >= 0
      ? [
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: ctx.nativeBigIntTypeIdx },
          { op: "if", blockType: { kind: "empty" }, then: throwArm2 },
        ]
      : []) satisfies Instr[]),
    // n = __unbox_number(prim); NaN → TypeError
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: unboxIdx },
    { op: "local.tee", index: 2 },
    { op: "local.get", index: 2 },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: (() => {
        const arm: Instr[] = [];
        emitBrandCheckTypeError(ctx, arm, "TypeError: invalid size for a set-like argument (NaN)");
        return arm;
      })(),
    },
    { op: "local.get", index: 2 },
  ];
  return addKernel(
    ctx,
    "__setrec_size",
    [externref],
    [{ kind: "f64" }],
    [
      { name: "prim", type: externref },
      { name: "n", type: { kind: "f64" } },
    ],
    body,
  );
}

/**
 * Emit `__set_<m>_any(a: ref $Map, arg: externref)` — the argument dispatcher:
 * real-collection arg → the native two-`$Map` kernel; anything else → the
 * GetSetRecord reads (Get size → coerce/throw → Get has → Get keys) + the
 * `__setlike_<m>` kernel. PRECONDITION: `ensureSetAlgebraHelpers` has run
 * (the native `__set_<m>` kernels exist in ctx.mapHelpers).
 */
export function ensureSetAlgebraAnyDispatch(ctx: CodegenContext, methodName: string): number | undefined {
  if (!isSetAlgebraMethod(methodName)) return undefined;
  const name = `__set_${methodName}_any`;
  const existing = ctx.mapHelpers.get(name);
  if (existing !== undefined) return existing;
  const nativeIdx = ctx.mapHelpers.get(`__set_${methodName}`);
  if (nativeIdx === undefined || ctx.mapTypeIdx < 0) return undefined;

  // Dependencies for the set-like path (all append-only in standalone).
  addUnionImportsViaRegistry(ctx); // __is_truthy / __unbox_number / __box_number
  ensureObjVecBuilders(ctx); // object runtime: __extern_get, __to_primitive, $ObjVec
  reserveApplyClosure(ctx);
  ensureNativeIteratorRuntime(ctx);
  reserveSetRecFieldGetters(ctx); // closed-struct field readers (filled at finalize)
  const sizeIdx = ensureSetRecSize(ctx);
  const setlikeIdx = ensureSetLikeKernel(ctx, methodName);
  const fieldSizeIdx = ctx.mapHelpers.get("__setrec_field_size");
  const fieldHasIdx = ctx.mapHelpers.get("__setrec_field_has");
  const fieldKeysIdx = ctx.mapHelpers.get("__setrec_field_keys");
  const checkCallableIdx = ctx.mapHelpers.get("__setrec_check_callable");
  if (
    sizeIdx === undefined ||
    setlikeIdx === undefined ||
    fieldSizeIdx === undefined ||
    fieldHasIdx === undefined ||
    fieldKeysIdx === undefined ||
    checkCallableIdx === undefined
  ) {
    return undefined;
  }

  const { returnsSet } = ALGEBRA_METHODS[methodName]!;
  const mref: ValType = { kind: "ref", typeIdx: ctx.mapTypeIdx };
  const externref: ValType = { kind: "externref" };
  const result: ValType = returnsSet ? mref : { kind: "i32" };

  // params: a(0 mref), arg(1 externref). locals: argAny(2), size(3 f64), has(4), keys(5)
  const body: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 2 },
    { op: "ref.test", typeIdx: ctx.mapTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: ctx.mapTypeIdx },
        { op: "call", funcIdx: nativeIdx },
        { op: "return" },
      ],
    },
    // GetSetRecord: Get(size) → coerce (throws), Get(has), Get(keys) — via the
    // reserved closed-struct-aware field readers (filled at finalize).
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: fieldSizeIdx },
    { op: "call", funcIdx: sizeIdx },
    { op: "local.set", index: 3 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: fieldHasIdx },
    { op: "call", funcIdx: checkCallableIdx }, // step 8 IsCallable(has)
    { op: "local.set", index: 4 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: fieldKeysIdx },
    { op: "call", funcIdx: checkCallableIdx }, // step 10 IsCallable(keys)
    { op: "local.set", index: 5 },
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 3 },
    { op: "local.get", index: 4 },
    { op: "local.get", index: 5 },
    { op: "call", funcIdx: setlikeIdx },
  ];
  return addKernel(
    ctx,
    name,
    [mref, externref],
    [result],
    [
      { name: "argAny", type: { kind: "anyref" } },
      { name: "size", type: { kind: "f64" } },
      { name: "has", type: externref },
      { name: "keys", type: externref },
    ],
    body,
  );
}

/**
 * Emit `__setlike_<m>(a, obj, size, has, keys)` — the spec algorithm over a
 * GetSetRecord, driving `keys()` through the native iterator substrate and
 * `has()` through `__apply_closure` + `__is_truthy`.
 */
function ensureSetLikeKernel(ctx: CodegenContext, methodName: string): number | undefined {
  const name = `__setlike_${methodName}`;
  const existing = ctx.mapHelpers.get(name);
  if (existing !== undefined) return existing;

  const { newIdx: objVecNewIdx, pushIdx: objVecPushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const iterIdx = ctx.funcMap.get("__iterator");
  const nextIdx = ctx.funcMap.get("__iterator_next");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  const mapNewIdx = ctx.mapHelpers.get("__map_new");
  const setAddIdx = ctx.mapHelpers.get("__set_add");
  const mapHasIdx = ctx.mapHelpers.get("__map_has");
  const mapDeleteIdx = ctx.mapHelpers.get("__map_delete");
  const unionIdx = ctx.mapHelpers.get("__set_union");
  if (
    iterIdx === undefined ||
    nextIdx === undefined ||
    isTruthyIdx === undefined ||
    mapNewIdx === undefined ||
    setAddIdx === undefined ||
    mapHasIdx === undefined ||
    mapDeleteIdx === undefined ||
    unionIdx === undefined
  ) {
    return undefined;
  }

  const mref: ValType = { kind: "ref", typeIdx: ctx.mapTypeIdx };
  const externref: ValType = { kind: "externref" };
  const anyref: ValType = { kind: "anyref" };
  const f64: ValType = { kind: "f64" };
  const i32: ValType = { kind: "i32" };

  // Shared param/local layout:
  //   params: a(0 mref), obj(1 ext), size(2 f64), has(3 ext), keys(4 ext)
  //   locals: r(5 mref-null), i(6 i32), entry(7 $MapEntry-null),
  //           iterRec(8 ext), valExt(9 ext), valAny(10 any), argvec(11 ext)
  const A = 0;
  const OBJ = 1;
  const SIZE = 2;
  const HAS = 3;
  const KEYS = 4;
  const R = 5;
  const I = 6;
  const ENTRY = 7;
  const ITER = 8;
  const VALEXT = 9;
  const VALANY = 10;
  const ARGVEC = 11;
  const locals: { name: string; type: ValType }[] = [
    { name: "r", type: { kind: "ref_null", typeIdx: ctx.mapTypeIdx } },
    { name: "i", type: i32 },
    { name: "entry", type: { kind: "ref_null", typeIdx: ctx.mapEntryTypeIdx } },
    { name: "iterRec", type: externref },
    { name: "valExt", type: externref },
    { name: "valAny", type: anyref },
    { name: "argvec", type: externref },
  ];

  /** r (non-null use): local.get R + ref.as_non_null. */
  const getR: Instr[] = [{ op: "local.get", index: R }, { op: "ref.as_non_null" }];

  /** `has(entryValue)` → i32 truthiness on the stack. */
  const callHasOnEntry: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: ARGVEC },
    { op: "local.get", index: ARGVEC },
    ...entryValue(ctx, ENTRY),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: HAS },
    { op: "local.get", index: OBJ },
    { op: "local.get", index: ARGVEC },
    { op: "call", funcIdx: applyIdx },
    { op: "call", funcIdx: isTruthyIdx },
  ];

  /** Drive `keys()`: iterRec = __iterator(apply(keys, obj, [])); then loop
   *  running `perVal` with the current element in VALANY. `perVal` may
   *  `return` for early exits. */
  const keysLoop = (perVal: Instr[]): Instr[] => [
    { op: "local.get", index: KEYS },
    { op: "local.get", index: OBJ },
    { op: "call", funcIdx: objVecNewIdx },
    { op: "call", funcIdx: applyIdx },
    { op: "call", funcIdx: iterIdx },
    { op: "local.set", index: ITER },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: ITER },
            { op: "call", funcIdx: nextIdx }, // → (i32 done, externref val)
            { op: "local.set", index: VALEXT }, // top = val
            { op: "br_if", depth: 1 }, // done → exit
            { op: "local.get", index: VALEXT },
            { op: "any.convert_extern" },
            { op: "local.set", index: VALANY },
            ...perVal,
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];

  /** thisSize (f64) onto the stack. */
  const thisSize: Instr[] = [
    { op: "local.get", index: A },
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_LIVECOUNT },
    { op: "f64.convert_i32_s" },
  ];

  /** r = clone(a) (union with itself — kind SET, dedup no-op). */
  const cloneAIntoR: Instr[] = [
    { op: "local.get", index: A },
    { op: "local.get", index: A },
    { op: "call", funcIdx: unionIdx },
    { op: "local.set", index: R },
  ];

  let body: Instr[];
  let result: ValType;

  switch (methodName) {
    case "union": {
      result = mref;
      body = [
        ...cloneAIntoR,
        ...keysLoop([...getR, { op: "local.get", index: VALANY }, { op: "call", funcIdx: setAddIdx }, { op: "drop" }]),
        ...getR,
      ];
      break;
    }
    case "symmetricDifference": {
      result = mref;
      body = [
        ...cloneAIntoR,
        ...keysLoop([
          { op: "local.get", index: A },
          { op: "local.get", index: VALANY },
          { op: "call", funcIdx: mapHasIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...getR, { op: "local.get", index: VALANY }, { op: "call", funcIdx: mapDeleteIdx }, { op: "drop" }],
            else: [...getR, { op: "local.get", index: VALANY }, { op: "call", funcIdx: setAddIdx }, { op: "drop" }],
          },
        ]),
        ...getR,
      ];
      break;
    }
    case "difference": {
      result = mref;
      body = [
        ...cloneAIntoR,
        ...thisSize,
        { op: "local.get", index: SIZE },
        { op: "f64.le" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            walkEntries(ctx, A, I, ENTRY, [
              ...callHasOnEntry,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...getR, ...entryValue(ctx, ENTRY), { op: "call", funcIdx: mapDeleteIdx }, { op: "drop" }],
              },
            ]),
          ],
          else: keysLoop([
            ...getR,
            { op: "local.get", index: VALANY },
            { op: "call", funcIdx: mapDeleteIdx },
            { op: "drop" },
          ]),
        },
        ...getR,
      ];
      break;
    }
    case "intersection": {
      result = mref;
      body = [
        { op: "i32.const", value: COLLECTION_KIND.SET },
        { op: "call", funcIdx: mapNewIdx },
        { op: "local.set", index: R },
        ...thisSize,
        { op: "local.get", index: SIZE },
        { op: "f64.le" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // this-order: walk a, keep has(e).
            walkEntries(ctx, A, I, ENTRY, [
              ...callHasOnEntry,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...getR, ...entryValue(ctx, ENTRY), { op: "call", funcIdx: setAddIdx }, { op: "drop" }],
              },
            ]),
          ],
          // arg-keys order: keep keys that are in a (spec result order).
          else: keysLoop([
            { op: "local.get", index: A },
            { op: "local.get", index: VALANY },
            { op: "call", funcIdx: mapHasIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...getR, { op: "local.get", index: VALANY }, { op: "call", funcIdx: setAddIdx }, { op: "drop" }],
            },
          ]),
        },
        ...getR,
      ];
      break;
    }
    case "isSubsetOf": {
      result = i32;
      body = [
        ...thisSize,
        { op: "local.get", index: SIZE },
        { op: "f64.gt" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 0 }, { op: "return" }],
        },
        walkEntries(ctx, A, I, ENTRY, [
          ...callHasOnEntry,
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 0 }, { op: "return" }],
          },
        ]),
        { op: "i32.const", value: 1 },
      ];
      break;
    }
    case "isSupersetOf": {
      result = i32;
      body = [
        ...thisSize,
        { op: "local.get", index: SIZE },
        { op: "f64.lt" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 0 }, { op: "return" }],
        },
        ...keysLoop([
          { op: "local.get", index: A },
          { op: "local.get", index: VALANY },
          { op: "call", funcIdx: mapHasIdx },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 0 }, { op: "return" }],
          },
        ]),
        { op: "i32.const", value: 1 },
      ];
      break;
    }
    case "isDisjointFrom": {
      result = i32;
      body = [
        ...thisSize,
        { op: "local.get", index: SIZE },
        { op: "f64.le" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            walkEntries(ctx, A, I, ENTRY, [
              ...callHasOnEntry,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 0 }, { op: "return" }],
              },
            ]),
          ],
          else: keysLoop([
            { op: "local.get", index: A },
            { op: "local.get", index: VALANY },
            { op: "call", funcIdx: mapHasIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 0 }, { op: "return" }],
            },
          ]),
        },
        { op: "i32.const", value: 1 },
      ];
      break;
    }
    default:
      return undefined;
  }

  return addKernel(ctx, name, [mref, externref, f64, externref, externref], [result], locals, body);
}

/**
 * Compile the ARGUMENT of a set-algebra call: coerce the compiled arg (its
 * ValType in `argType`, value on the stack) to externref and dispatch through
 * `__set_<m>_any`. The receiver `(ref $Map)` must already be on the stack
 * BENEATH the argument. Returns the method's result type, or undefined when
 * the dispatcher could not be built (caller falls back to legacy behaviour).
 */
export function emitSetAlgebraAnyArgDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  argType: ValType | null,
): InnerResult | undefined {
  const dispIdx = ensureSetAlgebraAnyDispatch(ctx, methodName);
  if (dispIdx === undefined) return undefined;
  // arg → externref.
  if (argType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (argType.kind !== "externref") {
    fctx.body.push(...coercionInstrs(ctx, argType, { kind: "externref" }, fctx));
  }
  fctx.body.push({ op: "call", funcIdx: dispIdx });
  return ALGEBRA_METHODS[methodName]!.returnsSet
    ? ({ kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType)
    : ({ kind: "i32" } as ValType);
}
