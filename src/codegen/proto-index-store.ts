// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4160) Prototype-INDEX store for `--target standalone` — the runtime
 * substrate that makes an integer-index property written onto
 * `Object.prototype` / `Array.prototype` VISIBLE through the prototype chain.
 *
 * ## The gap this closes (measured — #4159 architect-spec probes P2/P3)
 *
 * In standalone, `Object.prototype` / `Array.prototype` evaluate to the
 * `$NativeProto` glue singleton (native-proto.ts) — NOT a `$Object` — so
 * `Object.prototype[1] = 111` routed into `__extern_set`'s non-`$Object`
 * miss arm and landed NOWHERE (P3: the subsequent `({length:3})[1]` read
 * answered NaN). And the read chokepoints answered OWN-ONLY, so even with a
 * store the inherited index stayed invisible to the
 * `Array.prototype.<HOF>.call(obj)` borrow loops (P2: `{0:0,2:2,length:3}`
 * visited 2 of 3 indices).
 *
 * ## The mechanism (mirrors the host lane's ratified `_protoIndexHas` /
 * `_protoIndexGet`, src/runtime.ts:409/417)
 *
 * Two module globals hold lazily-minted `$Object` COMPANIONS — one for
 * `%Object.prototype%`, one for `%Array.prototype%`. Everything delegates to
 * the existing `$Object` machinery (`__new_plain_object`, `__obj_find`,
 * `__extern_set`, `__defineProperty_*`), never re-implements it:
 *
 *  - WRITE arms (finalize-spliced, substitution-by-recursion — the #4161
 *    `closureBagSubstitutionArm` idea): `__extern_set` /
 *    `__defineProperty_value` / `__defineProperty_accessor` get a prepended
 *    `$NativeProto`-brand arm. An Object/Array-branded receiver whose key is
 *    a CANONICAL NON-NEGATIVE INTEGER string re-targets the call at the
 *    companion (minting it on first write) and RECURSES, so the whole
 *    existing machinery (accessor-set gate, #2042-S4 preflight, flag
 *    translation, frozen checks) applies unchanged. Non-integer keys and
 *    other brands fall through byte-unchanged — integer-index-only
 *    participation, exactly the host model. `__extern_set_strict` needs no
 *    arm: its non-`$Object` head delegates to `__extern_set`.
 *  - READ fallbacks: the chokepoints consult the companions only after every
 *    own/chain probe missed — `__extern_get` / `__extern_has` at their
 *    terminal proto-walk miss (covers `$Object` receivers, incl. the
 *    `__extern_get_idx` / `__extern_has_idx` `$Object` arms that delegate
 *    there), the `$__vec_base` arms on OOB, and the closed-struct arms
 *    (`fillExternArrayLikeStructArms`) on field-ladder miss. A `$__vec_base`
 *    receiver consults the Array companion FIRST, then the Object companion
 *    (Array.prototype's own chain ends at Object.prototype); everything else
 *    consults the Object companion only. Presence is value-independent
 *    (§7.3.12); Get invokes a companion accessor with the ORIGINAL receiver
 *    bound as `this` (§6.2.5.5) via `__call_accessor_get`.
 *
 * ## Gate — `ctx.standalone && ctx.protoIndexDirty`; byte-identity by construction
 *
 * `protoIndexDirty` is a PRE-SCAN flag (array-holes.ts, set before any body
 * compiles — #4128), so the reserve below simply never runs for a clean
 * module: no globals, no helpers, and every consult site in object-runtime
 * resolves `funcMap.get(...) === undefined` and emits its exact pre-existing
 * instructions. Host/gc output is additionally untouched because the reserve
 * is standalone-gated. This is the flag-clear-means-no-new-instruction
 * guarantee the #4160 issue names as its no-regression criterion.
 *
 * ## Reserve-then-fill (the established funcIdx discipline)
 *
 * The six helpers are reserved as typed stubs from `ensureObjectRuntime`
 * BEFORE the `__extern_*` bodies bake their `call <idx>` (the vec-props /
 * closure-props pattern); bodies are filled at FINALIZE
 * (`fillProtoIndexStore`), when `$NativeProto` + the builtin brands + every
 * dependency funcIdx are known and resolvable from `funcMap`. Spliced arms
 * append locals only (never renumber) and build fresh Instr objects per use
 * (the shared-instr double-remap hazard,
 * `reference_shared_instr_object_dce_double_remap`).
 *
 * ## Known boundaries (deliberate, recorded)
 *
 *  - `Object.defineProperties(Object.prototype, {...})` (the PLURAL form) is
 *    not armed — its receiver head keeps the lenient no-op for a
 *    `$NativeProto`, as before. The singular forms (the test262-dominant
 *    shapes, incl. everything `isProtoIndexWrite` recognises) are covered.
 *  - A companion SETTER invoked via the `__extern_set` recursion receives the
 *    companion (not the proto object) as `this` — the same receiver
 *    approximation the delegation buys everywhere else on the write side.
 *    The GET side does bind the spec receiver (see `__protoidx_get_k`).
 *  - In-bounds vec HOLES still answer present/undefined (dense carriers; a
 *    `$Hole`-aware Has/Get is #2001/#3185 scope, not widened here).
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { getBuiltinBrand } from "./native-proto.js";
import { addFuncType } from "./registry/types.js";

/** Reserved helper names (all internal, never exported from the module). */
const PROTOIDX_COMPANION = "__protoidx_companion";
const PROTOIDX_NORM_KEY = "__protoidx_norm_key";
const PROTOIDX_HAS_K = "__protoidx_has_k";
const PROTOIDX_GET_K = "__protoidx_get_k";
const PROTOIDX_HAS_F = "__protoidx_has_f";
const PROTOIDX_GET_F = "__protoidx_get_f";

/** `$PropEntry` field indices (object-runtime.ts layout — value/flags/get). */
const ENTRY_VALUE = 1;
const ENTRY_FLAGS = 2;
const ENTRY_GET = 4;
/** `$PropEntry.$flags` accessor bit (object-runtime.ts `FLAG_ACCESSOR`). */
const FLAG_ACCESSOR = 0x08;
/** i31 abstract heap type (signed LEB -20) — small-int boxed numbers (#3673). */
const I31_HEAP_TYPE = -20;
/** 2^53 − 1 — the spec's integer-index ceiling (§6.1.7 "integer index"). */
const MAX_SAFE_INTEGER = 9007199254740991;

/**
 * Reserve the proto-index-store globals + helper stubs. Called from
 * `ensureObjectRuntime` right after the closure/vec side-table reserves,
 * BEFORE the `__extern_*` bodies bake their `call <idx>`. Self-gated on
 * `ctx.standalone && ctx.protoIndexDirty` (see module header) and idempotent.
 * Appends types/globals/funcs only — never shifts an existing index.
 */
export function reserveProtoIndexStore(ctx: CodegenContext): void {
  if (!ctx.standalone || !ctx.protoIndexDirty) return;
  if (ctx.protoIndexStoreReserved) return;
  ctx.protoIndexStoreReserved = true;

  // --- companion globals: (mut externref) = null, minted on first write ---
  const objGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__protoidx_obj_companion",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  ctx.protoIndexObjCompanionGlobalIdx = objGlobalIdx;
  const arrGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__protoidx_arr_companion",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  ctx.protoIndexArrCompanionGlobalIdx = arrGlobalIdx;

  // --- helper stubs (bodies filled by fillProtoIndexStore at finalize).
  // Stub bodies are FRESH arrays per helper — never a shared Instr list.
  const reserve = (name: string, params: ValType[], results: ValType[], stub: () => Instr[]): void => {
    if (ctx.funcMap.get(name) !== undefined) return;
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const placeholder: WasmFunction = { name, typeIdx, locals: [], body: stub(), exported: false };
    pushDefinedFunc(ctx, funcIdx, placeholder);
    ctx.funcMap.set(name, funcIdx);
  };
  const ext: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const nullExt = (): Instr[] => [{ op: "ref.null.extern" }];
  const zero = (): Instr[] => [{ op: "i32.const", value: 0 }];
  // (which: 0=Object 1=Array, create: 0/1) -> companion externref (null when
  // absent and create=0).
  reserve(PROTOIDX_COMPANION, [i32, i32], [ext], nullExt);
  // ToPropertyKey-lite normalizer: string / boxed-number key -> its canonical
  // non-negative-integer string, or null-extern when the key does not
  // participate (non-integer, non-canonical, symbol/object — the latter two
  // deliberately untouched so no user ToPrimitive ever runs twice).
  reserve(PROTOIDX_NORM_KEY, [ext], [ext], nullExt);
  // (key, consultArray) -> 1 iff a companion carries the key (§7.3.12 —
  // presence only, value-independent).
  reserve(PROTOIDX_HAS_K, [ext, i32], [i32], zero);
  // (origRecv, key, consultArray) -> [[Get]] through the companions: data
  // value, accessor invoked with origRecv as `this`, or the undefined miss.
  reserve(PROTOIDX_GET_K, [ext, ext, i32], [ext], nullExt);
  // f64-index conveniences for the numeric chokepoints (canonicalise via
  // number_toString — a non-integer index stringifies to "1.5" and misses).
  reserve(PROTOIDX_HAS_F, [f64, i32], [i32], zero);
  reserve(PROTOIDX_GET_F, [ext, f64, i32], [ext], nullExt);
}

/**
 * Registration-time consult for `__extern_get`'s terminal proto-walk miss:
 * `[recv, key, 0] -> call __protoidx_get_k` (tail position — the caller's
 * body ends with an externref). Returns `undefined` when the store is not
 * reserved (flag clear / host mode) so the caller emits its exact
 * pre-existing miss.
 */
export function protoIndexGetKeyMissInstrs(
  ctx: CodegenContext,
  recvLocal: number,
  keyLocal: number,
): Instr[] | undefined {
  const getKIdx = ctx.funcMap.get(PROTOIDX_GET_K);
  if (getKIdx === undefined) return undefined;
  return [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: keyLocal },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: getKIdx },
  ];
}

/**
 * Registration-time consult for `__extern_has`'s terminal proto-walk miss:
 * `[key, 0] -> call __protoidx_has_k` (tail i32). `undefined` when unreserved.
 */
export function protoIndexHasKeyMissInstrs(ctx: CodegenContext, keyLocal: number): Instr[] | undefined {
  const hasKIdx = ctx.funcMap.get(PROTOIDX_HAS_K);
  if (hasKIdx === undefined) return undefined;
  return [
    { op: "local.get", index: keyLocal },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: hasKIdx },
  ];
}

