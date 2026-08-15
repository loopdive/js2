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
 * `fillNativeIteratorLateArms` after the dispatchers exist — the reserve-then-fill
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
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)
// (#3100) The vec-family normalize arms reuse the #2190 element-boxing recipe +
// the non-array byte-carrier filter (ArrayBuffer/Uint8Array storage vecs).
// (#3100 S4) ensureObjectRuntime provides the native `__extern_length` /
// `__extern_get_idx` readers the index-based `__extern_slice` copies through.
import {
  boxVecElementToExternref,
  ensureObjectRuntime,
  NON_ARRAY_BYTE_VEC_ELEM_KINDS,
  reserveApplyClosure,
} from "./object-runtime.js";
// (#3206) `__array_from_mapped` reuses the native array-map HOF loop
// (`__hof_map`) after normalizing the source through `__array_from_iter_n`.
import { ensureNativeArrayHof } from "./hof-native.js";
// (#3100 S4) `__extern_slice`'s $AnyString arm reuses the #1470 code-point
// char-vec helper so a string rest (`const [a, ...r] = "hello"`) yields the
// spec §22.1.5.1 per-code-point elements natively.
// (#3119) `nativeStringLiteralInstrs` materializes the OBJ arm's string keys
// ("next"/"done"/"value"/"return") at fill time — pure instrs against the
// already-registered native-string types, no new module entities.
import { ensureStrToCharVecHelper, nativeStringLiteralInstrs } from "./native-strings.js";
// (#3119) The OBJ arm's miss/undefined value matches `__extern_get`'s miss
// representation (the #2106 S1 `$undefined` singleton when active, else null).
import { undefinedExternInstrs } from "./any-helpers.js";
// (#3388) GetIterator §7.4.1: a non-iterable subject must throw a catchable
// `TypeError`, not trap (`ref.cast $Vec` on a non-vec → `illegal cast`). The
// error constructor + message global are registered EAGERLY (idempotent) so the
// throw instrs at both the eager and finalize `buildIteratorBody` sites only
// READ already-registered symbols (no #2043 late-shift).
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { stringConstantExternrefInstrs as throwMsgExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
// (#3164) The GENSTATE step's f64 value read canonicalizes the UNDEF_F64
// sentinel (a done/valueless yield) to the null externref — the standalone
// canonical `undefined` — before boxing (same recipe as
// `sentinelAwareF64BoxInstrs`, generators-native.ts; inlined here to avoid a
// module-init-order-sensitive import back into that cycle-heavy module).
import { UNDEF_F64_BITS } from "./value-tags.js";

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
 * (#3119, #3100 Design arm 3) IterRec kind tag for an OBJ iterator: a plain
 * open `$Object` (or anything else the object runtime's `__extern_get` can
 * read) whose `@@iterator` was installed dynamically — the post-hoc
 * `o[Symbol.iterator] = fn` shape. Distinct from USER because the step arm
 * dispatches through PROPERTY reads (`__extern_get(iterObj, "next")`) and the
 * open-`any` closure bridge (`__apply_closure`), NOT the closed-struct
 * type-switch dispatchers (`__call_next`/`__sget_*`). The iterator object is
 * held in `userIter` (field 3) exactly like USER; `vec` is null.
 */
const ITER_KIND_OBJ = 4;

/**
 * (#3075) IterRec kind tag for a HOST generator object: the externref returned
 * by the legacy eager-buffer generator runtime (`__create_generator` /
 * `__create_async_generator` — the host fallback that `yield*`-and-friends
 * sync/async generator bodies still take even under `--target standalone`, see
 * `sourceNeedsGeneratorHostImports`). Such a value internalizes OUTSIDE every
 * GC heap subhierarchy (not struct / array / i31), so no native arm can read
 * it — before this arm it hit the hard-cast tail (`illegal cast [in
 * __iterator]`, the 468-record standalone for-of/for-await dstr cluster). A
 * generator object is its own iterator (`[Symbol.iterator]` /
 * `[Symbol.asyncIterator]` return `this`), so GetIterator is the identity; the
 * step arm drives it through the ALREADY-IMPORTED host helpers (`__gen_next` /
 * `__gen_result_done` / `__gen_result_value`) — no new host import is added,
 * the module carries the whole legacy bundle regardless. The buffered
 * async-gen `next()` returns a thenable that exposes `value`/`done`
 * synchronously (runtime.ts `mkResult`), so the sync drive reads the settled
 * result directly — exactly the sync-backed degenerate Await the standalone
 * for-await lowering layers around the loop body (see `ensureAsyncIterator`).
 */
const ITER_KIND_HOSTGEN = 5;

/**
 * (#3075) Abstract heap-type codes for the host-external `ref.test`
 * classification (binary s33 heap-type positions — see `vHeapType` in
 * emit/binary.ts: negative values are abstract heap-type codes encoding as one
 * signed-LEB byte). Never present in any DCE type-remap map (those key on
 * concrete indices ≥ 0), so bodies carrying them survive type compaction
 * unchanged.
 */
const HEAP_TYPE_STRUCT = -21; // 0x6B
const HEAP_TYPE_ARRAY = -22; // 0x6A
const HEAP_TYPE_I31 = -20; // 0x6C

/**
 * (#3132 S1) IterRec kind tag for a DRIVEN native async-generator frame
 * carrier (the `$AsyncFrame` struct `emitAsyncGenerator` returns, #2906
 * 3d-i / #2865). The bounded 3d-ii CFG consumer only drives a direct-call
 * source with a simple identifier binding, so a frame consumed through an
 * identifier (`var it = g(); for await (const [x] of it)`) or any
 * destructuring binding falls to the legacy sync `__iterator` lowering —
 * which hard-cast trapped on the frame struct. This arm dispatches a
 * per-producer type-switch over `ctx.asyncGenProducers`: `__iterator_next`
 * calls the matching `__async_gen_next_<stem>` driver and reads the settled
 * `$IteratorResult` off the minted `$Promise`. Await-free producers (the only
 * ones driven under `--target standalone`, #2865/#2980) settle that promise
 * SYNCHRONOUSLY inside the `next()` kick, so requiring FULFILLED is exact; a
 * pending promise (carrier-lane awaited yield) traps loudly (`unreachable`) —
 * the same loud-failure discipline as the pre-arm hard cast. The frame is
 * held in `userIter` (field 3).
 */
const ITER_KIND_ASYNCGEN = 6;

/**
 * (#3164) IterRec kind tag for a DRIVEN native SYNC-generator state struct
 * (`$GenState_*`, generators-native.ts). Statically-typed consumers drive the
 * per-generator resume function directly at the call site
 * (`tryCompileNativeGeneratorForOf`, the #2169 destructure drain), but a
 * generator held DYNAMICALLY — the (#3164) generator function-expression
 * closure returns its state struct as externref, and any `g: any` — reaches
 * the generic `__iterator` ladder, which previously either hard-cast trapped
 * (for-of) or silently defaulted every binding (externref destructure). This
 * arm dispatches a per-producer type-switch over `ctx.nativeGenerators` (dedup
 * by state struct type, resume emitted): GetIterator is the identity
 * (a generator object's `@@iterator` returns `this`); `__iterator_next` calls
 * the matching `__gen_resume_<name>` and reads `{value, done}` off the
 * per-generator result struct, boxing the value per elem carrier (f64 via the
 * UNDEF-sentinel-aware box, i32 via convert+box, GC refs via
 * `extern.convert_any`, externref as-is). IteratorClose marks the frame done
 * (`state := doneState`) so a closed generator's later `.next()` answers
 * `{undefined, true}`; finally-block `.return()` semantics on early exit are
 * out of scope (same boundary as the #2903 iter-hof `close` no-op). The frame
 * rides in `userIter` (field 3).
 */
const ITER_KIND_GENSTATE = 7;

/** `$Promise` field layout (async-scheduler.ts): state(0) i32 — 1=FULFILLED —
 *  and value(1) externref. */
const PROMISE_FIELD_STATE = 0;
const PROMISE_FIELD_VALUE = 1;
const PROMISE_STATE_FULFILLED = 1;

/** `__NativeGeneratorResult_externref` field layout (generators-native.ts
 *  `ensureNativeGeneratorResultType`): value(0) externref, done(1) i32. */
const AGEN_RESULT_FIELD_VALUE = 0;
const AGEN_RESULT_FIELD_DONE = 1;

/**
 * (#3132 S1) Resolved fill-time deps of the ASYNCGEN arm. All DEFINED funcs /
 * concrete type indices, resolved from funcMap/structMap at fill time (every
 * producer has registered by finalize — `emitAsyncGenerator` runs during body
 * compilation).
 */
interface AsyncGenCarrierDeps {
  /** Per-producer dispatch: frame `ref.test stateTypeIdx` → its next driver
   *  `__async_gen_next_<stem>(frame externref) -> externref ($Promise)`. */
  producers: { stateTypeIdx: number; nextIdx: number }[];
  /** `$Promise` struct typeIdx. */
  promiseTypeIdx: number;
  /** `__NativeGeneratorResult_externref` struct typeIdx. */
  resultTypeIdx: number;
}

/**
 * (#3164) Resolved fill-time deps of the GENSTATE arm — driven native SYNC
 * generators (`ctx.nativeGenerators`), deduped by state struct type. Only
 * generators whose resume function actually EMITTED participate (a
 * registered-but-never-instantiated generator's state struct cannot exist at
 * runtime). `resumeIdx` values are re-read from `info.resumeFuncIdx`, which
 * `shiftLateImportIndices` walks (#2941 lockstep), so they are current at
 * finalize. The per-producer result struct is PER-ELEM-KIND
 * (`__NativeGeneratorResult_<kind>`), so each producer carries its own
 * `resultTypeIdx` + `elemValType` for the value boxing.
 */
interface SyncGenCarrierDeps {
  producers: {
    stateTypeIdx: number;
    resumeIdx: number;
    resultTypeIdx: number;
    elemValType: ValType;
    /** Terminal state id — IteratorClose writes it into the frame's `state`. */
    doneState: number;
  }[];
  /** `__box_number` funcIdx (f64/i32 elem carriers box through it). */
  boxNumIdx?: number;
  /** Index of the f64 scratch local appended to `__iterator_next` at fill
   *  time (sentinel-aware f64 boxing needs one). */
  f64TmpIdx: number;
}

/** (#3164) `$GenState_*` field layout (generators-native.ts frame ABI):
 *  state(0) mut i32 — `doneState` marks the generator completed. */
const GENSTATE_STATE_FIELD = 0;

/**
 * (#3075) Resolved fill-time deps of the HOSTGEN arm — the legacy eager-buffer
 * generator HOST IMPORTS (`addGeneratorImports` bundle), present exactly when
 * some generator body in the module bailed to the host path
 * (`sourceNeedsGeneratorHostImports`). All are IMPORT funcIdxs resolved from
 * funcMap at fill time; later import shifts walk the rebuilt bodies like any
 * other defined function (same discipline as the USER/vec-family arms).
 */
interface HostGenDeps {
  /** `__gen_next(gen externref) -> externref` — gen.next(), the step. */
  genNextIdx: number;
  /** `__gen_result_done(res externref) -> i32` — reads res.done. */
  genResultDoneIdx: number;
  /** `__gen_result_value(res externref) -> externref` — reads res.value. */
  genResultValueIdx: number;
  /** `__gen_return(gen, value externref) -> externref` — IteratorClose. */
  genReturnIdx?: number;
}

/**
 * Resolved funcIdx of the closed-struct dispatchers the USER arm calls. All four
 * are emitted at FINALIZE; `fillNativeIteratorLateArms` looks them up then.
 */
interface UserCarrierDeps {
  /**
   * `__call_@@iterator(externref) -> externref` (emitIteratorMethodExport).
   * (#3146) OPTIONAL: a module whose only closed-struct iterator carriers are
   * bare `{ next() {…} }` objects (no `[Symbol.iterator]` method on ANY
   * struct — e.g. every Iterator.zip test262 file, whose sources are
   * top-level `{next, return}` literals) never emits the `@@iterator`
   * dispatcher. GetIterator then treats the subject as its OWN iterator
   * (§7.4.1 flattenable fallback) — the tail skips the dispatcher call.
   */
  callIteratorIdx?: number;
  /** `__call_next(externref) -> externref` (emitIteratorMethodExport). */
  callNextIdx: number;
  /**
   * `__sget_value(externref) -> externref` (emitStructFieldGetters).
   * (#3146) OPTIONAL: absent when NO closed struct in the module carries a
   * `value` field (e.g. iterator results are open `$Object`s / `{}`); the
   * USER step arm then degrades a CLOSED result read to done=1 (never spins),
   * mirroring the OBJ arm's fallback. Open results read via `objDeps`.
   */
  sgetValueIdx?: number;
  /** `__sget_done(externref) -> externref` (emitStructFieldGetters). Optional — see sgetValueIdx. */
  sgetDoneIdx?: number;
  /**
   * (#4447) True when `__sget_done` really has the extern signature
   * `(externref) -> externref`. A getter's RESULT type follows the FIELD type,
   * so a module whose `done` field is numeric emits `(externref) -> f64`,
   * which cannot feed `__is_truthy`. Only a `true` here licenses reading
   * `done` WITHOUT `__sget_value` (the `{ done: … }`-only IteratorResult arm).
   */
  sgetDoneIsExtern?: boolean;
  /** `__is_truthy(externref) -> i32` (ToBoolean on the boxed `done` flag). */
  isTruthyIdx: number;
  /**
   * (#3100 S5) `__call_return(externref) -> externref`
   * (emitIteratorMethodExport) — OPTIONAL: present only when some module
   * struct carries a `return` method. Absent ⇒ IteratorClose finds no
   * `return` ⇒ NormalCompletion (§7.4.9 step 4), the empty-body no-op.
   */
  callReturnIdx?: number;
}

/**
 * (#3119) Resolved fill-time deps of the plain-`$Object` OBJ arm. All are
 * DEFINED funcs (no import shift): the object runtime's dynamic reader, the
 * `$Symbol` boxer (#2866 — the `@@iterator` key is a `$Symbol` carrier looked
 * up by id in `__obj_find`/`__key_equals`), the open-`any` closure bridge
 * (#1888, reserve-then-fill — reserved by the fill if no other site did), and
 * ToBoolean. `keyInstrs`/`missInstrs` are FACTORIES so every embed gets fresh
 * `Instr` objects (#2169b shared-object double-remap hazard).
 */
interface ObjCarrierDeps {
  /** `__extern_get(externref obj, externref key) -> externref` (object runtime). */
  externGetIdx: number;
  /** `__apply_closure(externref fn, externref recv, externref args) -> externref`. */
  applyClosureIdx: number;
  /** `__box_symbol(i32 id) -> externref` — interned `$Symbol` carrier (#2866). */
  boxSymbolIdx: number;
  /** The `(externref) -> i32` §7.1.2 ToBoolean helper (reused USER-deps funcIdx). */
  isTruthyIdx: number;
  /** `$Object` struct typeIdx — discriminates the step-result read path. */
  objectTypeIdx: number;
  /** `__sget_value(externref) -> externref` — closed-struct `{value,done}` step
   *  results (an object-literal `next()` result often pre-shapes into a closed
   *  struct, which `__extern_get` cannot read). Optional: absent when the
   *  module has no `value` field bucket. */
  sgetValueIdx?: number;
  /** `__sget_done(externref) -> externref` — see `sgetValueIdx`. */
  sgetDoneIdx?: number;
  /** (#4447) `__sget_done` really is `(externref) -> externref` — see the twin
   *  field on `UserCarrierDeps`. */
  sgetDoneIsExtern?: boolean;
  /** `__sget_next(externref) -> externref` — the ITERATOR OBJECT itself often
   *  pre-shapes into a closed struct (`{ next: function () {…} }` literal with
   *  a field-stored closure, #3117), so the `next` read needs the field getter
   *  when the carrier is not a `$Object`. Present exactly when some struct has
   *  a `next` field — i.e. whenever such an iterator literal exists. */
  sgetNextIdx?: number;
  /** `__sget_return(externref) -> externref` — same for IteratorClose's
   *  `return` read on a closed-struct iterator object. */
  sgetReturnIdx?: number;
  /** Fresh instrs pushing the string key `name` as externref. */
  keyInstrs: (name: string) => Instr[];
  /** Fresh instrs pushing the miss/undefined externref (matches `__extern_get`). */
  missInstrs: () => Instr[];
}

/**
 * (#3119) Fresh instrs pushing an EMPTY canonical externref `$Vec` as externref
 * — the zero-arg `args` vector for `__apply_closure` (its `__extern_length`
 * reads 0 → `__call_fn_method_0(recv, fn)`). Factory per #2169b.
 */
function emptyArgsVecInstrs(types: IterRuntimeTypes): Instr[] {
  return [
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: types.arrTypeIdx },
    { op: "struct.new", typeIdx: types.vecTypeIdx },
    { op: "extern.convert_any" },
  ];
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
 * is set so `fillNativeIteratorLateArms` (finalize) rebuilds them with the USER
 * arm once the closed-struct dispatchers exist. A non-vec subject keeps trapping
 * (the legacy hard cast) until that fill runs, so a module where the fill is
 * skipped (e.g. multi-module) never ships a broken iterator.
 */
export function ensureNativeIteratorRuntime(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__iterator")) return;

  // (#3388) Register the native TypeError ctor + "not iterable" message eagerly
  // (idempotent) so the §7.4.1 non-iterable tail throws instead of trapping.
  // Must precede the `registerNative("__iterator", …)` below so the throw instrs
  // read a stable, already-registered funcIdx (no #2043 finalize shift).
  ensureNonIterableThrowDeps(ctx);

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
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, funcIdx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
    return funcIdx;
  };

  // --- __iterator(obj: externref) -> externref (the $IterRec, as externref) ---
  // GetIterator §7.4.1. Vec-only at emit time; the USER arm AND the (#3100)
  // vec-family normalization arms are filled later (`fillNativeIteratorLateArms`).
  // local 0 = obj (param, externref); local 1 = objAny (anyref);
  // local 2 = userIter (externref); locals 3..5 = i/len/out — scratch for the
  // (#3100) vec-family normalization loop (unused by the eager vec-only body;
  // declared here so the finalize fill never has to grow the locals list).
  registerNative(
    "__iterator",
    [{ kind: "externref" }],
    [{ kind: "externref" }],
    [
      { name: "objAny", type: { kind: "anyref" } },
      { name: "userIter", type: { kind: "externref" } },
      { name: "i", type: { kind: "i32" } },
      { name: "len", type: { kind: "i32" } },
      { name: "out", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
    ],
    buildIteratorBody(
      types,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      nonIterableThrowInstrs(ctx),
    ),
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
 * (#3146) Scratch global parking the step VALUE between a
 * `__j2w_iter_step(rec)` intrinsic call (which consumes the native
 * `__iterator_next` multivalue result: done stays on the stack, value goes
 * here) and the immediately-following `__j2w_iter_value()` read. Safe because
 * no user code can run between the two intrinsic calls the Iterator-statics
 * prelude emits back-to-back (user `next()` bodies run INSIDE the
 * `__iterator_next` call, before the global is written).
 */
const iterScratchGlobalIdxByCtx = new WeakMap<CodegenContext, number>();

export function ensureIterStepScratchGlobal(ctx: CodegenContext): number {
  const existing = iterScratchGlobalIdxByCtx.get(ctx);
  if (existing !== undefined) return existing;
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__j2w_iter_step_value",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  iterScratchGlobalIdxByCtx.set(ctx, globalIdx);
  return globalIdx;
}

/**
 * (#2904) Register a native standalone `__array_from_iter_n(externref, f64) ->
 * externref` defined function, reusing the existing native iterator runtime
 * (`__iterator` / `__iterator_next`). This replaces the JS-host
 * `env::__array_from_iter_n` import that fixed-arity array destructuring of an
 * `any`-typed (externref) source otherwise leaks — a leak that breaks
 * zero-import instantiation under `--target standalone`/`wasi`.
 *
 * Semantics mirror the host `_arrayFromIter(obj, limit)`:
 *   - `n < 0` (rest patterns): unbounded drain until the iterator reports done.
 *   - `n >= 0` (no-rest patterns, §8.5.3): consume AT MOST `n` IteratorSteps —
 *     exactly one `.next()` per binding slot, never over-draining a lazy
 *     generator. (#3100 S5) Stopping at the bound with the iterator NOT done
 *     calls `__iterator_return` (IteratorClose §7.4.9) — §8.5.2/§13.15.5.2
 *     require close when the pattern does not exhaust the iterator. This
 *     DIVERGES from the host `_arrayFromIter` (#1592 chose no-close there);
 *     the native lane follows the spec — a no-op for VEC-kind records, the
 *     USER close arm for custom iterators with a `return` method.
 *   - `null`/`undefined` source: return an empty vec (host returns `[]`).
 *
 * Returns a canonical externref `$Vec` (`__vec_externref`), which the downstream
 * `__extern_length` / `__extern_get_idx` consumers already read natively (it is
 * a `vecTypeMap` carrier). Drain loop = array-doubling growth + `array.copy`,
 * byte-shaped after the proven spread-override drain in literals.ts (#1749).
 *
 * Append-only: registering a DEFINED function does NOT shift existing function
 * indices the way `addImport` does. The body's `call __iterator` /
 * `call __iterator_next` funcIdx are captured here (post `ensureNativeIteratorRuntime`)
 * and patched by `shiftLateImportIndices` like any other defined body if a later
 * import shifts them.
 */
export function ensureNativeArrayFromIterN(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__array_from_iter_n");
  if (existing !== undefined) return existing;

  // Guarantee the iterator runtime (and the $Vec/$IterRec geometry) exist.
  ensureNativeIteratorRuntime(ctx);
  const { vecTypeIdx, arrTypeIdx } = iterRuntimeTypes(ctx);
  const iteratorIdx = ctx.funcMap.get("__iterator");
  const iteratorNextIdx = ctx.funcMap.get("__iterator_next");
  if (iteratorIdx === undefined || iteratorNextIdx === undefined) {
    // Should never happen (ensureNativeIteratorRuntime just ran) — fall back to
    // a host import so the caller still resolves a funcIdx by name.
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set("__array_from_iter_n", funcIdx);
    pushDefinedFunc(ctx, funcIdx, { name: "__array_from_iter_n", typeIdx, locals: [], body: [], exported: false });
    return funcIdx;
  }

  // Local layout:
  //   0 = obj   (externref, param)
  //   1 = n     (f64, param)
  //   2 = iter  (externref)        the $IterRec, as externref
  //   3 = limit (i32)              n<0 ? -1 : trunc_sat(n)
  //   4 = cap   (i32)              backing-array capacity
  //   5 = len   (i32)              logical element count
  //   6 = data  (ref $arrExtern)   backing array
  //   7 = grow  (ref $arrExtern)   doubled array on growth
  //   8 = done  (i32)
  //   9 = value (externref)
  //  10 = srcAny (anyref)          guard scratch (#3100 S5 multi-arm drain test)
  const arrRef: ValType = { kind: "ref", typeIdx: arrTypeIdx };
  const locals: { name: string; type: ValType }[] = [
    { name: "iter", type: { kind: "externref" } },
    { name: "limit", type: { kind: "i32" } },
    { name: "cap", type: { kind: "i32" } },
    { name: "len", type: { kind: "i32" } },
    { name: "data", type: arrRef },
    { name: "grow", type: arrRef },
    { name: "done", type: { kind: "i32" } },
    { name: "value", type: { kind: "externref" } },
    { name: "srcAny", type: { kind: "anyref" } },
  ];

  const body = buildArrayFromIterNBody(
    { vecTypeIdx, arrTypeIdx },
    { iteratorIdx, iteratorNextIdx, iteratorReturnIdx: ctx.funcMap.get("__iterator_return") },
    [],
  );

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__array_from_iter_n", funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name: "__array_from_iter_n", typeIdx, locals, body, exported: false });
  return funcIdx;
}

/**
 * (#3206) Register a native standalone `__array_from_mapped(source, mapFn,
 * thisArg) -> externref` — the host-free lowering of `Array.from(source,
 * mapFn, thisArg)` (§23.1.2.1 with a mapper). This is the last harness-level
 * gate before the `built-ins/TypedArray/prototype/**` makeCtorArg family
 * (`harness/testTypedArray.js` `makeArray` = `Array.from({length:n}, fn)` /
 * `Array.from(iterable, fn)`) can execute its body — previously the mapFn arm
 * fell to the host `env.__array_from` + `env.__make_callback` bridge, both
 * unsatisfiable standalone (module failed to instantiate).
 *
 * `Array.from(source, mapFn, thisArg)` is `source.map(mapFn, thisArg)` after
 * normalizing an iterable source to an array-like carrier, so the body simply
 * composes two existing native helpers:
 *   - `__array_from_iter_n(source, -1)` drains an iterable source to a `$Vec`
 *     and passes an indexable carrier (`$Vec`/`$ObjVec`/`$Object {length}`/host
 *     array) through UNCHANGED (§23.1.2.1: iterator protocol if the source is
 *     iterable, else the array-like `length`/indexed walk which the downstream
 *     `__extern_length`/`__extern_get_idx` reader performs).
 *   - `__hof_map(recv, cb, thisArg)` runs the per-element loop, invoking the
 *     callback through the `__apply_closure` bridge with `(value, index, recv)`.
 *     `__apply_closure` clamps to the callback's declared arity (§2939) so a
 *     `(value, index)` mapper ignores the extra `recv` arg — exactly the
 *     `Array.from` mapFn contract; array-like holes read `undefined`.
 *
 * The `$ObjVec` result carrier is the same boxed-any array `.map` returns and
 * what the host `__array_from` handed back — the consumer reads it through the
 * dynamic `__extern_length`/`__extern_get_idx` arm.
 *
 * Standalone-only (the deps `__hof_map` / `__extern_*` array-like arms are
 * standalone-gated); returns `undefined` if the map HOF is unavailable so the
 * caller keeps the existing routing. Append-only (defined funcs — no funcIdx
 * shift); the composed `call` funcIdx are patched by `shiftLateImportIndices`
 * like any other defined body if a later import shifts them.
 */
export function ensureNativeArrayFromMapped(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get("__array_from_mapped");
  if (existing !== undefined) return existing;

  // Register the composed deps first so their funcIdx are stable reads.
  const afinIdx = ensureNativeArrayFromIterN(ctx);
  const hofMapIdx = ensureNativeArrayHof(ctx, "map");
  if (hofMapIdx === undefined) return undefined;

  // __array_from_mapped(source, mapFn, thisArg) =
  //   __hof_map(__array_from_iter_n(source, -1), mapFn, thisArg)
  const body: Instr[] = [
    { op: "local.get", index: 0 }, // source
    { op: "f64.const", value: -1 }, // unbounded drain
    { op: "call", funcIdx: afinIdx }, // → normalized array-like carrier
    { op: "local.get", index: 1 }, // mapFn (raw GC closure externref)
    { op: "local.get", index: 2 }, // thisArg (externref | null)
    { op: "call", funcIdx: hofMapIdx }, // → $ObjVec externref
  ];

  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__array_from_mapped", funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name: "__array_from_mapped", typeIdx, locals: [], body, exported: false });
  return funcIdx;
}

/**
 * Build the `__array_from_iter_n(obj, n)` body. Shared by the eager
 * registration (no user arms yet) and the (#3100 S5) finalize rebuild, which
 * passes `extraDrainTypeIdxs` — the closed-struct types carrying an
 * `@@iterator`/`next` method — so a custom-iterable source is genuinely
 * DRAINED through the `__iterator` USER arm (values + IteratorClose) instead
 * of passed through to the indexed reader (which cannot read it).
 *
 * The (#2904) guard rationale is unchanged for everything else: a non-`$Vec`,
 * non-user-iterable source (JS array, `$ObjVec`, typed vec) is returned
 * UNCHANGED for the caller's downstream `__extern_length`/`__extern_get_idx`
 * carrier reads — byte-equivalent to the host result for an indexable source
 * and never trapping.
 *
 * (#3100 S5) IteratorClose: when the bounded drain stops at the limit with the
 * iterator NOT done (§8.5.2/§13.15.5.2 — the pattern did not exhaust the
 * iterator), call `__iterator_return(iter)` before breaking. A VEC-kind record
 * no-ops; a USER record with a `return` method dispatches `__call_return`.
 *
 * All instruction objects are FRESH per call (factory discipline, #2169b).
 */
function buildArrayFromIterNBody(
  types: { vecTypeIdx: number; arrTypeIdx: number },
  funcs: { iteratorIdx: number; iteratorNextIdx: number; iteratorReturnIdx: number | undefined },
  extraDrainTypeIdxs: number[],
  // (#3119) When set, a source with a truthy `@@iterator` PROPERTY (the
  // post-hoc `o[Symbol.iterator] = fn` install) is admitted to the drain —
  // the ladder's OBJ arm can drive it. `@@iterator`-less sources keep the
  // indexed pass-through (#2904 rationale).
  objGuard?: Pick<ObjCarrierDeps, "externGetIdx" | "boxSymbolIdx" | "isTruthyIdx">,
): Instr[] {
  const { vecTypeIdx, arrTypeIdx } = types;
  const { iteratorIdx, iteratorNextIdx, iteratorReturnIdx } = funcs;

  // Build an empty `__vec_externref` and convert to externref.
  const emptyVec: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" },
  ];

  // Grow: cap *= 2; grow = new array[cap]; array.copy grow[0..len]=data[0..len]; data = grow.
  const growInstrs: Instr[] = [
    { op: "local.get", index: 4 },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 4 },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: 7 },
    { op: "local.get", index: 7 }, // dst
    { op: "i32.const", value: 0 }, // dstOffset
    { op: "local.get", index: 6 }, // src
    { op: "i32.const", value: 0 }, // srcOffset
    { op: "local.get", index: 5 }, // len
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
    { op: "local.get", index: 7 },
    { op: "local.set", index: 6 },
  ];

  const loopBody: Instr[] = [
    // Bounded break: if (limit >= 0) && (len >= limit) → IteratorClose + break.
    // Depth accounting: inside the `if.then` below, 0 = the if, 1 = the loop,
    // 2 = the outer block — so the break out of the drain is `br 2`.
    { op: "local.get", index: 3 },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "local.get", index: 5 },
    { op: "local.get", index: 3 },
    { op: "i32.ge_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // (#3100 S5) The iterator is NOT done here by construction (a done
        // iterator breaks via the done-branch below without reaching the
        // bound) → IteratorClose per §8.5.2/§13.15.5.2.
        ...(iteratorReturnIdx !== undefined
          ? ([
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: iteratorReturnIdx },
            ] satisfies Instr[])
          : []),
        { op: "br", depth: 2 },
      ],
      else: [],
    },
    // (done, value) = __iterator_next(iter)
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: iteratorNextIdx },
    { op: "local.set", index: 9 }, // value (top of stack)
    { op: "local.set", index: 8 }, // done
    // if done → break (exhausted ⇒ [[Done]] true ⇒ NO IteratorClose, §7.4.9)
    { op: "local.get", index: 8 },
    { op: "br_if", depth: 1 },
    // grow if len == cap
    { op: "local.get", index: 5 },
    { op: "local.get", index: 4 },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: growInstrs, else: [] },
    // data[len] = value
    { op: "local.get", index: 6 },
    { op: "local.get", index: 5 },
    { op: "local.get", index: 9 },
    { op: "array.set", typeIdx: arrTypeIdx },
    // len++
    { op: "local.get", index: 5 },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: 5 },
    { op: "br", depth: 0 },
  ];

  // Drainability guard: canDrain = ref.test $Vec ∨ (ref.test each user-iterable
  // struct). Everything else passes through unchanged (#2904 rationale above).
  const drainTest: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: 10 },
    { op: "local.get", index: 10 },
    { op: "ref.test", typeIdx: vecTypeIdx },
  ];
  for (const t of extraDrainTypeIdxs) {
    drainTest.push({ op: "local.get", index: 10 }, { op: "ref.test", typeIdx: t }, { op: "i32.or" });
  }
  if (objGuard) {
    // (#3119) ∨ truthy(__extern_get(src, @@iterator)) — the post-hoc
    // `o[Symbol.iterator] = fn` install. Property read, so it needs no
    // `ref.test`: non-`$Object` sources answer the miss (falsy) and keep the
    // pass-through. `@@iterator` is well-known symbol id 1 (#2866 `$Symbol`
    // carrier, id-compared in `__obj_find`).
    drainTest.push(
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 1 },
      { op: "call", funcIdx: objGuard.boxSymbolIdx },
      { op: "call", funcIdx: objGuard.externGetIdx },
      { op: "call", funcIdx: objGuard.isTruthyIdx },
      { op: "i32.or" },
    );
  }

  return [
    // null/undefined guard → return empty vec (host `_arrayFromIter(null) → []`).
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [...emptyVec, { op: "return" }], else: [] },
    ...drainTest,
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "return" }],
      else: [],
    },
    // iter = __iterator(obj)  (a `$Vec` or a user-iterable closed struct)
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: iteratorIdx },
    { op: "local.set", index: 2 },
    // limit = (n < 0) ? -1 : trunc_sat(n)
    { op: "local.get", index: 1 },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: -1 }],
      else: [{ op: "local.get", index: 1 }, { op: "i32.trunc_sat_f64_s" }],
    },
    { op: "local.set", index: 3 },
    // cap = 4; data = array.new_default(4); len = 0
    { op: "i32.const", value: 4 },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 4 },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: 6 },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 5 },
    // drain loop
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    },
    // return $Vec{len, data} as externref
    { op: "local.get", index: 5 },
    { op: "local.get", index: 6 },
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" },
  ];
}

