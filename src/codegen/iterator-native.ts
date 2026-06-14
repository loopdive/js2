// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1320 Slice 1 — standalone (no-JS-host) iteration protocol bridge.
 *
 * In JS-host mode the iteration protocol is delivered by four `env::__iterator*`
 * host imports (see `addIteratorImports` in index.ts). Under `--target wasi` /
 * standalone there is no JS host, so this module registers the SAME four
 * funcMap names (`__iterator`, `__iterator_next`, `__iterator_return`,
 * `__iterator_rest`) as **emitted Wasm functions**. Because the consumer code
 * (for-of loop, spread, array-dstr) looks the operations up by name, it binds
 * to these native fns transparently — no consumer changes.
 *
 * **Canonical representation (Slice 1).** Rather than a generic GetIterator over
 * every compiled iterable shape (generators, Map/Set, class iterables — those
 * are later slices), Slice 1 standardizes on a single **canonical externref
 * `$Vec`** as the iterator backing store. The *caller* (e.g.
 * `compileArrayIteratorMethod`, which runs during expression codegen and has an
 * `fctx`) boxes each element to externref on-build and hands the native runtime
 * an externref vec. That keeps the fctx-less native bodies trivial: no
 * per-elemKind `ref.test`/box switch and no `coerceType` (which needs an fctx).
 *
 * **(#2038) USER `{next()}`-protocol carrier.** Beyond the canonical vec, the
 * native runtime now also drives a custom iterable
 * `{ [Symbol.iterator]() { return { next() {…} } } }`. Such an object compiles to
 * a *closed nominal WasmGC struct* (a named funcref field per method), NOT the
 * open `$Object` hash-map — so the generic `__extern_method_call` / `__extern_get`
 * helpers (which gate on `ref.test $Object`) return null for it, which previously
 * made `__iterator_next` spin forever (PATH A blocker, #25). Instead the USER arm
 * dispatches through the closed-struct **type-switch** helpers that the finalize
 * pass emits over every registered struct: `__call_@@iterator` / `__call_next`
 * (`emitIteratorMethodExport`) and `__sget_value` / `__sget_done`
 * (`emitStructFieldGetters`). Those are only known at finalize, so the carrier
 * bodies are emitted vec-only eagerly and *rebuilt with the USER arm* by
 * `fillNativeIteratorUserArms` after the dispatchers exist — the reserve-then-fill
 * funcIdx-authority discipline of #1719 (`fillProtoIteratorDriver`).
 *
 * The native iterator-record:
 *   (struct $__IterRec (field $kind i32)                  ;; VEC=3 / USER=1
 *                       (field $vec  (ref null $vecExtern));; canonical externref vec
 *                       (field $idx  (mut i32))            ;; cursor
 *                       (field $userIter (mut externref))) ;; USER iterator object
 *
 * Spec: ECMA-262 §7.4 (GetIterator / IteratorStep / IteratorValue /
 * IteratorClose). See plan/issues/2038-standalone-iterator-next-illegal-cast-async-dstr.md.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { addFuncType } from "./registry/types.js";

/** Slice-1 IterRec kind tag for a canonical externref `$Vec`. */
const ITER_KIND_VEC = 3;

/**
 * (#2038) IterRec kind tag for a USER iterator: a general `{next()}`-protocol
 * object obtained from a custom iterable's `[Symbol.iterator]()`. The `vec`
 * field is null; the iterator object is held in `userIter` (field 3, externref)
 * and each `__iterator_next` step calls `userIter.next()` through the
 * closed-struct dispatcher `__call_next` and reads `.value`/`.done` via
 * `__sget_value` / `__sget_done`. Covers BOTH sync `for-of` and (sync-backed)
 * async `for await` over a user iterable, which previously trapped/hung in the
 * vec-only native runtime.
 */
const ITER_KIND_USER = 1;

/**
 * Resolved funcIdx of the closed-struct dispatchers the USER arm calls. All four
 * are emitted at FINALIZE; `fillNativeIteratorUserArms` looks them up then.
 */
interface UserCarrierDeps {
  /** `__call_@@iterator(externref) -> externref` (emitIteratorMethodExport). */
  callIteratorIdx: number;
  /** `__call_next(externref) -> externref` (emitIteratorMethodExport). */
  callNextIdx: number;
  /** `__sget_value(externref) -> externref` (emitStructFieldGetters). */
  sgetValueIdx: number;
  /** `__sget_done(externref) -> externref` (emitStructFieldGetters). */
  sgetDoneIdx: number;
  /** `__is_truthy(externref) -> i32` (ToBoolean on the boxed `done` flag). */
  isTruthyIdx: number;
}

/**
 * Lazily register (or fetch) the `$__IterRec` GC struct type. Mirrors
 * `ensureNativeGeneratorResultType` (generators-native.ts) — one struct per
 * module, cached via `ctx.structMap`.
 */
export function getOrRegisterIterRecType(ctx: CodegenContext): number {
  const existing = ctx.structMap.get("__IterRec");
  if (existing !== undefined) return existing;

  // The canonical externref vec the record cursors over.
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });

  // Field order is load-bearing: fieldIdx kind=0, vec=1, idx=2 (the vec path).
  // (#2038) userIter=3 — a mutable externref holding the user `{next()}`
  // iterator object for the USER carrier (null on the vec path).
  const fields = [
    { name: "kind", type: { kind: "i32" as const }, mutable: false },
    { name: "vec", type: { kind: "ref_null" as const, typeIdx: vecTypeIdx }, mutable: false },
    { name: "idx", type: { kind: "i32" as const }, mutable: true },
    { name: "userIter", type: { kind: "externref" as const }, mutable: true },
  ];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: "__IterRec", fields });
  ctx.structMap.set("__IterRec", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "__IterRec");
  ctx.structFields.set("__IterRec", fields);
  return typeIdx;
}

