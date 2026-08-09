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

import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import {
  undefinedSingletonActive, // (#2106 S1)
  undefinedExternInstrs,
  ensureAnyFromExternHelper, // (#3053 U0) settled honest classifier (CS1b)
  ensureAnyToExternHelper, // (#3053 U0) key marshalling
} from "./any-helpers.js";
import { emitUndefined, ensureGetUndefined } from "./expressions/late-imports.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { allocLocal } from "./context/locals.js";
import { collectClosureBaseWrapperTypeIdxs as closureBaseWrapperTypeIdxs } from "./closure-classifier.js"; // (#2175 V2-S1) shared list
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { boxToAny } from "./value-tags.js";

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
    getUndefIdx !== undefined ? [{ op: "call", funcIdx: getUndefIdx }] : [{ op: "ref.null.extern" }];
  // (#2106 S1) Under the `undefinedSingleton` regime `__extern_get` ALREADY
  // returns the singleton for an absent property, and a null result means a
  // STORED JS null — so `__dyn_get` must NOT remap null → undefined (that
  // would read `obj.x = null` back as undefined), and `__dyn_has`'s
  // "present ⇔ non-null" flips to "present ⇔ non-nullish". This runs at
  // FINALIZE: only consult ALREADY-reserved indices (no ensureAnyValueType —
  // registering struct types this late is the #2043 late-shift class).
  const s1DynRegime = undefinedSingletonActive(ctx) && ctx.undefinedGlobalIdx !== undefined;
  const s1IsNullishIdx = s1DynRegime ? ctx.funcMap.get("__extern_is_nullish") : undefined;

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
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false } as never);
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
    s1DynRegime
      ? [
          // (#2106 S1) plain pass-through: __extern_get already answers the
          // singleton for absent, and null means a stored JS null.
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
        ]
      : [
          // val = __extern_get(recv, key)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
          { op: "local.tee", index: 2 },
          // if (val is null) return undefined  — §Get of an absent property is undefined
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: externref },
            then: undefInstrs,
            else: [{ op: "local.get", index: 2 }],
          },
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
    s1IsNullishIdx !== undefined
      ? [
          // (#2106 S1) present ⇔ NOT nullish (absent = the undefined singleton).
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
          { op: "call", funcIdx: s1IsNullishIdx },
          { op: "i32.eqz" },
        ]
      : [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
          { op: "ref.is_null" },
          { op: "i32.eqz" }, // present ⇔ NOT null
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
    fctx.body.push({ op: "call", funcIdx: dynGetIdx });
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
    // (#2896) Builtin-fn metadata read for the closure arm (standalone only):
    // a builtin function value's `.length` is its spec arity, answered by the
    // finalize-filled `__builtinfn_get_meta` native instead of the flat 0.
    if (ctx.standalone) {
      ensureLateImport(
        ctx,
        "__builtinfn_get_meta",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
    }
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
    fctx.body.push({ op: "local.set", index: recvTmp });
    fctx.body.push({ op: "local.get", index: recvTmp });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "local.set", index: anyTmp });

    // The MISS branch: __extern_get(recv, "length") → value-or-undefined externref.
    let chain: Instr[] = [
      { op: "local.get", index: recvTmp },
      ...stringConstantExternrefInstrs(ctx, keyName),
      { op: "call", funcIdx: finalExternGetIdx },
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
    // (#2896) Standalone: a builtin function value carries its spec arity in
    // the finalize-filled `__builtinfn_get_meta` native — ask it first; a null
    // result (plain user closure, or a builtin fn whose `length` was deleted →
    // inherited Function.prototype.length === 0) keeps the prior flat 0.
    const bfnGetMetaIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_get_meta") : undefined;
    const closureArmThen = (): Instr[] => {
      if (bfnGetMetaIdx === undefined) {
        // arity fallback: box_number(0.0) — matches the prior numeric path.
        return [
          { op: "f64.const", value: 0 },
          { op: "call", funcIdx: boxNumIdx },
        ];
      }
      const metaTmp = allocLocal(fctx, `__dg_bfnmeta_${fctx.locals.length}`, { kind: "externref" });
      return [
        { op: "local.get", index: recvTmp },
        ...stringConstantExternrefInstrs(ctx, keyName),
        { op: "call", funcIdx: bfnGetMetaIdx },
        { op: "local.tee", index: metaTmp },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [
            { op: "f64.const", value: 0 },
            { op: "call", funcIdx: boxNumIdx },
          ],
          else: [{ op: "local.get", index: metaTmp }],
        },
      ];
    };
    for (const closureBaseTypeIdx of closureBaseWrapperTypeIdxs(ctx)) {
      chain = [
        { op: "local.get", index: anyTmp },
        { op: "ref.test", typeIdx: closureBaseTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: closureArmThen(),
          else: chain,
        },
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
        { op: "local.get", index: anyTmp },
        { op: "ref.test", typeIdx: vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [
            { op: "local.get", index: anyTmp },
            { op: "ref.cast", typeIdx: vecTypeIdx },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: boxNumIdx },
          ],
          else: chain,
        },
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
        { op: "local.get", index: recvTmp },
        { op: "call", funcIdx: isUndefIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [
            { op: "f64.const", value: 0 },
            { op: "call", funcIdx: boxNumIdx },
          ],
          else: chain,
        },
      ];
    }
    for (const instr of chain) fctx.body.push(instr);
    return true;
  }

  // receiver externref already on the stack → push key → call __extern_get.
  for (const instr of stringConstantExternrefInstrs(ctx, keyName)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: finalExternGetIdx });
  return true;
}

/* (#2175 V2-S1) The deduped closure-base-wrapper list now lives in the leaf
 * `closure-classifier.ts` and is shared with index.ts's `__typeof*` natives —
 * one predicate, never two divergent arm lists. Imported (aliased to the prior
 * local name) at the top of this module. */

