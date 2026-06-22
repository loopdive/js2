// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2580 M0) Value-rep dynamic-read substrate — the runtime property-presence
// read primitives.
//
// The dense/typed WasmGC representation cannot model a *dynamic read*: reading a
// property (named or indexed) from a receiver whose true shape is only known at
// runtime — a plain `$Object`, an array-like object, a `$Vec`, a string, a boxed
// primitive, or `null`/`undefined`. The whole sprint-64 dynamic/sparse tail
// (#2001 S2/S3, #2573, #983d, the `Array.prototype.X.call(arrayLike, cb)` cluster)
// converges on this: each needs `HasProperty` / `Get` against an arbitrary heap
// value, which the typed `array.get` / vec-field-0 / static dispatch can't express.
//
// Two Wasm-native primitives, dispatched over the #1852 boxed `$AnyValue` family
// by its `tag` field (0 null · 1 undefined · 2 i32 · 3 f64 · 4 boolean ·
// 5 string/externref · 6 GC-ref → `$Object`/`$Vec`):
//
//   __dyn_has(recv: externref, key: externref) -> i32        (HasProperty, proto chain)
//   __dyn_get(recv: externref, key: externref) -> externref  (Get → externref / undefined)
//
// `.length` on an `any` receiver is just `__dyn_get(recv, "length")`; an absent
// index/property reads back as JS `undefined` (externref), NOT a numeric 0.
//
// **M0 is a 0-risk scaffold.** `ensureDynReadHelpers` is gated on
// `ctx.usesDynRead`, which **nothing sets in M0** (the first call site arrives in
// M1's `any`-receiver `.length`). So in M0 these helpers are never emitted and
// every module is byte-identical — the gate, not dead-elim, is what guarantees
// zero bytes / zero regression (an uncalled *defined* function is not
// import-pruned). M1 flips `ctx.usesDynRead` at its first call site and exercises
// the bodies; M2–M4 widen the call sites. The typed read path is forever
// untouched: only statically-`any`/dynamic receivers reach here.
//
// **Standalone parity.** Pure WasmGC + the existing `__extern_get` object-runtime
// helper (which already walks the prototype chain) + native-string indexing; the
// `undefined` result uses the existing `emitUndefined` convention (host
// `__get_undefined`, else `ref.null.extern`). No new host import.

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { ensureGetUndefined } from "./expressions/late-imports.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { allocLocal } from "./context/locals.js";

// `$AnyValue` tag constants (mirror any-helpers.ts box helpers).
const TAG_NULL = 0;
const TAG_UNDEFINED = 1;
// 2 = i32, 3 = f64, 4 = boolean — primitives, no own properties (besides length
// on strings, handled via tag 5). 5 = string/externref, 6 = GC ref.
const TAG_STRING = 5;
const TAG_REF = 6;
void TAG_NULL;
void TAG_UNDEFINED;
void TAG_STRING;

/**
 * Register the `__dyn_has` / `__dyn_get` runtime read primitives. Idempotent and
 * **gated on `ctx.usesDynRead`** — a no-op unless a call site (M1+) has flagged
 * that the module needs them, so M0 (no call sites) emits nothing.
 *
 * Call this in the finalize phase, after `ensureObjectRuntime`/`ensureAnyHelpers`
 * (the helpers reference `$AnyValue` + `__extern_get`). It must run before
 * dead-elim / late-import settle so the baked funcIdx values are stable.
 */
