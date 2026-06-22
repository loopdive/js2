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
import type { InnerResult } from "./shared.js";
import { compileExpression } from "./shared.js";
import { ensureMapHelpers } from "./map-runtime.js";
import { emitSetBrandCheck, ensureSetHelpers } from "./set-runtime.js";

const TOMBSTONE_BIT = 0x40000000; // mirrors map-runtime.ts
const M_ENTRIES = 1;
const M_ENTRYCOUNT = 2;
const F_VALUE = 1;
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
    { op: "local.get", index: aLocal } as Instr,
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
    { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx } as Instr,
    { op: "local.set", index: entryTmp } as Instr,
  ];
  return {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: iTmp } as Instr,
          { op: "local.get", index: aLocal } as Instr,
          { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRYCOUNT } as unknown as Instr,
          { op: "i32.ge_s" } as Instr,
          { op: "br_if", depth: 1 } as Instr,
          ...loadEntry,
          { op: "local.get", index: iTmp } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.add" } as Instr,
          { op: "local.set", index: iTmp } as Instr,
          // tombstone? skip
          { op: "local.get", index: entryTmp } as Instr,
          { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH } as unknown as Instr,
          { op: "i32.const", value: TOMBSTONE_BIT } as Instr,
          { op: "i32.and" } as Instr,
          { op: "br_if", depth: 0 } as Instr,
          ...perEntry,
          { op: "br", depth: 0 } as Instr,
        ],
      } as Instr,
    ],
  } as Instr;
}