// ───────────────────────────────────────────────────────────────────────────
// (#3053 U0) Unified dynamic-reader carrier substrate.
//
// `__dyn_member_get(recv, key) -> carrier` is the ONE locals-free, carrier-
// uniform primitive that both #3037 CS3 (object-identity) and #2949 S5.4 (IR
// claim-rate) converge on. It reads a named/indexed member from a dynamic
// receiver and returns a tag-HONEST carrier — a `$AnyValue` in gc/standalone
// (externref in host) — instead of the identity-losing bare externref the
// legacy `emitDynGet`/`__extern_get` hand back (which downstream tag-5-boxes,
// losing BOTH object identity and the typed carrier).
//
// The whole design turns on ONE floor-safety rule that all three prior −299/
// −788 deaths violated: the externref↔carrier round-trip lives INSIDE this
// helper, never in a shared seam. Concretely the standalone body is:
//
//   recvExt = __carrier_recv_to_extern(recv)   ;; INTERNAL peel — see below
//   keyExt  = __any_to_extern(key)             ;; existing key marshalling
//   resExt  = __extern_get(recvExt, keyExt)    ;; existing proto-walk reader
//   return  __any_from_extern_honest(resExt)   ;; settled CS1b classifier
//
// The critical, DIFFERENT-from-`__any_to_extern` piece is
// `__carrier_recv_to_extern`: unlike the global `__any_to_extern` (which keeps
// a tag-6 payload WRAPPED so an `any` boundary round-trips through the generic
// classifier — the CS1a read-breaker), this PEELS the tag-6 payload to the RAW
// `$Object` ref so `__extern_get`'s `ref.test $Object` HITS. Because the peel
// lives INSIDE the substrate helper and its output feeds ONLY `__extern_get`
// (then is immediately re-boxed honest), the global `__any_to_extern` seam —
// and every other consumer of it — stays byte-identical, and re-reads compose:
// `__dyn_member_get(__dyn_member_get(o,"a"),"z")` never hits the `__any_to_extern`
// tag-6 breaker.
//
// This is U0: BUILD the helper only. NOTHING calls it yet (U1 wires it into the
// IR member-read). So it is byte-inert: `ensureDynMemberGet` is gated on the
// `ctx.usesDynMemberGet` latch, which nothing sets in U0, plus a
// `JS2WASM_FORCE_DYN_MEMBER_GET=1` self-test escape (mirrors #2580 M0's
// `ensureDynReadHelpers` / `JS2WASM_FORCE_DYN_READ`). The latch — NOT dead-elim —
// guarantees zero bytes for every module that never calls it (an uncalled
// DEFINED function is not import-pruned). Under FORCE the helper is emitted AND
// a family of exported `__dmg_*` self-test drivers exercise the carrier round-
// trip (object→tag-6 identity, string→tag-5 content, number→tag-3 value, the
// re-read composition) on host + standalone. Registered stable-handle
// (mintDefinedFunc) so a later dead-elim import shift can never desync a baked
// call (the #2043 late-shift class): live-import call immediates are remapped by
// `eliminateDeadImports`, stable handles are skipped.

// `$AnyValue` struct field layout (mirrors ensureAnyValueType):
//   0 tag(i32) · 1 i32val(i32) · 2 f64val(f64) · 3 refval(eqref) · 4 externval(externref)
const AV_TAG = 0;
const AV_I32 = 1;
const AV_F64 = 2;
const AV_REF = 3;
const AV_EXT = 4;

/**
 * (#3053 U0) Register the unified dynamic-reader carrier primitive
 * `__dyn_member_get` (+ the internal `__carrier_recv_to_extern` peel in gc/
 * standalone). Idempotent and **gated on `ctx.usesDynMemberGet`** — a no-op
 * unless a call site (U1+) has flagged the module needs it, so U0 (no call
 * sites) emits nothing and every module is byte-identical.
 *
 * `JS2WASM_FORCE_DYN_MEMBER_GET=1` force-emits the helper AND a set of exported
 * `__dmg_*` unit-test drivers (the U0 anti-vacuity self-test). Off by default;
 * never set in production, so it cannot affect any normal/CI compile.
 *
 * Call this in the finalize phase, right after `ensureDynReadHelpers`, BEFORE
 * dead-elim/freeze so the baked funcIdx values are stable. Like
 * `ensureDynReadHelpers`, it does NOT call `ensureObjectRuntime` (registering
 * struct types this late desyncs the type-index space — #2043); it looks the
 * required natives up by name and bails without emitting if any is absent (the
 * call site keeps its prior lowering — no regression).
 */