/**
 * Numeric-index consult `[idx, consultArray] -> i32` for the `$__vec_base` /
 * closed-struct Has arms. `undefined` when unreserved.
 */
export function protoIndexHasIdxInstrs(
  ctx: CodegenContext,
  idxLocal: number,
  consultArray: 0 | 1,
): Instr[] | undefined {
  const hasFIdx = ctx.funcMap.get(PROTOIDX_HAS_F);
  if (hasFIdx === undefined) return undefined;
  return [
    { op: "local.get", index: idxLocal },
    { op: "i32.const", value: consultArray },
    { op: "call", funcIdx: hasFIdx },
  ];
}

/**
 * Numeric-index consult `[recv, idx, consultArray] -> externref` for the Get
 * miss points of the vec / closed-struct arms. `undefined` when unreserved.
 */
export function protoIndexGetIdxMissInstrs(
  ctx: CodegenContext,
  recvLocal: number,
  idxLocal: number,
  consultArray: 0 | 1,
): Instr[] | undefined {
  const getFIdx = ctx.funcMap.get(PROTOIDX_GET_F);
  if (getFIdx === undefined) return undefined;
  return [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: idxLocal },
    { op: "i32.const", value: consultArray },
    { op: "call", funcIdx: getFIdx },
  ];
}