/** entry.value (anyref) onto the stack. */
function entryValue(ctx: CodegenContext, entryTmp: number): Instr[] {
  return [
    { op: "local.get", index: entryTmp } as Instr,
    { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_VALUE } as unknown as Instr,
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
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mapHelpers.set(name, funcIdx);
    ctx.mod.functions.push({
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
    { op: "local.get", index: RES } as Instr,
    ...entryValue(ctx, ENTRY),
    { op: "call", funcIdx: setAdd } as Instr,
    { op: "local.set", index: RES } as Instr,
  ];

  // ── union(a,b): copy all of a, then all of b (set_add dedups). ───────────
  {
    const body: Instr[] = [
      { op: "call", funcIdx: mapNew } as Instr,
      { op: "local.set", index: RES } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.set", index: I } as Instr,
      walkEntries(ctx, A, I, ENTRY, addValToResult()),
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.set", index: I } as Instr,
      walkEntries(ctx, B, I, ENTRY, addValToResult()),
      { op: "local.get", index: RES } as Instr,
    ];
    addFn("__set_union", [mref], [mref, i32, entryRef], body);
  }

  // ── intersection(a,b): values of a that are also in b. ───────────────────
  {
    const perEntry: Instr[] = [
      // if (__map_has(b, entry.value)) result = __set_add(result, value)
      { op: "local.get", index: B } as Instr,
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: addValToResult(),
        else: [],
      } as Instr,
    ];
    const body: Instr[] = [
      { op: "call", funcIdx: mapNew } as Instr,
      { op: "local.set", index: RES } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.set", index: I } as Instr,
      walkEntries(ctx, A, I, ENTRY, perEntry),
      { op: "local.get", index: RES } as Instr,
    ];
    addFn("__set_intersection", [mref], [mref, i32, entryRef], body);
  }

  // ── difference(a,b): values of a NOT in b. ───────────────────────────────
  {
    const perEntry: Instr[] = [
      { op: "local.get", index: B } as Instr,
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas } as Instr,
      { op: "i32.eqz" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: addValToResult(),
        else: [],
      } as Instr,
    ];
    const body: Instr[] = [
      { op: "call", funcIdx: mapNew } as Instr,
      { op: "local.set", index: RES } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.set", index: I } as Instr,
      walkEntries(ctx, A, I, ENTRY, perEntry),
      { op: "local.get", index: RES } as Instr,
    ];
    addFn("__set_difference", [mref], [mref, i32, entryRef], body);
  }

  // ── symmetricDifference(a,b): (a\b) ∪ (b\a). ─────────────────────────────
  {
    // walk a: add value if NOT in b. walk b: add value if NOT in a.
    const aNotB: Instr[] = [
      { op: "local.get", index: B } as Instr,
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas } as Instr,
      { op: "i32.eqz" } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: addValToResult(), else: [] } as Instr,
    ];
    const bNotA: Instr[] = [
      { op: "local.get", index: A } as Instr,
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas } as Instr,
      { op: "i32.eqz" } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: addValToResult(), else: [] } as Instr,
    ];
    const body: Instr[] = [
      { op: "call", funcIdx: mapNew } as Instr,
      { op: "local.set", index: RES } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.set", index: I } as Instr,
      walkEntries(ctx, A, I, ENTRY, aNotB),
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.set", index: I } as Instr,
      walkEntries(ctx, B, I, ENTRY, bNotA),
      { op: "local.get", index: RES } as Instr,
    ];
    addFn("__set_symmetricDifference", [mref], [mref, i32, entryRef], body);
  }

  // ── isSubsetOf(a,b): every value of a is in b. flag starts 1, clears on a
  //    value missing from b. ─────────────────────────────────────────────--
  {
    const perEntry: Instr[] = [
      { op: "local.get", index: B } as Instr,
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas } as Instr,
      { op: "i32.eqz" } as Instr,
      // if missing → flag = 0
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: FLAG } as Instr],
        else: [],
      } as Instr,
    ];
    const body: Instr[] = [
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.set", index: FLAG } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.set", index: I } as Instr,
      walkEntries(ctx, A, I, ENTRY, perEntry),
      { op: "local.get", index: FLAG } as Instr,
    ];
    // locals: result slot unused but kept for index alignment (RES at 2).
    addFn("__set_isSubsetOf", [i32], [mref, i32, entryRef, i32], body);
  }

  // ── isSupersetOf(a,b): every value of b is in a (= isSubsetOf with args
  //    swapped). ──────────────────────────────────────────────────────────
  {
    const perEntry: Instr[] = [
      { op: "local.get", index: A } as Instr,
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas } as Instr,
      { op: "i32.eqz" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: FLAG } as Instr],
        else: [],
      } as Instr,
    ];
    const body: Instr[] = [
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.set", index: FLAG } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.set", index: I } as Instr,
      walkEntries(ctx, B, I, ENTRY, perEntry),
      { op: "local.get", index: FLAG } as Instr,
    ];
    addFn("__set_isSupersetOf", [i32], [mref, i32, entryRef, i32], body);
  }

  // ── isDisjointFrom(a,b): no value of a is in b. flag starts 1, clears on a
  //    shared value. ──────────────────────────────────────────────────────
  {
    const perEntry: Instr[] = [
      { op: "local.get", index: B } as Instr,
      ...entryValue(ctx, ENTRY),
      { op: "call", funcIdx: mapHas } as Instr,
      // if present in b → flag = 0 (not disjoint)
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: FLAG } as Instr],
        else: [],
      } as Instr,
    ];
    const body: Instr[] = [
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.set", index: FLAG } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.set", index: I } as Instr,
      walkEntries(ctx, A, I, ENTRY, perEntry),
      { op: "local.get", index: FLAG } as Instr,
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
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
  } else if (t.kind === "anyref" || t.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
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

  // receiver → ref $Map
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (!castToMap(ctx, fctx, recvType)) return undefined;
  // (#2607) GetSetRecord(arg) argument validation — spec 24.2.1.2 step 1 ("If
  // obj is not an Object, throw a TypeError") + steps 7-10 (has/keys must be
  // callable). A non-Set argument (primitive `1`/`""`/`true`/`Symbol()`, or a
  // plain object / array that is not the `$Map` backing struct) throws a
  // *catchable* TypeError — NOT a `ref.cast` trap (illegal cast) and NOT a host
  // fall-through (which silently completes / leaks `env`). Reuses #2604's
  // `emitSetBrandCheck` (`ref.test $Map` → throw-or-cast), which leaves the
  // validated `(ref $Map)` on the stack. A genuine set-LIKE object (size/has/
  // keys on an `any`) is conservatively rejected here — that data path is
  // #2580 M2 (dynamic property read), currently failing anyway (no regression).
  const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!);
  emitSetBrandCheck(ctx, fctx, argType);

  fctx.body.push({ op: "call", funcIdx: helperIdx });
  return isSetOp ? ({ kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType) : ({ kind: "i32" } as ValType);
}