/**
 * (#3100 S5) Standalone/WASI consumer helper: replace `externLocal`'s value
 * with `__array_from_iter_n(value, -1)` — an unbounded iterator-protocol
 * materialization. For every INDEXABLE carrier (`$Vec`, typed vecs, `$ObjVec`,
 * host arrays) the materializer passes the value through UNCHANGED, so the
 * caller's indexed reads behave exactly as before; for a USER custom-iterable
 * closed struct it drains through the `__iterator` ladder (values + protocol),
 * which the indexed reads cannot do. No-op in JS-host mode (the host lane
 * materializes via its own `__array_from_iter` import where it needs to).
 * Registration is append-only defined funcs — no import shift, no flush.
 */
export function emitStandaloneIterableMaterialize(
  ctx: CodegenContext,
  fctx: { body: Instr[] },
  externLocal: number,
): void {
  if (!ctx.standalone && !ctx.wasi) return;
  const afinIdx = ensureNativeArrayFromIterN(ctx);
  if (afinIdx === undefined) return;
  fctx.body.push({ op: "local.get", index: externLocal });
  fctx.body.push({ op: "f64.const", value: -1 });
  fctx.body.push({ op: "call", funcIdx: afinIdx });
  fctx.body.push({ op: "local.set", index: externLocal });
}