/** Everything the finalize fill needs; null when some dependency is absent. */
interface ProtoIndexFillDeps {
  objectTypeIdx: number;
  propEntryTypeIdx: number;
  companionIdx: number;
  newPlainObjectIdx: number;
  objFindIdx: number;
  unboxNumberIdx: number;
  strToNumberIdx: number;
  numberToStringIdx: number;
  callAccessorGetIdx: number;
  strFlattenIdx: number;
  strEqualsIdx: number;
  objGlobalIdx: number;
  arrGlobalIdx: number;
}

function resolveFillDeps(ctx: CodegenContext): ProtoIndexFillDeps | null {
  const types = ctx.objectRuntimeTypes;
  if (!types) return null;
  const companionIdx = ctx.funcMap.get(PROTOIDX_COMPANION);
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const unboxNumberIdx = ctx.funcMap.get("__unbox_number");
  const strToNumberIdx = ctx.funcMap.get("__str_to_number");
  const numberToStringIdx = ctx.funcMap.get("number_toString");
  const callAccessorGetIdx = ctx.funcMap.get("__call_accessor_get");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const objGlobalIdx = ctx.protoIndexObjCompanionGlobalIdx;
  const arrGlobalIdx = ctx.protoIndexArrCompanionGlobalIdx;
  if (
    companionIdx === undefined ||
    newPlainObjectIdx === undefined ||
    objFindIdx === undefined ||
    unboxNumberIdx === undefined ||
    strToNumberIdx === undefined ||
    numberToStringIdx === undefined ||
    callAccessorGetIdx === undefined ||
    strFlattenIdx === undefined ||
    strEqualsIdx === undefined ||
    objGlobalIdx === undefined ||
    arrGlobalIdx === undefined
  ) {
    return null;
  }
  return {
    objectTypeIdx: types.objectTypeIdx,
    propEntryTypeIdx: types.propEntryTypeIdx,
    companionIdx,
    newPlainObjectIdx,
    objFindIdx,
    unboxNumberIdx,
    strToNumberIdx,
    numberToStringIdx,
    callAccessorGetIdx,
    strFlattenIdx,
    strEqualsIdx,
    objGlobalIdx,
    arrGlobalIdx,
  };
}