export function ensureDynMemberGet(ctx: CodegenContext): void {
  const forceSelfTest = process.env.JS2WASM_FORCE_DYN_MEMBER_GET === "1";
  if (forceSelfTest) ctx.usesDynMemberGet = true;
  if (!ctx.usesDynMemberGet) return; // U0 / member-get-free modules: byte-identical.
  if (ctx.dynMemberGetHelpersEmitted) return;
  ctx.dynMemberGetHelpersEmitted = true;

  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };

  // `dyn.member_get` and `dyn.member_set` are the carrier-level equivalents of
  // JS property access. Preserve RequireObjectCoercible before either helper
  // reaches the object runtime: null and undefined throw, while all other
  // primitive/object partitions continue through ordinary property semantics.
  //
  // Build the constructor in-module on every target. This keeps the guard
  // import-neutral (important for standalone closure) and, because
  // preregisterDynamicSupport calls us before Phase 3, all added types/functions
  // are reserved before any IR body captures indices.
  const objectCoercibleThrow = (): Instr[] =>
    buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert undefined or null to object", {
      forceInModuleCtor: true,
    });
  // The externref carrier needs the sentinel-aware undefined predicate. The
  // object runtime owns the standalone native; host mode may need the import
  // registered here. Settle that import before resolving any helper indices.
  let externIsUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  if (!ctx.fast && externIsUndefinedIdx === undefined) {
    ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [i32]);
    flushLateImportShifts(ctx, null);
    externIsUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  }

  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined) {
    ctx.dynMemberGetHelpersEmitted = false;
    ctx.usesDynMemberGet = false;
    return;
  }

  function addHelper(
    name: string,
    params: ValType[],
    results: ValType[],
    body: Instr[],
    locals: { name: string; type: ValType }[] = [],
  ): number | undefined {
    const existing = ctx.funcMap.get(name);
    if (existing !== undefined) return existing;
    const typeIdx = addFuncType(ctx, params, results, name);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false } as never);
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  }

  // (#3053 U2) Carrier mode-split alignment — MUST key on `ctx.fast`, the SAME
  // predicate `resolveDynamic` / `makeDynamicLowering` (integration.ts) use to
  // choose the carrier ValType. The IR handle passes `$AnyValue` when `ctx.fast`
  // and `externref` otherwise; keying the helper BODY on `ctx.standalone||wasi`
  // (as U0/U1 did) DISAGREED with the carrier in two configs — `fast && !standalone`
  // (host js-string playground: gc carrier, externref body) and
  // `!fast && (standalone||wasi)` (gc body, externref carrier — e.g. the
  // prove-emit-identity `standalone`/`wasi` targets, which pass `fast:undefined`)
  // — so a call to `__dyn_member_get` would carry the wrong ABI ⇒ invalid Wasm.
  // Harmless in U1 (byte-inert: no producer emits `dyn.member_get`), but U2 opens
  // the scan and those reads start emitting, so the split is realised. Aligning
  // on `ctx.fast` makes body == carrier in ALL four configs. The gc body's native
  // deps (`__extern_get`, honest classifier, `__box_number`/`__box_boolean`) are
  // ensured at preregister time for the fast path (preregisterDynamicSupport);
  // the self-guards below stay as the finalize-late backstop.
  if (ctx.fast) {
    // ── gc carrier = (ref null $AnyValue) (fast: standalone OR host-js-string) ─
    const anyIdx = ctx.anyValueTypeIdx;
    if (anyIdx < 0) {
      ctx.dynMemberGetHelpersEmitted = false;
      ctx.usesDynMemberGet = false;
      return;
    }
    const anyRefNull: ValType = { kind: "ref_null", typeIdx: anyIdx };

    // The settled #3037 CS1b honest classifier (tag-3/tag-4 peel BEFORE the eq
    // test, then tag-5 string / tag-6 object) and the key marshaller. Registering
    // these at finalize is safe: both only `addFuncType` + mint and reuse struct
    // types reserved during body compilation (`ensureAnyValueType` early-returns).
    const honestIdx = ensureAnyFromExternHelper(ctx, { forceHonest: true });
    const anyToExternIdx = ensureAnyToExternHelper(ctx);
    const boxNumberIdx = ctx.funcMap.get("__box_number");
    const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
    if (
      honestIdx === undefined ||
      anyToExternIdx === undefined ||
      boxNumberIdx === undefined ||
      boxBooleanIdx === undefined
    ) {
      ctx.dynMemberGetHelpersEmitted = false;
      ctx.usesDynMemberGet = false;
      return;
    }

    // __carrier_recv_to_extern(v: (ref null $AnyValue)) -> externref
    //   PEELS the carrier to the externref `__extern_get` needs — the load-bearing
    //   difference from `__any_to_extern` (which WRAPS tag-6). tag 6 → the RAW
    //   `$Object` ref (field 3) so `__extern_get`'s `ref.test $Object` hits;
    //   tag 5 → the string externref (field 4); tag 2/3 → __box_number;
    //   tag 4 → __box_boolean. A null carrier or tag 0/1 is rejected here,
    //   before conversion, so Get/Set both preserve RequireObjectCoercible.
    const peelBody: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [{ op: "i32.const", value: 1 }],
        else: [
          { op: "local.get", index: 0 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_TAG },
          { op: "local.tee", index: 1 },
          { op: "i32.const", value: TAG_NULL },
          { op: "i32.eq" },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: TAG_UNDEFINED },
          { op: "i32.eq" },
          { op: "i32.or" },
        ],
      },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: objectCoercibleThrow(),
      },
      // tag 6 → extern.convert_any(v.refval)  — the RAW $Object
      { op: "local.get", index: 1 },
      { op: "i32.const", value: TAG_REF },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_REF },
          { op: "extern.convert_any" },
          { op: "return" },
        ],
      },
      // tag 5 → v.externval (string externref)
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 5 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_EXT },
          { op: "return" },
        ],
      },
      // tag 3 → __box_number(v.f64val)
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 3 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_F64 },
          { op: "call", funcIdx: boxNumberIdx },
          { op: "return" },
        ],
      },
      // tag 4 → __box_boolean(v.i32val)
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 4 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_I32 },
          { op: "call", funcIdx: boxBooleanIdx },
          { op: "return" },
        ],
      },
      // tag 2 → __box_number(f64.convert_i32_s(v.i32val))
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_I32 },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: boxNumberIdx },
          { op: "return" },
        ],
      },
      // Residual carrier partition: keep the historical null extern fallback.
      { op: "ref.null.extern" },
    ];
    const peelIdx = addHelper("__carrier_recv_to_extern", [anyRefNull], [externref], peelBody, [
      { name: "tag", type: i32 },
    ]);
    if (peelIdx === undefined) {
      ctx.dynMemberGetHelpersEmitted = false;
      ctx.usesDynMemberGet = false;
      return;
    }

    // __dyn_member_get(recv, key) -> (ref null $AnyValue): the self-contained
    // round-trip. The result of `__any_from_extern_honest` is a (ref $AnyValue),
    // a subtype of the (ref null $AnyValue) result, so it flows unchanged.
    const dmgBody: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: peelIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: anyToExternIdx },
      { op: "call", funcIdx: externGetIdx },
      { op: "call", funcIdx: honestIdx },
    ];
    const dmgIdx = addHelper("__dyn_member_get", [anyRefNull, anyRefNull], [anyRefNull], dmgBody);
    if (dmgIdx === undefined) {
      ctx.dynMemberGetHelpersEmitted = false;
      ctx.usesDynMemberGet = false;
      return;
    }

    if (forceSelfTest) {
      emitDynMemberGetSelfTestStandalone(ctx, {
        anyIdx,
        dmgIdx,
        honestIdx,
        boxNumberIdx,
        boxBooleanIdx,
      });
    }
    return;
  }

  // ── host carrier = externref ────────────────────────────────────────────
  // Use the same receiver-peel seam as the fast carrier. Here it is an identity
  // after the null/undefined guard, with the sentinel-aware host predicate
  // covering JS `undefined` (a non-null externref).
  if (externIsUndefinedIdx === undefined) {
    ctx.dynMemberGetHelpersEmitted = false;
    ctx.usesDynMemberGet = false;
    return;
  }
  const peelHostIdx = addHelper(
    "__carrier_recv_to_extern",
    [externref],
    [externref],
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: externIsUndefinedIdx },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: objectCoercibleThrow(),
      },
      { op: "local.get", index: 0 },
    ],
  );
  if (peelHostIdx === undefined) {
    ctx.dynMemberGetHelpersEmitted = false;
    ctx.usesDynMemberGet = false;
    return;
  }
  const dmgHostBody: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: peelHostIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: externGetIdx },
  ];
  const dmgHostIdx = addHelper("__dyn_member_get", [externref, externref], [externref], dmgHostBody);
  if (dmgHostIdx === undefined) {
    ctx.dynMemberGetHelpersEmitted = false;
    ctx.usesDynMemberGet = false;
    return;
  }
  if (forceSelfTest) emitDynMemberGetSelfTestHost(ctx, dmgHostIdx);
}

/**
 * #3795 — register the strict write dual
 * `__dyn_member_set(recv,key,value) -> ()`.
 *
 * The helper consumes the same carrier chosen by `resolveDynamic()`. Fast/GC
 * mode reuses `__carrier_recv_to_extern` for the receiver, the canonical
 * `__any_to_extern` key conversion, and an identity-preserving value peel
 * which unwraps tag-5 strings and tag-6 objects while leaving
 * null/undefined/scalars to the established conversion helper. Host mode is a
 * thin externref wrapper.
 */