/** Cached per-module geometry the body builders + the finalize fill both need. */
interface IterRuntimeTypes {
  iterRecTypeIdx: number;
  vecTypeIdx: number;
  arrTypeIdx: number;
}

function iterRuntimeTypes(ctx: CodegenContext): IterRuntimeTypes {
  const iterRecTypeIdx = getOrRegisterIterRecType(ctx);
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  return { iterRecTypeIdx, vecTypeIdx, arrTypeIdx };
}

/**
 * #1320 Slice 1 — register the four iteration-protocol operations as native
 * Wasm functions (standalone/WASI). Idempotent: guards on `funcMap.has`.
 *
 * Signatures match the JS-host imports exactly so consumer codegen is
 * byte-identical:
 *   __iterator(externref) -> externref               (GetIterator)
 *   __iterator_next(externref) -> (i32 done, externref value)  (IteratorStep)
 *   __iterator_return(externref) -> ()               (IteratorClose)
 *   __iterator_rest(externref) -> externref          (drain remainder → vec)
 *
 * The argument to `__iterator` is, in Slice 1, an externref-wrapped canonical
 * externref `$Vec` (the caller box-builds it). `__iterator` wraps it in an
 * `$IterRec`; `__iterator_next` walks the vec by index.
 *
 * (#2038) The `__iterator` / `__iterator_next` bodies are emitted **vec-only**
 * here — byte-identical to the pre-USER runtime — and `nativeIteratorUserArmPending`
 * is set so `fillNativeIteratorUserArms` (finalize) rebuilds them with the USER
 * arm once the closed-struct dispatchers exist. A non-vec subject keeps trapping
 * (the legacy hard cast) until that fill runs, so a module where the fill is
 * skipped (e.g. multi-module) never ships a broken iterator.
 */