function findFn(ctx: CodegenContext, name: string): WasmFunction | undefined {
  const idx = ctx.funcMap.get(name);
  return idx === undefined ? undefined : definedFuncAt(ctx, idx);
}

/**
 * FINALIZE — fill the reserved helper bodies and splice the `$NativeProto`
 * write/read arms, all funcIdx/typeIdx resolved NOW from `funcMap`/ctx (the
 * `fillExternArrayLikeStructArms` discipline). Idempotent. No-op unless
 * `reserveProtoIndexStore` ran (flag-set standalone modules only).
 */
export function fillProtoIndexStore(ctx: CodegenContext): void {
  if (!ctx.protoIndexStoreReserved || ctx.protoIndexStoreFilled) return;
  ctx.protoIndexStoreFilled = true;
  const deps = resolveFillDeps(ctx);
  if (!deps) return; // dependencies absent — stubs keep answering "miss" (safe)

  fillCompanionBody(ctx, deps);
  fillNormKeyBody(ctx, deps);
  fillHasKBody(ctx, deps);
  fillGetKBody(ctx, deps);
  fillHasFBody(ctx, deps);
  fillGetFBody(ctx, deps);
  spliceNativeProtoWriteArms(ctx);
  spliceNativeProtoDirectReadArms(ctx);
}