export function ensureDynMemberSet(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__dyn_member_set")) return;

  const externref: ValType = { kind: "externref" };
  const nativeStrictSet = ctx.standalone || ctx.wasi;
  const externSetIdx = ctx.funcMap.get(nativeStrictSet ? "__reflect_set" : "__extern_set_strict");
  if (externSetIdx === undefined) return;
  // Standalone receiver dispatch contains early-return arms before the
  // string-keyed object table.  Canonicalize the key at the dynamic Reference
  // boundary so IR dyn.member_set and legacy computed stores agree.  Host
  // setters already perform ToPropertyKey themselves.
  const toPropertyKeyIdx = nativeStrictSet ? ctx.funcMap.get("__to_property_key") : undefined;
  const canonicalizeKey = (): Instr[] =>
    toPropertyKeyIdx === undefined ? [] : [{ op: "call", funcIdx: toPropertyKeyIdx }];
  const strictSetFailure = (): Instr[] =>
    buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot assign to read only property", {
      forceInModuleCtor: true,
    });
  const finishStrictSet = (): Instr[] =>
    nativeStrictSet
      ? [
          { op: "call", funcIdx: externSetIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: strictSetFailure() },
        ]
      : [{ op: "call", funcIdx: externSetIdx }];

  const addHelper = (name: string, params: ValType[], results: ValType[], body: Instr[]): number | undefined => {
    const existing = ctx.funcMap.get(name);
    if (existing !== undefined) return existing;
    const typeIdx = addFuncType(ctx, params, results, name);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: [], body, exported: false } as never);
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  };

  if (ctx.fast) {
    // The read substrate owns the receiver peel. A dynamic write necessarily
    // uses the same object runtime, so registering the read helper here is a
    // small, safe dependency and keeps a single receiver-carrier policy.
    ctx.usesDynMemberGet = true;
    ensureDynMemberGet(ctx);
    const anyIdx = ctx.anyValueTypeIdx;
    const peelIdx = ctx.funcMap.get("__carrier_recv_to_extern");
    const anyToExternIdx = ensureAnyToExternHelper(ctx);
    if (anyIdx < 0 || peelIdx === undefined || anyToExternIdx === undefined) return;
    const anyRefNull: ValType = { kind: "ref_null", typeIdx: anyIdx };

    // Preserve ordinary JS storage when a dynamic string/object is assigned.
    // `__any_to_extern` intentionally keeps tags 5/6 wrapped for generic any
    // round trips; [[Set]] needs their raw payloads so the property contains
    // the string/object value rather than the internal carrier. Other
    // partitions retain the canonical null/undefined/number/boolean
    // conversion.
    const valueToExternBody: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_TAG },
      { op: "i32.const", value: TAG_STRING },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_EXT },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_TAG },
      { op: "i32.const", value: TAG_REF },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_REF },
          { op: "extern.convert_any" },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: anyToExternIdx },
    ];
    const valueToExternIdx = addHelper("__carrier_value_to_extern", [anyRefNull], [externref], valueToExternBody);
    if (valueToExternIdx === undefined) return;
    const dmsIdx = addHelper(
      "__dyn_member_set",
      [anyRefNull, anyRefNull, anyRefNull],
      [],
      [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: peelIdx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: anyToExternIdx },
        ...canonicalizeKey(),
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: valueToExternIdx },
        ...finishStrictSet(),
      ],
    );
    if (dmsIdx !== undefined && process.env.JS2WASM_FORCE_DYN_MEMBER_SET === "1") {
      emitDynMemberSetNullishSelfTest(ctx);
      emitDynMemberSetPrivateNameSelfTest(ctx);
    }
    return;
  }

  // Host writes share the same sentinel-aware RequireObjectCoercible seam as
  // reads. A set-only module still registers the read substrate so the receiver
  // policy cannot diverge between the two operations.
  ctx.usesDynMemberGet = true;
  ensureDynMemberGet(ctx);
  const peelHostIdx = ctx.funcMap.get("__carrier_recv_to_extern");
  if (peelHostIdx === undefined) return;
  const dmsIdx = addHelper(
    "__dyn_member_set",
    [externref, externref, externref],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: peelHostIdx },
      { op: "local.get", index: 1 },
      ...canonicalizeKey(),
      { op: "local.get", index: 2 },
      ...finishStrictSet(),
    ],
  );
  if (dmsIdx !== undefined && process.env.JS2WASM_FORCE_DYN_MEMBER_SET === "1") {
    emitDynMemberSetNullishSelfTest(ctx);
    emitDynMemberSetPrivateNameSelfTest(ctx);
  }
}

/**
 * (#3053 U0) Register an EXPORTED self-test driver (FORCE mode only). Uses a
 * stable handle so a dead-elim import shift can't desync the exported index.
 */
function addDriverExport(
  ctx: CodegenContext,
  name: string,
  results: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
): void {
  if (ctx.funcMap.has(name)) return;
  const typeIdx = addFuncType(ctx, [], results, name);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: true } as never);
  ctx.funcMap.set(name, funcIdx);
  ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
}

/** FORCE-only, zero-argument RequireObjectCoercible probes for Get and Set. */
function emitDynMemberSetNullishSelfTest(ctx: CodegenContext): void {
  const getIdx = ctx.funcMap.get("__dyn_member_get");
  const setIdx = ctx.funcMap.get("__dyn_member_set");
  if (
    getIdx === undefined ||
    setIdx === undefined ||
    !ctx.stringGlobalMap.has("x") ||
    !ctx.stringGlobalMap.has("true")
  ) {
    return;
  }
  const key = (value: string): Instr[] => stringConstantExternrefInstrs(ctx, value);
  const call = (funcIdx: number): Instr => ({ op: "call", funcIdx });

  if (ctx.fast) {
    const honestIdx = ctx.funcMap.get("__any_from_extern_honest");
    if (honestIdx === undefined || !undefinedSingletonActive(ctx)) return;
    const carrier = (jsType: "null" | "undefined"): Instr[] | undefined => {
      const body: Instr[] = [{ op: "ref.null.extern" }];
      const emitted = boxToAny(ctx, { body } as FunctionContext, { kind: "externref" }, jsType);
      return emitted ? body : undefined;
    };
    const nullCarrier = carrier("null");
    const undefinedCarrier = carrier("undefined");
    if (nullCarrier === undefined || undefinedCarrier === undefined) return;
    const keyCarrier = (value: string): Instr[] => [...key(value), call(honestIdx)];
    const getBody = (recv: Instr[]): Instr[] => [...recv, ...keyCarrier("x"), call(getIdx), { op: "drop" }];
    const setBody = (recv: Instr[]): Instr[] => [...recv, ...keyCarrier("x"), ...keyCarrier("true"), call(setIdx)];
    addDriverExport(ctx, "__dms_null_get", [], [], getBody(nullCarrier));
    addDriverExport(ctx, "__dms_undefined_get", [], [], getBody(undefinedCarrier));
    addDriverExport(ctx, "__dms_null_set", [], [], setBody(nullCarrier));
    addDriverExport(ctx, "__dms_undefined_set", [], [], setBody(undefinedCarrier));
    return;
  }

  const nullCarrier = (): Instr[] => [{ op: "ref.null.extern" }];
  const undefinedCarrier = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const getBody = (recv: Instr[]): Instr[] => [...recv, ...key("x"), call(getIdx), { op: "drop" }];
  const setBody = (recv: Instr[]): Instr[] => [...recv, ...key("x"), ...key("true"), call(setIdx)];
  addDriverExport(ctx, "__dms_null_get", [], [], getBody(nullCarrier()));
  addDriverExport(ctx, "__dms_undefined_get", [], [], getBody(undefinedCarrier()));
  addDriverExport(ctx, "__dms_null_set", [], [], setBody(nullCarrier()));
  addDriverExport(ctx, "__dms_undefined_set", [], [], setBody(undefinedCarrier()));
}