export function ensureNativeIteratorRuntime(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__iterator")) return;

  const types = iterRuntimeTypes(ctx);
  const { iterRecTypeIdx, vecTypeIdx, arrTypeIdx } = types;

  const iterRecRef: ValType = { kind: "ref", typeIdx: iterRecTypeIdx };
  const vecRefNull: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };

  const registerNative = (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ): number => {
    const typeIdx = addFuncType(ctx, paramTypes, resultTypes);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set(name, funcIdx);
    ctx.mod.functions.push({ name, typeIdx, locals, body, exported: false });
    return funcIdx;
  };

  // --- __iterator(obj: externref) -> externref (the $IterRec, as externref) ---
  // GetIterator §7.4.1. Vec-only at emit time; the USER arm is filled later.
  // local 0 = obj (param, externref); local 1 = objAny (anyref); local 2 = userIter (externref)
  registerNative(
    "__iterator",
    [{ kind: "externref" }],
    [{ kind: "externref" }],
    [
      { name: "objAny", type: { kind: "anyref" } },
      { name: "userIter", type: { kind: "externref" } },
    ],
    buildIteratorBody(types, undefined),
  );

  // --- __iterator_next(recExt: externref) -> (i32 done, externref value) ---
  // IteratorStep + IteratorValue §7.4.5/§7.4.6. Vec-only at emit time; the USER
  // arm is filled later. Locals sized for both arms (USER uses local 6 = res).
  //   local 0 = recExt (param, externref)
  //   local 1 = rec    ($IterRec)
  //   local 2 = vec    (ref null $vecExtern)
  //   local 3 = i      (i32 cursor)
  //   local 4 = done   (i32)
  //   local 5 = value  (externref)
  //   local 6 = res    (externref — USER next() result, #2038)
  registerNative(
    "__iterator_next",
    [{ kind: "externref" }],
    [{ kind: "i32" }, { kind: "externref" }],
    [
      { name: "rec", type: iterRecRef },
      { name: "vec", type: vecRefNull },
      { name: "i", type: { kind: "i32" } },
      { name: "done", type: { kind: "i32" } },
      { name: "value", type: { kind: "externref" } },
      { name: "res", type: { kind: "externref" } },
    ],
    buildIteratorNextBody(types, undefined),
  );

  // --- __iterator_return(recExt: externref) -> ()  (IteratorClose §7.4.8) ---
  // Slice 1: canonical-vec iterators have no user `.return` → no-op. (USER-arm
  // close of a sync-backed iterator is also a no-op for the common shape.)
  registerNative("__iterator_return", [{ kind: "externref" }], [], [], []);

  // --- __iterator_rest(recExt: externref) -> externref  ([...rest] drain) ---
  // Drain the remaining elements of the canonical vec into a fresh externref
  // vec. Slice 1: shallow-copy from the cursor to the end.
  //   local 0 = recExt
  //   local 1 = rec   ($IterRec)
  //   local 2 = vec   (ref null $vecExtern)
  //   local 3 = i     (i32 cursor)
  //   local 4 = len   (i32)
  //   local 5 = out   (ref null $arrExtern)  fresh data array
  //   local 6 = j     (i32 write cursor)
  registerNative(
    "__iterator_rest",
    [{ kind: "externref" }],
    [{ kind: "externref" }],
    [
      { name: "rec", type: iterRecRef },
      { name: "vec", type: vecRefNull },
      { name: "i", type: { kind: "i32" } },
      { name: "len", type: { kind: "i32" } },
      { name: "out", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "j", type: { kind: "i32" } },
    ],
    buildIteratorRestBody(iterRecTypeIdx, vecTypeIdx, arrTypeIdx),
  );

  // (#2038) Defer the USER arm to finalize (closed-struct dispatchers not yet
  // emitted). The eager bodies above are a valid vec-only carrier.
  ctx.nativeIteratorUserArmPending = true;
}

/**
 * (#2038, reserve-then-fill #1719) Rebuild the `__iterator` / `__iterator_next`
 * bodies with the USER `{next()}`-protocol arm, now that the closed-struct
 * dispatchers (`__call_@@iterator`, `__call_next`, `__sget_value`, `__sget_done`)
 * and `__is_truthy` have been emitted at finalize. No-op when:
 *   - the native runtime was never registered (`!nativeIteratorUserArmPending`),
 *   - any dispatcher is absent (e.g. no custom iterable / `{value,done}` struct in
 *     the module) — the carrier stays vec-only and byte-identical.
 *
 * MUST be called AFTER `emitStructFieldGetters` + `emitIteratorMethodExport` in
 * the finalize sequence. Storing the carrier funcIdx in `funcMap` (and looking it
 * up post-shift here) keeps it in lockstep with any late-import index shift.
 */
export function fillNativeIteratorUserArms(ctx: CodegenContext): void {
  if (!ctx.nativeIteratorUserArmPending) return;

  const callIteratorIdx = ctx.funcMap.get("__call_@@iterator");
  const callNextIdx = ctx.funcMap.get("__call_next");
  const sgetValueIdx = ctx.funcMap.get("__sget_value");
  const sgetDoneIdx = ctx.funcMap.get("__sget_done");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  if (
    callIteratorIdx === undefined ||
    callNextIdx === undefined ||
    sgetValueIdx === undefined ||
    sgetDoneIdx === undefined ||
    isTruthyIdx === undefined
  ) {
    // No closed-struct iterable in this module (or no truthiness helper) → the
    // vec-only carrier is correct as-is. Custom iterables, if any, keep trapping
    // exactly as on the pre-#2038 runtime rather than shipping a broken arm.
    return;
  }
  const deps: UserCarrierDeps = { callIteratorIdx, callNextIdx, sgetValueIdx, sgetDoneIdx, isTruthyIdx };

  const types = iterRuntimeTypes(ctx);

  const iteratorIdx = ctx.funcMap.get("__iterator");
  const iteratorNextIdx = ctx.funcMap.get("__iterator_next");
  if (iteratorIdx === undefined || iteratorNextIdx === undefined) return;

  const iteratorFn = ctx.mod.functions[iteratorIdx - ctx.numImportFuncs];
  const iteratorNextFn = ctx.mod.functions[iteratorNextIdx - ctx.numImportFuncs];
  if (iteratorFn) iteratorFn.body = buildIteratorBody(types, deps);
  if (iteratorNextFn) iteratorNextFn.body = buildIteratorNextBody(types, deps);
}