/** `__protoidx_companion(which, create) -> externref` — lazily-minted store. */
function fillCompanionBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_COMPANION);
  if (!fn) return;
  // params: 0=which 1=create
  const branch = (globalIdx: number): Instr[] => [
    { op: "global.get", index: globalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "call", funcIdx: deps.newPlainObjectIdx },
            { op: "global.set", index: globalIdx },
          ],
        },
      ],
    },
    { op: "global.get", index: globalIdx },
    { op: "return" },
  ];
  const tail = branch(deps.objGlobalIdx);
  tail.pop(); // trailing `return` is redundant in tail position
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "if", blockType: { kind: "empty" }, then: branch(deps.arrGlobalIdx) },
    ...tail,
  ];
}

/**
 * `__protoidx_norm_key(key) -> externref` — the canonical-integer-index gate
 * (the host `_protoIndexHas/Get`'s `Number.isInteger(idx) && idx >= 0`, plus
 * the CanonicalNumericIndexString check a string key needs). Returns the
 * canonical decimal string, or null-extern when the key does not participate.
 */
function fillNormKeyBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_NORM_KEY);
  if (!fn || ctx.anyStrTypeIdx < 0) return;
  const anyStr = ctx.anyStrTypeIdx;
  const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
  // locals: 1=any(anyref) 2=str(externref) 3=n(f64)
  fn.locals = [
    { name: "any", type: { kind: "anyref" } },
    { name: "str", type: { kind: "externref" } },
    { name: "n", type: { kind: "f64" } },
  ];
  const miss = (): Instr[] => [{ op: "ref.null.extern" }, { op: "return" }];
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    // string key → keep as-is; boxed-number / i31 key → canonical decimal
    // string; anything else (symbol / object) → does not participate. Object
    // keys are deliberately NOT ToPrimitive'd here: the fall-through path
    // coerces them exactly once, and running a user toString twice would
    // double its side effects.
    { op: "ref.test", typeIdx: anyStr },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.set", index: 2 },
      ],
      else:
        boxNumTypeIdx >= 0
          ? [
              { op: "local.get", index: 1 },
              { op: "ref.test", typeIdx: boxNumTypeIdx },
              { op: "local.get", index: 1 },
              { op: "ref.test", typeIdx: I31_HEAP_TYPE },
              { op: "i32.or" },
              { op: "i32.eqz" },
              { op: "if", blockType: { kind: "empty" }, then: miss() },
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: deps.unboxNumberIdx },
              { op: "call", funcIdx: deps.numberToStringIdx },
              { op: "local.set", index: 2 },
            ]
          : miss(),
    },
    // n = StringToNumber(str) (§7.1.4.1)
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: deps.strToNumberIdx },
    { op: "local.tee", index: 3 },
    // integer index: trunc(n) == n (NaN fails) && n >= 0 && n <= 2^53−1
    // (Infinity fails the ceiling).
    { op: "f64.trunc" },
    { op: "local.get", index: 3 },
    { op: "f64.eq" },
    { op: "local.get", index: 3 },
    { op: "f64.const", value: 0 },
    { op: "f64.ge" },
    { op: "i32.and" },
    { op: "local.get", index: 3 },
    { op: "f64.const", value: MAX_SAFE_INTEGER },
    { op: "f64.le" },
    { op: "i32.and" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: miss() },
    // canonicity: ToString(n) must equal the key string — "01" / " 1" / "1e2"
    // / "" are NOT integer indices (they stay plain string props, untouched).
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: deps.numberToStringIdx },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: deps.strFlattenIdx },
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: deps.strFlattenIdx },
    { op: "call", funcIdx: deps.strEqualsIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: miss() },
    { op: "local.get", index: 2 },
  ];
}

/**
 * Probe one companion (LOOKUP, never ensure — reads must not allocate): if it
 * exists and `__obj_find` answers a live entry for the key, run `hit`.
 * `cLocal` is an externref scratch local of the enclosing helper.
 */