/**
 * #3795 — FORCE-only zero-argument proof for Acorn's exact
 * `isPrivateNameConflicted` body. The driver builds every receiver and element
 * with the module's own object runtime, calls the compiled source function, and
 * returns a 16-bit checksum. No JS object crosses the export boundary.
 *
 * This is deliberately keyed by source-function name and therefore lives only
 * behind `JS2WASM_FORCE_DYN_MEMBER_SET=1`; production modules never emit it.
 */
function emitDynMemberSetPrivateNameSelfTest(ctx: CodegenContext): void {
  // The exact standalone/gc Acorn lane uses the externref dynamic carrier.
  // Fast-carrier helper coverage remains owned by the generic #3053 drivers.
  if (ctx.fast) return;

  const conflictIdx = ctx.funcMap.get("isPrivateNameConflicted");
  const createIdx = ctx.funcMap.get("__object_create");
  const newObjIdx = ctx.funcMap.get("__new_plain_object");
  const setIdx = ctx.funcMap.get("__extern_set_strict");
  const getIdx = ctx.funcMap.get("__extern_get");
  const freezeIdx = ctx.funcMap.get("__object_freeze");
  const hasOwnIdx = ctx.funcMap.get("__object_hasOwn") ?? ctx.funcMap.get("__hasOwnProperty");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  const requiredStrings = [
    "name",
    "key",
    "type",
    "kind",
    "static",
    "get",
    "set",
    "field",
    "MethodDefinition",
    "PropertyDefinition",
    "x",
    "__proto__",
    "iget",
    "sset",
    "true",
  ];
  if (
    conflictIdx === undefined ||
    createIdx === undefined ||
    newObjIdx === undefined ||
    setIdx === undefined ||
    getIdx === undefined ||
    freezeIdx === undefined ||
    hasOwnIdx === undefined ||
    boxBooleanIdx === undefined ||
    requiredStrings.some((value) => !ctx.stringGlobalMap.has(value))
  ) {
    return;
  }

  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const key = (value: string): Instr[] => stringConstantExternrefInstrs(ctx, value);
  const call = (funcIdx: number): Instr => ({ op: "call", funcIdx });
  const addHelper = (
    name: string,
    params: ValType[],
    results: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ): number => {
    const existing = ctx.funcMap.get(name);
    if (existing !== undefined) return existing;
    const typeIdx = addFuncType(ctx, params, results, name);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false } as never);
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  };

  // (kind, type, static, name) -> element
  const elementIdx = addHelper(
    "__dms_test_element",
    [externref, externref, externref, externref],
    [externref],
    [
      { name: "keyObj", type: externref },
      { name: "element", type: externref },
    ],
    [
      call(newObjIdx),
      { op: "local.set", index: 4 },
      { op: "local.get", index: 4 },
      ...key("name"),
      { op: "local.get", index: 3 },
      call(setIdx),
      call(newObjIdx),
      { op: "local.set", index: 5 },
      { op: "local.get", index: 5 },
      ...key("key"),
      { op: "local.get", index: 4 },
      call(setIdx),
      { op: "local.get", index: 5 },
      ...key("type"),
      { op: "local.get", index: 1 },
      call(setIdx),
      { op: "local.get", index: 5 },
      ...key("kind"),
      { op: "local.get", index: 0 },
      call(setIdx),
      { op: "local.get", index: 5 },
      ...key("static"),
      { op: "local.get", index: 2 },
      call(setIdx),
      { op: "local.get", index: 5 },
    ],
  );

  const newNullProto = (): Instr[] => [{ op: "ref.null.extern" }, call(createIdx)];
  const bool = (value: boolean): Instr[] => [{ op: "i32.const", value: value ? 1 : 0 }, call(boxBooleanIdx)];
  const element = (kind: string, isStatic: boolean, name = "x"): Instr[] => [
    ...key(kind),
    ...key(kind === "field" ? "PropertyDefinition" : "MethodDefinition"),
    ...bool(isStatic),
    ...key(name),
    call(elementIdx),
  ];
  const conflict = (mapLocal: number, kind: string, isStatic: boolean, name = "x"): Instr[] => [
    { op: "local.get", index: mapLocal },
    ...element(kind, isStatic, name),
    call(conflictIdx),
  ];
  const addBit = (condition: Instr[]): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    ...condition,
    { op: "i32.add" },
    { op: "local.set", index: 1 },
  ];
  const expectFalse = (mapLocal: number, kind: string, isStatic: boolean, name = "x"): Instr[] =>
    addBit([...conflict(mapLocal, kind, isStatic, name), { op: "i32.eqz" }]);
  const expectTrue = (mapLocal: number, kind: string, isStatic: boolean, name = "x"): Instr[] =>
    addBit(conflict(mapLocal, kind, isStatic, name));
  const expectStored = (mapLocal: number, name: string, value: string): Instr[] =>
    addBit([
      ...newNullProto(),
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      ...key(value),
      ...bool(true),
      call(setIdx),
      { op: "local.get", index: 2 },
      { op: "local.get", index: mapLocal },
      ...key(name),
      call(getIdx),
      call(hasOwnIdx),
    ]);

  addDriverExport(
    ctx,
    "__dms_private_name_checksum",
    [i32],
    [
      { name: "map", type: externref },
      { name: "checksum", type: i32 },
      { name: "expectedValues", type: externref },
    ],
    [
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 1 },

      // Instance getter/setter transition and duplicate after the "true" marker.
      ...newNullProto(),
      { op: "local.set", index: 0 },
      ...expectFalse(0, "get", false),
      ...expectStored(0, "x", "iget"),
      ...expectFalse(0, "set", false),
      ...expectStored(0, "x", "true"),
      ...expectTrue(0, "get", false),

      // Static setter/getter transition.
      ...newNullProto(),
      { op: "local.set", index: 0 },
      ...expectFalse(0, "set", true),
      ...expectStored(0, "x", "sset"),
      ...expectFalse(0, "get", true),
      ...expectStored(0, "x", "true"),

      // Mixed instance/static does not form an accessor pair.
      ...newNullProto(),
      { op: "local.set", index: 0 },
      ...expectFalse(0, "get", false),
      ...expectTrue(0, "set", true),

      // Duplicate field declarations conflict.
      ...newNullProto(),
      { op: "local.set", index: 0 },
      ...expectFalse(0, "field", false),
      ...expectTrue(0, "field", false),

      // Object.create(null): "__proto__" is an own data key, not prototype magic.
      ...newNullProto(),
      { op: "local.set", index: 0 },
      ...expectFalse(0, "field", false, "__proto__"),
      ...addBit([{ op: "local.get", index: 0 }, ...key("__proto__"), call(hasOwnIdx)]),
      ...expectStored(0, "__proto__", "true"),
      { op: "local.get", index: 1 },
    ],
  );

  addDriverExport(
    ctx,
    "__dms_private_name_strict_failure",
    [],
    [{ name: "map", type: externref }],
    [...newNullProto(), call(freezeIdx), { op: "local.set", index: 0 }, ...conflict(0, "field", false), { op: "drop" }],
  );
}