/**
 * Build the `__iterator(obj) -> externref` body. With `deps === undefined` this
 * is the vec-only carrier (a non-vec subject hard-casts → `illegal cast`, the
 * legacy failure mode). With `deps` it adds the USER arm:
 *   - obj is a canonical externref `$Vec` → $IterRec{kind:VEC, vec, 0, null}.
 *   - (#2038) otherwise → obtain the iterator object via `__call_@@iterator(obj)`
 *     and build $IterRec{kind:USER, vec:null, 0, userIter}. If the dispatcher
 *     returns null (obj is ALREADY an iterator with a bare `next` and no
 *     `@@iterator`), fall back to using obj itself as the iterator object.
 * Locals: 0=obj(param), 1=objAny(anyref), 2=userIter(externref).
 */
function buildIteratorBody(types: IterRuntimeTypes, deps: UserCarrierDeps | undefined): Instr[] {
  const { iterRecTypeIdx, vecTypeIdx } = types;
  // VEC arm: $IterRec{VEC, vec, 0, userIter:null}. Field order/arity is
  // load-bearing — struct.new pushes all 4 fields (userIter = ref.null.extern).
  const vecArm: Instr[] = [
    { op: "i32.const", value: ITER_KIND_VEC },
    { op: "local.get", index: 1 },
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "i32.const", value: 0 },
    { op: "ref.null.extern" } as Instr,
    { op: "struct.new", typeIdx: iterRecTypeIdx },
    { op: "extern.convert_any" } as Instr,
  ];

  const elseArm: Instr[] = deps
    ? [
        // userIter = __call_@@iterator(obj)  (null if obj has no @@iterator)
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: deps.callIteratorIdx } as Instr,
        { op: "local.tee", index: 2 },
        { op: "ref.is_null" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          // No @@iterator → obj is itself the iterator (has `next`).
          then: [{ op: "local.get", index: 0 }],
          else: [{ op: "local.get", index: 2 }],
        } as unknown as Instr,
        { op: "local.set", index: 2 },
        // $IterRec{USER, vec:null, idx:0, userIter}
        { op: "i32.const", value: ITER_KIND_USER },
        { op: "ref.null", typeIdx: vecTypeIdx } as Instr,
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 2 },
        { op: "struct.new", typeIdx: iterRecTypeIdx },
        { op: "extern.convert_any" } as Instr,
      ]
    : // USER carrier not filled — preserve the legacy hard cast so the failure
      // mode is unchanged (loud trap) rather than silently wrong.
      vecArm;

  return [
    // objAny = any.convert_extern(obj)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: vecTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: vecArm,
      else: elseArm,
    } as unknown as Instr,
  ];
}

/**
 * Build the `__iterator_next(recExt) -> (i32 done, externref value)` body. With
 * `deps === undefined` only the vec arm is reachable (USER kind is never produced
 * without the fill). With `deps` the USER arm dispatches (§7.4.4 IteratorNext +
 * §7.4.6 IteratorValue):
 *   res = __call_next(userIter);  done = ToBoolean(__sget_done(res));
 *   value = done ? undefined : __sget_value(res)
 * (a non-object `res` ⇒ the field getters return null ⇒ done falsy/value null;
 *  the §7.4.4 "next result not an Object ⇒ TypeError" refinement is a follow-up).
 * Locals: 0=recExt(param), 1=rec, 2=vec, 3=i, 4=done(i32), 5=value(externref),
 * 6=res(externref).
 */