function companionProbeArm(
  deps: ProtoIndexFillDeps,
  which: 0 | 1,
  keyLocal: number,
  cLocal: number,
  hit: Instr[],
): Instr[] {
  return [
    { op: "i32.const", value: which },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: deps.companionIdx },
    { op: "local.set", index: cLocal },
    { op: "local.get", index: cLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: cLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: deps.objectTypeIdx },
        { op: "local.get", index: keyLocal },
        { op: "call", funcIdx: deps.objFindIdx },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: hit },
      ],
    },
  ];
}

/** `__protoidx_has_k(key, consultArray) -> i32` — §7.3.12 presence. */
function fillHasKBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_HAS_K);
  if (!fn) return;
  // params: 0=key 1=consultArray ; locals: 2=c(externref)
  fn.locals = [{ name: "c", type: { kind: "externref" } }];
  const hit = (): Instr[] => [{ op: "i32.const", value: 1 }, { op: "return" }];
  fn.body = [
    { op: "local.get", index: 1 },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: companionProbeArm(deps, 1, 0, 2, hit()),
    },
    ...companionProbeArm(deps, 0, 0, 2, hit()),
    { op: "i32.const", value: 0 },
  ];
}

/** `__protoidx_get_k(origRecv, key, consultArray) -> externref` — §6.2.5.5 Get. */
function fillGetKBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_GET_K);
  if (!fn) return;
  const entryRefNull: ValType = { kind: "ref_null", typeIdx: deps.propEntryTypeIdx };
  // params: 0=origRecv 1=key 2=consultArray
  // locals: 3=c(externref) 4=e(ref null $PropEntry, default null) 5=getter(externref)
  fn.locals = [
    { name: "c", type: { kind: "externref" } },
    { name: "e", type: entryRefNull },
    { name: "getter", type: { kind: "externref" } },
  ];
  const miss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const probeInto = (which: 0 | 1): Instr[] => [
    { op: "i32.const", value: which },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: deps.companionIdx },
    { op: "local.set", index: 3 },
    { op: "local.get", index: 3 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: deps.objectTypeIdx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: deps.objFindIdx },
        { op: "local.set", index: 4 },
      ],
    },
  ];
  fn.body = [
    // consultArray → probe the Array companion first.
    { op: "local.get", index: 2 },
    { op: "if", blockType: { kind: "empty" }, then: probeInto(1) },
    // Object companion only when nothing was found yet.
    { op: "local.get", index: 4 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: probeInto(0) },
    // No entry anywhere → undefined miss.
    { op: "local.get", index: 4 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...miss(), { op: "return" }],
    },
    // Accessor entry → invoke the getter with the ORIGINAL receiver
    // (§6.2.5.5 step 8 — Receiver is the object the Get started on).
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: ENTRY_FLAGS },
    { op: "i32.const", value: FLAG_ACCESSOR },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 4 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: ENTRY_GET },
        { op: "extern.convert_any" },
        { op: "local.tee", index: 5 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...miss(), { op: "return" }],
        },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 5 },
        { op: "call", funcIdx: deps.callAccessorGetIdx },
        { op: "return" },
      ],
    },
    // Data entry → its value.
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
    { op: "extern.convert_any" },
  ];
}

/** `__protoidx_has_f(idx, consultArray)` = has_k(ToString(idx), consultArray). */
function fillHasFBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_HAS_F);
  const hasKIdx = ctx.funcMap.get(PROTOIDX_HAS_K);
  if (!fn || hasKIdx === undefined) return;
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: deps.numberToStringIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: hasKIdx },
  ];
}

/** `__protoidx_get_f(recv, idx, consultArray)` = get_k(recv, ToString(idx), ca). */
function fillGetFBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_GET_F);
  const getKIdx = ctx.funcMap.get(PROTOIDX_GET_K);
  if (!fn || getKIdx === undefined) return;
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: deps.numberToStringIdx },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: getKIdx },
  ];
}

