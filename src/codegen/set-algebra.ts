// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2162) ES2025 Set set-algebra methods, Wasm-native for standalone / WASI /
 * nativeStrings mode (spec 24.2.4.x). Each method takes the receiver Set `a` and
 * another Set `b` and either returns a new Set or a boolean:
 *
 *   union(b)              → a ∪ b           (new Set)
 *   intersection(b)       → a ∩ b           (new Set)
 *   difference(b)         → a \ b           (new Set)
 *   symmetricDifference(b)→ (a\b) ∪ (b\a)   (new Set)
 *   isSubsetOf(b)         → a ⊆ b           (boolean)
 *   isSupersetOf(b)       → a ⊇ b           (boolean)
 *   isDisjointFrom(b)     → a ∩ b = ∅       (boolean)
 *
 * All build on the shared `$Map` backing store (a Set is a Map with value===key,
 * #2162 Slice 1): each method walks one set's entries vector — the same
 * insertion-ordered, tombstone-skipping walk `forEach`/`__map_iter_next` use —
 * and consults the other set via `__map_has`, accumulating into a fresh `$Map`
 * (`__map_new` + `__set_add`) or an i32 flag. No host import, no iterator object.
 *
 * Spec note: the real algorithms call GetSetRecord(other) and use the other's
 * `has`/`keys`/`size` so a Set-LIKE argument works too. This slice supports a
 * genuine Set `b` (the dominant case); a non-Set arg falls through to the generic
 * path (the dispatch only fires when both receiver and arg type as Set).
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import type { InnerResult } from "./shared.js";
import { compileExpression } from "./shared.js";
import { emitSetAlgebraAnyArgDispatch, ensureSetAlgebraAnyDispatch } from "./collections-es2025.js";
import { COLLECTION_KIND } from "./collection-kind.js"; // (#6419) import-free leaf — map-runtime.js is in an import cycle
import { ensureMapHelpers } from "./map-runtime.js";
import { emitSetBrandCheck, ensureSetHelpers } from "./set-runtime.js";

const TOMBSTONE_BIT = 0x40000000; // mirrors map-runtime.ts
const M_ENTRIES = 1;
const M_ENTRYCOUNT = 2;
const F_KEY = 0;
const F_VALUE = 1;
void F_VALUE; // layout doc — the walks project F_KEY (see entryValue)
const F_HASH = 3;

const SET_ALGEBRA_SET_OPS = new Set(["union", "intersection", "difference", "symmetricDifference"]);
const SET_ALGEBRA_PREDICATES = new Set(["isSubsetOf", "isSupersetOf", "isDisjointFrom"]);

/**
 * Build an entries-walk over set `aLocal` ($Map ref). For each live (non-tombstone)
 * entry it runs `perEntry`, which may use `entryTmp` ($MapEntry ref, already loaded
 * for the current iteration). `iTmp`/`entryTmp` must be pre-allocated i32/entry locals.
 */
function walkEntries(ctx: CodegenContext, aLocal: number, iTmp: number, entryTmp: number, perEntry: Instr[]): Instr {
  const loadEntry: Instr[] = [
    { op: "local.get", index: aLocal },
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES },
    { op: "local.get", index: iTmp },
    { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx },
    { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
    { op: "local.set", index: entryTmp },
  ];
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
          ...loadEntry,
          { op: "local.get", index: iTmp },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: iTmp },
          // tombstone? skip
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

/** entry element (anyref) onto the stack — the entry's KEY. For a Set entry
 *  key === value, so this is the element either way; for a MAP argument
 *  (#3172 `combines-Map`) the spec's GetSetRecord `keys()` yields the map's
 *  KEYS, so the walk must project F_KEY, not F_VALUE. */
function entryValue(ctx: CodegenContext, entryTmp: number): Instr[] {
  return [
    { op: "local.get", index: entryTmp },
    { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_KEY },
  ];
}

/**
 * Emit the 7 set-algebra helpers (idempotent). Names registered in
 * `ctx.mapHelpers`: `__set_union` / `__set_intersection` / `__set_difference` /
 * `__set_symmetricDifference` / `__set_isSubsetOf` / `__set_isSupersetOf` /
 * `__set_isDisjointFrom`. Each is `(ref $Map, ref $Map) -> {ref $Map | i32}`.
 */
export function ensureSetAlgebraHelpers(ctx: CodegenContext): void {
  ensureSetHelpers(ctx); // ⇒ ensureMapHelpers + __set_add
  if (ctx.mapTypeIdx < 0) return;
  if (ctx.mapHelpers.has("__set_union")) return;

  const mref: ValType = { kind: "ref", typeIdx: ctx.mapTypeIdx };
  const i32: ValType = { kind: "i32" };
  const entryRef: ValType = { kind: "ref", typeIdx: ctx.mapEntryTypeIdx };
  const mapNew = ctx.mapHelpers.get("__map_new");
  const setAdd = ctx.mapHelpers.get("__set_add");
  const mapHas = ctx.mapHelpers.get("__map_has");
  if (mapNew === undefined || setAdd === undefined || mapHas === undefined) return;

  const addFn = (name: string, results: ValType[], localTypes: ValType[], body: Instr[]): void => {
    const typeIdx = addFuncType(ctx, [mref, mref], results);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.mapHelpers.set(name, funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: localTypes.map((type, i) => ({ name: `__sa_l${i}`, type })),
      body,
      exported: false,
    });
  };

  // Param layout: a=0, b=1. Extra locals appended after.
  // result(2)=ref $Map, i(3)=i32, entry(4)=ref $MapEntry, flag(5)=i32.
  const A = 0;
  const B = 1;
  const RES = 2;
  const I = 3;
  const ENTRY = 4;
  const FLAG = 5;

  // addToResult(value): result = __set_add(result, value)  [result stays in RES]
  const addValToResult = (): Instr[] => [
    { op: "local.get", index: RES },
    ...entryValue(ctx, ENTRY),
    { op: "call", funcIdx: setAdd },
    { op: "local.set", index: RES },
  ];

  // ── union(a,b): copy all of a, then all of b (set_add dedups). ───────────
  {
    const body: Instr[] = [
      { op: "i32.const", value: COLLECTION_KIND.SET }, // (#3171) result is a Set
      { op: "call", funcIdx: mapNew },
      { op: "local.set", index: RES },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      walkEntries(ctx, A, I, ENTRY, addValToResult()),
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      walkEntries(ctx, B, I, ENTRY, addValToResult()),
      { op: "local.get", index: RES },
    ];
    addFn("__set_union", [mref], [mref, i32, entryRef], body);
  }

  // ── intersection(a,b): values of a that are also in b. ───────────────────
  {
    const perEntry: Instr[] = [
      // if (__map_has(b, entry.value)) result = __set_add(result, value)
      { op: "local.get", index: B },
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: addValToResult(),
        else: [],
      },
    ];
    const body: Instr[] = [
      { op: "i32.const", value: COLLECTION_KIND.SET }, // (#3171) result is a Set
      { op: "call", funcIdx: mapNew },
      { op: "local.set", index: RES },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      walkEntries(ctx, A, I, ENTRY, perEntry),
      { op: "local.get", index: RES },
    ];
    addFn("__set_intersection", [mref], [mref, i32, entryRef], body);
  }

  // ── difference(a,b): values of a NOT in b. ───────────────────────────────
  {
    const perEntry: Instr[] = [
      { op: "local.get", index: B },
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: addValToResult(),
        else: [],
      },
    ];
    const body: Instr[] = [
      { op: "i32.const", value: COLLECTION_KIND.SET }, // (#3171) result is a Set
      { op: "call", funcIdx: mapNew },
      { op: "local.set", index: RES },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      walkEntries(ctx, A, I, ENTRY, perEntry),
      { op: "local.get", index: RES },
    ];
    addFn("__set_difference", [mref], [mref, i32, entryRef], body);
  }

  // ── symmetricDifference(a,b): (a\b) ∪ (b\a). ─────────────────────────────
  {
    // walk a: add value if NOT in b. walk b: add value if NOT in a.
    const aNotB: Instr[] = [
      { op: "local.get", index: B },
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: addValToResult(), else: [] },
    ];
    const bNotA: Instr[] = [
      { op: "local.get", index: A },
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: addValToResult(), else: [] },
    ];
    const body: Instr[] = [
      { op: "i32.const", value: COLLECTION_KIND.SET }, // (#3171) result is a Set
      { op: "call", funcIdx: mapNew },
      { op: "local.set", index: RES },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      walkEntries(ctx, A, I, ENTRY, aNotB),
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      walkEntries(ctx, B, I, ENTRY, bNotA),
      { op: "local.get", index: RES },
    ];
    addFn("__set_symmetricDifference", [mref], [mref, i32, entryRef], body);
  }

  // ── isSubsetOf(a,b): every value of a is in b. flag starts 1, clears on a
  //    value missing from b. ─────────────────────────────────────────────--
  {
    const perEntry: Instr[] = [
      { op: "local.get", index: B },
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas },
      { op: "i32.eqz" },
      // if missing → flag = 0
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: FLAG },
        ],
        else: [],
      },
    ];
    const body: Instr[] = [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: FLAG },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      walkEntries(ctx, A, I, ENTRY, perEntry),
      { op: "local.get", index: FLAG },
    ];
    // locals: result slot unused but kept for index alignment (RES at 2).
    addFn("__set_isSubsetOf", [i32], [mref, i32, entryRef, i32], body);
  }

  // ── isSupersetOf(a,b): every value of b is in a (= isSubsetOf with args
  //    swapped). ──────────────────────────────────────────────────────────
  {
    const perEntry: Instr[] = [
      { op: "local.get", index: A },
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: FLAG },
        ],
        else: [],
      },
    ];
    const body: Instr[] = [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: FLAG },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      walkEntries(ctx, B, I, ENTRY, perEntry),
      { op: "local.get", index: FLAG },
    ];
    addFn("__set_isSupersetOf", [i32], [mref, i32, entryRef, i32], body);
  }

  // ── isDisjointFrom(a,b): no value of a is in b. flag starts 1, clears on a
  //    shared value. ──────────────────────────────────────────────────────
  {
    const perEntry: Instr[] = [
      { op: "local.get", index: B },
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas },
      // if present in b → flag = 0 (not disjoint)
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: FLAG },
        ],
        else: [],
      },
    ];
    const body: Instr[] = [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: FLAG },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      walkEntries(ctx, A, I, ENTRY, perEntry),
      { op: "local.get", index: FLAG },
    ];
    addFn("__set_isDisjointFrom", [i32], [mref, i32, entryRef, i32], body);
  }
}