/**
 * (#3100 S4) Register a native standalone `__extern_slice(externref, f64) ->
 * externref` defined function — the rest-element slice every array-destructure
 * consumer uses (`[a, ...r] = src` assignment, `const [a, ...r] = src` string
 * rest, for-of destructuring rest). In JS-host mode this is an `env::` import
 * (host `Array.prototype.slice` semantics); standalone previously LEAKED that
 * import (raw `addImport` at each consumer), breaking zero-import
 * instantiation — the `__extern_slice` rows of the standalone JSONL.
 *
 * Semantics (index-based, mirroring the host `_externSlice(src, start)` for
 * indexable sources):
 *   - `$AnyString` source → per-CODE-POINT rest (§22.1.5.1) via the #1470
 *     `__str_to_char_vec` helper: `[a, ...r] = "hello"` → r = ["e","l","l","o"].
 *   - anything `__extern_length`/`__extern_get_idx` can read (canonical `$Vec`,
 *     typed `__vec_*` carriers, `$ObjVec`, array-like `$Object` — the #2190
 *     carrier arms) → copy elements [start..len) into a fresh canonical
 *     externref `$Vec`.
 *   - non-indexable / null → empty `$Vec` (never traps; matches the host
 *     import's degenerate fallback).
 *
 * Index-based rather than `__iterator`-ladder-based BY DESIGN: every consumer
 * calls it on an already-MATERIALIZED source (post-`__array_from_iter_n` /
 * a for-of element), so iterator-protocol re-entry would be observable
 * double-stepping; the indexed read is side-effect-free and covers every
 * carrier the read substrate covers, in one place.
 *
 * Registered as a DEFINED function (append-only, no import-index shift). The
 * baked `call` funcIdxs (`__extern_length`, `__extern_get_idx`,
 * `__str_to_char_vec`) live in a defined body, which every later
 * `shiftLateImportIndices` walk patches like any other defined function.
 */
export function ensureNativeExternSlice(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get("__extern_slice");
  if (existing !== undefined) return existing;

  // Native readers (defined funcs under standalone/wasi — ensureObjectRuntime
  // is idempotent and registers both names in funcMap).
  ensureObjectRuntime(ctx);
  const lenIdx = ctx.funcMap.get("__extern_length");
  const getIdxIdx = ctx.funcMap.get("__extern_get_idx");
  if (lenIdx === undefined || getIdxIdx === undefined) return undefined;

  // Canonical externref $Vec geometry for the result.
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return undefined;

  // ($AnyString arm) — only when the native-string runtime is active (it always
  // is under standalone/wasi, where nativeStrings auto-enables). The helper call
  // registers the string runtime if a string literal hasn't already.
  const strArm: Instr[] = [];
  let charVecGeom: { funcIdx: number; vecTypeIdx: number } | undefined;
  if (ctx.nativeStrings) {
    charVecGeom = ensureStrToCharVecHelper(ctx);
  }

  // Local layout:
  //   0 = src   (externref, param)
  //   1 = start (f64, param)
  //   2 = s     (i32)  clamped start index
  //   3 = len   (i32)  source length
  //   4 = n     (i32)  result length
  //   5 = j     (i32)  write cursor
  //   6 = out   (ref null $arrExtern)
  //   7 = srcAny(anyref) — for the $AnyString ref.test
  const locals: { name: string; type: ValType }[] = [
    { name: "s", type: { kind: "i32" } },
    { name: "len", type: { kind: "i32" } },
    { name: "n", type: { kind: "i32" } },
    { name: "j", type: { kind: "i32" } },
    { name: "out", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
    { name: "srcAny", type: { kind: "anyref" } },
  ];

  if (charVecGeom !== undefined) {
    const anyStrTypeIdx = ctx.anyStrTypeIdx;
    const charVecTypeIdx = charVecGeom.vecTypeIdx;
    const charArrTypeIdx = getArrTypeIdxFromVec(ctx, charVecTypeIdx);
    if (anyStrTypeIdx >= 0 && charArrTypeIdx >= 0) {
      // Normalize the string into its per-code-point char vec and REPLACE the
      // src param with it, then FALL THROUGH to the generic indexed copy — the
      // char vec is a `__vec_ref_<anyStr>` carrier that `__extern_length`
      // (vec-base arm) and `__extern_get_idx` (#2190 vec arms, each element
      // `extern.convert_any`-boxed) read natively. No recursion, no per-arm
      // copy loop of its own.
      strArm.push(
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: 7 },
        { op: "ref.test", typeIdx: anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 7 },
            { op: "ref.cast", typeIdx: anyStrTypeIdx },
            { op: "call", funcIdx: charVecGeom.funcIdx },
            { op: "extern.convert_any" },
            { op: "local.set", index: 0 },
          ],
          else: [],
        },
      );
    }
  }

  const body: Instr[] = [
    ...strArm,
    // len = i32(__extern_length(src))  (null / non-indexable → 0 → empty vec)
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: lenIdx },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: 3 },
    // s = max(0, trunc(start))
    { op: "local.get", index: 1 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: 2 },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: 2 },
      ],
      else: [],
    },
    // n = max(0, len - s)
    { op: "local.get", index: 3 },
    { op: "local.get", index: 2 },
    { op: "i32.sub" },
    { op: "local.tee", index: 4 },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: 4 },
      ],
      else: [],
    },
    // out = array.new_default(n)
    { op: "local.get", index: 4 },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: 6 },
    // j = 0; while (j < n) out[j] = __extern_get_idx(src, f64(s + j)), j++
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 5 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 5 },
            { op: "local.get", index: 4 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 6 },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 5 },
            { op: "local.get", index: 0 },
            { op: "local.get", index: 2 },
            { op: "local.get", index: 5 },
            { op: "i32.add" },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: getIdxIdx },
            { op: "array.set", typeIdx: arrTypeIdx },
            { op: "local.get", index: 5 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 5 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // return $Vec{n, out} as externref
    { op: "local.get", index: 4 },
    { op: "local.get", index: 6 },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__extern_slice", funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name: "__extern_slice", typeIdx, locals, body, exported: false });
  return funcIdx;
}

/**
 * (#4447) Resolve a `__sget_<field>` getter ONLY when it actually has the
 * extern signature `(externref) -> externref`.
 *
 * A field getter's RESULT type follows the FIELD's type, so a module whose
 * `done` field is numeric emits `__sget_done : (externref) -> f64`. The
 * iterator-result arms feed that value straight into `__is_truthy`
 * (`(externref) -> i32`), which is invalid Wasm. Before #4447 the mismatch was
 * masked: the arm was emitted only when `__sget_value` ALSO existed, and those
 * modules happened to have an externref `done`. Making the two getters
 * independent (so a conformant `{ done: … }`-only IteratorResult reports its
 * real `done`) exposed it — `Iterator.from([1,2,3])` produced
 * "call[0] expected type externref, found block of type f64" in
 * `__iterator_next`. A non-extern getter answers `undefined` here, which keeps
 * the new done-only arm off and leaves the existing degrade in place.
 *
 * This gate is ADDITIVE: the pre-existing both-getters-present path is not
 * routed through it, so modules that compiled before are byte-identical.
 */
function externSgetIdx(ctx: CodegenContext, name: string): number | undefined {
  const idx = ctx.funcMap.get(name);
  if (idx === undefined) return undefined;
  const fn = definedFuncAt(ctx, idx);
  if (!fn) return undefined;
  const t = ctx.mod.types[fn.typeIdx];
  if (!t || t.kind !== "func") return undefined;
  if (t.params.length !== 1 || t.params[0]?.kind !== "externref") return undefined;
  if (t.results.length !== 1 || t.results[0]?.kind !== "externref") return undefined;
  return idx;
}