/**
 * The `$NativeProto` brand head shared by the write arms: runs `then` when
 * the receiver (param 0) is the Object/Array prototype glue singleton and the
 * key (param `keyParam`) normalises to a canonical integer index (left in
 * `nkLocal`; brand left in `brandLocal`). Falls through untouched otherwise.
 */
function nativeProtoWriteArmHead(
  ctx: CodegenContext,
  opts: { brandLocal: number; nkLocal: number; keyParam: number; objBrand: number; arrBrand: number; then: Instr[] },
): Instr[] | undefined {
  const npTypeIdx = ctx.nativeProtoTypeIdx;
  const normKeyIdx = ctx.funcMap.get(PROTOIDX_NORM_KEY);
  if (npTypeIdx === undefined || normKeyIdx === undefined) return undefined;
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: npTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: npTypeIdx },
        { op: "struct.get", typeIdx: npTypeIdx, fieldIdx: 0 }, // $brand
        { op: "local.set", index: opts.brandLocal },
        { op: "local.get", index: opts.brandLocal },
        { op: "i32.const", value: opts.objBrand },
        { op: "i32.eq" },
        { op: "local.get", index: opts.brandLocal },
        { op: "i32.const", value: opts.arrBrand },
        { op: "i32.eq" },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: opts.keyParam },
            { op: "call", funcIdx: normKeyIdx },
            { op: "local.tee", index: opts.nkLocal },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: opts.then },
          ],
        },
      ],
    },
  ];
}

/** `[brandLocal == arrBrand (which), create=1] -> call companion` (externref). */
function companionForBrandInstrs(companionIdx: number, brandLocal: number, arrBrand: number): Instr[] {
  return [
    { op: "local.get", index: brandLocal },
    { op: "i32.const", value: arrBrand },
    { op: "i32.eq" },
    { op: "i32.const", value: 1 }, // create — this is the write side
    { op: "call", funcIdx: companionIdx },
  ];
}

/**
 * FINALIZE — prepend the `$NativeProto` write arms (substitution-by-recursion)
 * onto `__extern_set` / `__defineProperty_value` / `__defineProperty_accessor`.
 * The arm re-targets the call at the companion `$Object` and RECURSES (the
 * companion is a plain `$Object`, so the recursion takes the ordinary path and
 * terminates), which keeps the accessor-set gate, the #2042-S4 preflight, the
 * flag translation and the frozen checks all working unchanged; the define
 * arms still return the ORIGINAL receiver (defineProperty returns O). Locals
 * are appended, never renumbered.
 */