export function ensureDynReadHelpers(ctx: CodegenContext): void {
  // (#2580 M0) `JS2WASM_FORCE_DYN_READ=1` force-emits the helpers even with no
  // call site — the M0 self-test that the bodies are VALID Wasm (host +
  // standalone) before M1 wires real call sites. Off by default; never set in
  // production, so it cannot affect any normal/CI compile.
  if (process.env.JS2WASM_FORCE_DYN_READ === "1") ctx.usesDynRead = true;
  if (!ctx.usesDynRead) return; // M0 / dynamic-read-free modules: byte-identical.
  if (ctx.dynReadHelpersEmitted) return;
  ctx.dynReadHelpersEmitted = true;

  // The object arm delegates to `__extern_get` (named/indexed property read with
  // prototype-chain walk; returns `ref.null.extern` when absent). It MUST already
  // be registered by the program's normal compilation — a call site that sets
  // `ctx.usesDynRead` (M1+: an `any`-receiver read) naturally pulls in the object
  // runtime. We do NOT call `ensureObjectRuntime` here: this runs in the finalize
  // phase, and registering new STRUCT types this late desyncs the type index
  // space (the #2043 late-shift class). Adding only FUNC types via `addFuncType`
  // below is safe. If `__extern_get` is somehow absent, bail without emitting —
  // the call site keeps its prior lowering, no regression.
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined) {
    ctx.dynReadHelpersEmitted = false;
    ctx.usesDynRead = false;
    return;
  }

  // `undefined` as externref: host `__get_undefined` when present, else the
  // standalone `ref.null.extern` convention.
  const getUndefIdx = ensureGetUndefined(ctx);
  const undefInstrs: Instr[] =
    getUndefIdx !== undefined ? [{ op: "call", funcIdx: getUndefIdx } as Instr] : [{ op: "ref.null.extern" } as Instr];

  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };

  function addHelper(
    name: string,
    params: ValType[],
    results: ValType[],
    body: Instr[],
    locals: { name: string; type: ValType }[] = [],
  ): void {
    if (ctx.funcMap.has(name)) return;
    const typeIdx = addFuncType(ctx, params, results, name);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({ name, typeIdx, locals, body, exported: false } as never);
    ctx.funcMap.set(name, funcIdx);
  }

  // Shared tag read: convert the externref receiver to anyref, test the boxed
  // `$AnyValue`, and leave the tag (i32) on the stack — or fall through to the
  // "raw" (non-boxed) cases. A receiver reaches here either already boxed
  // (`$AnyValue`) or as a raw `$Object`/`$Vec`/string ref; `__extern_get` handles
  // the raw object/vec case directly (it `any.convert_extern`s + casts), so the
  // object arm does not need the tag — it just calls `__extern_get`.

  // __dyn_get(recv, key) -> externref
  //   Get(recv, key): the value, or `undefined` when absent.
  //   Tag 6 (GC ref) / raw object/vec → __extern_get (returns null when absent →
  //     map null to `undefined`). Tags 0/1 (null/undefined) and 2/3/4 (primitives)
  //     → `undefined` (no own properties; string `.length`/index handled by the
  //     object/extern path's string arm where present). String tag 5 also routes
  //     through __extern_get, which has the native-string indexed/`.length` arm.
  //   The result is a UNIFORM externref — numeric values arrive boxed.
  addHelper(
    "__dyn_get",
    [externref, externref],
    [externref],
    [
      // val = __extern_get(recv, key)
      { op: "local.get", index: 0 } as Instr,
      { op: "local.get", index: 1 } as Instr,
      { op: "call", funcIdx: externGetIdx } as Instr,
      { op: "local.tee", index: 2 } as Instr,
      // if (val is null) return undefined  — §Get of an absent property is undefined
      { op: "ref.is_null" } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: undefInstrs,
        else: [{ op: "local.get", index: 2 } as Instr],
      } as Instr,
    ],
    [{ name: "__dg_val", type: externref }],
  );

  // __dyn_has(recv, key) -> i32
  //   HasProperty(recv, key) INCLUDING the prototype chain. Tag 6 / raw object/vec
  //   / string → 1 iff __extern_get returns non-null (it walks own + proto).
  //   Tags 0/1/2/3/4 → 0 (a primitive/null/undefined has no own indexable props
  //   here; string length/index presence rides the __extern_get string arm).
  //   NOTE: this conflates "present with value undefined" vs "absent" for the
  //   rare `obj.x === undefined` own-property case — refined in M2/M3 where the
  //   distinction matters (HasProperty proper vs Get); for M1's `.length` and the
  //   array-like cluster, non-null-Get ⇔ present is correct.
  addHelper(
    "__dyn_has",
    [externref, externref],
    [i32],
    [
      { op: "local.get", index: 0 } as Instr,
      { op: "local.get", index: 1 } as Instr,
      { op: "call", funcIdx: externGetIdx } as Instr,
      { op: "ref.is_null" } as Instr,
      { op: "i32.eqz" } as Instr, // present ⇔ NOT null
    ],
  );

  // Reference the tag constant so a future refined tag-dispatch (M2/M3) keeps it;
  // the M0 form delegates to `__extern_get`, which tag-dispatches internally.
  void TAG_REF;
}

/**
 * (#2580 M1) Call-site helper: emit a `__dyn_get(recv, "<keyName>")` at a property
 * read site. The RECEIVER externref must already be on the stack; this pushes the
 * key string (externref) and the `call __dyn_get`, leaving the value externref
 * (the property, or `undefined` when absent) on the stack.
 *
 * Runs during BODY compilation (not finalize): it eagerly `ensureObjectRuntime`
 * (so `__extern_get` exists — safe to register its struct types here, the normal
 * path) and eagerly emits the dyn-read helpers (so `__dyn_get`'s funcIdx is known
 * for the `call` below). Sets `ctx.usesDynRead` so the finalize pass is a no-op
 * (the latch is already set). Returns true on success; false (no-op, receiver
 * left on stack) if the runtime is unavailable — the caller then keeps its prior
 * lowering.
 */