/**
 * (#2038 / #3100, reserve-then-fill #1719) Rebuild the `__iterator` (and, with
 * USER deps, `__iterator_next`) bodies with the LATE ladder arms at finalize:
 *
 *   - (#3100) the vec-FAMILY normalization arms — `$ObjVec` (Object.keys/
 *     values/entries results) and every module-local `__vec_<elemKind>`
 *     carrier with a proven element-boxing recipe. These are only enumerable
 *     at FINALIZE (array literals of a given element kind may compile after
 *     the runtime registers — the same reason `fillExternGetIdxVecArms`
 *     fills late). Filled INDEPENDENTLY of the USER dispatchers, so a module
 *     with no custom iterable still iterates `Object.keys(<any>)` natively.
 *   - (#2038) the USER `{next()}`-protocol arm, when the closed-struct
 *     dispatchers (`__call_@@iterator`, `__call_next`, `__sget_value`,
 *     `__sget_done`) and `__is_truthy` exist. `__iterator_next` is rebuilt
 *     ONLY in this case — without the USER arm the kind is always VEC (the
 *     family arms normalize INTO the canonical vec), so the vec-only next/rest
 *     bodies stay correct as-is.
 *
 * No-op when the native runtime was never registered
 * (`!nativeIteratorUserArmPending`) or when neither arm set applies — the
 * carrier stays vec-only and byte-identical.
 *
 * MUST be called AFTER `emitStructFieldGetters` + `emitIteratorMethodExport` in
 * the finalize sequence. Storing the carrier funcIdx in `funcMap` (and looking it
 * up post-shift here) keeps it in lockstep with any late-import index shift.
 */
export function fillNativeIteratorLateArms(ctx: CodegenContext): void {
  if (!ctx.nativeIteratorUserArmPending) return;

  const callIteratorIdx = ctx.funcMap.get("__call_@@iterator");
  const callNextIdx = ctx.funcMap.get("__call_next");
  const sgetValueIdx = ctx.funcMap.get("__sget_value");
  const sgetDoneIdx = ctx.funcMap.get("__sget_done");
  // (#4447) Only gates the NEW `{ done }`-only arm; the pre-existing
  // both-getters-present path is untouched (byte-identical).
  const sgetDoneIsExtern = externSgetIdx(ctx, "__sget_done") !== undefined;
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  const deps: UserCarrierDeps | undefined =
    callNextIdx === undefined || isTruthyIdx === undefined
      ? // No closed-struct iterator carrier in this module (or no truthiness
        // helper) → no USER arm. Custom iterables, if any, keep trapping
        // exactly as on the pre-#2038 runtime rather than shipping a broken
        // arm. The (#3100) vec-family arms below fill regardless.
        undefined
      : {
          // (#3146) optional — absent when NO struct carries `[Symbol.iterator]`
          // (bare `{next()}` iterator carriers only); the tail then treats the
          // subject as its own iterator.
          callIteratorIdx,
          callNextIdx,
          sgetValueIdx,
          sgetDoneIdx,
          sgetDoneIsExtern,
          isTruthyIdx,
          // (#3100 S5) optional — only when some struct has a `return` method.
          callReturnIdx: ctx.funcMap.get("__call_return"),
        };

  // (#3119) OBJ-arm deps — the plain-`$Object` `@@iterator` protocol arm.
  // Independent of the closed-struct USER deps: a module whose only custom
  // iterable is a post-hoc `o[Symbol.iterator] = fn` install has NO closed
  // dispatchers, yet must iterate. Gated on the object runtime + `$Symbol`
  // boxer + ToBoolean existing (standalone/wasi only — host mode keeps the
  // env-import iterator lane and stays byte-identical). `__apply_closure` is
  // reserve-then-fill (#1888): reserving here (a DEFINED func mint, append-only)
  // is safe at finalize because `fillApplyClosure` runs AFTER this fill in the
  // finalize sequence (index.ts), with the `__call_fn_method_N` dispatchers
  // emitted in between.
  let objDeps: ObjCarrierDeps | undefined;
  if (ctx.standalone || ctx.wasi) {
    const externGetIdx = ctx.funcMap.get("__extern_get");
    const boxSymbolIdx = ctx.funcMap.get("__box_symbol");
    const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
    if (
      externGetIdx !== undefined &&
      boxSymbolIdx !== undefined &&
      objectTypeIdx !== undefined &&
      isTruthyIdx !== undefined &&
      ctx.nativeStrTypeIdx >= 0
    ) {
      objDeps = {
        externGetIdx,
        boxSymbolIdx,
        objectTypeIdx,
        isTruthyIdx,
        applyClosureIdx: reserveApplyClosure(ctx),
        sgetValueIdx: ctx.funcMap.get("__sget_value"),
        sgetDoneIdx: ctx.funcMap.get("__sget_done"),
        sgetDoneIsExtern,
        sgetNextIdx: ctx.funcMap.get("__sget_next"),
        sgetReturnIdx: ctx.funcMap.get("__sget_return"),
        keyInstrs: (name: string) => [...nativeStringLiteralInstrs(ctx, name), { op: "extern.convert_any" }],
        missInstrs: () => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }],
      };
    }
  }

  // (#3075) HOSTGEN-arm deps — the legacy eager-buffer generator HOST imports.
  // Present exactly when some generator body bailed to the host path under
  // standalone/wasi (`sourceNeedsGeneratorHostImports`) — the module already
  // carries the imports, so driving them adds no new host dependency. Without
  // them (the common zero-import standalone module) every body below is
  // byte-identical.
  let hostDeps: HostGenDeps | undefined;
  // (#3132) Gate on a legacy-buffer generator having actually EMITTED — not on
  // the eagerly-registered `__gen_*` imports being in funcMap. In an
  // all-driven module the bundle may be registered yet unreferenced (dead
  // imports, eliminated); building the arm would pin them and break the
  // zero-import host-free contract.
  if ((ctx.standalone || ctx.wasi) && ctx.legacyGenBufferEmitted === true) {
    const genNextIdx = ctx.funcMap.get("__gen_next");
    const genResultDoneIdx = ctx.funcMap.get("__gen_result_done");
    const genResultValueIdx = ctx.funcMap.get("__gen_result_value");
    if (genNextIdx !== undefined && genResultDoneIdx !== undefined && genResultValueIdx !== undefined) {
      hostDeps = {
        genNextIdx,
        genResultDoneIdx,
        genResultValueIdx,
        genReturnIdx: ctx.funcMap.get("__gen_return"),
      };
    }
  }

  // (#3132 S1) ASYNCGEN-arm deps — the driven native async-generator frame
  // carriers. Present exactly when some `emitAsyncGenerator` producer
  // registered (standalone/wasi drive lane); each dispatches to its own
  // `__async_gen_next_<stem>` driver. Modules without producers (or whose
  // promise/result types never materialized) are byte-identical.
  let agDeps: AsyncGenCarrierDeps | undefined;
  if ((ctx.standalone || ctx.wasi) && ctx.asyncGenProducers !== undefined && ctx.asyncGenProducers.size > 0) {
    const promiseTypeIdx = ctx.structMap.get("$Promise");
    const resultTypeIdx = ctx.structMap.get("__NativeGeneratorResult_externref");
    if (promiseTypeIdx !== undefined && resultTypeIdx !== undefined) {
      const producers: { stateTypeIdx: number; nextIdx: number }[] = [];
      const seenFrames = new Set<number>();
      for (const p of ctx.asyncGenProducers.values()) {
        const nextIdx = ctx.funcMap.get(p.nextHelperName);
        if (nextIdx === undefined || seenFrames.has(p.stateTypeIdx)) continue;
        seenFrames.add(p.stateTypeIdx);
        producers.push({ stateTypeIdx: p.stateTypeIdx, nextIdx });
      }
      producers.sort((a, b) => a.stateTypeIdx - b.stateTypeIdx);
      if (producers.length > 0) agDeps = { producers, promiseTypeIdx, resultTypeIdx };
    }
  }

  // (#3164) GENSTATE-arm deps — driven native SYNC generator frames. Present
  // exactly when some native generator's resume function emitted
  // (standalone/wasi drive lane; a factory compile ensures the resume — see
  // `compileNativeGeneratorFunction`). Modules without native generators are
  // byte-identical. `f64TmpIdx` names the scratch local appended to
  // `__iterator_next` below (params(1) + reserve-time locals(6) = index 7).
  let sgDeps: SyncGenCarrierDeps | undefined;
  if ((ctx.standalone || ctx.wasi) && ctx.nativeGenerators.size > 0) {
    const sgProducers: SyncGenCarrierDeps["producers"] = [];
    const seenStates = new Set<number>();
    for (const info of ctx.nativeGenerators.values()) {
      if (info.resumeFuncIdx === undefined || seenStates.has(info.stateTypeIdx)) continue;
      seenStates.add(info.stateTypeIdx);
      sgProducers.push({
        stateTypeIdx: info.stateTypeIdx,
        resumeIdx: info.resumeFuncIdx,
        resultTypeIdx: info.resultTypeIdx,
        elemValType: info.elemValType,
        doneState: info.doneState,
      });
    }
    sgProducers.sort((a, b) => a.stateTypeIdx - b.stateTypeIdx);
    if (sgProducers.length > 0) {
      sgDeps = { producers: sgProducers, boxNumIdx: ctx.funcMap.get("__box_number"), f64TmpIdx: 7 };
    }
  }

  const types = iterRuntimeTypes(ctx);

  // (#3146) STRING subjects — `Iterator.from("ab")`, a string element reaching
  // a dynamic GetIterator. Normalize the string into its per-code-point char
  // vec (`__str_to_char_vec`, the #1470 helper `__extern_slice` reuses) and
  // REPLACE objAny (local 1) with it, then FALL THROUGH to the family arms:
  // the char vec is a `__vec_ref_<anyStr>` carrier the collector admits
  // (string-GC-ref elements box via `extern.convert_any`). Registering the
  // helper BEFORE `buildVecFamilyArms` puts its vec type in `ctx.vecTypeMap`
  // in time for the collection. Defined-func appends only — fill-safe (same
  // discipline as `reserveApplyClosure`).
  const stringArm: Instr[] = [];
  if (ctx.nativeStrings) {
    const charVecGeom = ensureStrToCharVecHelper(ctx);
    if (ctx.anyStrTypeIdx >= 0) {
      stringArm.push(
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "call", funcIdx: charVecGeom.funcIdx },
            { op: "local.set", index: 1 },
          ],
          else: [],
        },
      );
    }
  }

  const familyArms = [...stringArm, ...buildVecFamilyArms(ctx, types)];
  if (!deps && !objDeps && !hostDeps && !agDeps && !sgDeps && familyArms.length === 0) return; // nothing to fill — byte-identical

  const iteratorIdx = ctx.funcMap.get("__iterator");
  const iteratorNextIdx = ctx.funcMap.get("__iterator_next");
  if (iteratorIdx === undefined || iteratorNextIdx === undefined) return;

  const iteratorFn = definedFuncAt(ctx, iteratorIdx);
  const iteratorNextFn = definedFuncAt(ctx, iteratorNextIdx);
  if (iteratorFn)
    iteratorFn.body = buildIteratorBody(
      types,
      deps,
      familyArms,
      objDeps,
      hostDeps,
      agDeps,
      callIteratorIdx,
      sgDeps,
      nonIterableThrowInstrs(ctx), // (#3388) throw §7.4.1 TypeError, not trap
    );
  if ((deps || objDeps || hostDeps || agDeps || sgDeps) && iteratorNextFn) {
    // (#3164) The GENSTATE step's sentinel-aware f64 boxing needs an f64
    // scratch local; append it at fill time (locals are read at emit, after
    // this fill — same discipline as the #3100 S5 `__iterator_rest` locals
    // swap). Index = params(1) + reserve-time locals(6) = 7 (`sgDeps.f64TmpIdx`).
    if (sgDeps && iteratorNextFn.locals.length === 6) {
      iteratorNextFn.locals.push({ name: "__gen_f64tmp", type: { kind: "f64" } });
    }
    iteratorNextFn.body = buildIteratorNextBody(types, deps, objDeps, hostDeps, agDeps, sgDeps);
  }

  // (#3100 S5) `__iterator_rest` was VEC-only — a USER record (custom iterable)
  // drained EMPTY under `[...iterable]` / `Array.from(iterable)`. Rebuild it
  // with a USER arm that steps the (just-rebuilt) `__iterator_next` to
  // exhaustion into a fresh canonical `$Vec` (exhaustion ⇒ [[Done]] ⇒ no
  // IteratorClose, §7.4.9). Locals are replaced alongside the body — the
  // encoder reads both at emit, after this fill.
  // (#3119) OBJ records drain through the SAME step-to-exhaustion arm (the
  // kind dispatch lives inside `__iterator_next`), so the guard admits every
  // step-driven kind the GetIterator ladder can produce in this module.
  if (deps || objDeps || hostDeps || agDeps || sgDeps) {
    const stepKinds: number[] = [];
    if (deps) stepKinds.push(ITER_KIND_USER);
    if (objDeps) stepKinds.push(ITER_KIND_OBJ);
    if (hostDeps) stepKinds.push(ITER_KIND_HOSTGEN); // (#3075) drain via __iterator_next
    if (agDeps) stepKinds.push(ITER_KIND_ASYNCGEN); // (#3132) drain via __iterator_next
    if (sgDeps) stepKinds.push(ITER_KIND_GENSTATE); // (#3164) drain via __iterator_next
    const iteratorRestIdx = ctx.funcMap.get("__iterator_rest");
    const iteratorRestFn = iteratorRestIdx !== undefined ? definedFuncAt(ctx, iteratorRestIdx) : undefined;
    if (iteratorRestFn) {
      iteratorRestFn.locals = [
        { name: "rec", type: { kind: "ref", typeIdx: types.iterRecTypeIdx } },
        { name: "vec", type: { kind: "ref_null", typeIdx: types.vecTypeIdx } },
        { name: "i", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "out", type: { kind: "ref_null", typeIdx: types.arrTypeIdx } },
        { name: "j", type: { kind: "i32" } },
        { name: "done", type: { kind: "i32" } },
        { name: "value", type: { kind: "externref" } },
        { name: "grow", type: { kind: "ref_null", typeIdx: types.arrTypeIdx } },
      ];
      iteratorRestFn.body = buildIteratorRestBodyWithUserArm(types, iteratorNextIdx, stepKinds);
    }
  }

  // (#3100 S5) IteratorClose: rebuild `__iterator_return` with the USER close
  // arm when a `return` dispatcher exists. Without one, close on a USER record
  // finds no `return` method ⇒ NormalCompletion (§7.4.9 step 4) — the eager
  // empty body is already exactly that, so it stays untouched (byte-identical).
  // (#3119) The OBJ close arm (`__extern_get(iterObj, "return")` +
  // `__apply_closure`) fills independently — a plain-object iterator's
  // `return` is a PROPERTY, reachable without any closed-struct dispatcher.
  if (
    (deps && deps.callReturnIdx !== undefined) ||
    objDeps ||
    hostDeps?.genReturnIdx !== undefined ||
    sgDeps !== undefined
  ) {
    const iteratorReturnIdx = ctx.funcMap.get("__iterator_return");
    const iteratorReturnFn = iteratorReturnIdx !== undefined ? definedFuncAt(ctx, iteratorReturnIdx) : undefined;
    if (iteratorReturnFn) {
      iteratorReturnFn.locals = [
        { name: "recAny", type: { kind: "anyref" } },
        { name: "userIter", type: { kind: "externref" } },
        // (#3119) `ret` scratch for the OBJ close arm — harmless when unused.
        ...(objDeps ? [{ name: "ret", type: { kind: "externref" as const } }] : []),
      ];
      iteratorReturnFn.body = buildIteratorReturnBody(types, deps?.callReturnIdx, objDeps, hostDeps, sgDeps);
    }
  }

  // (#3100 S5) Rebuild `__array_from_iter_n` so USER-iterable closed structs
  // (an `@@iterator` or `next` method registered) are genuinely DRAINED through
  // the `__iterator` USER arm — values AND IteratorClose — instead of passed
  // through to the indexed reader (which cannot read them). Gated on `deps`:
  // without the USER arm a custom-iterable drain would hit the hard-cast tail.
  // (#3119) With `objDeps`, a source carrying a truthy `@@iterator` PROPERTY
  // (post-hoc `o[Symbol.iterator] = fn`) is likewise admitted to the drain;
  // `@@iterator`-less array-like `$Object`s keep the indexed pass-through.
  // (#2903 R3) Admit the lazy Iterator-helper wrapper `$LazyIterHelper` to the
  // `__array_from_iter_n` drain: `Array.from(g().map(f))` / spread must DRIVE it
  // (via the `__iterator`/`__iterator_next` prepends `fillLazyIterLadderArms`
  // adds later in finalize) rather than pass the wrapper through to the indexed
  // reader. The prepends run AFTER this fill, but the drain loop calls them at
  // runtime, so ordering is irrelevant.
  const lazyHelperTypeIdx = ctx.structMap.get("$LazyIterHelper");
  if (deps || objDeps || sgDeps || lazyHelperTypeIdx !== undefined) {
    const afinIdx = ctx.funcMap.get("__array_from_iter_n");
    const afinFn = afinIdx !== undefined ? definedFuncAt(ctx, afinIdx) : undefined;
    if (afinFn && afinFn.body.length > 0) {
      // Closed-struct drain candidates need the USER arm; without `deps` they
      // would hit the ladder's hard-cast tail, so admit them only with `deps`.
      const userTypeIdxs = deps ? collectUserIterableStructTypeIdxs(ctx) : [];
      // (#3164) Native sync-generator frames are drainable through the
      // GENSTATE arm just filled above — admit their state struct types so an
      // externref-held generator (the fn-expr closure return / `g: any`)
      // destructures by actually DRIVING the generator instead of passing
      // through to the indexed reader (which answers length 0 → every binding
      // silently `undefined`).
      const genStateTypeIdxs = sgDeps ? sgDeps.producers.map((p) => p.stateTypeIdx) : [];
      const lazyTypeIdxs = lazyHelperTypeIdx !== undefined ? [lazyHelperTypeIdx] : [];
      if (userTypeIdxs.length > 0 || objDeps || genStateTypeIdxs.length > 0 || lazyTypeIdxs.length > 0) {
        afinFn.body = buildArrayFromIterNBody(
          { vecTypeIdx: types.vecTypeIdx, arrTypeIdx: types.arrTypeIdx },
          {
            iteratorIdx,
            iteratorNextIdx,
            iteratorReturnIdx: ctx.funcMap.get("__iterator_return"),
          },
          [...userTypeIdxs, ...genStateTypeIdxs, ...lazyTypeIdxs],
          objDeps,
        );
      }
    }
  }
}