function spliceNativeProtoWriteArms(ctx: CodegenContext): void {
  const objBrand = getBuiltinBrand(ctx, "Object");
  const arrBrand = getBuiltinBrand(ctx, "Array");
  const companionIdx = ctx.funcMap.get(PROTOIDX_COMPANION);
  if (objBrand === undefined || arrBrand === undefined || companionIdx === undefined) return;

  const spliceInto = (
    name: string,
    numParams: number,
    inner: (brandLocal: number, nkLocal: number, selfIdx: number) => Instr[],
  ): void => {
    const selfIdx = ctx.funcMap.get(name);
    const fn = selfIdx === undefined ? undefined : definedFuncAt(ctx, selfIdx);
    if (!fn || selfIdx === undefined) return;
    const brandLocal = numParams + fn.locals.length;
    const nkLocal = brandLocal + 1;
    const arm = nativeProtoWriteArmHead(ctx, {
      brandLocal,
      nkLocal,
      keyParam: 1,
      objBrand,
      arrBrand,
      then: inner(brandLocal, nkLocal, selfIdx),
    });
    if (!arm) return;
    fn.locals.push(
      { name: "__protoidx_brand", type: { kind: "i32" } },
      { name: "__protoidx_nk", type: { kind: "externref" } },
    );
    fn.body.splice(0, 0, ...arm);
  };

  // __extern_set(obj, key, value) -> void
  spliceInto("__extern_set", 3, (brandLocal, nkLocal, selfIdx) => [
    ...companionForBrandInstrs(companionIdx, brandLocal, arrBrand),
    { op: "local.get", index: nkLocal },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: selfIdx },
    { op: "return" },
  ]);
  // __defineProperty_value(obj, key, value, flagsF64) -> externref (returns O)
  spliceInto("__defineProperty_value", 4, (brandLocal, nkLocal, selfIdx) => [
    ...companionForBrandInstrs(companionIdx, brandLocal, arrBrand),
    { op: "local.get", index: nkLocal },
    { op: "local.get", index: 2 },
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: selfIdx },
    { op: "drop" },
    { op: "local.get", index: 0 }, // return the ORIGINAL proto receiver
    { op: "return" },
  ]);
  // __defineProperty_accessor(obj, key, getter, setter, flagsF64) -> externref
  spliceInto("__defineProperty_accessor", 5, (brandLocal, nkLocal, selfIdx) => [
    ...companionForBrandInstrs(companionIdx, brandLocal, arrBrand),
    { op: "local.get", index: nkLocal },
    { op: "local.get", index: 2 },
    { op: "local.get", index: 3 },
    { op: "local.get", index: 4 },
    { op: "call", funcIdx: selfIdx },
    { op: "drop" },
    { op: "local.get", index: 0 },
    { op: "return" },
  ]);
}

/**
 * FINALIZE — read-your-writes coherence for DIRECT indexed reads on the proto
 * objects themselves (`Object.prototype[1]` / `Array.prototype[1]` as
 * receivers): prepend a `$NativeProto` brand arm onto `__extern_get_idx` /
 * `__extern_has_idx` that consults the companions (the Array brand consults
 * the Array companion first — its own chain ends at Object.prototype). Other
 * brands fall through to today's behaviour.
 */
function spliceNativeProtoDirectReadArms(ctx: CodegenContext): void {
  const npTypeIdx = ctx.nativeProtoTypeIdx;
  const objBrand = getBuiltinBrand(ctx, "Object");
  const arrBrand = getBuiltinBrand(ctx, "Array");
  const getFIdx = ctx.funcMap.get(PROTOIDX_GET_F);
  const hasFIdx = ctx.funcMap.get(PROTOIDX_HAS_F);
  if (npTypeIdx === undefined || objBrand === undefined || arrBrand === undefined) return;
  if (getFIdx === undefined || hasFIdx === undefined) return;

  const splice = (name: string, isHas: boolean, consultIdx: number): void => {
    const fn = findFn(ctx, name);
    if (!fn) return;
    // params: 0=v(externref) 1=idx(f64); append a brand scratch local.
    const brandLocal = 2 + fn.locals.length;
    fn.locals.push({ name: "__protoidx_brand", type: { kind: "i32" } });
    // has_f takes (idx, consultArray); get_f takes (recv, idx, consultArray).
    const consult = (consultArray: 0 | 1): Instr[] => [
      ...(isHas ? [] : ([{ op: "local.get", index: 0 }] satisfies Instr[])),
      { op: "local.get", index: 1 },
      { op: "i32.const", value: consultArray },
      { op: "call", funcIdx: consultIdx },
      { op: "return" },
    ];
    const arm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: npTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: npTypeIdx },
          { op: "struct.get", typeIdx: npTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: brandLocal },
          { op: "local.get", index: brandLocal },
          { op: "i32.const", value: objBrand },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: consult(0) },
          { op: "local.get", index: brandLocal },
          { op: "i32.const", value: arrBrand },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: consult(1) },
          // other brands: fall through unchanged
        ],
      },
    ];
    fn.body.splice(0, 0, ...arm);
  };
  splice("__extern_get_idx", false, getFIdx);
  splice("__extern_has_idx", true, hasFIdx);
}