export function emitDynGet(ctx: CodegenContext, fctx: FunctionContext, keyName: string): boolean {
  if (ctx.standalone) {
    // STANDALONE: `__extern_get` is a DEFINED native helper inside the object
    // runtime (anyStrTypeIdx valid). Route through the `__dyn_get` wrapper so the
    // M0 helper's `$Vec`/`$Hole`/native-string arms apply (M2/M3 fill them in).
    // `usesDynRead` makes the finalize pass emit the wrapper helpers.
    ctx.usesDynRead = true;
    ensureObjectRuntime(ctx);
    ensureDynReadHelpers(ctx);
    addStringConstantGlobal(ctx, keyName);
    flushLateImportShifts(ctx, fctx);
    const dynGetIdx = ctx.funcMap.get("__dyn_get");
    if (dynGetIdx === undefined) return false;
    for (const instr of stringConstantExternrefInstrs(ctx, keyName)) fctx.body.push(instr);
    fctx.body.push({ op: "call", funcIdx: dynGetIdx } as Instr);
    return true;
  }
  // HOST mode: INLINE `__extern_get(recv, key)` directly — do NOT call the
  // defined `__dyn_get` wrapper. `__extern_get` is a JS host IMPORT (stable index
  // at the import section, kept in lockstep by the late-import shift), so baking
  // `call __extern_get` is shift-safe. The defined `__dyn_get`/`__dyn_has` helpers
  // are DEFINED functions whose indices FLOAT as later imports are added; baking
  // `call __dyn_get` mid-body and then having a value-consumer add an import
  // (`=== undefined` → `__extern_is_undefined`, arithmetic → `__unbox_number`)
  // shifts the defined-func index out from under the baked call, which then hits
  // the adjacent `__dyn_has` (the funcidx-ordering #2043 bug). Inlining the host
  // `__extern_get` sidesteps it entirely. In host mode `__extern_get(obj, key)`
  // already returns JS `undefined` for an absent property (the host `obj[key]`),
  // so no null→undefined remap is needed — the result is the spec `Get`.
  //
  // BUT: an `any`-typed receiver that holds a compiled ARRAY is an externref
  // wrapping a WasmGC vec struct. The host `__extern_get(vec, "length")` returns
  // `undefined` (V8 sees an opaque struct with no `.length` JS property), which
  // would WRONGLY shadow the real array length. So for the `.length` key we FIRST
  // dispatch on the runtime receiver kind via `ref.test` against the registered
  // vec types — a HIT reads vec struct field 0 (the length, i32) and boxes it to
  // an externref via `__box_number`; the MISS (genuine plain object / host value)
  // falls to `__extern_get`. `ref.test typeIdx` uses *type* indices, which are
  // append-only / dead-elim-stable (the rec-group), so unlike a `call __is_vec`
  // this carries NO funcidx-ordering hazard. Non-`length` keys skip the vec arm
  // (vec indexed reads are a later slice) and go straight to `__extern_get`.
  // Register BOTH imports up-front (before resolving any baked index): the
  // vec-aware `.length` arm boxes the i32 length to externref via `__box_number`,
  // and a late `__box_number` import added *after* `__extern_get`'s index was
  // baked would shift it. Ensure-then-flush-then-resolve keeps both stable.
  const externGetIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (externGetIdx === undefined) {
    flushLateImportShifts(ctx, fctx);
    return false;
  }
  // Only the `.length` key uses the vec arm; ensure `__box_number` for it, plus
  // `__extern_is_undefined` for the null/undefined-receiver guard (#2580 M2 s1).
  if (keyName === "length") {
    ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
    ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  }
  addStringConstantGlobal(ctx, keyName);
  flushLateImportShifts(ctx, fctx);
  // Re-resolve by name AFTER all import shifts have settled.
  const finalExternGetIdx = ctx.funcMap.get("__extern_get") ?? externGetIdx;
  const boxNumIdx = keyName === "length" ? ctx.funcMap.get("__box_number") : undefined;
  const isUndefIdx = keyName === "length" ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  const vecEntries = Array.from(ctx.vecTypeMap.values());
  if (keyName === "length" && boxNumIdx !== undefined && vecEntries.length > 0) {
    // Stash the receiver externref (currently on the stack) so we can test it.
    const recvTmp = allocLocal(fctx, `__dg_recv_${fctx.locals.length}`, { kind: "externref" });
    const anyTmp = allocLocal(fctx, `__dg_any_${fctx.locals.length}`, { kind: "anyref" });
    fctx.body.push({ op: "local.set", index: recvTmp } as Instr);
    fctx.body.push({ op: "local.get", index: recvTmp } as Instr);
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "local.set", index: anyTmp } as Instr);

    // The MISS branch: __extern_get(recv, "length") → value-or-undefined externref.
    let chain: Instr[] = [
      { op: "local.get", index: recvTmp } as Instr,
      ...stringConstantExternrefInstrs(ctx, keyName),
      { op: "call", funcIdx: finalExternGetIdx } as Instr,
    ];
    // (#2580 M1a v2 — merge_group eject fix) CLOSURE arm, innermost so it is
    // tested LAST inside the vec chain's else. A function/closure `.length` is its
    // ARITY, not a vec length; routing a closure externref through `__extern_get`
    // returned `undefined` → NaN (the v1 Cluster-A regression: zero-arity built-in
    // method `.length` `verifyProperty({value:0})` tests flipped pass→fail because
    // origin's prior numeric path returned 0). The compiler does not statically
    // track an `any`-typed closure's arity here, and origin's prior path returned
    // a flat `0`, so match it: `ref.test` the registered closure base wrapper
    // types and, on a hit, return `box_number(0)`. Same `ref.test typeIdx`
    // discipline as the vec arm (type indices are rec-group / dead-elim stable —
    // no funcidx hazard). Closure base types are derived inline from
    // `ctx.closureInfoByTypeIdx` (walking each to its root struct) to avoid a
    // circular import on index.ts's private `collectClosureBaseWrapperTypeIdxs`.
    for (const closureBaseTypeIdx of closureBaseWrapperTypeIdxs(ctx)) {
      chain = [
        { op: "local.get", index: anyTmp } as Instr,
        { op: "ref.test", typeIdx: closureBaseTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [
            // arity fallback: box_number(0.0) — matches the prior numeric path.
            { op: "f64.const", value: 0 } as Instr,
            { op: "call", funcIdx: boxNumIdx } as Instr,
          ],
          else: chain,
        } as Instr,
      ];
    }
    // Wrap from the innermost (last) vec type outward: each layer is
    // `if ref.test $vec { box_number(f64(struct.get field0)) } else { <chain> }`.
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const vecTypeIdx = vecEntries[i]!;
      const def = ctx.mod.types[vecTypeIdx];
      if (def?.kind !== "struct" || def.fields[0]?.name !== "length" || def.fields[1]?.name !== "data") {
        continue; // not a length/data vec — skip
      }
      chain = [
        { op: "local.get", index: anyTmp } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [
            { op: "local.get", index: anyTmp } as Instr,
            { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "call", funcIdx: boxNumIdx } as Instr,
          ],
          else: chain,
        } as Instr,
      ];
    }
    // (#2580 M2 slice 1) NULL/UNDEFINED-RECEIVER guard, OUTERMOST (tested FIRST).
    // A receiver that is JS `null`/`undefined` at runtime — e.g. a Symbol-keyed
    // prototype walk that did not resolve (`IteratorProto[Symbol.iterator]` →
    // undefined; the Cluster-A class of the #1894 eject) — read its `.length` as
    // the prior numeric path's null-guarded `0`, NOT `__extern_get(undefined,
    // "length")` → undefined → NaN. `ref.is_null` does NOT catch this (a JS
    // `undefined` is a NON-null externref wrapping the host undefined sentinel —
    // why M1's `ref.is_null` guard left Cluster A at 0/13); the HOST
    // `__extern_is_undefined` does (`v === undefined`). On a hit return
    // `box_number(0)`, matching origin. The canary `{}` is a non-null object →
    // miss → reaches `__extern_get` → undefined (preserved).
    if (isUndefIdx !== undefined && boxNumIdx !== undefined) {
      chain = [
        { op: "local.get", index: recvTmp } as Instr,
        { op: "call", funcIdx: isUndefIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr],
          else: chain,
        } as Instr,
      ];
    }
    for (const instr of chain) fctx.body.push(instr);
    return true;
  }

  // receiver externref already on the stack → push key → call __extern_get.
  for (const instr of stringConstantExternrefInstrs(ctx, keyName)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: finalExternGetIdx } as Instr);
  return true;
}

/**
 * (#2580 M1a v2) The deduped root struct types of every registered closure
 * wrapper, for `ref.test`-discriminating a closure receiver. Mirrors index.ts's
 * private `collectClosureBaseWrapperTypeIdxs` (walking each closure struct up its
 * `superTypeIdx` chain to the root) but lives here to avoid a circular import
 * (`index.ts` already imports `ensureDynReadHelpers` from this module).
 */
function closureBaseWrapperTypeIdxs(ctx: CodegenContext): number[] {
  const mod = ctx.mod;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (!info) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    let root = typeIdx;
    let cur: typeof typeDef = typeDef;
    while (cur && cur.kind === "struct" && cur.superTypeIdx !== undefined && cur.superTypeIdx >= 0) {
      const parent = mod.types[cur.superTypeIdx];
      if (!parent || parent.kind !== "struct") break;
      root = cur.superTypeIdx;
      cur = parent;
    }
    if (!seen.has(root)) {
      seen.add(root);
      out.push(root);
    }
  }
  return out;
}