/**
 * (#3100 S5) Closed-struct types that carry an iterator-protocol method —
 * `<Struct>_@@iterator` (an iterable) or `<Struct>_next` (an iterator object).
 * These are the subjects the `__iterator` USER arm can drive, so the
 * `__array_from_iter_n` drainability guard admits them. Same struct filter as
 * `emitIteratorMethodExport` (index.ts). Sorted for deterministic emission.
 */
function collectUserIterableStructTypeIdxs(ctx: CodegenContext): number[] {
  const out: number[] = [];
  for (const [structName] of ctx.structFields) {
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    )
      continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    if (ctx.funcMap.has(`${structName}_@@iterator`) || ctx.funcMap.has(`${structName}_next`)) {
      out.push(typeIdx);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * (#3100 S5) Build the `__iterator_return(recExt) -> ()` body — IteratorClose
 * §7.4.9 for the USER carrier: call the iterator's `return` method through the
 * closed-struct `__call_return` dispatcher, discarding its result. Every
 * non-USER shape (VEC records — array iteration has no observable `return` —
 * a null/foreign externref after drift) exits early; the body NEVER traps.
 * The §7.4.9 "innerResult not an Object ⇒ TypeError" refinement is deferred,
 * matching the `__iterator_next` §7.4.4 refinement note (#2038).
 *
 * (#3119) OBJ close arm (when `objDeps`): `ret = __extern_get(iterObj,
 * "return")` — absent/undefined ⇒ NormalCompletion no-op (GetMethod §7.3.10:
 * undefined/null → no close call); else `__apply_closure(ret, iterObj, [])`,
 * result dropped. Fills independently of `callReturnIdx` (a plain-object
 * iterator's `return` is a property, not a closed-struct method).
 *
 * Locals (set at fill): 1 = recAny (anyref), 2 = userIter (externref),
 * 3 = ret (externref, only when `objDeps`).
 */
function buildIteratorReturnBody(
  types: IterRuntimeTypes,
  callReturnIdx: number | undefined,
  objDeps: ObjCarrierDeps | undefined,
  hostDeps?: HostGenDeps,
  sgDeps?: SyncGenCarrierDeps,
): Instr[] {
  const { iterRecTypeIdx } = types;
  // (#3164) kind == GENSTATE → IteratorClose marks the sync-generator frame
  // COMPLETED (`state := doneState`): a subsequent `.next()` then answers
  // `{value: undefined, done: true}` (§27.5.3.3 — the generator moves to
  // "completed"). Running a finally block on early close is out of scope
  // (same boundary as the #2903 iter-hof `close`). Per-producer type-switch;
  // an unmatched frame falls through (defensive no-op).
  const genStateClose: Instr[] = sgDeps
    ? [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: iterRecTypeIdx },
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: ITER_KIND_GENSTATE },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...sgDeps.producers.flatMap((p): Instr[] => [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: iterRecTypeIdx },
              { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: p.stateTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 1 },
                  { op: "ref.cast", typeIdx: iterRecTypeIdx },
                  { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
                  { op: "any.convert_extern" },
                  { op: "ref.cast", typeIdx: p.stateTypeIdx },
                  { op: "i32.const", value: p.doneState },
                  { op: "struct.set", typeIdx: p.stateTypeIdx, fieldIdx: GENSTATE_STATE_FIELD },
                  { op: "return" },
                ],
                else: [],
              },
            ]),
            { op: "return" },
          ],
          else: [],
        },
      ]
    : [];
  // (#3075) kind == HOSTGEN → IteratorClose via the host `__gen_return`
  // import (gen.return(undefined), result dropped — marks the buffered
  // generator exhausted). Absent import ⇒ arm not filled ⇒ NormalCompletion
  // no-op, matching the USER/OBJ discipline.
  const hostClose: Instr[] =
    hostDeps?.genReturnIdx !== undefined
      ? [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: iterRecTypeIdx },
          { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: ITER_KIND_HOSTGEN },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: iterRecTypeIdx },
              { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
              { op: "ref.null.extern" },
              { op: "call", funcIdx: hostDeps.genReturnIdx },
              { op: "drop" },
              { op: "return" },
            ],
            else: [],
          },
        ]
      : [];
  // (#3119) kind == OBJ → property-read close. Placed BEFORE the USER-kind
  // early-return so both arms coexist; empty when the OBJ arm is not filled
  // (byte-identical to the #3100 S5 body).
  const objClose: Instr[] = objDeps
    ? [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: iterRecTypeIdx },
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: ITER_KIND_OBJ },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // userIter = rec.userIter; nullish/undefined → no-op.
            { op: "local.get", index: 1 },
            { op: "ref.cast", typeIdx: iterRecTypeIdx },
            { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
            { op: "local.tee", index: 2 },
            { op: "call", funcIdx: objDeps.isTruthyIdx },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }], else: [] },
            // ret = Get(userIter, "return") — carrier-branched like the step
            // arm's `next` read; miss/undefined → no-op (§7.4.9 step 4
            // NormalCompletion).
            { op: "local.get", index: 2 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: objDeps.objectTypeIdx },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: [
                { op: "local.get", index: 2 },
                ...objDeps.keyInstrs("return"),
                { op: "call", funcIdx: objDeps.externGetIdx },
              ],
              else:
                objDeps.sgetReturnIdx !== undefined
                  ? [
                      { op: "local.get", index: 2 },
                      { op: "call", funcIdx: objDeps.sgetReturnIdx },
                    ]
                  : objDeps.missInstrs(),
            },
            { op: "local.tee", index: 3 },
            { op: "call", funcIdx: objDeps.isTruthyIdx },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }], else: [] },
            // __apply_closure(ret, userIter, []) — drop the result.
            { op: "local.get", index: 3 },
            { op: "local.get", index: 2 },
            ...emptyArgsVecInstrs(types),
            { op: "call", funcIdx: objDeps.applyClosureIdx },
            { op: "drop" },
            { op: "return" },
          ],
          else: [],
        },
      ]
    : [];
  // USER close (closed-struct `__call_return` dispatch) — only when the
  // dispatcher exists; otherwise the body simply ends after the OBJ arm
  // (non-OBJ kinds ⇒ NormalCompletion no-op).
  const userClose: Instr[] =
    callReturnIdx !== undefined
      ? [
          // Only USER records have a user `return` to dispatch.
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: iterRecTypeIdx },
          { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: ITER_KIND_USER },
          { op: "i32.ne" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }], else: [] },
          // userIter = rec.userIter; null → no-op.
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: iterRecTypeIdx },
          { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
          { op: "local.tee", index: 2 },
          { op: "ref.is_null" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }], else: [] },
          // __call_return(userIter) — drop the result ({done} carrier or null when
          // the struct has no `return` method; the dispatcher returns null then).
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: callReturnIdx },
          { op: "drop" },
        ]
      : [];
  return [
    // recAny = any.convert_extern(recExt); not an $IterRec → no-op return.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: iterRecTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }], else: [] },
    ...genStateClose,
    ...hostClose,
    ...objClose,
    ...userClose,
  ];
}

/**
 * Build the `__iterator(obj) -> externref` body — the native GetIterator §7.4.1
 * ladder. Arms, first match wins:
 *   1. canonical externref `$Vec`      → $IterRec{kind:VEC, vec, 0, null}.
 *   2. (#3100, finalize-filled) vec FAMILY (`$ObjVec`, `__vec_f64`, string vecs,
 *      …) → normalize into a fresh canonical externref `$Vec` (per-element
 *      boxing), then the same VEC record. `familyArms` is empty at eager
 *      registration time (carriers not all known yet) and filled by
 *      `fillNativeIteratorLateArms`.
 *   3. (#3119, `objDeps`, finalize-filled) plain-`$Object` `@@iterator`
 *      PROPERTY protocol — the post-hoc `o[Symbol.iterator] = fn` install:
 *      `iterFn = __extern_get(obj, __box_symbol(@@iterator))`; truthy ⇒
 *      `iterObj = __apply_closure(iterFn, obj, [])` →
 *      $IterRec{kind:OBJ, vec:null, 0, userIter:iterObj}. The read needs no
 *      `ref.test $Object` gate: on every non-`$Object` subject (closed
 *      structs, strings, boxes) `__extern_get` answers the miss (falsy) and
 *      the subject falls through to the USER tail unchanged. The §7.4.3
 *      "iterator not an Object ⇒ TypeError" refinement is deferred (S1
 *      no-throw discipline, #1888).
 *   4. (#2038, `deps`) USER `{next()}` protocol → obtain the iterator object via
 *      `__call_@@iterator(obj)` and build $IterRec{kind:USER, vec:null, 0,
 *      userIter}. If the dispatcher returns null (obj is ALREADY an iterator
 *      with a bare `next` and no `@@iterator`), fall back to obj itself.
 *   5. else (no `deps`) — the legacy hard cast: a non-vec subject traps loudly
 *      (`illegal cast`) rather than silently misbehaving.
 * Locals: 0=obj(param), 1=objAny(anyref), 2=userIter(externref — the OBJ arm
 * reuses it for iterFn/iterObj), 3=i(i32)/4=len(i32)/5=out(arr) — scratch for
 * the family-arm normalize loops.
 */
/** (#3388) The §7.4.1 GetIterator TypeError message for a non-iterable subject. */
const NOT_ITERABLE_MSG = "value is not iterable";

/**
 * (#3388) Eagerly register the native `TypeError` constructor + the
 * "not iterable" message string global (both idempotent) so `__iterator`'s
 * non-iterable tail can throw a catchable `TypeError` instead of trapping.
 * Standalone/wasi only (host mode keeps the legacy loud trap — its `__iterator`
 * is a JS host import that already throws). Call from `ensureNativeIteratorRuntime`
 * BEFORE `buildIteratorBody`, so `nonIterableThrowInstrs` (below) only READS
 * already-registered symbols at both the eager and finalize build sites.
 */
function ensureNonIterableThrowDeps(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  emitWasiErrorConstructor(ctx, "TypeError", 1); // idempotent (funcMap.has guard)
  addStringConstantGlobal(ctx, NOT_ITERABLE_MSG); // idempotent (keyed by value)
}

/**
 * (#3388) FRESH throw-`TypeError` instrs for the §7.4.1 non-iterable tail, or
 * `undefined` to keep the legacy trap (host mode, or the ctor/global was not
 * pre-registered). Builds a new instr array each call (never share — the DCE
 * in-place remap double-applies to an aliased object, #2169b). Reads only
 * pre-registered symbols, so it is safe at BOTH the eager and finalize
 * `buildIteratorBody` sites.
 */
function nonIterableThrowInstrs(ctx: CodegenContext): Instr[] | undefined {
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  const ctorIdx = ctx.funcMap.get("__new_TypeError");
  if (ctorIdx === undefined) return undefined;
  const tagIdx = ensureExnTag(ctx);
  return [...throwMsgExternrefInstrs(ctx, NOT_ITERABLE_MSG), { op: "call", funcIdx: ctorIdx }, { op: "throw", tagIdx }];
}

function buildIteratorBody(
  types: IterRuntimeTypes,
  deps: UserCarrierDeps | undefined,
  familyArms: Instr[] = [],
  objDeps?: ObjCarrierDeps,
  hostDeps?: HostGenDeps,
  agDeps?: AsyncGenCarrierDeps,
  /**
   * (#3146) `__call_@@iterator` funcIdx for the PARTIAL tail: a module can
   * carry a closed-struct ITERABLE (`{ [Symbol.iterator]() {…} }`) whose
   * `@@iterator` returns a plain-`$Object` iterator, yet have NO closed-struct
   * `next` anywhere — then the full USER `deps` never assemble and the tail
   * used to keep the hard cast. With `objDeps` + this dispatcher the tail can
   * still resolve the iterable and route an `$Object` iterator through the
   * property-read OBJ arms; every other subject keeps the loud trap.
   */
  tailCallIteratorIdx?: number,
  sgDeps?: SyncGenCarrierDeps,
  /**
   * (#3388) When present, the §7.4.1 non-iterable FALLBACK tail throws a
   * catchable `TypeError` (these instrs) instead of the legacy `ref.cast $Vec`
   * loud trap. Only supplied on the standalone/wasi native path (host `__iterator`
   * is a JS import that already throws). Fresh instr array per call (never share).
   */
  nonIterableThrow?: Instr[],
): Instr[] {
  const { iterRecTypeIdx, vecTypeIdx } = types;

  // (#3164) GENSTATE arm — a DRIVEN native SYNC-generator `$GenState_*` frame.
  // One `ref.test` per registered producer state type; a match wraps the frame
  // in $IterRec{GENSTATE, vec:null, idx:0, userIter: frame}. GetIterator on a
  // generator object is the identity (`@@iterator` returns `this`). Fresh
  // Instr objects per producer (#2169b). Placed with the ASYNCGEN arm — after
  // the vec/family arms, before the OBJ/USER arms.
  const genStateArm: Instr[] = sgDeps
    ? sgDeps.producers.flatMap((p): Instr[] => [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: p.stateTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: ITER_KIND_GENSTATE },
            { op: "ref.null", typeIdx: vecTypeIdx },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: 0 },
            { op: "struct.new", typeIdx: iterRecTypeIdx },
            { op: "extern.convert_any" },
            { op: "return" },
          ],
          else: [],
        },
      ])
    : [];

  // (#3132 S1) ASYNCGEN arm — a DRIVEN async-generator `$AsyncFrame` carrier.
  // One `ref.test` per registered producer frame type; a match wraps the frame
  // in $IterRec{ASYNCGEN, vec:null, idx:0, userIter: frame}. GetIterator on an
  // async generator is the identity (`@@asyncIterator` returns `this`). Fresh
  // Instr objects per producer (#2169b). Placed after the vec/family arms
  // (frames are structs, so they never reach the HOSTGEN host-external
  // classification) and before the OBJ/USER arms.
  const asyncGenArm: Instr[] = agDeps
    ? agDeps.producers.flatMap((p): Instr[] => [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: p.stateTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: ITER_KIND_ASYNCGEN },
            { op: "ref.null", typeIdx: vecTypeIdx },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: 0 },
            { op: "struct.new", typeIdx: iterRecTypeIdx },
            { op: "extern.convert_any" },
            { op: "return" },
          ],
          else: [],
        },
      ])
    : [];
  // VEC arm: $IterRec{VEC, vec, 0, userIter:null}. Field order/arity is
  // load-bearing — struct.new pushes all 4 fields (userIter = ref.null.extern).
  //
  // (#2169b) Build a FRESH arm each call — never reuse one `Instr[]`/`struct.new`
  // object across branches. A shared instruction object aliased into two
  // branches is walked twice by any mutate-in-place body pass (DCE's
  // `remapTypeIdxInBody`), which double-applies a chained type-index remap
  // (e.g. 46→40 then 40→34) to the single `struct.new`, emitting it at the
  // wrong type index → `invalid struct index`. Distinct objects per branch keep
  // each `struct.new` remapped exactly once.
  const buildVecArm = (): Instr[] => [
    { op: "i32.const", value: ITER_KIND_VEC },
    { op: "local.get", index: 1 },
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "i32.const", value: 0 },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: iterRecTypeIdx },
    { op: "extern.convert_any" },
  ];

  // (#3075) HOSTGEN arm — a HOST-created external (legacy eager-buffer
  // generator object). Classification: `objAny` internalizes outside every GC
  // heap subhierarchy — NOT struct, NOT array, NOT i31 — so none of the later
  // arms (vec-family `ref.test`s, the `$Object` reader, the closed-struct
  // dispatchers) can ever match it; divert it to a HOSTGEN record BEFORE they
  // run. GetIterator on a generator object is the identity (`@@iterator` /
  // `@@asyncIterator` return `this`). All Instr objects fresh per build
  // (#2169b). Placed after the vec/family arms (internal carriers keep their
  // exact current routing) and before the OBJ/USER arms.
  const hostArm: Instr[] = hostDeps
    ? [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: HEAP_TYPE_STRUCT },
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: HEAP_TYPE_ARRAY },
        { op: "i32.or" },
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: HEAP_TYPE_I31 },
        { op: "i32.or" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // $IterRec{HOSTGEN, vec:null, idx:0, userIter: obj (param 0)}
            { op: "i32.const", value: ITER_KIND_HOSTGEN },
            { op: "ref.null", typeIdx: vecTypeIdx },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: 0 },
            { op: "struct.new", typeIdx: iterRecTypeIdx },
            { op: "extern.convert_any" },
            { op: "return" },
          ],
          else: [],
        },
      ]
    : [];

  // (#3119) OBJ arm — post-hoc `o[Symbol.iterator] = fn`. All Instr objects
  // fresh per build (#2169b); baked funcIdxs are fill-time funcMap lookups.
  // (#3146) With a FALSY `@@iterator` read, a truthy `next` PROPERTY now also
  // admits the subject as an OBJ record wrapping the object ITSELF — the
  // GetIteratorFlattenable "obj is already an iterator" case for plain-object
  // carriers (`{ next() {…}, return() {…} }` reaching `any`). Previously such
  // a subject fell through to the USER tail and hard-cast trapped whenever no
  // closed-struct dispatchers existed. Non-`$Object` subjects are unaffected:
  // `__extern_get` answers the miss (falsy) on them for BOTH reads.
  const objArm: Instr[] = objDeps
    ? [
        // iterFn = __extern_get(obj, __box_symbol(1))  (@@iterator, #2866)
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 1 },
        { op: "call", funcIdx: objDeps.boxSymbolIdx },
        { op: "call", funcIdx: objDeps.externGetIdx },
        { op: "local.tee", index: 2 },
        { op: "call", funcIdx: objDeps.isTruthyIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // iterObj = __apply_closure(iterFn, obj, [])
            { op: "local.get", index: 2 },
            { op: "local.get", index: 0 },
            ...emptyArgsVecInstrs(types),
            { op: "call", funcIdx: objDeps.applyClosureIdx },
            { op: "local.set", index: 2 },
            // $IterRec{OBJ, vec:null, idx:0, userIter:iterObj}
            { op: "i32.const", value: ITER_KIND_OBJ },
            { op: "ref.null", typeIdx: vecTypeIdx },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: 2 },
            { op: "struct.new", typeIdx: iterRecTypeIdx },
            { op: "extern.convert_any" },
            { op: "return" },
          ],
          else: [],
        },
        // (#3146) next-property fallback: obj itself is the iterator.
        { op: "local.get", index: 0 },
        ...objDeps.keyInstrs("next"),
        { op: "call", funcIdx: objDeps.externGetIdx },
        { op: "call", funcIdx: objDeps.isTruthyIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // $IterRec{OBJ, vec:null, idx:0, userIter:obj}
            { op: "i32.const", value: ITER_KIND_OBJ },
            { op: "ref.null", typeIdx: vecTypeIdx },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: 0 },
            { op: "struct.new", typeIdx: iterRecTypeIdx },
            { op: "extern.convert_any" },
            { op: "return" },
          ],
          else: [],
        },
      ]
    : [];

  const tail: Instr[] = deps
    ? [
        // userIter = __call_@@iterator(obj)  (null if obj has no @@iterator).
        // (#3146) When NO struct in the module carries `[Symbol.iterator]`
        // the dispatcher was never emitted (`callIteratorIdx` undefined) —
        // the subject is then its own iterator (bare `{next()}` carrier).
        ...((deps.callIteratorIdx !== undefined
          ? [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: deps.callIteratorIdx },
              { op: "local.tee", index: 2 },
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "externref" } },
                // No @@iterator → obj is itself the iterator (has `next`).
                then: [{ op: "local.get", index: 0 }],
                else: [{ op: "local.get", index: 2 }],
              },
            ]
          : [{ op: "local.get", index: 0 }]) satisfies Instr[]),
        { op: "local.set", index: 2 },
        // (#3146) kind selection: a closed iterable's `@@iterator` can return
        // a PLAIN-`$Object` iterator (closure-property `next`/`return`) — the
        // closed-struct USER dispatchers cannot drive that; route it through
        // the property-read OBJ arms instead. Non-`$Object` iterators keep the
        // USER kind (closed-struct type-switch dispatch).
        ...((objDeps
          ? [
              { op: "local.get", index: 2 },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: objDeps.objectTypeIdx },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "i32.const", value: ITER_KIND_OBJ }],
                else: [{ op: "i32.const", value: ITER_KIND_USER }],
              },
            ]
          : [{ op: "i32.const", value: ITER_KIND_USER }]) satisfies Instr[]),
        // $IterRec{kind, vec:null, idx:0, userIter}
        { op: "ref.null", typeIdx: vecTypeIdx },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 2 },
        { op: "struct.new", typeIdx: iterRecTypeIdx },
        { op: "extern.convert_any" },
      ]
    : tailCallIteratorIdx !== undefined && objDeps
      ? [
          // (#3146) PARTIAL tail — no closed-struct step dispatchers, but the
          // `@@iterator` dispatcher + OBJ arms exist. Resolve the iterable;
          // an `$Object` iterator routes through the OBJ property arms, any
          // other shape falls to the legacy hard cast below.
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: tailCallIteratorIdx },
          { op: "local.tee", index: 2 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "local.get", index: 0 }],
            else: [{ op: "local.get", index: 2 }],
          },
          { op: "local.set", index: 2 },
          { op: "local.get", index: 2 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: objDeps.objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // $IterRec{OBJ, vec:null, idx:0, userIter}
              { op: "i32.const", value: ITER_KIND_OBJ },
              { op: "ref.null", typeIdx: vecTypeIdx },
              { op: "i32.const", value: 0 },
              { op: "local.get", index: 2 },
              { op: "struct.new", typeIdx: iterRecTypeIdx },
              { op: "extern.convert_any" },
              { op: "return" },
            ],
            else: [],
          },
          // (#3388) Non-`$Object`, non-iterable subject: throw §7.4.1 TypeError
          // (catchable) rather than the legacy `ref.cast $Vec` trap. Legacy
          // trap only when no throw was supplied.
          ...(nonIterableThrow ?? buildVecArm()),
        ]
      : // USER carrier not filled. By this point the subject is proven NON-vec
        // (the ladder's `ref.test $Vec` at the top returned on a match) and
        // matched no iterable arm — i.e. it is genuinely non-iterable.
        // (#3388) Throw a catchable §7.4.1 `TypeError` when the native error
        // machinery is available (standalone/wasi) — a `yield*`/for-of over a
        // non-iterable must REJECT/throw, not trap. Fall back to the legacy loud
        // `ref.cast $Vec` trap only when no throw was supplied (host mode uses a
        // JS `__iterator` import that already throws, so this path is
        // native-only). A FRESH vec arm (#2169b) on the legacy branch.
        (nonIterableThrow ?? buildVecArm());

  return [
    // objAny = any.convert_extern(obj)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: vecTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...buildVecArm(), { op: "return" }],
      else: [],
    },
    ...familyArms,
    ...genStateArm,
    ...asyncGenArm,
    ...hostArm,
    ...objArm,
    ...tail,
  ];
}

/**
 * (#3100) One vec-FAMILY carrier the `__iterator` ladder normalizes: a struct
 * shaped `{length/len: i32 (field 0), data: (ref array) (field 1)}` that is NOT
 * the canonical externref `$Vec` type — `$ObjVec` (Object.keys/values/entries
 * results) and every module-local `__vec_<elemKind>` (`__vec_f64` array
 * literals reaching `any`, string vecs, …). `boxOps` lifts one loaded element
 * to externref (empty = element already externref).
 */
interface VecFamilyCarrier {
  typeIdx: number;
  arrTypeIdx: number;
  boxOps: Instr[];
}

/**
 * (#3100) Enumerate the vec-family carriers `__iterator` should accept, at
 * FINALIZE time (all module-local carrier types are registered by then):
 *   - `$ObjVec` (when the object runtime exists) — elements already externref.
 *   - every `ctx.vecTypeMap` carrier except the canonical externref `$Vec`
 *     (ladder arm 1 already handles it), the exclusively-non-array byte
 *     carriers (`i32_byte` ArrayBuffer / `i8_byte` Uint8Array storage — never
 *     plain-array iterables), and carriers whose element kind has no proven
 *     boxing recipe (`boxVecElementToExternref` returns null → the value keeps
 *     the legacy loud-trap tail rather than iterating silently-wrong values).
 * Deduped by typeIdx, sorted for deterministic emission.
 */
function collectVecFamilyCarriers(ctx: CodegenContext, types: IterRuntimeTypes): VecFamilyCarrier[] {
  const carriers: VecFamilyCarrier[] = [];
  const seen = new Set<number>([types.vecTypeIdx]);

  const objRT = ctx.objectRuntimeTypes;
  if (objRT && !seen.has(objRT.objVecTypeIdx)) {
    seen.add(objRT.objVecTypeIdx);
    carriers.push({ typeIdx: objRT.objVecTypeIdx, arrTypeIdx: objRT.objVecArrTypeIdx, boxOps: [] });
  }

  for (const [elemKind, vecTypeIdx] of ctx.vecTypeMap.entries()) {
    if (NON_ARRAY_BYTE_VEC_ELEM_KINDS.has(elemKind)) continue;
    if (seen.has(vecTypeIdx)) continue;
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) continue;
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") continue;
    let boxOps = boxVecElementToExternref(ctx, arrDef.element);
    // (#3146) GC-ref element vecs — e.g. the OUTER vec of a nested array
    // literal (`[[1,2],[10,20]]` → `__vec_ref_<__vec_f64>`) — have no proven
    // per-kind boxing in the shared helper, but for ITERATION the identity
    // externalization is exact: the element is handed onward as an opaque
    // `any` value, and every consumer (a nested `__iterator` call, `__extern_*`
    // readers) re-tests/casts it right back. Scoped to this collector only
    // (the shared `boxVecElementToExternref` keeps its conservative scope for
    // `__extern_get_idx`/`__extern_slice`). Previously these carriers fell to
    // the loud-trap tail, which made `Iterator.zip([[..],[..]])` (dynamic
    // array-of-arrays GetIterator) an `illegal cast`.
    if (boxOps === null && (arrDef.element.kind === "ref" || arrDef.element.kind === "ref_null")) {
      const ti = (arrDef.element as { typeIdx: number }).typeIdx;
      if (ti >= 0) boxOps = [{ op: "extern.convert_any" }];
    }
    if (boxOps === null) continue; // no proven boxing — keep the loud-trap tail
    seen.add(vecTypeIdx);
    carriers.push({ typeIdx: vecTypeIdx, arrTypeIdx, boxOps });
  }

  carriers.sort((a, b) => a.typeIdx - b.typeIdx);
  return carriers;
}

/**
 * (#3100) Build the `__iterator` vec-family normalization arms (ladder arm 2).
 * Each arm: `ref.test <carrier>` → copy the carrier's elements into a FRESH
 * canonical externref `$Vec` (boxing each element per kind) → return
 * $IterRec{VEC, freshVec, 0, null}. Downstream (`__iterator_next` /
 * `__iterator_rest`) then reads the canonical vec unchanged — the whole dynamic
 * iteration fix lives in this one normalize step.
 *
 * A COPY (not an aliased rewrap of the carrier's data array) is deliberate:
 * the canonical `$Vec.data` array type and a carrier's array type (e.g.
 * `$ObjVecArr`) are distinct type-section entries even when structurally
 * identical, and relying on engine iso-recursive canonicalization to make a
 * cross-type `struct.new` validate is exactly the #2009/#2158 hazard class.
 * The copy costs O(n) once per GetIterator — iteration steps stay O(1).
 *
 * All instruction objects are FRESH per arm (factory discipline, #2169b) so no
 * finalize walk (DCE remap / funcIdx shift) ever double-visits a shared object.
 * The only baked funcIdx is inside `boxOps` (`__box_number`), resolved from
 * funcMap at fill time — the same discipline as the USER arm's dispatcher
 * funcIdxs (#2038, landed) — and later import shifts walk this body like any
 * other defined function.
 *
 * Locals (declared at registration): 1=objAny, 3=i, 4=len, 5=out.
 */
function buildVecFamilyArms(ctx: CodegenContext, types: IterRuntimeTypes): Instr[] {
  const { iterRecTypeIdx, vecTypeIdx, arrTypeIdx } = types;
  const arms: Instr[] = [];
  for (const carrier of collectVecFamilyCarriers(ctx, types)) {
    arms.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: carrier.typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // len = carrier.length (field 0)
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: carrier.typeIdx },
          { op: "struct.get", typeIdx: carrier.typeIdx, fieldIdx: 0 },
          { op: "local.set", index: 4 },
          // out = array.new_default $__arr_externref (len)
          { op: "local.get", index: 4 },
          { op: "array.new_default", typeIdx: arrTypeIdx },
          { op: "local.set", index: 5 },
          // for (i = 0; i < len; i++) out[i] = box(carrier.data[i])
          { op: "i32.const", value: 0 },
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
                  { op: "local.get", index: 4 },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  { op: "local.get", index: 5 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 3 },
                  { op: "local.get", index: 1 },
                  { op: "ref.cast", typeIdx: carrier.typeIdx },
                  { op: "struct.get", typeIdx: carrier.typeIdx, fieldIdx: 1 },
                  { op: "local.get", index: 3 },
                  { op: "array.get", typeIdx: carrier.arrTypeIdx },
                  ...carrier.boxOps.map((instr) => ({ ...instr })),
                  { op: "array.set", typeIdx: arrTypeIdx },
                  { op: "local.get", index: 3 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 3 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          // return $IterRec{VEC, $Vec{len, out}, 0, null} as externref
          { op: "i32.const", value: ITER_KIND_VEC },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 5 },
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: vecTypeIdx },
          { op: "i32.const", value: 0 },
          { op: "ref.null.extern" },
          { op: "struct.new", typeIdx: iterRecTypeIdx },
          { op: "extern.convert_any" },
          { op: "return" },
        ],
        else: [],
      },
    );
  }
  return arms;
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
 *
 * (#3119) With `objDeps` the OBJ arm dispatches through PROPERTY reads:
 *   next = __extern_get(iterObj, "next"); res = __apply_closure(next, iterObj, []);
 *   done = ToBoolean(Get(res, "done")); value = done ? undefined : Get(res, "value")
 * where Get(res, ·) routes through `__extern_get` when `res` is a `$Object`
 * and through the closed-struct field getters (`__sget_done`/`__sget_value`)
 * otherwise — an object-literal `next()` result (`{value, done}`) often
 * pre-shapes into a closed struct that `__extern_get` cannot read. A falsy
 * `res` (missing/uncallable `next`, bridge degrade) reports done=1 rather
 * than spinning (§7.4.3 TypeError refinement deferred).
 *
 * Locals: 0=recExt(param), 1=rec, 2=vec, 3=i, 4=done(i32), 5=value(externref),
 * 6=res(externref).
 */
function buildIteratorNextBody(
  types: IterRuntimeTypes,
  deps: UserCarrierDeps | undefined,
  objDeps?: ObjCarrierDeps,
  hostDeps?: HostGenDeps,
  agDeps?: AsyncGenCarrierDeps,
  sgDeps?: SyncGenCarrierDeps,
): Instr[] {
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
    { op: "ref.is_null" },
    { op: "local.get", index: 3 },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "i32.ge_s" },
    { op: "i32.or" },
    { op: "local.set", index: 4 },
    // value default = undefined-extern
    { op: "ref.null.extern" },
    { op: "local.set", index: 5 },
    // if (!done) { value = vec.data[i]; rec.idx = i + 1; }
    { op: "local.get", index: 4 },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 3 },
        { op: "array.get", typeIdx: arrTypeIdx },
        { op: "local.set", index: 5 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 3 },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx: iterRecTypeIdx, fieldIdx: 2 },
      ],
      else: [],
    },
  ];

  // (#3302) `!sgDeps` is load-bearing: a module whose ONLY step-driven carrier
  // is a native SYNC generator (a minimal capturing fn-expr module — no user /
  // obj / host / async-gen carrier) used to hit this vec-only early return,
  // silently dropping the GENSTATE step from `__iterator_next` while
  // `__iterator` still wrapped the frame in a GENSTATE record → the vec step
  // read `rec.vec` (null for GENSTATE) through `ref.as_non_null` → null-deref
  // trap on the first for-of resume. Latent since #3164 (every prior module
  // with a driven native generator happened to also carry `deps`/`objDeps`).
  if (!deps && !objDeps && !hostDeps && !agDeps && !sgDeps) {
    // Vec-only carrier: kind is always VEC, so emit the vec step directly with no
    // kind branch — byte-identical to the pre-#2038 runtime.
    return [
      // rec = cast(any.convert_extern(recExt))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: iterRecTypeIdx },
      { op: "local.set", index: 1 },
      ...vecStep,
      // results in ABI order: (done, value)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 5 },
    ];
  }

  // (#3075) HOSTGEN step — drive the legacy host generator object through the
  // already-imported bundle: res = __gen_next(rec.userIter); done =
  // __gen_result_done(res); value = done ? undefined : __gen_result_value(res).
  // The buffered async-gen `next()` thenable exposes value/done synchronously
  // (runtime.ts `mkResult`), so the settled read is exact — a genuinely-pending
  // host promise has no `done` and reports done=0/value=undefined host-side.
  const hostStep: Instr[] = hostDeps
    ? [
        // res = __gen_next(rec.userIter)
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
        { op: "call", funcIdx: hostDeps.genNextIdx },
        { op: "local.set", index: 6 },
        // done = __gen_result_done(res)
        { op: "local.get", index: 6 },
        { op: "call", funcIdx: hostDeps.genResultDoneIdx },
        { op: "local.set", index: 4 },
        // value = done ? undefined : __gen_result_value(res)
        { op: "local.get", index: 4 },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [{ op: "ref.null.extern" }],
          else: [
            { op: "local.get", index: 6 },
            { op: "call", funcIdx: hostDeps.genResultValueIdx },
          ],
        },
        { op: "local.set", index: 5 },
      ]
    : [];

  // (#3119) The OBJ-carrier step: property reads + the open-`any` closure
  // bridge (see the function doc). Fresh Instr objects per build (#2169b).
  const objStep: Instr[] = objDeps
    ? (() => {
        const od = objDeps;
        // res is a `$Object` → read done/value through the dynamic reader.
        const readObjArm: Instr[] = [
          // done = ToBoolean(__extern_get(res, "done"))
          { op: "local.get", index: 6 },
          ...od.keyInstrs("done"),
          { op: "call", funcIdx: od.externGetIdx },
          { op: "call", funcIdx: od.isTruthyIdx },
          { op: "local.set", index: 4 },
          // value = done ? undefined : __extern_get(res, "value")
          { op: "local.get", index: 4 },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: od.missInstrs(),
            else: [{ op: "local.get", index: 6 }, ...od.keyInstrs("value"), { op: "call", funcIdx: od.externGetIdx }],
          },
          { op: "local.set", index: 5 },
        ];
        // res is a closed struct (`{value, done}` literal pre-shape) → the
        // #2038 field getters. Without `__sget_done` a non-`$Object` res is
        // unreadable: report done (terminate) rather than spin.
        //
        // (#4447) `__sget_value` is read INDEPENDENTLY of `__sget_done`. A
        // conformant iterator may return `{ done: … }` with no `value` property
        // at all (§7.4.4 IteratorValue then answers `undefined`) — test262's
        // `for-of/dstr/array-elem-trlg-iter-*` iterators do exactly that. No
        // struct in such a module carries a `value` field, so `__sget_value`
        // is never emitted; the old conjunction then fell to the
        // `done := 1` degrade and reported the iterator EXHAUSTED on its first
        // step. That silently skipped IteratorClose (the drain breaks on the
        // done-branch, §7.4.9 closes only on a non-done stop) and made
        // `nextCount`/`returnCount` observably wrong.
        const readStructArm: Instr[] =
          od.sgetDoneIdx !== undefined && (od.sgetValueIdx !== undefined || od.sgetDoneIsExtern === true)
            ? [
                { op: "local.get", index: 6 },
                { op: "call", funcIdx: od.sgetDoneIdx },
                { op: "call", funcIdx: od.isTruthyIdx },
                { op: "local.set", index: 4 },
                { op: "local.get", index: 4 },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "externref" } },
                  then: od.missInstrs(),
                  else:
                    od.sgetValueIdx !== undefined
                      ? [
                          { op: "local.get", index: 6 },
                          { op: "call", funcIdx: od.sgetValueIdx },
                        ]
                      : od.missInstrs(),
                },
                { op: "local.set", index: 5 },
              ]
            : [
                { op: "i32.const", value: 1 },
                { op: "local.set", index: 4 },
                ...od.missInstrs(),
                { op: "local.set", index: 5 },
              ];
        return [
          // next = Get(rec.userIter, "next") — carrier-branched (#3117): a
          // `$Object` iterator reads through the dynamic reader; a closed-
          // struct iterator literal (`{ next: function () {…} }`, field-stored
          // closure) reads through the `__sget_next` field getter.
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: od.objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              { op: "local.get", index: 1 },
              { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
              ...od.keyInstrs("next"),
              { op: "call", funcIdx: od.externGetIdx },
            ],
            else:
              od.sgetNextIdx !== undefined
                ? [
                    { op: "local.get", index: 1 },
                    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
                    { op: "call", funcIdx: od.sgetNextIdx },
                  ]
                : od.missInstrs(),
          },
          // res = __apply_closure(next, rec.userIter, [])
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
          ...emptyArgsVecInstrs(types),
          { op: "call", funcIdx: od.applyClosureIdx },
          { op: "local.set", index: 6 },
          // Falsy res (undefined/null — `next` missing/uncallable, bridge
          // degrade) → done=1, never spin.
          { op: "local.get", index: 6 },
          { op: "call", funcIdx: od.isTruthyIdx },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: 1 },
              { op: "local.set", index: 4 },
              ...od.missInstrs(),
              { op: "local.set", index: 5 },
            ],
            else: [
              { op: "local.get", index: 6 },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: od.objectTypeIdx },
              { op: "if", blockType: { kind: "empty" }, then: readObjArm, else: readStructArm },
            ],
          },
        ];
      })()
    : [];

  // vecStep, or (with the OBJ arm filled) the kind==OBJ dispatch around it.
  const vecOrObjStep: Instr[] = objDeps
    ? [
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: ITER_KIND_OBJ },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: objStep, else: vecStep },
      ]
    : vecStep;

  // (#3132 S1) The ASYNCGEN step — drive the frame carrier through its
  // per-producer next driver, then read the SETTLED IteratorResult off the
  // minted $Promise. Locals: 1=rec, 4=done, 5=value, 6=res (holds frame →
  // promise → result across the phases). A frame matching no producer, or a
  // promise not FULFILLED, traps loudly (`unreachable`) — same loud-failure
  // discipline as the pre-arm hard cast (never a silent wrong value).
  const asyncGenStep: Instr[] = agDeps
    ? [
        // res := rec.userIter (the frame externref)
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
        { op: "local.set", index: 6 },
        // res := __async_gen_next_<matching>(res)  — per-producer dispatch
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            ...agDeps.producers.flatMap((p): Instr[] => [
              { op: "local.get", index: 6 },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: p.stateTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 6 },
                  { op: "call", funcIdx: p.nextIdx },
                  { op: "local.set", index: 6 },
                  { op: "br", depth: 1 },
                ],
                else: [],
              },
            ]),
            // No producer matched — an ASYNCGEN record only wraps matched
            // frames, so this is unreachable by construction.
            { op: "unreachable" },
          ],
        },
        // Require the next()-promise FULFILLED (await-free producers settle
        // synchronously inside the kick; pending ⇒ loud trap).
        { op: "local.get", index: 6 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: agDeps.promiseTypeIdx },
        { op: "struct.get", typeIdx: agDeps.promiseTypeIdx, fieldIdx: PROMISE_FIELD_STATE },
        { op: "i32.const", value: PROMISE_STATE_FULFILLED },
        { op: "i32.ne" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }], else: [] },
        // res := promise.value (the $IteratorResult, boxed externref)
        { op: "local.get", index: 6 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: agDeps.promiseTypeIdx },
        { op: "struct.get", typeIdx: agDeps.promiseTypeIdx, fieldIdx: PROMISE_FIELD_VALUE },
        { op: "local.set", index: 6 },
        // done = result.done
        { op: "local.get", index: 6 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: agDeps.resultTypeIdx },
        { op: "struct.get", typeIdx: agDeps.resultTypeIdx, fieldIdx: AGEN_RESULT_FIELD_DONE },
        { op: "local.set", index: 4 },
        // value = done ? undefined : result.value
        { op: "local.get", index: 4 },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [{ op: "ref.null.extern" }],
          else: [
            { op: "local.get", index: 6 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: agDeps.resultTypeIdx },
            { op: "struct.get", typeIdx: agDeps.resultTypeIdx, fieldIdx: AGEN_RESULT_FIELD_VALUE },
          ],
        },
        { op: "local.set", index: 5 },
      ]
    : [];

  // (#3164) The GENSTATE step — drive the sync-generator frame through its
  // per-producer resume function, then read `{value, done}` off the
  // per-generator result struct. Locals: 1=rec, 4=done, 5=value, 6=res (holds
  // frame → result across the phases), sgDeps.f64TmpIdx = f64 scratch for the
  // sentinel-aware boxing. A frame matching no producer traps loudly
  // (`unreachable`) — a GENSTATE record only wraps matched frames, so this is
  // unreachable by construction (same discipline as the ASYNCGEN step). A
  // resume-time JS throw propagates as the native `$exc` tag, catchable by the
  // caller (the dstr `-err` harness shapes observe it via assert.throws).
  const genStateStep: Instr[] = sgDeps
    ? (() => {
        const valueRead = (p: SyncGenCarrierDeps["producers"][number]): Instr[] => {
          const read: Instr[] = [
            { op: "local.get", index: 6 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: p.resultTypeIdx },
            { op: "struct.get", typeIdx: p.resultTypeIdx, fieldIdx: AGEN_RESULT_FIELD_VALUE },
          ];
          if (p.elemValType.kind === "externref") return read;
          if (p.elemValType.kind === "f64" && sgDeps.boxNumIdx !== undefined) {
            // Sentinel-aware box: the UNDEF_F64 bit pattern (done/valueless
            // yield) canonicalizes to the null externref (standalone canonical
            // `undefined`), everything else boxes via `__box_number` — the
            // `sentinelAwareF64BoxInstrs` recipe (generators-native.ts).
            return [
              ...read,
              { op: "local.tee", index: sgDeps.f64TmpIdx },
              { op: "i64.reinterpret_f64" },
              { op: "i64.const", value: UNDEF_F64_BITS },
              { op: "i64.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "externref" } },
                then: [{ op: "ref.null.extern" }],
                else: [
                  { op: "local.get", index: sgDeps.f64TmpIdx },
                  { op: "call", funcIdx: sgDeps.boxNumIdx },
                ],
              },
            ];
          }
          if (p.elemValType.kind === "i32" && sgDeps.boxNumIdx !== undefined) {
            return [...read, { op: "f64.convert_i32_s" }, { op: "call", funcIdx: sgDeps.boxNumIdx }];
          }
          if (p.elemValType.kind === "ref" || p.elemValType.kind === "ref_null") {
            return [...read, { op: "extern.convert_any" }];
          }
          // Unboxable carrier (defensive): undefined.
          return [...read, { op: "drop" }, { op: "ref.null.extern" }];
        };
        return [
          // res := rec.userIter (the frame externref)
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
          { op: "local.set", index: 6 },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              ...sgDeps.producers.flatMap((p): Instr[] => [
                { op: "local.get", index: 6 },
                { op: "any.convert_extern" },
                { op: "ref.test", typeIdx: p.stateTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // res := extern(resume(cast(frame)))  — the {value, done} result
                    { op: "local.get", index: 6 },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: p.stateTypeIdx },
                    { op: "call", funcIdx: p.resumeIdx },
                    { op: "extern.convert_any" },
                    { op: "local.set", index: 6 },
                    // done = res.done
                    { op: "local.get", index: 6 },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: p.resultTypeIdx },
                    { op: "struct.get", typeIdx: p.resultTypeIdx, fieldIdx: AGEN_RESULT_FIELD_DONE },
                    { op: "local.set", index: 4 },
                    // value = box_elem(res.value) — a done result's value field
                    // already holds the canonical absent marker (UNDEF_F64
                    // sentinel / null ref), which the boxing canonicalizes to
                    // the null externref.
                    ...valueRead(p),
                    { op: "local.set", index: 5 },
                    { op: "br", depth: 1 },
                  ],
                  else: [],
                },
              ]),
              // No producer matched — unreachable by construction.
              { op: "unreachable" },
            ],
          },
        ];
      })()
    : [];

  // (#3075/#3132) Wrap a step chain in the kind==HOSTGEN / kind==ASYNCGEN
  // dispatches when the arms are filled; pass-through otherwise
  // (byte-identical).
  const withHostDispatch = (inner: Instr[]): Instr[] => {
    let wrapped = inner;
    if (sgDeps) {
      wrapped = [
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: ITER_KIND_GENSTATE },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: genStateStep, else: wrapped },
      ];
    }
    if (agDeps) {
      wrapped = [
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: ITER_KIND_ASYNCGEN },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: asyncGenStep, else: wrapped },
      ];
    }
    if (hostDeps) {
      wrapped = [
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: ITER_KIND_HOSTGEN },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: hostStep, else: wrapped },
      ];
    }
    return wrapped;
  };

  if (!deps) {
    // OBJ/HOSTGEN + VEC kinds only (no closed-struct USER carrier in this module).
    return [
      // rec = cast(any.convert_extern(recExt))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: iterRecTypeIdx },
      { op: "local.set", index: 1 },
      ...withHostDispatch(vecOrObjStep),
      // results in ABI order: (done, value)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 5 },
    ];
  }

  // (#2038) The USER-carrier step: dispatch through the closed-struct helpers.
  // (#3146) The RESULT read is carrier-branched like the OBJ arm's: a closed
  // iterator's `next()` can return an OPEN `$Object` result (`{ done: … }`
  // reaching `any`), which the `__sget_*` field getters cannot read. With
  // `objDeps`, an `$Object` result reads `done`/`value` through the dynamic
  // reader; a closed result keeps the field getters. When the module carries
  // NO `{value, done}`-shaped closed struct at all, `__sget_value`/`__sget_done`
  // were never emitted (now optional in the deps) — a closed result then
  // reports done=1 rather than spinning, mirroring the OBJ arm's fallback.
  // (#4447) `__sget_value` is read INDEPENDENTLY of `__sget_done` — see the
  // twin note on the OBJ arm's `readStructArm`. A `{ done: … }`-only result
  // (no `value` property anywhere in the module ⇒ no `__sget_value`) must
  // report the REAL `done`, not the done=1 degrade, or the drain terminates
  // on step 1 and skips IteratorClose.
  const userReadStructArm: Instr[] =
    deps.sgetDoneIdx !== undefined && (deps.sgetValueIdx !== undefined || deps.sgetDoneIsExtern === true)
      ? [
          { op: "local.get", index: 6 },
          { op: "call", funcIdx: deps.sgetDoneIdx },
          { op: "call", funcIdx: deps.isTruthyIdx },
          { op: "local.set", index: 4 },
          { op: "local.get", index: 4 },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "ref.null.extern" }],
            else:
              deps.sgetValueIdx !== undefined
                ? [
                    { op: "local.get", index: 6 },
                    { op: "call", funcIdx: deps.sgetValueIdx },
                  ]
                : [{ op: "ref.null.extern" }],
          },
          { op: "local.set", index: 5 },
        ]
      : [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: 4 },
          { op: "ref.null.extern" },
          { op: "local.set", index: 5 },
        ];
  const userReadObjArm: Instr[] = objDeps
    ? [
        { op: "local.get", index: 6 },
        ...objDeps.keyInstrs("done"),
        { op: "call", funcIdx: objDeps.externGetIdx },
        { op: "call", funcIdx: objDeps.isTruthyIdx },
        { op: "local.set", index: 4 },
        { op: "local.get", index: 4 },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: objDeps.missInstrs(),
          else: [
            { op: "local.get", index: 6 },
            ...objDeps.keyInstrs("value"),
            { op: "call", funcIdx: objDeps.externGetIdx },
          ],
        },
        { op: "local.set", index: 5 },
      ]
    : [];
  const userStep: Instr[] = [
    // res = __call_next(rec.userIter)
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
    { op: "call", funcIdx: deps.callNextIdx },
    { op: "local.set", index: 6 },
    ...((objDeps
      ? [
          { op: "local.get", index: 6 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: objDeps.objectTypeIdx },
          { op: "if", blockType: { kind: "empty" }, then: userReadObjArm, else: userReadStructArm },
        ]
      : userReadStructArm) satisfies Instr[]),
  ];

  return [
    // rec = cast(any.convert_extern(recExt))
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: iterRecTypeIdx },
    { op: "local.set", index: 1 },
    // (#3075: outermost kind==HOSTGEN dispatch when filled)
    // if (rec.kind == USER) { userStep } else { vecStep | kind==OBJ dispatch }
    ...withHostDispatch([
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: ITER_KIND_USER },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: userStep,
        else: vecOrObjStep,
      },
    ]),
    // results in ABI order: (done, value)
    { op: "local.get", index: 4 },
    { op: "local.get", index: 5 },
  ];
}

/**
 * (#3100 S5) Build the finalize-rebuilt `__iterator_rest` body: the existing
 * vec tail-copy PLUS a USER arm that steps `__iterator_next(recExt)` to
 * exhaustion into a fresh canonical `$Vec` (doubling-array drain, byte-shaped
 * after the materializer's loop). Before this, a USER record (custom iterable)
 * had `vec: null` so the vec-only body returned an EMPTY vec — `[...iterable]`
 * and `Array.from(iterable)` silently produced [] for custom iterables.
 * Exhaustion ⇒ [[Done]] ⇒ NO IteratorClose (§7.4.9).
 * Locals (replaced at fill): 0=recExt(param), 1=rec, 2=vec, 3=i, 4=len/cap,
 * 5=out(arr), 6=j, 7=done, 8=value, 9=grow(arr).
 */
function buildIteratorRestBodyWithUserArm(
  types: IterRuntimeTypes,
  iteratorNextIdx: number,
  // (#3119) The step-driven kinds the drain admits — [USER], [OBJ], or both,
  // matching which GetIterator arms the fill installed. The kind dispatch of
  // the step itself lives inside `__iterator_next`, so one drain serves all.
  stepKinds: number[] = [ITER_KIND_USER],
): Instr[] {
  const { iterRecTypeIdx, vecTypeIdx, arrTypeIdx } = types;
  const userDrain: Instr[] = [
    // cap = 4; out = array.new_default(4); j = 0
    { op: "i32.const", value: 4 },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 4 },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: 5 },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 6 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // (done, value) = __iterator_next(recExt)
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: iteratorNextIdx },
            { op: "local.set", index: 8 },
            { op: "local.set", index: 7 },
            { op: "local.get", index: 7 },
            { op: "br_if", depth: 1 },
            // grow if j >= cap
            { op: "local.get", index: 6 },
            { op: "local.get", index: 4 },
            { op: "i32.ge_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 4 },
                { op: "i32.const", value: 2 },
                { op: "i32.mul" },
                { op: "local.set", index: 4 },
                { op: "local.get", index: 4 },
                { op: "array.new_default", typeIdx: arrTypeIdx },
                { op: "local.set", index: 9 },
                { op: "local.get", index: 9 },
                { op: "i32.const", value: 0 },
                { op: "local.get", index: 5 },
                { op: "i32.const", value: 0 },
                { op: "local.get", index: 6 },
                { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
                { op: "local.get", index: 9 },
                { op: "local.set", index: 5 },
              ],
              else: [],
            },
            // out[j] = value; j++
            { op: "local.get", index: 5 },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 6 },
            { op: "local.get", index: 8 },
            { op: "array.set", typeIdx: arrTypeIdx },
            { op: "local.get", index: 6 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 6 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // return $Vec{j, out} as externref
    { op: "local.get", index: 6 },
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" },
    { op: "return" },
  ];

  return [
    // rec = cast(recExt)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: iterRecTypeIdx },
    { op: "local.set", index: 1 },
    // USER/OBJ record → step-to-exhaustion drain
    ...stepKinds.flatMap((kind, i): Instr[] => [
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: kind },
      { op: "i32.eq" },
      ...(i > 0 ? ([{ op: "i32.or" }] satisfies Instr[]) : []),
    ]),
    { op: "if", blockType: { kind: "empty" }, then: userDrain, else: [] },
    // VEC record → the existing tail-copy, reading rec from local 1
    { op: "local.get", index: 1 },
    ...buildIteratorRestVecTail(iterRecTypeIdx, vecTypeIdx, arrTypeIdx),
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
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: iterRecTypeIdx },
    { op: "local.tee", index: 1 },
    ...buildIteratorRestVecTail(iterRecTypeIdx, vecTypeIdx, arrTypeIdx),
  ];
}

/**
 * The vec tail-copy of `__iterator_rest` — everything after the record is on
 * the stack. Shared by the eager vec-only body and the (#3100 S5) USER-aware
 * rebuild. Expects the `$IterRec` (non-null ref) ON THE STACK; consumes it.
 */
function buildIteratorRestVecTail(iterRecTypeIdx: number, vecTypeIdx: number, arrTypeIdx: number): Instr[] {
  return [
    // vec = rec.vec
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: 2 },
    // i = rec.idx
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: 3 },
    // len = (vec == null) ? 0 : vec.length
    { op: "local.get", index: 2 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      ],
    },
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
    },
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
            { op: "ref.as_non_null" },
            { op: "local.get", index: 6 },
            { op: "local.get", index: 2 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: 3 },
            { op: "array.get", typeIdx: arrTypeIdx },
            { op: "array.set", typeIdx: arrTypeIdx },
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
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" },
  ];
}