function buildIteratorNextBody(types: IterRuntimeTypes, deps: UserCarrierDeps | undefined): Instr[] {
  const { iterRecTypeIdx, vecTypeIdx, arrTypeIdx } = types;

  // The vec-carrier step (existing behavior), computing done(4)/value(5).
  const vecStep: Instr[] = [
    // vec = rec.vec
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: 2 },
    // i = rec.idx
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: 3 },
    // done = (vec == null) | (i >= vec.length)
    { op: "local.get", index: 2 },
    { op: "ref.is_null" } as Instr,
    { op: "local.get", index: 3 },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "i32.ge_s" },
    { op: "i32.or" },
    { op: "local.set", index: 4 },
    // value default = undefined-extern
    { op: "ref.null.extern" } as Instr,
    { op: "local.set", index: 5 },
    // if (!done) { value = vec.data[i]; rec.idx = i + 1; }
    { op: "local.get", index: 4 },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 3 },
        { op: "array.get", typeIdx: arrTypeIdx },
        { op: "local.set", index: 5 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 3 },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx: iterRecTypeIdx, fieldIdx: 2 } as Instr,
      ],
      else: [],
    } as unknown as Instr,
  ];

  if (!deps) {
    // Vec-only carrier: kind is always VEC, so emit the vec step directly with no
    // kind branch — byte-identical to the pre-#2038 runtime.
    return [
      // rec = cast(any.convert_extern(recExt))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "ref.cast", typeIdx: iterRecTypeIdx },
      { op: "local.set", index: 1 },
      ...vecStep,
      // results in ABI order: (done, value)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 5 },
    ];
  }

  // (#2038) The USER-carrier step: dispatch through the closed-struct helpers.
  const userStep: Instr[] = [
    // res = __call_next(rec.userIter)
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
    { op: "call", funcIdx: deps.callNextIdx } as Instr,
    { op: "local.set", index: 6 },
    // done = ToBoolean(__sget_done(res))
    { op: "local.get", index: 6 },
    { op: "call", funcIdx: deps.sgetDoneIdx } as Instr,
    { op: "call", funcIdx: deps.isTruthyIdx } as Instr,
    { op: "local.set", index: 4 },
    // value = done ? undefined : __sget_value(res)
    { op: "local.get", index: 4 },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "ref.null.extern" } as Instr],
      else: [{ op: "local.get", index: 6 }, { op: "call", funcIdx: deps.sgetValueIdx } as Instr],
    } as unknown as Instr,
    { op: "local.set", index: 5 },
  ];

  return [
    // rec = cast(any.convert_extern(recExt))
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: iterRecTypeIdx },
    { op: "local.set", index: 1 },
    // if (rec.kind == USER) { userStep } else { vecStep }
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: ITER_KIND_USER },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: userStep,
      else: vecStep,
    } as unknown as Instr,
    // results in ABI order: (done, value)
    { op: "local.get", index: 4 },
    { op: "local.get", index: 5 },
  ];
}

/**
 * Build the `__iterator_rest` body: copy the canonical vec's elements from the
 * cursor to the end into a fresh externref vec, returned as externref.
 * Locals: 0=recExt(param), 1=rec, 2=vec, 3=i, 4=len, 5=out(arr), 6=j.
 */
function buildIteratorRestBody(iterRecTypeIdx: number, vecTypeIdx: number, arrTypeIdx: number): Instr[] {
  return [
    // rec = cast(recExt)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: iterRecTypeIdx },
    { op: "local.tee", index: 1 },
    // vec = rec.vec
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: 2 },
    // i = rec.idx
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: 3 },
    // len = (vec == null) ? 0 : vec.length
    { op: "local.get", index: 2 },
    { op: "ref.is_null" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      ],
    } as unknown as Instr,
    { op: "local.set", index: 4 },
    // out = new externref[ (i < len) ? len - i : 0 ]   (clamp negative to 0).
    // Compute the count cleanly: the if's condition (i < len) is the ONLY value
    // on the stack entering the `if`, and each arm leaves exactly one i32.
    { op: "local.get", index: 3 },
    { op: "local.get", index: 4 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "local.get", index: 4 }, { op: "local.get", index: 3 }, { op: "i32.sub" }],
      else: [{ op: "i32.const", value: 0 }],
    } as unknown as Instr,
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: 5 },
    // j = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 6 },
    // while (i < len) { out[j] = vec.data[i]; i++; j++; }
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // i >= len -> break
            { op: "local.get", index: 3 },
            { op: "local.get", index: 4 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // out[j] = vec.data[i]
            { op: "local.get", index: 5 },
            { op: "ref.as_non_null" } as Instr,
            { op: "local.get", index: 6 },
            { op: "local.get", index: 2 },
            { op: "ref.as_non_null" } as Instr,
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: 3 },
            { op: "array.get", typeIdx: arrTypeIdx },
            { op: "array.set", typeIdx: arrTypeIdx } as Instr,
            // i++ ; j++
            { op: "local.get", index: 3 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 3 },
            { op: "local.get", index: 6 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 6 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // result vec = $vecExtern{ length: j, data: out }
    { op: "local.get", index: 6 },
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" } as Instr,
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" } as Instr,
  ];
}