/**
 * (#3053 U0) Standalone/gc self-test drivers. Each builds a receiver with the
 * object runtime, boxes it to a tag-6 carrier via the honest classifier, calls
 * `__dyn_member_get`, and returns an i32 verdict the unit test asserts. The keys
 * ("a"/"b"/"s"/"n"/"bo"/"z") and value "ab" MUST already be pooled by the test
 * source (dynamic reads pool them) so `stringConstantExternrefInstrs` never adds
 * an import at finalize.
 */
function emitDynMemberGetSelfTestStandalone(
  ctx: CodegenContext,
  ids: { anyIdx: number; dmgIdx: number; honestIdx: number; boxNumberIdx: number; boxBooleanIdx: number },
): void {
  const { anyIdx, dmgIdx, honestIdx, boxNumberIdx, boxBooleanIdx } = ids;
  const i32: ValType = { kind: "i32" };
  const externref: ValType = { kind: "externref" };
  const anyRefNull: ValType = { kind: "ref_null", typeIdx: anyIdx };
  const EQ_HEAP_TYPE = -19; // WasmGC `eq` abstract heap type
  const newObjIdx = ctx.funcMap.get("__new_plain_object");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  if (
    newObjIdx === undefined ||
    externSetIdx === undefined ||
    !ctx.stringGlobalMap.has("a") ||
    !ctx.stringGlobalMap.has("b") ||
    !ctx.stringGlobalMap.has("s") ||
    !ctx.stringGlobalMap.has("n") ||
    !ctx.stringGlobalMap.has("bo") ||
    !ctx.stringGlobalMap.has("z") ||
    !ctx.stringGlobalMap.has("ab")
  ) {
    return; // dependency missing → skip drivers (self-test will surface it)
  }
  const key = (s: string): Instr[] => stringConstantExternrefInstrs(ctx, s);
  const newObj = (): Instr[] => [{ op: "call", funcIdx: newObjIdx }];
  const call = (fn: number): Instr => ({ op: "call", funcIdx: fn });
  const box = (carrier: number): Instr => call(carrier); // honest classifier / box helper
  // carrierOf(objLocal): honest($AnyValue tag-6) of the object externref in a local
  const carrierOf = (objLocal: number): Instr[] => [{ op: "local.get", index: objLocal }, call(honestIdx)];
  const keyCarrier = (s: string): Instr[] => [...key(s), call(honestIdx)];
  const readTag = (): Instr[] => [{ op: "ref.as_non_null" }, { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_TAG }];
  // `read(k)` leaves the (ref null $AnyValue) carrier of o[k] on the stack.
  const read = (k: string): Instr[] => [...carrierOf(0), ...keyCarrier(k), call(dmgIdx)];
  // Field extractors that turn the carrier on the stack into an `eq`/`f64` value
  // for a DIRECT `ref.eq` / `f64.eq` — no engine coercion helper (#2108 gate):
  //   tag-6 object → refval (field 3, already eqref);
  //   tag-5 string → externval (field 4) → any.convert_extern → cast eq (native
  //     strings are `(array i16)`, an eq subtype; two reads of one stored value
  //     yield the SAME ref → ref.eq → 1);
  //   tag-3 number → f64val (field 2) → f64.eq.
  const refvalEq: Instr[] = [{ op: "ref.as_non_null" }, { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_REF }];
  const externvalEq: Instr[] = [
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_EXT },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
  ];
  const f64val: Instr[] = [{ op: "ref.as_non_null" }, { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_F64 }];

  // Driver 1 — object read → tag 6.
  addDriverExport(
    ctx,
    "__dmg_st_object_tag",
    [i32],
    [
      { name: "o", type: externref },
      { name: "inner", type: externref },
    ],
    [
      ...newObj(),
      { op: "local.set", index: 1 }, // inner
      ...newObj(),
      { op: "local.set", index: 0 }, // o
      { op: "local.get", index: 0 },
      ...key("a"),
      { op: "local.get", index: 1 },
      call(externSetIdx),
      ...carrierOf(0),
      ...keyCarrier("a"),
      call(dmgIdx),
      ...readTag(),
    ],
  );

  // Driver 2 — aliased object reads ARE === (identity via tag-6 refval ref.eq).
  const aliasedIdentity = (k1: string, k2: string, distinct: boolean): Instr[] => [
    ...newObj(),
    { op: "local.set", index: 1 }, // inner
    ...((distinct ? [...newObj(), { op: "local.set", index: 2 }] : []) satisfies Instr[]), // inner2 (distinct only)
    ...newObj(),
    { op: "local.set", index: 0 }, // o
    { op: "local.get", index: 0 },
    ...key(k1),
    { op: "local.get", index: 1 },
    call(externSetIdx),
    { op: "local.get", index: 0 },
    ...key(k2),
    { op: "local.get", index: distinct ? 2 : 1 },
    call(externSetIdx),
    ...read(k1),
    ...refvalEq,
    ...read(k2),
    ...refvalEq,
    { op: "ref.eq" },
  ];
  addDriverExport(
    ctx,
    "__dmg_st_object_identity",
    [i32],
    [
      { name: "o", type: externref },
      { name: "inner", type: externref },
      { name: "inner2", type: externref },
    ],
    aliasedIdentity("a", "b", false),
  );
  // Driver 3 — distinct objects are NOT === (anti-vacuity → 0).
  addDriverExport(
    ctx,
    "__dmg_st_object_distinct",
    [i32],
    [
      { name: "o", type: externref },
      { name: "inner", type: externref },
      { name: "inner2", type: externref },
    ],
    aliasedIdentity("a", "b", true),
  );

  // Driver 4/5 — string read → tag 5, content-=== → 1.
  const buildStringObj: Instr[] = [
    ...newObj(),
    { op: "local.set", index: 0 },
    { op: "local.get", index: 0 },
    ...key("s"),
    ...key("ab"),
    call(externSetIdx),
  ];
  addDriverExport(
    ctx,
    "__dmg_st_string_tag",
    [i32],
    [{ name: "o", type: externref }],
    [...buildStringObj, ...carrierOf(0), ...keyCarrier("s"), call(dmgIdx), ...readTag()],
  );
  addDriverExport(
    ctx,
    "__dmg_st_string_value",
    [i32],
    [{ name: "o", type: externref }],
    [...buildStringObj, ...read("s"), ...externvalEq, ...read("s"), ...externvalEq, { op: "ref.eq" }],
  );

  // Driver 6/7 — number read → tag 3, value-=== → 1.
  const buildNumberObj: Instr[] = [
    ...newObj(),
    { op: "local.set", index: 0 },
    { op: "local.get", index: 0 },
    ...key("n"),
    { op: "f64.const", value: 42 },
    box(boxNumberIdx),
    call(externSetIdx),
  ];
  addDriverExport(
    ctx,
    "__dmg_st_number_tag",
    [i32],
    [{ name: "o", type: externref }],
    [...buildNumberObj, ...carrierOf(0), ...keyCarrier("n"), call(dmgIdx), ...readTag()],
  );
  addDriverExport(
    ctx,
    "__dmg_st_number_value",
    [i32],
    [{ name: "o", type: externref }],
    [...buildNumberObj, ...read("n"), ...f64val, ...read("n"), ...f64val, { op: "f64.eq" }],
  );

  // Driver 8 — boolean read → tag 4.
  addDriverExport(
    ctx,
    "__dmg_st_boolean_tag",
    [i32],
    [{ name: "o", type: externref }],
    [
      ...newObj(),
      { op: "local.set", index: 0 },
      { op: "local.get", index: 0 },
      ...key("bo"),
      { op: "i32.const", value: 1 },
      box(boxBooleanIdx),
      call(externSetIdx),
      ...carrierOf(0),
      ...keyCarrier("bo"),
      call(dmgIdx),
      ...readTag(),
    ],
  );

  // Driver 9 — RE-READ composition `dmg(dmg(o,"a"),"z")`. Proves the internal
  // peel round-trips (the CS1a `__any_to_extern` breaker is NOT re-triggered):
  // inner.z = 7, o.a = inner; reading o.a yields a tag-6 carrier for inner, then
  // reading .z off THAT carrier yields tag-3 value 7. Returns tag*1000 + value.
  addDriverExport(
    ctx,
    "__dmg_st_reread",
    [i32],
    [
      { name: "o", type: externref },
      { name: "inner", type: externref },
      { name: "r", type: anyRefNull },
    ],
    [
      ...newObj(),
      { op: "local.set", index: 1 }, // inner
      { op: "local.get", index: 1 },
      ...key("z"),
      { op: "f64.const", value: 7 },
      box(boxNumberIdx),
      call(externSetIdx),
      ...newObj(),
      { op: "local.set", index: 0 }, // o
      { op: "local.get", index: 0 },
      ...key("a"),
      { op: "local.get", index: 1 },
      call(externSetIdx),
      // r = dmg(dmg(carrier(o), "a"), "z")
      ...carrierOf(0),
      ...keyCarrier("a"),
      call(dmgIdx),
      ...keyCarrier("z"),
      call(dmgIdx),
      { op: "local.set", index: 2 },
      // tag*1000
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_TAG },
      { op: "i32.const", value: 1000 },
      { op: "i32.mul" },
      // + trunc(f64val)
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: anyIdx, fieldIdx: AV_F64 },
      { op: "i32.trunc_f64_s" },
      { op: "i32.add" },
    ],
  );
}