/**
 * Cast a compiled receiver/arg expression to `ref $Map` (the Set backing store).
 * Returns false when the value is a different concrete struct (bail to generic).
 */
function castToMap(ctx: CodegenContext, fctx: FunctionContext, t: ValType | null): boolean {
  if (t === null) return false;
  if (t.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  } else if (t.kind === "anyref" || t.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  } else if ((t.kind === "ref" || t.kind === "ref_null") && t.typeIdx !== ctx.mapTypeIdx) {
    return false;
  }
  return true;
}

/**
 * (#2162) Intercept an ES2025 Set set-algebra method call in standalone /
 * nativeStrings mode. Both the receiver and the single argument must type as a
 * Set (the WasmGC `$Map` struct); otherwise return undefined to let the generic
 * path try. Receiver + arg are compiled here.
 */
export function tryCompileNativeSetAlgebraCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  const methodName = propAccess.name.text;
  const isSetOp = SET_ALGEBRA_SET_OPS.has(methodName);
  const isPredicate = SET_ALGEBRA_PREDICATES.has(methodName);
  if (!isSetOp && !isPredicate) return undefined;
  if (callExpr.arguments.length !== 1) return undefined;

  ensureMapHelpers(ctx);
  ensureSetAlgebraHelpers(ctx);
  if (ctx.mapTypeIdx < 0) return undefined;
  const helperIdx = ctx.mapHelpers.get(`__set_${methodName}`);
  if (helperIdx === undefined) return undefined;
  // (#3172) Emit the runtime any-dispatcher (native fast lane + set-LIKE
  // GetSetRecord lane) NOW — before any receiver/arg instruction is baked —
  // so its transitive registrations (object runtime, iterator substrate,
  // union imports) can never shift an already-emitted funcidx (#1719).
  ensureSetAlgebraAnyDispatch(ctx, methodName);

  // receiver → ref $Map
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (!castToMap(ctx, fctx, recvType)) return undefined;
  // (#3172) GetSetRecord(arg) — spec 24.2.1.2. The argument dispatches at
  // RUNTIME through `__set_<m>_any` (collections-es2025.ts): a real native
  // collection takes the fast two-`$Map` kernel; a genuine set-LIKE object
  // (numeric `size`, callable `has`/`keys`) drives the spec algorithm over
  // its record; anything else throws a catchable TypeError from the size
  // coercion (undefined/NaN/BigInt size — covers every primitive/plain-object
  // row #2607 used to reject via the struct-only brand check).
  const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!);
  const anyResult = emitSetAlgebraAnyArgDispatch(ctx, fctx, methodName, argType);
  if (anyResult !== undefined) return anyResult;

  // Fallback (any-dispatch unavailable): the #2607 struct-only brand check.
  emitSetBrandCheck(ctx, fctx, argType);
  fctx.body.push({ op: "call", funcIdx: helperIdx });
  return isSetOp ? ({ kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType) : ({ kind: "i32" } as ValType);
}