/**
 * (#3053 U0) Host (gc) self-test drivers. In host mode the carrier IS externref
 * and `__dyn_member_get` is a thin `__extern_get` wrapper; objects from the host
 * `__new_plain_object` are plain JS objects (writes via `__extern_set_strict`).
 * The host object model is JS-side and box/marshal semantics are opaque, so the
 * driver returns a marshalling-independent i32: it exercises the host wrapper
 * end-to-end (build object → set → `__dyn_member_get`) and reports that a
 * present-key read produced a NON-NULL externref (`ref.is_null` works on a raw
 * externref, no engine coercion helper — keeps the #2108 coercion gate at 0).
 * The deep host read semantics are `__extern_get`'s, tested elsewhere; here we
 * prove the U0 wrapper is emitted, valid Wasm, and executes without trapping.
 * Key "n" pooled by the test source.
 */
function emitDynMemberGetSelfTestHost(ctx: CodegenContext, dmgIdx: number): void {
  const i32: ValType = { kind: "i32" };
  const externref: ValType = { kind: "externref" };
  const newObjIdx = ctx.funcMap.get("__new_plain_object");
  const externSetIdx = ctx.funcMap.get("__extern_set_strict");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  if (
    newObjIdx === undefined ||
    externSetIdx === undefined ||
    boxNumberIdx === undefined ||
    !ctx.stringGlobalMap.has("n")
  ) {
    return;
  }
  const key = (s: string): Instr[] => stringConstantExternrefInstrs(ctx, s);
  const call = (fn: number): Instr => ({ op: "call", funcIdx: fn });

  // Present-key read via the host wrapper is a non-null externref → 1.
  addDriverExport(
    ctx,
    "__dmg_gc_present",
    [i32],
    [{ name: "o", type: externref }],
    [
      { op: "call", funcIdx: newObjIdx },
      { op: "local.set", index: 0 },
      { op: "local.get", index: 0 },
      ...key("n"),
      { op: "f64.const", value: 7 },
      call(boxNumberIdx),
      call(externSetIdx),
      { op: "local.get", index: 0 },
      ...key("n"),
      call(dmgIdx),
      { op: "ref.is_null" },
      { op: "i32.eqz" }, // 1 iff the read produced a non-null result
    ],
  );
}

/**
 * (#2984) True when a property-access site's TS type is boolean-like:
 * `boolean`, a boolean literal, or a union of boolean literals with only
 * `undefined`/`void`/`null` alongside (the ubiquitous lib shape
 * `PropertyDescriptor.writable?: boolean` resolves to `boolean | undefined`,
 * whose UNION type object carries no `BooleanLike` flag of its own — the
 * members must be walked).
 *
 * Why it matters: a boolean-typed property read that resolves through the
 * DYNAMIC fallback (`__extern_get` host-MOP read / member-get dispatcher /
 * sidecar read) must NOT narrow to i32 via `__unbox_number` +
 * `i32.trunc_sat_f64_s`. That pipeline is a ToNumber, not a boolean read: the
 * standalone native `__unbox_number` yields NaN for a boxed boolean, so
 * `Object.getOwnPropertyDescriptor(o, k).writable` came back as i32 0, and an
 * any-context consumer (a test262-harness `assert.sameValue(desc.writable,
 * true)` argument) then RE-boxed that 0 as a NUMBER — failing strict equality
 * for every descriptor-attribute assertion in the standalone gOPD cluster
 * (host only "passed" the harness shape by the ToNumber(true)=1 coincidence).
 * Keeping the raw externref preserves BOTH the boolean box (value-correct
 * native `===`) and `undefined` for an absent attribute (i32 narrowing erased
 * it to `false`). Consumed by `compilePropertyAccess`'s dynamic-fallback
 * region (property-access.ts).
 */
export function isBooleanLikeAccessType(t: ts.Type): boolean {
  if ((t.flags & ts.TypeFlags.BooleanLike) !== 0) return true;
  if ((t.flags & ts.TypeFlags.Union) !== 0) {
    let sawBool = false;
    for (const m of (t as ts.UnionType).types) {
      if ((m.flags & ts.TypeFlags.BooleanLike) !== 0) {
        sawBool = true;
        continue;
      }
      if ((m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) !== 0) continue;
      return false;
    }
    return sawBool;
  }
  return false;
}

/**
 * (#2984) The dynamic-fallback access-type widening consumed by
 * `compilePropertyAccess` (property-access.ts): a boolean-like access type
 * whose resolved Wasm type is i32 keeps the raw externref instead (see the
 * rationale on `isBooleanLikeAccessType` above). Numeric narrowings and every
 * non-boolean i32 (native `type i32 = number` annotations) pass through
 * unchanged, so modules without boolean-typed dynamic-fallback reads are
 * byte-identical.
 */
export function widenBooleanDynamicAccess(t: ts.Type, wasm: ValType): ValType {
  return wasm.kind === "i32" && isBooleanLikeAccessType(t) ? { kind: "externref" } : wasm;
}

/**
 * (#2984) `Object.getOwnPropertyDescriptor(this, "NaN"|"Infinity"|"undefined")`
 * — the sloppy-mode global-`this` receiver. The compiler models an unbound
 * top-level `this` as `undefined`, so the dynamic gOPD saw
 * `gOPD(undefined, key)` → no descriptor; the test262
 * `built-ins/{NaN,Infinity,undefined}` + gOPD 15.2.3.3-4-178..180 attribute
 * asserts only "passed" through the pre-#2984 undefined→ToNumber(NaN)→i32
 * 0 === false coincidence that the boolean-read fix retired. This emits a
 * RUNTIME-guarded fold: a nullish receiver (the unbound global `this` — null
 * extern on standalone, the non-null host `undefined` sentinel via
 * `__extern_is_undefined` on the host lane) yields the spec §19.1.1–19.1.3
 * value-property data descriptor `{ value, writable:false, enumerable:false,
 * configurable:false }`; a REAL receiver (a host-dispatched body invoked with
 * one) keeps the dynamic `__getOwnPropertyDescriptor` read, so an own "NaN"
 * prop still wins. Only these three immutable global value props are folded —
 * their descriptors are spec constants.
 *
 * Contract: the CALLER has already pushed the receiver as externref (this
 * ordering is load-bearing — the receiver's own lowering may register late
 * imports, e.g. `__get_undefined`, so every funcIdx here is captured AFTER
 * it and flushed before use). Always consumes the receiver and leaves exactly
 * one externref on the stack.
 */
export function emitGlobalThisGopdFold(ctx: CodegenContext, fctx: FunctionContext, key: string): void {
  const recvTmp = allocLocal(fctx, `__gopd_this_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvTmp });
  const boxIdx =
    key === "undefined" ? undefined : ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  const createIdx = ensureLateImport(
    ctx,
    "__create_descriptor",
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "externref" }],
  );
  const dynGopdIdx = ensureLateImport(
    ctx,
    "__getOwnPropertyDescriptor",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  const isUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  const getUndefIdx = key === "undefined" ? ensureGetUndefined(ctx) : undefined;
  addStringConstantGlobal(ctx, key);
  flushLateImportShifts(ctx, fctx);
  if (createIdx === undefined || dynGopdIdx === undefined || isUndefIdx === undefined) {
    // Degenerate (imports unregisterable): preserve the one-externref contract.
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // nullish? (ref.is_null catches the standalone null-extern regime; the host
  // `undefined` sentinel is a NON-null externref → __extern_is_undefined.)
  fctx.body.push({ op: "local.get", index: recvTmp });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "local.get", index: recvTmp });
  fctx.body.push({ op: "call", funcIdx: isUndefIdx });
  fctx.body.push({ op: "i32.or" });
  const thenInstrs: Instr[] = [];
  if (key === "undefined") {
    // Regime-aware `undefined` (host sentinel / standalone singleton / null
    // extern) — its import was pre-ensured above (getUndefIdx), so this
    // detached-array emission cannot add a late import mid-build.
    void getUndefIdx;
    const savedBody = fctx.body;
    fctx.body = thenInstrs;
    emitUndefined(ctx, fctx);
    fctx.body = savedBody;
  } else {
    thenInstrs.push({ op: "f64.const", value: key === "NaN" ? Number.NaN : Number.POSITIVE_INFINITY });
    if (boxIdx !== undefined) thenInstrs.push({ op: "call", funcIdx: boxIdx });
    else thenInstrs.push({ op: "drop" }, { op: "ref.null.extern" });
  }
  thenInstrs.push({ op: "i32.const", value: 0 }); // writable/enumerable/configurable: false (§19.1)
  thenInstrs.push({ op: "call", funcIdx: createIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: thenInstrs,
    else: [
      { op: "local.get", index: recvTmp },
      ...stringConstantExternrefInstrs(ctx, key),
      { op: "call", funcIdx: dynGopdIdx },
    ],
  });
}
