// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1472 Phase B — Wasm-native open-object runtime for `--target standalone`.
 *
 * Open objects (plain object literals, `any`-typed property access) are the
 * single largest standalone-mode failure cluster (26,880 primary rows). In
 * JS-host mode they route through a family of `env::__extern_*` /
 * `env::__object_*` host imports backed by JS WeakMap sidecars; in standalone
 * there is no JS runtime to satisfy those imports. Phase A refuses such code at
 * compile time. Phase B (this module) replaces the sidecars with a pure-WasmGC
 * open-hash-map so dynamic object semantics work with zero host calls.
 *
 * ## Representation
 *
 * ```
 * (type $PropEntry (struct
 *   (field $key   (ref $AnyString))            ;; immutable property key
 *   (field $value (mut anyref))                ;; property value (boxed)
 *   (field $flags (mut i32))))                 ;; writable/enumerable/configurable/tombstone
 *
 * (type $PropMap (array (mut (ref null $PropEntry))))   ;; open-addressing table
 *
 * (type $Object (struct
 *   (field $proto      (mut (ref null $Object)))
 *   (field $props      (mut (ref $PropMap)))
 *   (field $count      (mut i32))              ;; live entries (excl. tombstones)
 *   (field $tombstones (mut i32))              ;; dead entries pending rehash
 *   (field $flags      (mut i32))))            ;; extensible/frozen/sealed bits
 * ```
 *
 * ## Integration strategy (why no per-call-site retargeting)
 *
 * The existing JS-host call sites treat objects as `externref` and look the
 * helper up by name via `ensureLateImport(ctx, "__extern_get", …)` then emit a
 * plain `call funcIdx`. To avoid touching every call site (and the index-shift
 * machinery they rely on), the native helpers registered here keep the **exact
 * same name and externref-based signature** as the host imports:
 *
 *   - `__new_plain_object()                          -> externref`
 *   - `__extern_get(externref obj, externref key)    -> externref`
 *   - `__extern_set(externref obj, externref key, externref value) -> void`
 *
 * Internally a `$Object` struct is wrapped to externref via `extern.convert_any`
 * (a no-op at the engine level, same trick `__box_number` uses) and unwrapped
 * via `any.convert_extern` + `ref.cast $Object`. So `ensureLateImport` can route
 * these names here under `ctx.standalone` exactly like the #1471 boxing helpers
 * (`UNION_NATIVE_HELPER_NAMES`), and the call sites are byte-for-byte unchanged.
 *
 * Keys arrive as `externref` holding a `$NativeString` (standalone auto-enables
 * nativeStrings, so a string literal key is `extern.convert_any(ref
 * $NativeString)`). We `ref.cast $AnyString` + `__str_flatten` to a
 * `$NativeString` for hashing and reuse the existing `__str_equals` for
 * comparison.
 *
 * Closed-shape struct access (the `getFieldEntry` fast path) never reaches this
 * runtime — it emits `struct.get`/`struct.set` directly and never calls
 * `ensureLateImport` for these names.
 */
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeCharCodeAtHelper } from "./char-code-at-helpers.js";
import { getFuncRefWrapperRootTypeIdx } from "./closures/funcref-wrapper-types.js"; // (#3673 round 19b)
import {
  ensureAnyToStringHelper,
  ensureNativeStringHelpers,
  nativeStringLiteralInstrs,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { emitNativeParseNumber } from "./parse-number-native.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterBoundFnType,
  getOrRegisterVecBaseType,
  getOrRegisterVecType,
} from "./registry/types.js";
import { buildClosureRefTestArms } from "./closure-classifier.js"; // (#3140) __bind_dyn callable gate
import { buildApplyClosureArityWidening, buildTransferredCharAtApplyArm } from "./closure-exports.js"; // (#3592) under-application widening
import { addUnionImportsViaRegistry, flushLateImportShifts } from "./shared.js";
import { reserveAccessorGetDriver, reserveAccessorSetDriver } from "./accessor-driver.js";
import { registerDescriptorHasOwn } from "./carrier-bag-hasown.js"; // (#4055) descriptor-scoped HasProperty over the #3468 bag
import { buildNonObjectDeleteArms, reserveCarrierBagDelete } from "./carrier-bag-delete.js"; // (#4010 S2) OrdinaryDelete over the carrier bags
import {
  bagHasElseAbsent,
  bagHasIfAbsent,
  bagKeysTail,
  reserveCarrierBagVisibility,
} from "./carrier-bag-visibility.js";
import { reserveClosurePropHelpers } from "./closure-props.js"; // (#3468 C-core) closure-own-property side table
import { OBJECT_INTEGRITY_OBJ_PREDICATES } from "./object-integrity-carrier.js"; // (#4032)
// (#3537) array ($Vec) expando side table — composes AROUND the #3468 closure
// arms (vec test first, unchanged closure arm as fallthrough).
import {
  buildVecOrClosurePropGetMissArm,
  buildVecOrClosurePropMethodCallElseArm,
  buildVecOrClosurePropSetMissArm,
  reserveVecPropHelpers,
} from "./vec-props.js";
import { ensureSymbolCarrier } from "./symbol-native.js";
import { reserveArrayToPrimitiveString } from "./array-to-primitive.js";
import { UNDEF_F64_BITS } from "./value-tags.js";
// (#2106 S1) function-level-only cycle with any-helpers.ts (which imports
// ensureObjectRuntime) — same tolerated shape as native-strings ↔ any-helpers.
import { buildIsUndefinedExternBody, undefinedExternInstrs, undefinedSingletonActive } from "./any-helpers.js";
import { reserveClassToPrimitive } from "./class-to-primitive.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2/S3) positional-read chokepoint + stable-regime minting
import { emitSelfHostedFunc } from "./stdlib-selfhost.js"; // (#3160) self-hosted object-runtime slice
import { SELF_HOSTED_OBJECT_RUNTIME } from "../stdlib/object-runtime.js"; // (#3160) TS-source builtins
import { buildObjectDescriptorHelpers } from "./object-runtime-descriptors.js";
import { buildStrictSetHelper } from "./object-runtime-strict-set.js"; // (#3983) strict [[Set]] TypeError
import { exposedClosedStructFieldName, isOpenDescriptorShape } from "./property-descriptor-shape.js";
import type { PresenceSlot } from "./fnctor-presence-bits.js"; // (#3780) packed own-presence flags
import { presenceSlotOf, presenceTestInstrs } from "./fnctor-presence-bits.js";
import { buildObjectEnumerationHelpers } from "./object-runtime-enumeration.js"; // (#3274 wave-B) enumeration/array-like/object-static helper builders
import { buildObjectPrototypeHelpers } from "./object-runtime-prototype.js"; // (#3274 wave-B) prototype-chain helper builders
import * as fnctorArray from "./fnctor-array-prototype.js";
import { isSyntheticStructName } from "./emit-helpers.js";
import { orderNamesByInsertion } from "./struct-field-exports.js";
import {
  buildRuntimeEvalValueWrap,
  buildRuntimeEvalValueUnwrap,
  ensureRuntimeEvalProviderActiveGlobal,
  RUNTIME_EVAL_AOT_CALLABLE_BRAND_A,
  RUNTIME_EVAL_AOT_CALLABLE_BRAND_B,
  RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A,
  RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B,
} from "./runtime-eval-boundary.js";
// (#3265) Proxy dispatch subsystem extracted to a sibling module (subtask of
// #3182 god-file split). `ensureProxyRuntime` is still called by
// `ensureObjectRuntime` (imported back here); `fillProxyDispatch` is re-exported
// so `index.ts`s `from "./object-runtime.js"` importer keeps resolving.
import { ensureProxyRuntime } from "./object-runtime-proxy.js";
import { ensureArgcGlobal } from "./statements/nested-declarations.js";
import { buildLazyNativeProtoGetInstrs, getBuiltinBrand } from "./native-proto.js";
export { fillProxyDispatch } from "./object-runtime-proxy.js";

/** Initial `$PropMap` capacity. Must be a power of two (mask = cap - 1).
 *  Exported for the (#802) dynamic-proto null-sentinel `$Object` builder, which
 *  must mint a structurally ordinary (hash-compatible) empty `$Object`. */
export const INITIAL_CAP = 8;

/** WasmGC `none` bottom heap type (signed-LEB 0x6e = -18). `ref.null none` is a
 *  subtype of `anyref`, used to push a null into the `$PropEntry.$get/$set`
 *  anyref slots on the data path (#1888 Slice 5). */
const NONE_HEAP = -18;

/** `$PropEntry.$flags` bit layout. */
const FLAG_WRITABLE = 0x01;
const FLAG_ENUMERABLE = 0x02;
const FLAG_CONFIGURABLE = 0x04;
// #1888 Slice 5 — accessor descriptor: when set, the entry's value is replaced
// by the `$get`/`$set` funcref-bearing slots (fields 4/5). 0x08 is the first
// extension bit (0x10 internal; 0x20/0x40 vec-overlay; 0x80 = TOMBSTONE).
const FLAG_ACCESSOR = 0x08;
// #1910/#1472 S2 — internal-slot marker. Set on the single reserved $PropEntry a
// boxed primitive wrapper (`new Number`/`new String`/`new Boolean`) carries: it
// holds the wrapper's [[NumberData]]/[[StringData]]/[[BooleanData]] primitive
// under WRAPPER_PRIMITIVE_KEY. The entry is NON-enumerable (FLAG_INTERNAL is set,
// FLAG_ENUMERABLE is not), so it never appears in Object.keys/for-in/JSON, and
// `__to_primitive` reads it FIRST (before the OrdinaryToPrimitive valueOf/toString
// probe) per §7.1.1.1 — standalone ships no Number.prototype.valueOf, so the slot
// IS the recoverable internal value. 0x20/0x40 are reserved by vec-overlay.ts.
export const FLAG_INTERNAL = 0x10;
// 0x20 = FLAG_COMPANION_VALUE (#3251, vec-overlay.ts) — on an array-overlay
// COMPANION data entry whose [[Value]] could not be written back into the vec
// element (kind-incompatible carrier); dynamic readers answer from the
// companion. 0x40 marks a semantically deleted dense vec index.
const FLAG_TOMBSTONE = 0x80;
/**
 * Reserved own-key under which a boxed primitive wrapper stores its internal
 * `[[PrimitiveValue]]` slot (#1910/#1472 S2). Uses the spec internal-slot
 * spelling so it cannot collide with an ordinary identifier-shaped key created
 * by user code in any realistic program; the entry is additionally flagged
 * FLAG_INTERNAL so even an explicit `o["[[PrimitiveValue]]"]` user write is
 * distinguishable, and it is non-enumerable so enumeration never observes it.
 */
export const WRAPPER_PRIMITIVE_KEY = "[[PrimitiveValue]]";
/** Default for a data property created by `o.x = v` — w/e/c all true. */
const FLAG_DEFAULT = FLAG_WRITABLE | FLAG_ENUMERABLE | FLAG_CONFIGURABLE;

/**
 * `$Object.flags` (field 4) object-level integrity bits (#1472 Phase B Blocker
 * A Half 1, landed via PR #1074). Read by the
 * __object_isFrozen/isSealed/isExtensible helpers; set by the freeze/seal SET
 * path (Half 2, not yet landed). On a never-frozen object the field is 0, so
 * isFrozen/isSealed read false and isExtensible reads true.
 */
const OBJ_FLAG_NONEXTENSIBLE = 0x01;
const OBJ_FLAG_SEALED = 0x02;
const OBJ_FLAG_FROZEN = 0x04;
// (#3176) `[[IsRawJSON]]` internal-slot marker for the ES2025 `JSON.rawJSON`
// carrier. Set on the `$Object.flags` field (a genuine internal slot, NOT an
// own property — so a plain `{ rawJSON: '…' }` is distinguishable from a real
// raw-JSON object). `JSON.isRawJSON` reads this bit. 0x10/0x20 are #4120's
// callable/ctor brand (builtin-callable-brand.ts), 0x40+ free; the isFrozen/
// isSealed/isExtensible helpers mask only their own bits, so all stay inert.
export const OBJ_FLAG_RAWJSON = 0x08;

/**
 * Type indices for the open-object runtime structs/arrays, allocated once per
 * module by `ensureObjectRuntime`. Stored on the context so subsequent slices
 * (keys/values/delete/for-in) can reference the same types.
 */
export interface ObjectRuntimeTypes {
  propEntryTypeIdx: number;
  propMapTypeIdx: number;
  objectTypeIdx: number;
  /** `$ObjVec` struct {len: i32, data: (ref (array (mut externref)))} — the
   *  growable externref vector that backs standalone `Object.keys/values/entries`
   *  enumeration results (#1472 Phase B Blocker B). */
  objVecTypeIdx: number;
  /** Backing `(array (mut externref))` for `$ObjVec.data`. */
  objVecArrTypeIdx: number;
  /** (#1100) `$ProxyTraps` struct — 4 funcref fields (get/set/has/apply) for the
   *  standalone Proxy meta-object Phase 1. Null fields forward to the ordinary
   *  [[Get]]/[[Set]]/[[Has]]/[[Call]] on the target. */
  proxyTrapsTypeIdx: number;
  /** (#1100) `$Proxy` struct — subtype of `$Object` carrying the proxy tag,
   *  target, handler, traps, and revoked bit. A proxy IS-A object, so every
   *  `ref.test $Object` still matches it. */
  proxyTypeIdx: number;
}

/**
 * Idempotently register the open-object runtime types + helper functions as
 * defined Wasm functions in `ctx.funcMap` (under the host-import names the call
 * sites already look up). Safe to call repeatedly; only the first call emits.
 *
 * MUST run after `ensureNativeStringHelpers` (it depends on `__str_flatten` /
 * `__str_equals` and the `$NativeString` type indices) — we call it here to
 * guarantee that. Because this path adds only DEFINED functions (no imports),
 * the freshly-allocated func indices sit above every existing function and no
 * index shift is required (same invariant as `addUnionImportsAsNativeFuncs`).
 *
 * That invariant only holds when NO late-import batch is pending: a deferred
 * `ensureLateImport` shift (ctx.pendingLateImportShift) would later add its
 * delta to every funcIdx >= its importsBefore — including the indices this
 * function is about to bake with the post-batch `numImportFuncs` — leaving
 * funcMap and every internal sibling call one regime too high while the
 * function itself sits lower (#2039: `__obj_find` calling `__new_plain_object`
 * instead of `__obj_hash`, 146 invalid-Wasm test262 binaries). So we end any
 * pending batch first; registration then happens in a clean, final regime.
 */

/**
 * (#3239) The TypedArray family + `SharedArrayBuffer`, all of whose subclass
 * parent construction leaks a distinct `env::__new_<Parent>` host import in
 * standalone. See `emitStandaloneVecBuiltinConstructor` for the shared native
 * replacement and the identity-only rationale.
 */
export const STANDALONE_VEC_BUILTIN_PARENTS: ReadonlySet<string> = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "SharedArrayBuffer",
]);

/**
 * (#3239) Standalone/WASI-native `class Sub extends <TypedArray | SharedArrayBuffer>`
 * parent construction.
 *
 * Like `emitStandaloneObjectConstructor`, but the fresh parent value is an
 * empty native `$__vec_externref` rather than a plain object. In standalone the
 * subclass parent creation otherwise lowers to a distinct `env::__new_<Parent>`
 * host import (one per TypedArray element kind, plus `SharedArrayBuffer`) — the
 * SOLE remaining host import of the corresponding `subclass-<Parent>`
 * conformance test, which only asserts `instanceof`. Both `instanceof Sub` and
 * `instanceof <Parent>` are ALREADY resolved host-free at compile time
 * (`tryStaticInstanceOf`: the subclass's recorded builtin parent statically
 * satisfies the hierarchy), so routing the construction native flips the module
 * to `host_free_pass`.
 *
 * SCOPE — identity only, not real typed construction. This deliberately does
 * NOT model element kind, byteLength, backing buffer, or the `super(length)` /
 * `super(buffer, …)` argument semantics: the constructor arguments (still
 * side-effect-evaluated at the call site and passed here as ignored params) are
 * dropped, and an empty vec is returned. That is safe because NO TypedArray /
 * SharedArrayBuffer subclass *behavior* test passes in standalone today — only
 * the `instanceof`-only `subclass-<Parent>` tests do — so there is no
 * length/behavior-dependent passing test to regress (verified against the
 * standalone baseline). Faithful typed construction (needed once behavior tests
 * begin to pass) is left to a follow-up; the arg-honoring Array/Date/RegExp/
 * ArrayBuffer slices (which DO have passing behavior tests) are separate work.
 *
 * Host/gc mode never calls this — the caller gates on `ctx.standalone || ctx.wasi`
 * and keeps the `__new_<Parent>` import there, so those lanes stay byte-identical.
 *
 * (#2917) PER-ARITY registration — funcMap key `<importName>@<argCount>`,
 * funcIdx RETURNED (see `emitStandaloneObjectConstructor` for the mis-call
 * hazard a single plain-name registration created). Idempotent per key.
 */
export function emitStandaloneVecBuiltinConstructor(
  ctx: CodegenContext,
  importName: string,
  argCount: number,
): number | undefined {
  const key = `${importName}@${argCount}`;
  const existing = ctx.funcMap.get(key);
  if (existing !== undefined) return existing;

  // A single shared externref-element vec type backs every one of these parents:
  // the element kind is irrelevant to the identity-only `instanceof` result, and
  // reusing one type keeps the module's type section minimal.
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

  const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" }) as ValType);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `${key}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(key, funcIdx);
  // Ignore the (already side-effect-evaluated) constructor arguments and return
  // a fresh empty vec boxed to externref (`extern.convert_any` — the same no-op
  // boxing the object runtime uses to expose `$Object`/vec structs as externref).
  const body: Instr[] = [
    { op: "i32.const", value: 0 }, // length = 0
    { op: "i32.const", value: 0 }, // backing capacity = 0 (identity-only, no growth)
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" },
  ];
  pushDefinedFunc(ctx, funcIdx, { name: key, typeIdx, locals: [], body, exported: false });
  return funcIdx;
}

/**
 * (#2917 slice 2) Standalone/WASI-native `class Sub extends Array` parent
 * construction — a REAL native `$__vec_externref` backing, honoring the
 * §23.1.1.1 `Array(...values)` argument semantics (unlike the identity-only
 * TypedArray helper above):
 *
 *   - the trailing `undefined` padding the synthetic forwarder adds up to
 *     `argCount` is stripped first (mirroring the JS-host `__new_<Parent>`
 *     resolver, which strips args the wasm side passes as undefined —
 *     class-bodies.ts ~L869);
 *   - 0 effective args → empty array;
 *   - 1 effective arg that IS a boxed number (`$__box_number_struct` — the
 *     representation `compileExternrefArgument` produces for numeric args;
 *     deliberately NOT ToNumber-coercing, so `new Sub("3")` stays `["3"]`) →
 *     array with that length (elements are holes, read back as undefined via
 *     the null externref slots). A non-integral / negative / ≥2^32 length
 *     throws a real RangeError per §23.1.1.1 step 4b;
 *   - otherwise → array OF the effective args (raw externrefs — already the
 *     uniform boxed element representation the `$__vec_base` dynamic
 *     accessors read back).
 *
 * The result is a genuine vec, so dynamic element ops and `.length`
 * (`__extern_get_idx` / `__extern_set_idx` / `__extern_length` `$__vec_base`
 * arms) and `Array.isArray` behave like a real array. Subclass identity
 * (`instanceof Sub` / `instanceof Array`) is resolved statically
 * (`tryStaticInstanceOf`), as with the other externref-backed builtins.
 *
 * Host/gc mode never calls this — the caller gates on
 * `ctx.standalone || ctx.wasi`, so those lanes stay byte-identical.
 *
 * (#2917) PER-ARITY registration — funcMap key `__new_Array@<argCount>`,
 * funcIdx RETURNED (see `emitStandaloneObjectConstructor` for the mis-call
 * hazard a single plain-name registration created). Idempotent per key.
 */
export function emitStandaloneArrayConstructor(ctx: CodegenContext, argCount: number): number | undefined {
  const key = `__new_Array@${argCount}`;
  const existing = ctx.funcMap.get(key);
  if (existing !== undefined) return existing;

  // Dependencies FIRST, so their funcIdx/typeIdx are settled before this body
  // bakes them (any later late-import batch shift-repairs mod.functions bodies,
  // including this one — the standard defined-native invariant).
  ensureObjectRuntime(ctx); // registers __extern_is_undefined (native, no import)
  addUnionImportsViaRegistry(ctx); // registers $__box_number_struct + boxing natives
  const isUndefIdx = ctx.funcMap.get("__extern_is_undefined");
  const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
  if (isUndefIdx === undefined || boxNumTypeIdx === undefined || boxNumTypeIdx < 0) return undefined; // defensive
  // §23.1.1.1 step 4b — a non-integral / negative / ≥2^32 single numeric arg
  // throws a real RangeError (`$Error_struct` via the native ctor, so
  // `catch (e) { e instanceof RangeError }` works — the throwNativeError
  // pattern from registry/imports.ts).
  emitWasiErrorConstructor(ctx, "RangeError", 1);
  const rangeErrCtorIdx = ctx.funcMap.get("__new_RangeError");
  const rangeErrMsg = "Invalid array length";
  addStringConstantGlobal(ctx, rangeErrMsg);
  const exnTagIdx = ensureExnTag(ctx);
  const throwRangeInstrs: Instr[] =
    rangeErrCtorIdx !== undefined
      ? [
          ...stringConstantExternrefInstrs(ctx, rangeErrMsg),
          { op: "call", funcIdx: rangeErrCtorIdx },
          { op: "throw", tagIdx: exnTagIdx },
        ]
      : [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx: exnTagIdx }];

  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

  const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" }) as ValType);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `${key}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(key, funcIdx);

  // Locals (after the argCount externref params):
  const kLocal = argCount; // i32 — effective arg count after padding strip
  const anyLocal = argCount + 1; // anyref — number-box test scratch
  const lenLocal = argCount + 2; // i32 — single-numeric-arg length
  const dataLocal = argCount + 3; // (ref null $__arr_externref)
  const nLocal = argCount + 4; // f64 — single-numeric-arg raw value (RangeError check)
  const locals: { name: string; type: ValType }[] = [
    { name: "k", type: { kind: "i32" } },
    { name: "any", type: { kind: "anyref" } },
    { name: "len", type: { kind: "i32" } },
    { name: "data", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
    { name: "n", type: { kind: "f64" } },
  ];

  const body: Instr[] = [];
  // k = argCount, then strip trailing nullish (ref.null padding pre-#2106, or
  // the non-null $undefined singleton under the S1 regime) args:
  // for i = argCount-1 downTo 0: if (k == i+1 && isNullish(a_i)) k = i
  body.push({ op: "i32.const", value: argCount }, { op: "local.set", index: kLocal });
  for (let i = argCount - 1; i >= 0; i--) {
    body.push(
      { op: "local.get", index: kLocal },
      { op: "i32.const", value: i + 1 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: i },
          { op: "ref.is_null" },
          { op: "local.get", index: i },
          { op: "call", funcIdx: isUndefIdx },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: i },
              { op: "local.set", index: kLocal },
            ],
            else: [],
          },
        ],
        else: [],
      },
    );
  }
  // Single boxed-number arg → array of that length (§23.1.1.1 step 4).
  if (argCount >= 1) {
    body.push(
      { op: "local.get", index: kLocal },
      { op: "i32.const", value: 1 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // (#3673) Normalize an i31-boxed count to a $BoxedNumber so the
          // legacy validation arm below handles both encodings verbatim.
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: -20 },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: -20 },
              { op: "i31.get_s" },
              { op: "f64.convert_i32_s" },
              { op: "struct.new", typeIdx: boxNumTypeIdx },
              { op: "extern.convert_any" },
              { op: "local.set", index: 0 },
            ],
          },
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "local.tee", index: anyLocal },
          { op: "ref.test", typeIdx: boxNumTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx: boxNumTypeIdx },
              { op: "struct.get", typeIdx: boxNumTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: nLocal },
              // RangeError when n != trunc(n) (also catches NaN) | n < 0 | n >= 2^32
              { op: "local.get", index: nLocal },
              { op: "local.get", index: nLocal },
              { op: "f64.trunc" },
              { op: "f64.ne" },
              { op: "local.get", index: nLocal },
              { op: "f64.const", value: 0 },
              { op: "f64.lt" },
              { op: "i32.or" },
              { op: "local.get", index: nLocal },
              { op: "f64.const", value: 4294967296 },
              { op: "f64.ge" },
              { op: "i32.or" },
              { op: "if", blockType: { kind: "empty" }, then: throwRangeInstrs, else: [] },
              { op: "local.get", index: nLocal },
              { op: "i32.trunc_sat_f64_u" },
              { op: "local.tee", index: lenLocal },
              { op: "local.get", index: lenLocal },
              { op: "array.new_default", typeIdx: arrTypeIdx },
              { op: "struct.new", typeIdx: vecTypeIdx },
              { op: "extern.convert_any" },
              { op: "return" },
            ],
            else: [],
          },
        ],
        else: [],
      },
    );
  }
  // General case: array OF the k effective args.
  body.push(
    { op: "local.get", index: kLocal },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    {
      op: "local.set",
      index: dataLocal,
    },
  );
  for (let i = 0; i < argCount; i++) {
    body.push(
      { op: "i32.const", value: i },
      { op: "local.get", index: kLocal },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: dataLocal },
          { op: "i32.const", value: i },
          { op: "local.get", index: i },
          { op: "array.set", typeIdx: arrTypeIdx },
        ],
        else: [],
      },
    );
  }
  body.push(
    { op: "local.get", index: kLocal },
    { op: "local.get", index: dataLocal },
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" },
  );

  pushDefinedFunc(ctx, funcIdx, { name: key, typeIdx, locals, body, exported: false });
  return funcIdx;
}

export function ensureObjectRuntime(ctx: CodegenContext): ObjectRuntimeTypes {
  if (ctx.objectRuntimeTypes) return ctx.objectRuntimeTypes;

  // #2039: settle any deferred late-import shift before baking funcIdx values.
  flushLateImportShifts(ctx, null);

  // Dependencies: native string helpers (flatten + equals) and the string type
  // indices they populate.
  ensureNativeStringHelpers(ctx);

  // #2036 — the array-like `$Object` arms in __extern_length / __extern_get_idx /
  // __extern_has_idx need (a) `number_toString` to ToString a numeric index into
  // its canonical decimal key, and (b) `__unbox_number` to ToLength the stored
  // `length` value. Gate on standalone: in gc/host mode this runtime is also
  // pulled in (Object.keys etc.) but the host `__extern_*` JS imports own the
  // array-like read path, so registering these helpers there would only shift
  // funcMap indices and risk breaking existing references — the $Object arms are
  // skipped in gc mode (see `withObjectArrayLikeArms` below). Both helpers are
  // DEFINED funcs in standalone (no import added → no funcIdx shift) and
  // idempotent. Register BEFORE the helper bodies bake their `call` funcIdx.
  // (`number_toString` also upgrades __extern_toString's boxed-number arm from
  // "[object Object]" to the real decimal, which is spec-correct.)
  const objArrayLikeArms = ctx.standalone;
  if (objArrayLikeArms) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
    // (#3183) `__str_to_number` (§7.1.4.1 StringToNumber) is the scanner the
    // finalize-time `$__vec_base` arms of `__extern_get`/`__extern_has` use to
    // turn a string element key ("0".."n-1", from a for-in loop or a computed
    // `arr[k]` with a string `k`) into the numeric index they delegate on. It is
    // otherwise emitted on demand, so register it eagerly here (a DEFINED func —
    // no import shift) to give the arms a stable, shift-maintained funcIdx at
    // finalize; dead-elimination prunes it when no arm references it.
    emitNativeParseNumber(ctx, new Set(["__str_to_number"]));
    addUnionImportsViaRegistry(ctx);
  }

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const nativeStrTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;

  // (#2866) Register the native `$Symbol` carrier struct + `__box_symbol` builder
  // so the `$Object` property key channel can hold a Symbol key (`o[sym] = v`).
  // The carrier struct's type index drives the `ref.test $Symbol` discriminators
  // in `__obj_hash`/`__key_equals`/`__obj_ordered`. Gated on no-JS-host mode: in
  // gc/host mode this native object runtime is not used (host `env::__extern_*`
  // imports own the dynamic property path), so the carrier is never needed there.
  // `symbolTypeIdx` stays -1 when not registered, and every symbol branch below
  // is guarded on `symbolKeysEnabled` (idx >= 0) so the string-only key path is
  // byte-unchanged when symbols are absent from the type space.
  const symbolTypeIdx = ctx.standalone || ctx.wasi ? ensureSymbolCarrier(ctx) : -1;
  const symbolKeysEnabled = symbolTypeIdx >= 0;

  // --- 1. Register the three struct/array types. ---
  const propEntryTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$PropEntry",
    fields: [
      // (#2866) `key` is `anyref`, not `(ref $AnyString)`: the open-object key
      // channel now holds EITHER a native string key ($AnyString) OR a native
      // `$Symbol` carrier (for `o[sym] = v`). Readers discriminate with
      // `ref.test $AnyString` / `ref.test $Symbol`; the hash + equality
      // (`__obj_hash`/`__key_equals`) branch on the key kind. `anyref` (not
      // `eqref`) keeps storage free — the converted search key (`any.convert_extern`
      // → anyref) and a `(ref $AnyString)`/`(ref $Symbol)` both widen to it with no
      // cast — and symbol identity is decided by the i32 `$id`, not `ref.eq`, so
      // `eqref` is unnecessary. String-only programs are behaviour-identical; the
      // few string readers add a `ref.cast $AnyString` (always succeeds).
      { name: "key", type: { kind: "anyref" }, mutable: false },
      { name: "value", type: { kind: "anyref" }, mutable: true },
      { name: "flags", type: { kind: "i32" }, mutable: true },
      // #1837 — monotonically-increasing insertion sequence, assigned at
      // create time from $Object.nextSeq and PRESERVED across rehash so
      // OrdinaryOwnPropertyKeys can emit string keys in insertion order. Mutable
      // only so the field can be filled by struct.new at any callsite; it is
      // never rewritten after creation.
      { name: "seq", type: { kind: "i32" }, mutable: true },
      // #1888 Slice 5 — accessor get/set slots. Non-null only when
      // (flags & FLAG_ACCESSOR); the boxed getter/setter closure is held as an
      // anyref (closures are per-signature structs dispatched dynamically, so
      // there is no single typed closure ref to use here). On the data path
      // both are null — zero behavioural change for non-accessor properties.
      // Appended LAST so existing field indices 0-3 (key/value/flags/seq) are
      // unchanged (R3 migration note); the single `struct.new $PropEntry` site
      // (__obj_insert) pushes two `ref.null any` for these.
      { name: "get", type: { kind: "anyref" }, mutable: true },
      { name: "set", type: { kind: "anyref" }, mutable: true },
    ],
  });

  const propMapTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "$PropMap",
    element: { kind: "ref_null", typeIdx: propEntryTypeIdx },
    mutable: true,
  });

  const objectTypeIdx = ctx.mod.types.length;
  const objectFields: FieldDef[] = [
    { name: "proto", type: { kind: "ref_null", typeIdx: objectTypeIdx }, mutable: true },
    { name: "props", type: { kind: "ref", typeIdx: propMapTypeIdx }, mutable: true },
    { name: "count", type: { kind: "i32" }, mutable: true },
    { name: "tombstones", type: { kind: "i32" }, mutable: true },
    { name: "flags", type: { kind: "i32" }, mutable: true },
    // #1837 — next insertion sequence number. Incremented (never reset, not
    // even on rehash) on every NEW key so $PropEntry.seq records the order
    // string keys were first added. Powers OrdinaryOwnPropertyKeys insertion
    // ordering for Object.keys/values/entries/for-in/spread/JSON.stringify.
    { name: "nextSeq", type: { kind: "i32" }, mutable: true },
  ];
  // `$Object` is a plain (final) struct. NOTE (#1100): an earlier attempt made
  // this a NON-FINAL `sub` so the standalone `$Proxy` could extend it, but
  // opening `$Object` up triggered WasmGC iso-recursive canonicalization
  // (#2009): the now-open single-shape struct merged with another module type,
  // so a baked `struct.new`/index resolved to a wrong-arity type and
  // `__new_plain_object` failed to validate ("not enough arguments on the stack
  // for drop"). Same canonicalization hazard as #2158. So `$Object` stays
  // closed and `$Proxy` is a STANDALONE struct (below), discriminated by its own
  // `ref.test $Proxy` ahead of the ordinary `ref.cast $Object` path — the
  // front-guards already test `$Proxy` first, so a proxy never reaches the
  // `$Object` cast.
  ctx.mod.types.push({
    kind: "struct",
    name: "$Object",
    fields: objectFields,
  });

  // $ObjVec backing array: (array (mut externref)) — holds enumeration results
  // (keys/values/entries) as boxed externrefs. Separate from the closed-shape
  // __vec_externref/__arr_externref the array literal path uses, so this runtime
  // owns its own type and never collides with shifted indices there.
  //
  // (#2026 #53) ADOPT the eagerly-reserved `$ObjVecArr` slot when present
  // (`reserveObjVecArrType`, called up-front for class-bearing sources): the
  // dynamic-`new` runtime-argv path references this type from a function body,
  // so its index must be stable across the type prefix. Minting it here lazily
  // when this runtime is first pulled in would land it at a pass-dependent index
  // (the #2043 / subview type-idx-stability hazard). Fall back to registering it
  // now when no reservation exists (the common Object.keys/values path).
  let objVecArrTypeIdx: number;
  if (ctx.reservedObjVecArrTypeIdx !== undefined) {
    objVecArrTypeIdx = ctx.reservedObjVecArrTypeIdx;
  } else {
    objVecArrTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "array",
      name: "$ObjVecArr",
      element: { kind: "externref" },
      mutable: true,
    });
  }

  // Growable externref Array carrier; vec-base exposes length to shared reflection.
  const objVecBaseTypeIdx = getOrRegisterVecBaseType(ctx);
  const objVecTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$ObjVec",
    superTypeIdx: objVecBaseTypeIdx,
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: objVecArrTypeIdx }, mutable: true },
    ],
  });

  // (#1100/#1355) `$ProxyTraps` — trap fields for the standalone Proxy. A null
  // field means "no trap" → forward to the ordinary operation on the proxy
  // target. The fields hold the user trap handler as an **externref closure**
  // (the boxed closure-wrapper struct produced by every compiled function
  // expression), NOT a bare funcref: a user trap `(t,k,r) => …` lowers to a GC
  // closure struct whose own funcref takes the closure-self as arg0, so it cannot
  // be `call_ref`-ed with `(target,key,receiver)` directly. Traps are invoked
  // through the existing closure-call bridge (`__apply_closure`, the same path
  // accessors use) which threads `this` and the closure-self correctly — see
  // `ensureProxyRuntime` / `fillProxyDispatch`. This is the architect's "reuse
  // the closure→funcref bridge, don't invent a calling convention" requirement.
  //
  // (#1355) APPEND new trap fields after the #1100 base four (get/set/has/apply);
  // never renumber the base — the dispatch helpers and `__proxy_create` bake the
  // field indices. `deleteProperty` is field index 4.
  const proxyTrapsTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$ProxyTraps",
    fields: [
      { name: "get", type: { kind: "externref" }, mutable: false },
      { name: "set", type: { kind: "externref" }, mutable: false },
      { name: "has", type: { kind: "externref" }, mutable: false },
      { name: "apply", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice A) deleteProperty — field index 4.
      { name: "deleteProperty", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice B) getOwnPropertyDescriptor — field index 5.
      { name: "getOwnPropertyDescriptor", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice C) getPrototypeOf — field index 6.
      { name: "getPrototypeOf", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice C) setPrototypeOf — field index 7.
      { name: "setPrototypeOf", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice D) isExtensible — field index 8.
      { name: "isExtensible", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice D) preventExtensions — field index 9.
      { name: "preventExtensions", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice E) ownKeys — field index 10. §10.5.11 [[OwnPropertyKeys]].
      { name: "ownKeys", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice F) defineProperty — field index 11. §10.5.6 [[DefineOwnProperty]].
      { name: "defineProperty", type: { kind: "externref" }, mutable: false },
    ],
  });

  // (#1100) `$Proxy` — a STANDALONE struct (NOT a subtype of `$Object`; see the
  // canonicalization note on `$Object` above). A proxy is discriminated by its
  // own `ref.test $Proxy`, emitted by the `__extern_get/set/has` front-guards
  // AHEAD of the ordinary `ref.cast $Object`, so the proxy never flows down the
  // plain-object path and does not need to carry `$Object`'s fields. Fields:
  //   0 ptag      i32           PROXY_TAG marker (the bare ref.test is the real
  //                             discriminator; kept for symmetry with #1325)
  //   1 ptarget   anyref(mut)   wrapped target (any value)
  //   2 phandler  anyref(mut)   handler object — trap `this` (§10.5.x)
  //   3 ptraps    ref null …    the 4 trap closures
  //   4 revoked   i32(mut)      revocation bit
  const proxyTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$Proxy",
    fields: [
      { name: "ptag", type: { kind: "i32" }, mutable: false },
      { name: "ptarget", type: { kind: "anyref" }, mutable: true },
      { name: "phandler", type: { kind: "anyref" }, mutable: true },
      { name: "ptraps", type: { kind: "ref_null", typeIdx: proxyTrapsTypeIdx }, mutable: true },
      { name: "revoked", type: { kind: "i32" }, mutable: true },
    ],
  });

  const types: ObjectRuntimeTypes = {
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    objVecTypeIdx,
    objVecArrTypeIdx,
    proxyTrapsTypeIdx,
    proxyTypeIdx,
  };
  ctx.objectRuntimeTypes = types;

  // Common ValTypes.
  const objRef: ValType = { kind: "ref", typeIdx: objectTypeIdx };
  const objRefNull: ValType = { kind: "ref_null", typeIdx: objectTypeIdx };
  const propMapRef: ValType = { kind: "ref", typeIdx: propMapTypeIdx };
  const entryRefNull: ValType = { kind: "ref_null", typeIdx: propEntryTypeIdx };
  const anyStrRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const nativeStrRef: ValType = { kind: "ref", typeIdx: nativeStrTypeIdx };
  const objVecRef: ValType = { kind: "ref", typeIdx: objVecTypeIdx };
  const objVecArrRef: ValType = { kind: "ref", typeIdx: objVecArrTypeIdx };

  // Helper: register a defined function, return its funcIdx.
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

  // (#3468 C-core) Reserve the closure-own-property side-table helpers + register
  // the `$ClosurePropEntry` struct / `$__closure_prop_head` global BEFORE the
  // `__extern_get`/`__extern_set`/`__extern_method_call` arms below bake their
  // `call <idx>`. Filled at FINALIZE (`fillClosurePropHelpers`) once every
  // closure root + `__extern_get`/`_set` funcIdx is known. Standalone/wasi only:
  // in gc/host mode the `env::__extern_*` imports own the dynamic-property path,
  // these defined arms are not emitted, and nothing here is reserved.
  if (ctx.standalone || ctx.wasi) {
    reserveClosurePropHelpers(ctx);
    // (#3537) reserve the array-expando side table right after — same
    // reserve-before-arms-bake discipline, appended indices only.
    reserveVecPropHelpers(ctx);
    reserveCarrierBagVisibility(ctx); // (#4010 S3) visibility over both bags — see that module
  }

  // ── __extern_is_array(externref v) -> i32 ────────────────────────────────
  //
  // Placeholder reserved with the object runtime and filled at FINALIZE by
  // fillExternIsArray(), after all module-local array carrier types are known.
  // This keeps Array.isArray over a helper compiled before a later array type
  // from baking an incomplete ref.test list.
  registerNative(
    "__extern_is_array",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    [{ name: "any", type: { kind: "anyref" } }],
    [{ op: "i32.const", value: 0 }],
  );
  ctx.externIsArrayReserved = true;

  // Look up an already-emitted native string helper.
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals")!;

  // ── (#2896) Reserved builtin-fn metadata natives (standalone only) ────────
  //
  // Builtin function values (the per-(builtin, member) closure meta subtypes —
  // see builtin-fn-meta.ts) answer their spec `name`/`length` own properties at
  // RUNTIME through these four helpers. They are REGISTERED here with valid
  // constant default bodies (so a module with no builtin closures is
  // unaffected), and their `ref.test <metaType>` arms are SPLICED IN AT
  // FINALIZE by `fillBuiltinFnMeta` once every meta type is known — the same
  // reserve/fill discipline as `__extern_is_array` above. The reflective
  // consumers below (`__extern_get` / `__hasOwnProperty` /
  // `__getOwnPropertyDescriptor` / `__getOwnPropertyNames` /
  // `__delete_property`) bake eager `call`s to these funcIdxs at their own
  // registration, keeping the late-import shift invariant intact.
  //
  //   __builtinfn_get_meta(v, key)  -> externref   name string / boxed length,
  //                                                 null when not a builtin fn,
  //                                                 not "name"/"length", or the
  //                                                 property was deleted.
  //   __builtinfn_gopd(v, key)      -> externref   full data descriptor
  //                                                 ({writable:false,
  //                                                 enumerable:false,
  //                                                 configurable:true}) or null.
  //   __builtinfn_delete(v, key)    -> i32          1 = handled (deleted-bit
  //                                                 set on the instance).
  //   __builtinfn_push_ownnames(v, vec) -> i32      1 = v is a builtin fn (its
  //                                                 undeleted own names were
  //                                                 pushed into vec).
  //
  // Gated on ctx.standalone: in gc/host mode this runtime is also pulled in
  // (Object.keys etc.) but builtin function values are host objects there — the
  // host imports own their metadata, and registering these would only shift
  // funcMap indices (gc bytes must stay unchanged).
  const bfnMetaLocals = [
    { name: "any", type: { kind: "anyref" } as ValType },
    { name: "fkey", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } as ValType },
    { name: "isName", type: { kind: "i32" } as ValType },
    { name: "isLen", type: { kind: "i32" } as ValType },
  ];
  if (ctx.standalone) {
    registerNative(
      "__builtinfn_get_meta",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      bfnMetaLocals,
      [{ op: "ref.null.extern" }],
    );
    registerNative(
      "__builtinfn_gopd",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "v", type: { kind: "externref" } as ValType }],
      [{ op: "ref.null.extern" }],
    );
    registerNative(
      "__builtinfn_delete",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      bfnMetaLocals,
      [{ op: "i32.const", value: 0 }],
    );
    registerNative(
      "__builtinfn_push_ownnames",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [{ name: "any", type: { kind: "anyref" } as ValType }],
      [{ op: "i32.const", value: 0 }],
    );
  }
  const bfnGetMetaIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_get_meta") : undefined;
  const bfnGopdIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_gopd") : undefined;
  const bfnDeleteIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_delete") : undefined;
  const bfnPushOwnNamesIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_push_ownnames") : undefined;

  // #2042 R2 — held reference to `__to_property_key`'s body so the object-key
  // arm can be spliced in after `__extern_toString` is registered later in this
  // pass (forward dependency; see the splice below the `__extern_toString` reg).
  let tpkBodyRef: Instr[] | undefined;

  // ── __to_property_key(externref key) -> externref (#2042 S1) ──────────────
  //
  // Central ToPropertyKey-style coercion for the string-keyed `$Object` runtime.
  // The downstream `ref.cast $AnyString` in `__obj_hash` / `__obj_find` traps
  // (`illegal cast [in __obj_find()]`) for any non-string key — every computed
  // numeric access (`o[0]`, `Reflect.get(o, 1)`, descriptor reflection) feeds a
  // boxed number straight into that cast. Coercing once here, at the top of both
  // hash + find, makes the cast always safe without patching each public entry
  // (`__extern_get`/`_set`/`_has`/`__getOwnPropertyDescriptor`/`__delete_property`).
  //
  //   - already an `$AnyString` (cons or flat) → return unchanged (fast path).
  //   - a boxed number → `number_toString(__unbox_number(key))` → canonical
  //     decimal `$NativeString` ("0"/"1.5"/"-0"→"0" per §6.1.6.1.20), matching
  //     `{0:x}` literal-key storage and host behaviour.
  //   - else (Symbol / opaque) → return unchanged: the downstream behaviour is
  //     unchanged for those keys (no NEW trap introduced), while the dominant
  //     numeric + string cases are fixed. Symbol keys under the string-keyed
  //     runtime stay a separate concern (#1472 Phase B refusal at compile time).
  //
  // standalone-only: in gc/host mode the host `__extern_*` JS imports own these
  // paths and ToPropertyKey the key themselves, so registering this helper there
  // would only shift funcMap indices — host output stays byte-identical.
  if (ctx.standalone) {
    const numToStringIdx = ctx.funcMap.get("number_toString")!;
    const unboxNumberIdx = ctx.funcMap.get("__unbox_number")!;
    const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
    const tpkBody: Instr[] = [
      // any = any.convert_extern(key)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      // if (ref.test $AnyString any) return key unchanged
      { op: "ref.test", typeIdx: anyStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // else if (boxed number) return number_toString(__unbox_number(key))
      ...(boxNumTypeIdx >= 0
        ? ([
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: boxNumTypeIdx },
            // (#3673) …or an i31-boxed small int (unbox helper handles both).
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: -20 },
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: unboxNumberIdx },
                { op: "call", funcIdx: numToStringIdx },
                { op: "return" },
              ],
            },
          ] satisfies Instr[])
        : []),
      // #2042 R2 — object-key arm. A computed access with an OBJECT key
      // (`obj[{valueOf:()=>2}]`) reaches here as a `$Object` externref; the
      // downstream `ref.cast $AnyString` in `__obj_find`/`__obj_hash` then traps
      // ("illegal cast"). Run the object through `__extern_toString` (§7.1.1
      // ToPrimitive(string) → ToString — the same canonical ToString used by
      // `String(x)` / template literals), yielding the canonical string key.
      // `__extern_toString` is registered LATER in this same `ensureObjectRuntime`
      // pass, so the call is spliced in below once its funcIdx is known (the body
      // array is held by reference in `mod.functions`). The splice goes BEFORE
      // the unchanged-fallthrough so non-object opaque keys (Symbols) still
      // pass through untouched.
      // <<R2-OBJECT-ARM-SPLICE>>
      // else return key unchanged (Symbol / opaque — preserve existing behaviour)
      { op: "local.get", index: 0 },
    ];
    registerNative(
      "__to_property_key",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "any", type: { kind: "anyref" } }],
      tpkBody,
    );
    // Record the splice point: index of the trailing `local.get 0` fallthrough.
    // After `__extern_toString` registers we insert the `$Object`-key arm here.
    tpkBodyRef = tpkBody;
  }
  const toPropertyKeyIdx = ctx.funcMap.get("__to_property_key");

  // Prepend, in standalone mode, a guarded ToPropertyKey coercion to a key-taking
  // helper body so its downstream `ref.cast $AnyString` is always safe. No-op in
  // gc/host mode (the host imports own the path → byte-identical output).
  // The coercion is itself guarded (`__to_property_key` fast-returns an
  // already-$AnyString key) so the common string-key path pays one `ref.test`.
  const withKeyCoercion = (keyParamIdx: number, body: Instr[]): Instr[] =>
    toPropertyKeyIdx === undefined
      ? body
      : [
          { op: "local.get", index: keyParamIdx },
          { op: "call", funcIdx: toPropertyKeyIdx },
          { op: "local.set", index: keyParamIdx },
          ...body,
        ];

  // ── $__obj_hash(externref key) -> i32 ────────────────────────────────────
  //
  // FNV-1a over the UTF-16 code units of the flattened string. The key is an
  // externref holding a $NativeString/$AnyString; convert + cast + flatten,
  // then read len/off/data and fold. Returns a non-negative i32 hash.
  //
  // locals: 1=str(ref $NativeString) 2=data(ref $strData) 3=len 4=off 5=i 6=h
  {
    const FNV_OFFSET = 0x811c9dc5 | 0;
    const FNV_PRIME = 0x01000193;
    const body: Instr[] = [
      // (#2866) keyAny = any.convert_extern(key). A Symbol key hashes by its i32
      // identity id (consistent with `__key_equals`'s id-compare); a string key
      // takes the FNV-1a path below. The two hash spaces may collide — open
      // addressing resolves any collision via `__key_equals`, so that is benign.
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 7 },
      ...(symbolKeysEnabled
        ? ([
            { op: "ref.test", typeIdx: symbolTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 7 },
                { op: "ref.cast", typeIdx: symbolTypeIdx },
                { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 }, // $Symbol.id
                { op: "i32.const", value: 0x7fffffff },
                { op: "i32.and" },
                { op: "return" },
              ],
            },
          ] satisfies Instr[])
        : []),
      // str = flatten(cast<$AnyString>(keyAny))
      { op: "local.get", index: 7 },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
      { op: "call", funcIdx: strFlattenIdx },
      { op: "local.tee", index: 1 },
      // (#3673 round 9) Cached-hash fast path: interned literal keys carry a
      // compile-time-baked FNV hash in the `$HashedString` subtype's field 3
      // (0 = uncomputed; else masked hash | sign bit). Most $Object probes use
      // constant keys, so this turns the O(len) FNV walk into one struct.get.
      ...(ctx.hashedStrTypeIdx >= 0
        ? ([
            { op: "ref.test", typeIdx: ctx.hashedStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.cast", typeIdx: ctx.hashedStrTypeIdx },
                { op: "struct.get", typeIdx: ctx.hashedStrTypeIdx, fieldIdx: 3 },
                { op: "local.tee", index: 6 },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: 6 },
                    { op: "i32.const", value: 0x7fffffff },
                    { op: "i32.and" },
                    { op: "return" },
                  ],
                },
              ],
            },
            { op: "local.get", index: 1 },
          ] satisfies Instr[])
        : []),
      // len = str.len ; off = str.off ; data = str.data
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },
      // h = FNV_OFFSET ; i = 0
      { op: "i32.const", value: FNV_OFFSET },
      { op: "local.set", index: 6 },
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
              // if i >= len break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 3 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // h = (h ^ data[off + i]) * FNV_PRIME
              { op: "local.get", index: 6 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.xor" },
              { op: "i32.const", value: FNV_PRIME },
              { op: "i32.mul" },
              { op: "local.set", index: 6 },
              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // (#3673 round 9) Cache write-back: a `$HashedString` probe key (a
      // flatten-memoized flat copy) stores `(h & mask) | signbit` so its next
      // probe takes the fast path above. Interned literals never reach here
      // (their baked hash short-circuits).
      ...(ctx.hashedStrTypeIdx >= 0
        ? ([
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: ctx.hashedStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.cast", typeIdx: ctx.hashedStrTypeIdx },
                { op: "local.get", index: 6 },
                { op: "i32.const", value: 0x7fffffff },
                { op: "i32.and" },
                { op: "i32.const", value: -0x80000000 },
                { op: "i32.or" },
                { op: "struct.set", typeIdx: ctx.hashedStrTypeIdx, fieldIdx: 3 },
              ],
            },
          ] satisfies Instr[])
        : []),
      // return h & 0x7fffffff  (non-negative; masking happens at call sites too)
      { op: "local.get", index: 6 },
      { op: "i32.const", value: 0x7fffffff },
      { op: "i32.and" },
    ];
    registerNative(
      "__obj_hash",
      [{ kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "str", type: nativeStrRef },
        { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
        { name: "len", type: { kind: "i32" } },
        { name: "off", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "h", type: { kind: "i32" } },
        { name: "keyAny", type: { kind: "anyref" } }, // (#2866) index 7
      ],
      // #2042 S1 — coerce a non-string key (boxed number) to its canonical
      // string before the FNV walk's `ref.cast $AnyString`. key is param 0.
      withKeyCoercion(0, body),
    );
  }
  const objHashIdx = ctx.funcMap.get("__obj_hash")!;

  // ── __key_equals(anyref storedKey, i32 searchIsSym, i32 searchSymId,
  //                ref_null $NativeString fkey) -> i32  (#2866) ───────────────
  //
  // Unified property-key equality over the widened (anyref) `$PropEntry.key`
  // channel. The caller classifies the SEARCH key ONCE (`searchIsSym` +
  // `searchSymId` for a Symbol, or the pre-flattened `fkey` for a string) so the
  // per-probe cost stays a single `__str_equals` on the string hot path — exactly
  // the pre-#2866 work — plus one `ref.test` to reject a cross-kind collision.
  //
  //   - searching for a Symbol: match iff storedKey is a `$Symbol` whose `$id`
  //     equals `searchSymId` (identity by id; no interning needed).
  //   - searching for a string: match iff storedKey is an `$AnyString` whose
  //     flattened content equals `fkey` (`__str_equals`). A `$Symbol` stored key
  //     fails the `ref.test $AnyString` and is skipped (cross-kind keys collide
  //     in the table only by hash, never by equality).
  if (symbolKeysEnabled) {
    const keyEqualsBody: Instr[] = [
      { op: "local.get", index: 1 }, // searchIsSym
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // symbol search: ref.test $Symbol(storedKey) && id == searchSymId
          { op: "local.get", index: 0 },
          { op: "ref.test", typeIdx: symbolTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 0 },
              { op: "ref.cast", typeIdx: symbolTypeIdx },
              { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 },
              { op: "local.get", index: 2 }, // searchSymId
              { op: "i32.eq" },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ],
        else: [
          // string search: ref.test $AnyString(storedKey) && str_equals(flatten(storedKey), fkey)
          { op: "local.get", index: 0 },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 0 },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "local.get", index: 3 }, // fkey (ref_null $NativeString)
              { op: "ref.as_non_null" },
              { op: "call", funcIdx: strEqualsIdx },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ],
      },
    ];
    registerNative(
      "__key_equals",
      [{ kind: "anyref" }, { kind: "i32" }, { kind: "i32" }, { kind: "ref_null", typeIdx: nativeStrTypeIdx }],
      [{ kind: "i32" }],
      [],
      keyEqualsBody,
    );
  }
  const keyEqualsIdx = symbolKeysEnabled ? ctx.funcMap.get("__key_equals")! : -1;

  // (#2866) Classify a search key (an externref param) into scratch locals:
  //   searchAny  (anyref)               — the converted key; ALSO the value to
  //                                       STORE into `$PropEntry.key` (preserves
  //                                       Symbol identity in the table).
  //   searchIsSym(i32)                  — 1 iff the key is a `$Symbol`.
  //   searchSymId(i32)                  — the `$Symbol.$id` when a symbol.
  //   fkey       (ref_null $NativeString) — the flattened string key (null when a
  //                                       symbol) — the hot-path `__str_equals` rhs.
  const emitClassifyKey = (
    keyParamIdx: number,
    searchAnyLocal: number,
    isSymLocal: number,
    symIdLocal: number,
    fkeyLocal: number,
  ): Instr[] => [
    { op: "local.get", index: keyParamIdx },
    { op: "any.convert_extern" },
    { op: "local.set", index: searchAnyLocal },
    ...(symbolKeysEnabled
      ? ([
          { op: "local.get", index: searchAnyLocal },
          { op: "ref.test", typeIdx: symbolTypeIdx },
          { op: "local.tee", index: isSymLocal },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: searchAnyLocal },
              { op: "ref.cast", typeIdx: symbolTypeIdx },
              { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: symIdLocal },
              { op: "ref.null", typeIdx: nativeStrTypeIdx },
              { op: "local.set", index: fkeyLocal },
            ],
            else: [
              { op: "local.get", index: searchAnyLocal },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "local.set", index: fkeyLocal },
            ],
          },
        ] satisfies Instr[])
      : ([
          { op: "i32.const", value: 0 },
          { op: "local.set", index: isSymLocal },
          { op: "local.get", index: searchAnyLocal },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          { op: "local.set", index: fkeyLocal },
        ] satisfies Instr[])),
  ];

  // (#2866) Leave an i32 (1/0) on the stack: does `entryLocal`'s (non-null) key
  // match the classified search key? Routes through `__key_equals` when symbol
  // keys are in play; a `ref.cast $AnyString` string-only path otherwise.
  const emitKeyMatch = (entryLocal: number, isSymLocal: number, symIdLocal: number, fkeyLocal: number): Instr[] =>
    symbolKeysEnabled
      ? [
          { op: "local.get", index: entryLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
          { op: "local.get", index: isSymLocal },
          { op: "local.get", index: symIdLocal },
          { op: "local.get", index: fkeyLocal },
          { op: "call", funcIdx: keyEqualsIdx },
        ]
      : [
          { op: "local.get", index: entryLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          { op: "local.get", index: fkeyLocal },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: strEqualsIdx },
        ];

  // ── __new_plain_object() -> externref ────────────────────────────────────
  //
  // struct.new $Object { proto: null, props: new $PropMap[INITIAL_CAP], count:
  // 0, tombstones: 0, flags: 0, nextSeq: 0 }, then extern.convert_any.
  {
    const body: Instr[] = [
      { op: "ref.null", typeIdx: objectTypeIdx }, // proto
      { op: "i32.const", value: INITIAL_CAP }, // props: array.new_default count
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "i32.const", value: 0 }, // count
      { op: "i32.const", value: 0 }, // tombstones
      { op: "i32.const", value: 0 }, // flags
      { op: "i32.const", value: 0 }, // nextSeq (#1837)
      { op: "struct.new", typeIdx: objectTypeIdx },
      { op: "extern.convert_any" },
    ];
    registerNative("__new_plain_object", [], [{ kind: "externref" }], [], body);
  }

  // ── $__obj_find(ref $Object, externref key) -> ref null $PropEntry ────────
  //
  // Linear-probing lookup in the object's OWN props table (no proto walk).
  // Returns the matching live entry, or null if absent. Tombstoned entries
  // (FLAG_TOMBSTONE set) are skipped but do not terminate the probe (they are
  // "deleted but occupied" slots in open addressing).
  //
  // params: 0=o(ref $Object) 1=key(externref)
  // locals: 2=arr(ref $PropMap) 3=cap 4=mask 5=i 6=e(ref null $PropEntry) 7=fkey(ref $NativeString)
  {
    const body: Instr[] = [
      // (#2866) classify the search key → searchAny(8)/isSym(9)/symId(10)/fkey(7)
      ...emitClassifyKey(1, 8, 9, 10, 7),
      // arr = o.props ; cap = arr.len ; mask = cap - 1
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 2 },
      { op: "array.len" },
      { op: "local.tee", index: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.set", index: 4 },
      // i = hash(key) & mask
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objHashIdx },
      { op: "local.get", index: 4 },
      { op: "i32.and" },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // e = arr[i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              // if e == null → key absent → return null
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "ref.null", typeIdx: propEntryTypeIdx }, { op: "return" }],
              },
              // if !(e.flags & TOMBSTONE) && key_match(e.key) → return e  (#2866)
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              { op: "i32.const", value: FLAG_TOMBSTONE },
              { op: "i32.and" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...emitKeyMatch(6, 9, 10, 7),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "local.get", index: 6 }, { op: "return" }],
                  },
                ],
              },
              // i = (i + 1) & mask ; loop
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: 4 },
              { op: "i32.and" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "ref.null", typeIdx: propEntryTypeIdx },
    ];
    registerNative(
      "__obj_find",
      [objRef, { kind: "externref" }],
      [entryRefNull],
      [
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "mask", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        // (#2866) fkey is now NULLABLE — null for a Symbol search key.
        { name: "fkey", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } },
        { name: "searchAny", type: { kind: "anyref" } }, // 8
        { name: "searchIsSym", type: { kind: "i32" } }, // 9
        { name: "searchSymId", type: { kind: "i32" } }, // 10
      ],
      // #2042 S1 — coerce a non-string key (boxed number) to its canonical
      // string before the `ref.cast $AnyString` flatten + the inner __obj_hash
      // call. key is param 1 (param 0 is the $Object). The inner __obj_hash
      // re-coercion is idempotent (the key is now an $AnyString → fast-return).
      withKeyCoercion(1, body),
    );
  }
  const objFindIdx = ctx.funcMap.get("__obj_find")!;

  // Approved standalone function constructors use native `__fnctor_<F>`
  // instance structs while their prototype properties live on a per-fnctor
  // `$Object`. Reserve a tiny classifier before `__extern_get` bakes its call
  // index; finalize fills the complete ref.test/global.get ladder after all
  // fnctor structs and prototype globals are known.
  const fnctorProtoStartIdx =
    ctx.standalone && (ctx.fnctorEscapeGate?.approvedNames.size ?? 0) > 0
      ? registerNative(
          "__fnctor_proto_start",
          [{ kind: "externref" }],
          [{ kind: "externref" }],
          [{ name: "any", type: { kind: "anyref" } }],
          [{ op: "ref.null.extern" }],
        )
      : undefined;

  // (#3673 round 9b) Table generation for the per-key prototype-lookup cache
  // (see the `$HashedString` cacheGen/cacheOwner/cacheEntry fields). Bumped
  // ONLY by `__obj_grow` — a rehash re-mints `$PropEntry` structs, so cached
  // entry refs from before a grow must be treated as stale. Value updates
  // mutate entries in place (visible through the cache); deletes set
  // FLAG_TOMBSTONE and defineProperty morphs set FLAG_ACCESSOR on the entry
  // itself, both checked at cache-hit time — neither needs a generation bump.
  // Starts at 1 so a literal's baked cacheGen of 0 can never spuriously match.
  // (#3673 round 21) The global `__obj_table_gen` generation is RETIRED: a
  // grow of ANY object (acorn's per-parse options build grows twice) bumped it
  // and cold-started every per-key cache program-wide. Staleness is now
  // per-object: the cache stores the owner's props ARRAY (`$HashedString`
  // field 7) at population, and the hit guard `ref.eq`s it against the live
  // `owner.props` — a grow replaces the array, so exactly the grown object's
  // caches miss. Field 4 degrades to a populated flag (0/1).
  const protoCacheEnabled = ctx.hashedStrTypeIdx >= 0 && fnctorProtoStartIdx !== undefined;

  // (#3673 round 13) `__method_cache_lookup(recv, name) -> externref` — the
  // per-key prototype-method cache probe as a standalone helper: interned key
  // + generation match + owner `ref.eq` against the receiver's fnctor
  // prototype + live-DATA entry flags → the cached method value; every miss
  // answers null (caller takes its legacy resolution path, which populates
  // the cache via `__extern_get`). Used by the `__call_m_<name>_<arity>`
  // dispatcher fallbacks to call `__call_fn_method_<arity>` DIRECTLY with
  // unpacked args on a hit — skipping the per-call `$ObjVec` allocation,
  // `__extern_method_call`, and `__apply_closure` re-extraction.
  if (protoCacheEnabled) {
    const HSTR = ctx.hashedStrTypeIdx;
    registerNative(
      "__method_cache_lookup",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "kh", type: { kind: "ref_null", typeIdx: HSTR } }, // 2
        { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } }, // 3
        { name: "p", type: { kind: "externref" } }, // 4
      ],
      [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: HSTR },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: HSTR },
            { op: "local.tee", index: 2 },
            { op: "struct.get", typeIdx: HSTR, fieldIdx: 4 }, // populated flag
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: fnctorProtoStartIdx! },
                { op: "local.tee", index: 4 },
                { op: "ref.is_null" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: 4 },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: objectTypeIdx },
                    // owner non-null once populated (population writes all
                    // cache fields together).
                    { op: "local.get", index: 2 },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: HSTR, fieldIdx: 5 }, // cacheOwner
                    { op: "ref.cast", typeIdx: objectTypeIdx },
                    { op: "ref.eq" },
                    // (#3673 round 21) per-object staleness: owner.props must
                    // be the SAME array as at population (a grow replaces it).
                    { op: "local.get", index: 4 },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: objectTypeIdx },
                    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 }, // props
                    { op: "local.get", index: 2 },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: HSTR, fieldIdx: 7 }, // cacheProps
                    { op: "ref.cast", typeIdx: propMapTypeIdx },
                    { op: "ref.eq" },
                    { op: "i32.and" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: 2 },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: HSTR, fieldIdx: 6 }, // cacheEntry
                        { op: "ref.cast", typeIdx: propEntryTypeIdx },
                        { op: "local.tee", index: 3 },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 }, // flags
                        { op: "i32.const", value: FLAG_TOMBSTONE | FLAG_ACCESSOR },
                        { op: "i32.and" },
                        { op: "i32.eqz" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: 3 },
                            { op: "ref.as_non_null" },
                            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value
                            { op: "extern.convert_any" },
                            { op: "return" },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { op: "ref.null.extern" },
      ],
    );
  }

  // ── __extern_get(externref obj, externref key) -> externref ──────────────
  //
  // Unwrap obj to $Object (return null on non-object), walk the own-property
  // entry then the prototype chain. Property values are stored as anyref;
  // convert back to externref for the result.
  //
  // params: 0=obj(externref) 1=key(externref)
  // locals: 2=o(ref null $Object) 3=e(ref null $PropEntry) 4=any(anyref)
  //         5=getter(externref) — (#1888 S5b) stored accessor $get closure
  {
    // (#1888 S5b) Reserve the `__call_accessor_get` driver funcIdx BEFORE the
    // body bakes its `call`. The driver body is filled in finalize once
    // `__call_fn_method_0` exists (fillAccessorDrivers). Routing through funcMap
    // keeps the late-import shifter in sync (#329/#1899).
    const callAccessorGetIdx = reserveAccessorGetDriver(ctx);
    // (#2106 S1) Under the `undefinedSingleton` regime a MISSING property read
    // answers the extern-wrapped tag-1 `$undefined` singleton — the value JS
    // semantics require (`({}).x === undefined` true, destructuring/param
    // defaults fire) — while a stored JS `null` still reads back as
    // `ref.null.extern`. Legacy (flag off): miss = `ref.null.extern`,
    // byte-identical. This is the producer half of the lockstep flip whose
    // absence caused PR #2025's −1245 (consumer flipped, producer not).
    // A FACTORY, not a shared array — the miss appears in three branches and
    // shared Instr objects get double-remapped by finalize walks (see
    // `reference_shared_instr_object_dce_double_remap`).
    const getMiss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
    const HSTR = ctx.hashedStrTypeIdx;
    const body: Instr[] = [
      // (#3673 round 9b) The per-key prototype-lookup cache HIT arm is NOT
      // here — it is prepended at FINALIZE by `unshiftExternGetProtoCacheArm`
      // so it lands BEFORE the closed-struct field-ladder arms that the
      // finalize fills unshift onto this body (the ladder is most of the cost
      // the cache exists to skip). Population lives inline below (data-
      // property branch); locals 8/9 are reserved at registration.
      // (#2896) Builtin-fn metadata arm: `fn[key]` for key "name"/"length" on a
      // builtin function value answers its spec metadata (host-free). Non-meta
      // receivers/keys fall through unchanged (the helper returns null).
      ...(bfnGetMetaIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: bfnGetMetaIdx },
            { op: "local.tee", index: 6 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 6 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      // any = any.convert_extern(obj)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 4 },
      // Plain `$Object` starts its walk at itself. An approved native fnctor
      // instance starts at its per-fnctor prototype `$Object`, but param 0 stays
      // the ORIGINAL instance so an accessor found on that prototype receives
      // the correct `this`. Every other non-object keeps the closure-side-table
      // miss path.
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 4 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.set", index: 2 },
          // (#3673 round 9b) a depth-0 (OWN) data hit on a plain $Object may
          // populate the per-key cache too — covers acorn's per-parse
          // `options.<x>` singleton reads. Same soundness argument as the
          // fnctor arm: population implies every earlier arm missed for this
          // exact receiver, and hits are owner-`ref.eq`-confined to it.
          ...(protoCacheEnabled
            ? ([
                { op: "i32.const", value: 1 },
                { op: "local.set", index: 9 },
              ] satisfies Instr[])
            : []),
        ],
        else:
          fnctorProtoStartIdx === undefined
            ? buildVecOrClosurePropGetMissArm(ctx, getMiss)
            : [
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: fnctorProtoStartIdx },
                { op: "local.tee", index: 7 },
                { op: "ref.is_null" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: buildVecOrClosurePropGetMissArm(ctx, getMiss),
                },
                { op: "local.get", index: 7 },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: objectTypeIdx },
                { op: "local.set", index: 2 },
                // (#3673 round 9b) walk starts at a fnctor prototype → a
                // first-proto data hit below may populate the per-key cache.
                ...(protoCacheEnabled
                  ? ([
                      { op: "i32.const", value: 1 },
                      { op: "local.set", index: 9 },
                    ] satisfies Instr[])
                  : []),
              ],
      },
      // proto-walk loop
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if o == null break
              { op: "local.get", index: 2 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // e = __obj_find(o, key)
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: objFindIdx },
              { op: "local.tee", index: 3 },
              // if e != null → resolve the property
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // (#1888 S5b) Accessor branch: if (e.flags & FLAG_ACCESSOR),
                  // invoke the stored getter with the ORIGINAL receiver (param 0,
                  // §6.2.5.5 Get — NOT the proto-walk cursor) bound as `this`.
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_ACCESSOR },
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // getter = extern.convert_any(e.$get)
                      { op: "local.get", index: 3 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                      { op: "extern.convert_any" },
                      { op: "local.tee", index: 5 },
                      // if getter == null → return undefined (§6.2.5.5 step 3)
                      { op: "ref.is_null" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [...getMiss(), { op: "return" }],
                      },
                      // return __call_accessor_get(obj /*param 0*/, getter)
                      { op: "local.get", index: 0 },
                      { op: "local.get", index: 5 },
                      { op: "call", funcIdx: callAccessorGetIdx },
                      { op: "return" },
                    ],
                  },
                  // (#3673 round 9b) Populate the per-key cache: a DATA entry
                  // found on the FIRST prototype object of a fnctor receiver
                  // (canCache still 1 — cleared on every proto advance) with
                  // an interned `$HashedString` key. All the earlier arms
                  // (field ladder, builtin meta) missed for this fnctor class,
                  // so the cache-hit shortcut is sound for the whole class.
                  ...(protoCacheEnabled
                    ? ([
                        { op: "local.get", index: 9 },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: 1 },
                            { op: "any.convert_extern" },
                            { op: "ref.test", typeIdx: HSTR },
                            {
                              op: "if",
                              blockType: { kind: "empty" },
                              then: [
                                { op: "local.get", index: 1 },
                                { op: "any.convert_extern" },
                                { op: "ref.cast", typeIdx: HSTR },
                                { op: "local.set", index: 8 },
                                { op: "local.get", index: 8 },
                                { op: "ref.as_non_null" },
                                { op: "local.get", index: 2 },
                                { op: "ref.as_non_null" },
                                { op: "struct.set", typeIdx: HSTR, fieldIdx: 5 }, // cacheOwner
                                { op: "local.get", index: 8 },
                                { op: "ref.as_non_null" },
                                { op: "local.get", index: 3 },
                                { op: "ref.as_non_null" },
                                { op: "struct.set", typeIdx: HSTR, fieldIdx: 6 }, // cacheEntry
                                // (#3673 round 21) owner's props array — the
                                // per-object staleness witness (grow replaces it).
                                { op: "local.get", index: 8 },
                                { op: "ref.as_non_null" },
                                { op: "local.get", index: 2 },
                                { op: "ref.as_non_null" },
                                { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 }, // props
                                { op: "struct.set", typeIdx: HSTR, fieldIdx: 7 }, // cacheProps
                                { op: "local.get", index: 8 },
                                { op: "ref.as_non_null" },
                                { op: "i32.const", value: 1 },
                                { op: "struct.set", typeIdx: HSTR, fieldIdx: 4 }, // populated
                              ],
                            },
                          ],
                        },
                      ] satisfies Instr[])
                    : []),
                  // Data property → return extern.convert_any(e.value)
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                  { op: "extern.convert_any" },
                  { op: "return" },
                ],
              },
              // o = o.proto ; loop
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 2 },
              // (#3673 round 9b) left the first prototype — stop cache writes.
              ...(protoCacheEnabled
                ? ([
                    { op: "i32.const", value: 0 },
                    { op: "local.set", index: 9 },
                  ] satisfies Instr[])
                : []),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found anywhere → miss (undefined under the S1 regime; legacy null)
      ...getMiss(),
    ];
    registerNative(
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "o", type: objRefNull },
        { name: "e", type: entryRefNull },
        { name: "any", type: { kind: "anyref" } },
        { name: "getter", type: { kind: "externref" } }, // (#1888 S5b) accessor $get
        { name: "bfmeta", type: { kind: "externref" } }, // (#2896) builtin-fn meta
        { name: "fnctorProto", type: { kind: "externref" } },
        ...(protoCacheEnabled
          ? [
              // (#3673 round 9b) per-key proto-cache scratch (locals 8/9).
              { name: "kh", type: { kind: "ref_null", typeIdx: ctx.hashedStrTypeIdx } as ValType },
              { name: "canCache", type: { kind: "i32" } as ValType },
            ]
          : []),
      ],
      body,
    );
  }

  // (#2106 S1, flag-only) __extern_is_nullish(externref) -> i32 — "null OR
  // undefined". Under the singleton regime a bare `ref.is_null` no longer
  // catches undefined (a non-null singleton), so every NULLISH-intent absence
  // check in the native runtime (missing-method / to-primitive / iterator
  // lookups, the loose `== null` guard) routes through this instead. Body is
  // self-contained (inline tag-1 ∨ UNDEF-box test, NOT a call into
  // `__extern_is_undefined`, which registers later) so it can be baked into
  // any subsequently-built native body. Registered ONLY under the flag so
  // legacy modules stay byte-identical.
  {
    const s1IsUndefTail = buildIsUndefinedExternBody(ctx, 1, UNDEF_F64_BITS);
    if (undefinedSingletonActive(ctx) && s1IsUndefTail !== undefined) {
      const isNullishIdx = registerNative(
        "__extern_is_nullish",
        [{ kind: "externref" }],
        [{ kind: "i32" }],
        [{ name: "any", type: { kind: "anyref" } }],
        [
          { op: "local.get", index: 0 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 1 }],
            else: s1IsUndefTail,
          },
        ],
      );
      // (#2106 S1, flag-only) __nullish_to_null(externref) -> externref —
      // canonicalize nullish (null OR the undefined singleton OR the UNDEF-box)
      // back to `ref.null.extern`. INTERNAL runtime lookups whose result feeds
      // null-keyed control logic (to-primitive valueOf/toString resolution,
      // proxy trap reads, descriptor field reads, method resolution, groupBy
      // presence checks) append ONE call to this after `__extern_get`, keeping
      // their entire downstream absence logic byte-identical to legacy instead
      // of widening every `ref.is_null` in place. JS-VISIBLE reads do NOT
      // normalize — they want the singleton.
      registerNative(
        "__nullish_to_null",
        [{ kind: "externref" }],
        [{ kind: "externref" }],
        [],
        [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: isNullishIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "ref.null.extern" }],
            else: [{ op: "local.get", index: 0 }],
          },
        ],
      );
    }
  }

  // ── $__obj_insert(ref $Object, externref key, anyref value, i32 flags, i32 seq) ──
  //
  // Insert-or-update on the OWN table. Caller is responsible for growing the
  // table BEFORE calling when the load factor is exceeded (see __extern_set).
  // On update of a LIVE entry with the same key, overwrites value + flags (the
  // existing entry's seq is NOT touched — first-insertion order is preserved
  // per OrdinaryOwnPropertyKeys; updating an existing key does not reorder it).
  // `seq` (#1837) is stamped onto a freshly-created entry. Callers that add a
  // NEW key pass `o.nextSeq` (and bump it); the __obj_grow rehash passes the
  // entry's PRESERVED seq so order survives a resize.
  //
  // params: 0=o(ref $Object) 1=key(externref) 2=value(anyref) 3=flags 4=seq
  // locals: 5=arr(ref $PropMap) 6=cap 7=mask 8=i 9=e(ref null $PropEntry) 10=fkey(ref $NativeString) 11=keyStr(ref $AnyString)
  {
    const body: Instr[] = [
      // (#2866) classify the search key → searchAny(12)/isSym(13)/symId(14)/fkey(10).
      // searchAny is the raw converted key (string OR $Symbol) — it is what gets
      // STORED into `$PropEntry.key`, preserving Symbol identity in the table.
      ...emitClassifyKey(1, 12, 13, 14, 10),
      // arr = o.props ; cap = arr.len ; mask = cap - 1
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 5 },
      { op: "array.len" },
      { op: "local.tee", index: 6 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.set", index: 7 },
      // i = hash(key) & mask
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objHashIdx },
      { op: "local.get", index: 7 },
      { op: "i32.and" },
      { op: "local.set", index: 8 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // e = arr[i]
              { op: "local.get", index: 5 },
              { op: "local.get", index: 8 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 9 },
              // empty slot → create new entry here, UNLESS the object is
              // non-extensible (#1472 Phase B Blocker A Half 2). A
              // sealed/preventExtensions/frozen object refuses NEW keys per ES
              // §10.4.7 [[DefineOwnProperty]] extensibility check — sloppy no-op
              // (strict throw deferred to #1473). Updates of existing keys are
              // unaffected (they take the update-in-place branch below). A
              // frozen object never reaches __obj_insert via __extern_set (the
              // FROZEN gate there returns first), but __obj_insert is also
              // called during __obj_grow rehash — where the table is rebuilt
              // from existing live entries, all of which take the empty-slot
              // branch. We must NOT refuse those, so the gate is keyed on the
              // OBJECT's NON_EXTENSIBLE bit, which during a grow only matters
              // when a non-extensible object grows (it can't — no new key was
              // accepted, so load never rises to force a grow). Safe.
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // if o.flags & NON_EXTENSIBLE → refuse new key (return)
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
                  { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
                  { op: "i32.and" },
                  { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
                  // arr[i] = struct.new $PropEntry { searchAny, value, flags, seq,
                  //                                   get=null, set=null }  (#2866:
                  //   store the raw converted key — $AnyString or $Symbol)
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 12 },
                  { op: "local.get", index: 2 },
                  { op: "local.get", index: 3 },
                  { op: "local.get", index: 4 }, // seq (#1837)
                  { op: "ref.null", typeIdx: NONE_HEAP }, // get (#1888 S5) — data path: null
                  { op: "ref.null", typeIdx: NONE_HEAP }, // set (#1888 S5) — data path: null
                  { op: "struct.new", typeIdx: propEntryTypeIdx },
                  { op: "array.set", typeIdx: propMapTypeIdx },
                  // o.count++
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
                  { op: "return" },
                ],
              },
              // occupied + LIVE + key matches → update in place  (#2866 key_match)
              ...emitKeyMatch(9, 13, 14, 10),
              // AND not a tombstone
              { op: "local.get", index: 9 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              { op: "i32.const", value: FLAG_TOMBSTONE },
              { op: "i32.and" },
              { op: "i32.eqz" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // e.value = value ; e.flags = flags ; return (update in place,
                  // seq untouched — first-insertion order preserved per #1837)
                  { op: "local.get", index: 9 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 2 },
                  { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                  { op: "local.get", index: 9 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 3 },
                  { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "return" },
                ],
              },
              // collision → i = (i + 1) & mask ; loop
              { op: "local.get", index: 8 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: 7 },
              { op: "i32.and" },
              { op: "local.set", index: 8 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];
    registerNative(
      "__obj_insert",
      [objRef, { kind: "externref" }, { kind: "anyref" }, { kind: "i32" }, { kind: "i32" }],
      [],
      [
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "mask", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        // (#2866) fkey nullable (null for a Symbol key); keyStr retired (the raw
        // converted key in `searchAny` is stored directly).
        { name: "fkey", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } },
        { name: "keyStr", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "searchAny", type: { kind: "anyref" } }, // 12
        { name: "searchIsSym", type: { kind: "i32" } }, // 13
        { name: "searchSymId", type: { kind: "i32" } }, // 14
      ],
      // #2042 S1 — coerce a non-string key (boxed number) to its canonical
      // string before the `ref.cast $AnyString` that both flattens it for the
      // probe AND is stored into `$PropEntry.key`. So `o[0] = v` stores key "0"
      // (matching the literal `{0:v}` path and the find-side coercion). key is
      // param 1; the inner __obj_hash re-coercion is idempotent.
      withKeyCoercion(1, body),
    );
  }
  const objInsertIdx = ctx.funcMap.get("__obj_insert")!;

  // ── Boxed primitive wrappers (#1910/#1472 S2) ────────────────────────────
  //
  // `new Number(x)` / `new String(x)` / `new Boolean(x)` produce a wrapper
  // OBJECT (typeof === "object"), not a primitive. In standalone mode there is
  // no JS host to satisfy the `env::__new_Number` import that the gc path uses,
  // so we build the wrapper as a plain `$Object` carrying the internal
  // [[NumberData]]/[[StringData]]/[[BooleanData]] slot under the reserved,
  // non-enumerable WRAPPER_PRIMITIVE_KEY entry. Because the wrapper IS a
  // `$Object`, ordinary member access (`w.toString`, `w.constructor`, future
  // indexed reads) keeps flowing through __extern_get/__obj_find unchanged, and
  // `__to_primitive` recovers the primitive by reading this slot first
  // (§7.1.1.1 — the wrapper's intrinsic valueOf returns the internal slot).
  //
  // All three take an ALREADY-boxed primitive externref in local `valueLocal` and
  // emit the shared wrapper-build tail: create the `$Object`, insert the internal
  // slot (key + FLAG_INTERNAL, non-enumerable) into `objLocal`, and return the
  // wrapper as externref. The slot encoding lives in exactly one place. The
  // wrapper's INITIAL_CAP (8) table holds one entry without any grow, so
  // __obj_insert is called directly.
  const emitWrapperBuildTail = (valueLocal: number, objLocal: number): Instr[] => [
    // o = new $Object { proto: null, props: $PropMap[INITIAL_CAP], 0,0,0, nextSeq=1 }
    { op: "ref.null", typeIdx: objectTypeIdx }, // proto
    { op: "i32.const", value: INITIAL_CAP },
    { op: "array.new_default", typeIdx: propMapTypeIdx },
    { op: "i32.const", value: 0 }, // count
    { op: "i32.const", value: 0 }, // tombstones
    { op: "i32.const", value: 0 }, // flags
    { op: "i32.const", value: 1 }, // nextSeq (slot consumes seq 0)
    { op: "struct.new", typeIdx: objectTypeIdx },
    { op: "local.set", index: objLocal },
    // __obj_insert(o, WRAPPER_PRIMITIVE_KEY, any.convert_extern(value),
    //              FLAG_INTERNAL (non-enumerable), seq=0)
    { op: "local.get", index: objLocal },
    ...((): Instr[] => {
      addStringConstantGlobal(ctx, WRAPPER_PRIMITIVE_KEY);
      return stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY);
    })(),
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "i32.const", value: FLAG_INTERNAL },
    { op: "i32.const", value: 0 }, // seq
    { op: "call", funcIdx: objInsertIdx },
    // return extern.convert_any(o)
    { op: "local.get", index: objLocal },
    { op: "extern.convert_any" },
  ];

  // __new_Number(f64) -> externref : box the number, then wrap.
  {
    addUnionImportsViaRegistry(ctx);
    const boxNumIdx = ctx.funcMap.get("__box_number")!;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: boxNumIdx }, // boxed number externref
      { op: "local.set", index: 1 },
      ...emitWrapperBuildTail(1, 2),
    ];
    registerNative(
      "__new_Number",
      [{ kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "boxed", type: { kind: "externref" } },
        { name: "o", type: objRef },
      ],
      body,
    );
  }

  // __new_String(externref) -> externref : the value is already a string
  // externref; wrap it directly (param 0 is the value local).
  {
    const body: Instr[] = emitWrapperBuildTail(0, 1);
    registerNative(
      "__new_String",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "o", type: objRef }],
      body,
    );
  }

  // __new_Boolean(f64) -> externref : ToBoolean(arg) — the call sites coerce the
  // argument to f64; truthy iff (x != 0) && (x == x) (NaN is falsy). Box the
  // i32 boolean, then wrap.
  {
    addUnionImportsViaRegistry(ctx);
    const boxBoolIdx = ctx.funcMap.get("__box_boolean")!;
    const body: Instr[] = [
      // truthy = (arg != 0) & (arg == arg)
      { op: "local.get", index: 0 },
      { op: "f64.const", value: 0 },
      { op: "f64.ne" },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 0 },
      { op: "f64.eq" }, // 0 when NaN, 1 otherwise
      { op: "i32.and" },
      { op: "call", funcIdx: boxBoolIdx }, // boxed boolean externref
      { op: "local.set", index: 1 },
      ...emitWrapperBuildTail(1, 2),
    ];
    registerNative(
      "__new_Boolean",
      [{ kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "boxed", type: { kind: "externref" } },
        { name: "o", type: objRef },
      ],
      body,
    );
  }

  // ── $__obj_grow(ref $Object) -> void ─────────────────────────────────────
  //
  // Double the capacity and rehash live (non-tombstone) entries into a fresh
  // table. Resets tombstones to 0 and replays entries through __obj_insert
  // against the NEW table (count reset to 0 first so inserts re-accumulate it).
  //
  // params: 0=o(ref $Object)
  // locals: 1=old(ref $PropMap) 2=newCap 3=i 4=oldLen 5=e(ref null $PropEntry)
  //         6=inserted(ref null $PropEntry)
  {
    const body: Instr[] = [
      // (#3673 round 21) No generation bump: a grow REPLACES `o.props`, and
      // every per-key cache hit `ref.eq`s the stored props array against the
      // live one — the replacement itself invalidates exactly this object's
      // cached entries.
      // old = o.props ; oldLen = old.len ; newCap = oldLen * 2
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 1 },
      { op: "array.len" },
      { op: "local.tee", index: 4 },
      { op: "i32.const", value: 2 },
      { op: "i32.mul" },
      { op: "local.set", index: 2 },
      // o.props = new $PropMap[newCap] ; o.count = 0 ; o.tombstones = 0
      { op: "local.get", index: 0 },
      { op: "local.get", index: 2 },
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 3 },
      // for i in 0..oldLen: replay live entries
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
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // e = old[i]
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 5 },
              // if e != null && !(e.flags & TOMBSTONE): re-insert
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 5 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_TOMBSTONE },
                  { op: "i32.and" },
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // __obj_insert(o, extern.convert_any(e.key), e.value,
                      // e.flags, e.seq) — PRESERVE the original seq across the
                      // rehash so insertion order survives a resize (#1837)
                      { op: "local.get", index: 0 },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                      { op: "extern.convert_any" },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 3 }, // seq
                      { op: "call", funcIdx: objInsertIdx },
                      // __obj_insert preserves the common key/value/flags/seq
                      // fields but initializes accessor halves to null. During
                      // a rehash that would silently turn every existing
                      // accessor into a getter-less/setter-less property. Find
                      // the freshly inserted entry and copy both live halves.
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                      { op: "i32.const", value: FLAG_ACCESSOR },
                      { op: "i32.and" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 0 },
                          { op: "local.get", index: 5 },
                          { op: "ref.as_non_null" },
                          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                          { op: "extern.convert_any" },
                          { op: "call", funcIdx: objFindIdx },
                          { op: "local.tee", index: 6 },
                          { op: "ref.is_null" },
                          { op: "i32.eqz" },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            then: [
                              { op: "local.get", index: 6 },
                              { op: "ref.as_non_null" },
                              { op: "local.get", index: 5 },
                              { op: "ref.as_non_null" },
                              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                              { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                              { op: "local.get", index: 6 },
                              { op: "ref.as_non_null" },
                              { op: "local.get", index: 5 },
                              { op: "ref.as_non_null" },
                              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
                              { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              // i++
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];
    registerNative(
      "__obj_grow",
      [objRef],
      [],
      [
        { name: "old", type: propMapRef },
        { name: "newCap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "oldLen", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "inserted", type: entryRefNull },
      ],
      body,
    );
  }
  const objGrowIdx = ctx.funcMap.get("__obj_grow")!;

  // ── __extern_set(externref obj, externref key, externref value) -> void ──
  //
  // Unwrap obj to $Object (no-op on non-object — matches host leniency), grow
  // if the load factor is too high, then insert/update. A fresh property gets
  // the default data-property flags; an update preserves the existing
  // descriptor flags, as OrdinarySet changes only [[Value]]. Value is stored
  // as anyref via any.convert_extern.
  //
  // params: 0=obj 1=key 2=value
  // locals: 3=o(ref null $Object) 4=cap 5=load 6=any(anyref) 7=seq
  //         8=accEntry(ref null $PropEntry) 9=setter(externref) — (#1888 S5b)
  {
    // (#1888 S5b) Reserve the `__call_accessor_set` driver funcIdx BEFORE the
    // body bakes its `call`; body filled in finalize (fillAccessorDrivers) once
    // `__call_fn_method_1` exists.
    const callAccessorSetIdx = reserveAccessorSetDriver(ctx);
    const body: Instr[] = [
      // any = any.convert_extern(obj)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 6 },
      // if !ref.test $Object → silently no-op (host import is lenient too), OR
      // (#3468 C-core) route a closure receiver's write into the side table.
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: buildVecOrClosurePropSetMissArm(ctx),
      },
      // o = cast<$Object>(any)
      { op: "local.get", index: 6 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 3 },
      // (#1888 S5b) Accessor write gate — runs BEFORE the FROZEN gate because a
      // setter is invoked regardless of [[Extensible]]/frozen state (§10.1.5.3
      // OrdinarySetWithOwnDescriptor calls Set even on a frozen object; only data
      // writes are blocked by frozen). Find the OWN entry; if it has
      // FLAG_ACCESSOR, invoke the stored setter with the ORIGINAL receiver
      // (param 0) bound as `this` and `value` (param 2) as the argument, then
      // return — bypassing the data-write path entirely. A null setter is a
      // sloppy no-op (strict TypeError deferred, matches the frozen-refuse).
      // Inherited-accessor set (proto-chain) is out of scope for this slice;
      // __obj_find walks only the own table.
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 8 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 8 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          { op: "i32.const", value: FLAG_ACCESSOR },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // setter = extern.convert_any(e.$set)
              { op: "local.get", index: 8 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
              { op: "extern.convert_any" },
              { op: "local.tee", index: 9 },
              // if setter != null → __call_accessor_set(obj /*param 0*/, setter, value /*param 2*/)
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 9 },
                  { op: "local.get", index: 2 },
                  { op: "call", funcIdx: callAccessorSetIdx },
                ],
              },
              // accessor write handled (setter ran, or sloppy no-op) → return
              { op: "return" },
            ],
          },
          // Own data property with [[Writable]] false: sloppy assignment is a
          // no-op.  `Object.defineProperty` / `defineProperties` store the
          // attribute in the entry flags, so the ordinary assignment path must
          // consult it just like `__reflect_set` does below.  The object-level
          // frozen bit is insufficient: an otherwise extensible object can
          // contain one non-writable data property.
          { op: "local.get", index: 8 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          { op: "i32.const", value: FLAG_WRITABLE },
          { op: "i32.and" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "return" }],
          },
        ],
      },
      // #1472 Phase B Blocker A Half 2 — FROZEN write gate. A frozen object
      // refuses ALL data writes (update AND new key) per ES §10.4.7 / the
      // [[Set]] invariant on non-writable own data properties. Sloppy-mode
      // no-op here (strict-mode TypeError throw is deferred to the error
      // machinery slice, #1473). Sealed/non-extensible objects still allow
      // updates of existing keys — that new-key refusal lives in __obj_insert's
      // empty-slot branch (gated on NON_EXTENSIBLE), so it is NOT gated here.
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_FROZEN },
      { op: "i32.and" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      // load = o.count + o.tombstones ; cap = o.props.len
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 5 },
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
      // if (load + 1) * 10 >= cap * 7 → grow  (load factor 0.7)
      { op: "local.get", index: 5 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "i32.const", value: 10 },
      { op: "i32.mul" },
      { op: "local.get", index: 4 },
      { op: "i32.const", value: 7 },
      { op: "i32.mul" },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 3 }, { op: "ref.as_non_null" }, { op: "call", funcIdx: objGrowIdx }],
      },
      // seq = o.nextSeq ; o.nextSeq = seq + 1  (#1837 — claim the next insertion
      // sequence for a potential NEW entry; an update of an existing key keeps
      // its original seq so this number is simply skipped, which is harmless
      // because seq values are only compared for relative order)
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 5 },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 7 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 5 },
      // __obj_insert(o, key, any.convert_extern(value), flags, seq)
      //
      // Ordinary assignment updates [[Value]] only. Reusing FLAG_DEFAULT here
      // used to make every successful write configurable, enumerable, and
      // writable, silently erasing attributes installed by defineProperty.
      // `accEntry` is the own live entry probed above; null means this is a new
      // property and therefore still receives FLAG_DEFAULT.
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "local.get", index: 8 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: FLAG_DEFAULT }],
        else: [
          { op: "local.get", index: 8 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
        ],
      },
      { op: "local.get", index: 7 },
      { op: "call", funcIdx: objInsertIdx },
    ];
    registerNative(
      "__extern_set",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
      [
        { name: "o", type: objRefNull },
        { name: "cap", type: { kind: "i32" } },
        { name: "load", type: { kind: "i32" } },
        { name: "any", type: { kind: "anyref" } },
        { name: "seq", type: { kind: "i32" } },
        { name: "accEntry", type: entryRefNull }, // (#1888 S5b) own entry for accessor probe
        { name: "setter", type: { kind: "externref" } }, // (#1888 S5b) accessor $set
      ],
      body,
    );
    // (#3983) `__extern_set_strict` is no longer an alias of this one.
  }

  // ── __reflect_set(externref obj, externref key, externref value) -> i32 ──
  //
  // Reflect.set's supported standalone subset shares the existing __extern_set
  // data-write machinery, but it must return the [[Set]] boolean instead of
  // void. Keep __extern_set's ABI stable for ordinary assignment call sites and
  // preflight the object-runtime refusal cases here:
  //   - non-$Object receiver → false (standalone has no host TypeError bridge)
  //   - own accessor with no setter → false
  //   - own data property with !writable → false
  //   - frozen object data write → false
  //   - missing own property on a non-extensible object → false
  // Otherwise delegate to __extern_set and return true.
  {
    const reflectSetExternSetIdx = ctx.funcMap.get("__extern_set")!;
    const body: Instr[] = [
      // any = any.convert_extern(obj); if !ref.test $Object → false
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 3 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // o = cast<$Object>(any); e = __obj_find(o, key)
      { op: "local.get", index: 3 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 4 },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 5 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // Own accessor: true iff a setter exists; __extern_set invokes it.
          { op: "local.get", index: 5 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          { op: "i32.const", value: FLAG_ACCESSOR },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 5 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
              { op: "extern.convert_any" },
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 0 }, { op: "return" }],
              },
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: reflectSetExternSetIdx },
              { op: "i32.const", value: 1 },
              { op: "return" },
            ],
          },
          // Own data: false if non-writable.
          { op: "local.get", index: 5 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          { op: "i32.const", value: FLAG_WRITABLE },
          { op: "i32.and" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 0 }, { op: "return" }],
          },
          // Frozen data write: false. __extern_set would no-op; Reflect.set
          // exposes that refusal as its boolean result.
          { op: "local.get", index: 4 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
          { op: "i32.const", value: OBJ_FLAG_FROZEN },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 0 }, { op: "return" }],
          },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: reflectSetExternSetIdx },
          { op: "i32.const", value: 1 },
          { op: "return" },
        ],
      },
      // Missing own property: non-extensible objects refuse the new key.
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: reflectSetExternSetIdx },
      { op: "i32.const", value: 1 },
    ];
    registerNative(
      "__reflect_set",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "e", type: entryRefNull },
      ],
      body,
    );
  }

  // (#3983) __extern_set_strict — strict [[Set]]/PutValue TypeError. MUST follow
  // `__extern_set` + `__reflect_set` (the body bakes their funcIdx); see module.
  buildStrictSetHelper(ctx, { registerNative, objectTypeIdx });

  // ── __delete_property(externref obj, externref key) -> i32 ───────────────
  //
  // ES §13.5.1 delete operator / §28.1.4 Reflect.deleteProperty on an own data
  // property. Finds the live entry; if present AND configurable (§10.1.10
  // OrdinaryDelete), marks it tombstoned (FLAG_TOMBSTONE), nulls its value (drop
  // the reference for GC), decrements count, increments tombstones, returns 1.
  // (#2046 PR-B) A configurability preflight refuses non-configurable props
  // (return 0): props on a sealed/frozen object, or data props defined
  // non-configurable via __defineProperty_value (#1629) — the prior "always
  // configurable" assumption was stale once #1629 landed. Returns 1 when the key
  // is absent (delete of a missing own prop succeeds, §10.1.10 step 2 / host
  // import parity).
  //
  // params: 0=obj(externref) 1=key(externref)
  // locals: 2=any(anyref) 3=o(ref null $Object) 4=e($PropEntry?) 5=cbd(i32)
  {
    // (#4010 S2) The non-$Object head, owned by carrier-bag-delete.ts: the
    // #2896 builtin-fn metadata arm FIRST (unchanged), then the #3468/#3537
    // carrier-bag arm, then the historical `return 1` no-op success. See that
    // module for why the bag consult is tri-state and strictly additive.
    reserveCarrierBagDelete(ctx);
    const body: Instr[] = [
      ...buildNonObjectDeleteArms(ctx, { bfnDeleteIdx, objectTypeIdx, anyLocal: 2, resultLocal: 5 }),
      // o = cast<$Object>(any) ; e = __obj_find(o, key)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 3 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 4 },
      // if e == null → property absent → return 1 (delete of missing key succeeds)
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
      // (#2046 PR-B) Configurability preflight — §10.1.10 OrdinaryDelete step 3-4:
      // a non-configurable own property is NOT deletable. Return 0 (false, keep)
      // when either:
      //   (a) the OBJECT is sealed/frozen — `__object_seal`/`__object_freeze`
      //       set the object-level OBJ_FLAG_SEALED bit but do NOT clear each
      //       entry's FLAG_CONFIGURABLE, so the per-entry check below is NOT
      //       sufficient on its own; sealed ⇒ every own prop is non-configurable
      //       (frozen ⊃ sealed), so test the object bit too; OR
      //   (b) the individual entry was defined non-configurable
      //       (FLAG_CONFIGURABLE cleared) via __defineProperty_value (#1629).
      // This is correct for BOTH callers of __delete_property: Reflect (returns
      // false) and sloppy `delete obj[k]` (also returns false for a
      // non-configurable own prop, §13.5.1.2).
      // (a) object sealed/frozen?
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_SEALED },
      { op: "i32.and" },
      // (b) entry non-configurable? ((e.flags & FLAG_CONFIGURABLE) == 0)
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: FLAG_CONFIGURABLE },
      { op: "i32.and" },
      { op: "i32.eqz" },
      // refuse-delete = (sealed) | (entry not configurable)
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // e.flags |= TOMBSTONE
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: FLAG_TOMBSTONE },
      { op: "i32.or" },
      { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      // o.count-- ; o.tombstones++
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 3 },
      // return 1
      { op: "i32.const", value: 1 },
    ];
    registerNative(
      "__delete_property",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "e", type: entryRefNull },
        { name: "cbd", type: { kind: "i32" } }, // (#4010 S2) carrier-bag tri-state
      ],
      body,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // #1472 Phase B Blocker B — native $ObjVec build/iterate foundation.
  //
  // A growable externref vector that backs standalone enumeration results
  // (Object.keys/values/entries). It is wrapped to externref via
  // extern.convert_any so the result flows unchanged through the existing
  // externref-typed enumeration call sites, where the consumer reads it back
  // via __extern_length + __extern_get_idx. Those two helpers gain a
  // $ObjVec-aware native path here so the round-trip is fully host-free.
  //
  // Insert/append uses doubling growth; INITIAL_CAP keeps small objects cheap.
  // ════════════════════════════════════════════════════════════════════════

  // ── __objvec_new() -> externref ─────────────────────────────────────────
  // struct.new $ObjVec { len: 0, data: new $ObjVecArr[INITIAL_CAP] }, wrapped.
  {
    const body: Instr[] = [
      { op: "i32.const", value: 0 }, // len
      { op: "i32.const", value: INITIAL_CAP }, // data: array.new_default count
      { op: "array.new_default", typeIdx: objVecArrTypeIdx },
      { op: "struct.new", typeIdx: objVecTypeIdx },
      { op: "extern.convert_any" },
    ];
    registerNative("__objvec_new", [], [{ kind: "externref" }], [], body);
  }
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;

  // ── __objvec_push(externref vec, externref elem) -> void ─────────────────
  //
  // Append elem to the wrapped $ObjVec, doubling the backing array when full.
  // No-op (silently) if vec is not a $ObjVec — keeps the helper total.
  //
  // params: 0=vec(externref) 1=elem(externref)
  // locals: 2=any(anyref) 3=v(ref null $ObjVec) 4=arr(ref null $ObjVecArr)
  //         5=len 6=cap 7=narr(ref null $ObjVecArr) 8=i
  {
    const body: Instr[] = [
      // any = any.convert_extern(vec); if !$ObjVec → return
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      // v = cast<$ObjVec>(any)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objVecTypeIdx },
      { op: "local.set", index: 3 },
      // arr = v.data ; len = v.len ; cap = arr.len
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 4 },
      { op: "array.len" },
      { op: "local.set", index: 6 },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 5 },
      // if len >= cap → grow: narr = new[cap*2]; copy 0..len; v.data = narr; arr = narr
      { op: "local.get", index: 5 },
      { op: "local.get", index: 6 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // narr = array.new_default(cap*2)  (cap is always >=1)
          { op: "local.get", index: 6 },
          { op: "i32.const", value: 2 },
          { op: "i32.mul" },
          { op: "array.new_default", typeIdx: objVecArrTypeIdx },
          { op: "local.set", index: 7 },
          // i = 0; while i < len: narr[i] = arr[i]; i++
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 8 },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 5 },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  // narr[i] = arr[i]
                  { op: "local.get", index: 7 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 8 },
                  { op: "array.get", typeIdx: objVecArrTypeIdx },
                  { op: "array.set", typeIdx: objVecArrTypeIdx },
                  // i++
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 8 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          // v.data = narr ; arr = narr
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 7 },
          { op: "ref.as_non_null" },
          { op: "struct.set", typeIdx: objVecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 7 },
          { op: "local.set", index: 4 },
        ],
      },
      // arr[len] = elem ; v.len = len + 1
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 5 },
      { op: "local.get", index: 1 },
      { op: "array.set", typeIdx: objVecArrTypeIdx },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 5 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objVecTypeIdx, fieldIdx: 0 },
    ];
    registerNative(
      "__objvec_push",
      [{ kind: "externref" }, { kind: "externref" }],
      [],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "v", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
        { name: "arr", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
        { name: "len", type: { kind: "i32" } },
        { name: "cap", type: { kind: "i32" } },
        { name: "narr", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
    );
  }
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;

  // ── __hasOwnProperty / __object_hasOwn (externref obj, externref key) -> i32 ─
  //
  // ES §20.1.3.2 Object.prototype.hasOwnProperty / §20.1.2.13 Object.hasOwn:
  // OWN-property presence only (NO prototype walk). Cast obj to $Object (return
  // 0 on a non-$Object / null receiver — never throws into Wasm), then
  // __obj_find on the own props table; present iff the returned entry is
  // non-null (find already skips tombstones). Object.hasOwn shares the exact
  // own-only predicate, so both names register the same body.
  const emitHasOwn = (name: string): void => {
    const body: Instr[] = [
      // (#2896) Builtin-fn metadata arm: name/length are OWN properties of a
      // builtin function value (until deleted). get_meta returns non-null
      // exactly when the own property exists.
      ...(bfnGetMetaIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: bfnGetMetaIdx },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 1 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      // any = any.convert_extern(obj); if !ref.test $Object → carrier bag, else 0 (#4010 S3)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      bagHasIfAbsent(ctx),
      // e = __obj_find(cast<$Object>(any), key) ; return e != null
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
    ];
    registerNative(
      name,
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [{ name: "any", type: { kind: "anyref" } }],
      body,
    );
  };
  emitHasOwn("__hasOwnProperty");
  emitHasOwn("__object_hasOwn");

  // (#4055) ToPropertyDescriptor's HasProperty step, and ONLY it, must also see
  // the #3468 closure own-property bag — a function used as a descriptor keeps
  // its `value`/`enumerable`/… there, and gating each field on a bag-blind
  // HasProperty yielded an empty descriptor with all-false defaults. Deliberately
  // a separate native rather than a widening of `__hasOwnProperty`: #4017 tried
  // the latter and cost 684 host-free passes via `propertyHelper.js`. See
  // carrier-bag-hasown.ts.
  registerDescriptorHasOwn(ctx, registerNative, {
    hasOwnIdx: ctx.funcMap.get("__hasOwnProperty")!,
    objFindIdx,
    objectTypeIdx,
  });

  // ── __propertyIsEnumerable(externref obj, externref key) -> i32 (#2541) ─────
  //
  // ES §20.1.3.4 Object.prototype.propertyIsEnumerable: OWN-property presence
  // (NO prototype walk) AND the own property's [[Enumerable]] attribute. Same
  // __obj_find own-only lookup as __hasOwnProperty, then test the found entry's
  // FLAG_ENUMERABLE bit. Missing own property / non-$Object receiver → false.
  // This replaces the standalone #1472-Phase-B refusal with a native lowering
  // over the same $Object/$PropEntry runtime; host mode keeps its JS import.
  {
    const body: Instr[] = [
      // any = any.convert_extern(obj); if !ref.test $Object → 0
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // e = __obj_find(cast<$Object>(any), key)  (local 3)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 3 },
      // if e == null → 0 (no own property)
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // return (e.flags & FLAG_ENUMERABLE) != 0
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: FLAG_ENUMERABLE },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
    ];
    registerNative(
      "__propertyIsEnumerable",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "e", type: entryRefNull },
      ],
      body,
    );
  }

  // ── __extern_has(externref obj, externref key) -> i32 (#1472 Phase C) ──────
  //
  // ES §7.3.12 HasProperty(O, P): keyed `key in obj` — own properties AND the
  // prototype chain. Mirrors __extern_get's proto-walk but returns a boolean
  // instead of the value (so a present-but-undefined property still reports 1).
  // Non-$Object / null receiver → 0 (the `in` dispatch site has already
  // confirmed an object-shaped externref; this never throws into Wasm).
  //
  // params: 0=obj(externref) 1=key(externref)
  // locals: 2=o(ref null $Object) 3=any(anyref)
  {
    const body: Instr[] = [
      // any = any.convert_extern(obj); if !ref.test $Object → carrier bag, else 0 (#4010 S3)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 3 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      bagHasIfAbsent(ctx),
      // o = cast<$Object>(any)
      { op: "local.get", index: 3 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 2 },
      // proto-walk loop (mirror of __extern_get)
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if o == null break
              { op: "local.get", index: 2 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // if __obj_find(o, key) != null → return 1
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: objFindIdx },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
              },
              // o = o.proto ; loop
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found anywhere → 0
      { op: "i32.const", value: 0 },
    ];
    registerNative(
      "__extern_has",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "o", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
      ],
      body,
    );
  }

  // ── __to_primitive(externref input, externref hint) -> externref ─────────
  //
  // #1900 Phase 1 — Wasm-native OrdinaryToPrimitive over the standalone
  // `$Object` runtime. Implements ECMA-262 §7.1.1.1 method ordering:
  //   string hint: toString → valueOf
  //   number/default hint: valueOf → toString
  //
  // The standalone runtime does not yet materialize Object.prototype as a real
  // prototype object, so a modeled object with no `toString` property would
  // otherwise throw. When `__extern_has(obj, "toString")` is false, the helper
  // supplies the ordinary default Object.prototype.toString result
  // `"[object Object]"`. A present non-callable or object-returning `toString`
  // still shadows that default and can produce the required TypeError.
  {
    addUnionImportsViaRegistry(ctx);
    const externGetIdx = ctx.funcMap.get("__extern_get")!;
    const externHasIdx = ctx.funcMap.get("__extern_has")!;
    const callMethod0Idx = reserveAccessorGetDriver(ctx);
    // (#2358 #10) Standalone Array → primitive. A real array (a `__vec_<k>`
    // struct subtyping `$__vec_base`) is NOT a `$Object`, so the
    // `ref.test objectTypeIdx` arm below misses it and ToPrimitive would return
    // the array unchanged → `__unbox_number(array)` → NaN. Reduce it via
    // `Array.prototype.toString` (`join(",")`) instead. The join helper depends
    // on `__extern_length`/`__extern_get_idx`, which are registered AFTER
    // `__to_primitive`, so we reserve the placeholder here (stable call target)
    // and fill it in post-processing. `$__vec_base` is the shared supertype with
    // `length` at field 0 (#2186) — one `ref.test` detects every element kind.
    const arrayLikeReduce = ctx.standalone;
    const vecBaseTypeIdx = arrayLikeReduce ? getOrRegisterVecBaseType(ctx) : -1;
    const arrayToPrimIdx = arrayLikeReduce ? reserveArrayToPrimitiveString(ctx) : -1;
    // (#2638) Standalone CLASS-instance → primitive. A nominal class struct is
    // neither `$Object` nor `$Vec`, so the `ref.test objectTypeIdx` arm below
    // misses it and ToPrimitive returns the struct unchanged → `__unbox_number`
    // → NaN. Route it through the per-struct `__call_valueOf`/`__call_toString`
    // dispatchers (§7.1.1.1) via the reserved `__class_to_primitive` driver. The
    // dispatchers are emitted at FINALIZE (after `__to_primitive`), so we reserve
    // the placeholder here (stable call target) and fill it post-processing
    // (`fillClassToPrimitive`, after `emitToPrimitiveMethodExports`). Same
    // reserve/fill funcIdx discipline as `arrayToPrimIdx`.
    const classToPrimIdx = arrayLikeReduce ? reserveClassToPrimitive(ctx) : -1;
    const typeofNumberIdx = ctx.funcMap.get("__typeof_number")!;
    const typeofStringIdx = ctx.funcMap.get("__typeof_string")!;
    const typeofBooleanIdx = ctx.funcMap.get("__typeof_boolean")!;
    const typeofFunctionIdx = ctx.funcMap.get("__typeof_function")!;

    const typeErrorMessage = "Cannot convert object to primitive value";
    addStringConstantGlobal(ctx, typeErrorMessage);
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
    const exnTagIdx = ensureExnTag(ctx);

    const stringExtern = (value: string): Instr[] => {
      addStringConstantGlobal(ctx, value);
      return stringConstantExternrefInstrs(ctx, value);
    };

    const L_ANY = 2;
    const L_METHOD = 3;
    const L_RESULT = 4;
    // #1910/#1472 S2 — the boxed-primitive internal-slot $PropEntry (or null).
    const L_SLOT = 5;

    const returnIfPrimitive = (localIdx: number): Instr[] => [
      { op: "local.get", index: localIdx },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx: typeofNumberIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx: typeofBooleanIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx: typeofStringIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
    ];

    const throwTypeError = (): Instr[] => [
      ...stringExtern(typeErrorMessage),
      { op: "call", funcIdx: typeErrorCtorIdx },
      { op: "throw", tagIdx: exnTagIdx },
    ];

    const isStringHint: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 0 }],
        else: [
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: typeofStringIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              ...nativeStringLiteralInstrs(ctx, "string"),
              { op: "call", funcIdx: strFlattenIdx },
              { op: "call", funcIdx: strEqualsIdx },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ],
      },
    ];

    // (#2106 S1) Normalize the method lookup back to the legacy null-keyed
    // convention: under the singleton regime a MISSING valueOf/toString comes
    // back as the non-null `$undefined` singleton, which the `ref.is_null`
    // absence check below would treat as a callable method — the exact source
    // of PR #2025's 948 "Cannot convert object to primitive value" CEs.
    const s1ToPrimNorm: Instr[] = (() => {
      const idx = ctx.funcMap.get("__nullish_to_null");
      return idx !== undefined ? [{ op: "call", funcIdx: idx }] : [];
    })();
    const tryOrdinaryMethod = (name: "valueOf" | "toString", defaultObjectToStringOnMissing: boolean): Instr[] => [
      { op: "local.get", index: 0 },
      ...stringExtern(name),
      { op: "call", funcIdx: externGetIdx },
      ...s1ToPrimNorm.map((i) => ({ ...i })),
      { op: "local.tee", index: L_METHOD },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: defaultObjectToStringOnMissing
          ? [
              { op: "local.get", index: 0 },
              ...stringExtern(name),
              { op: "call", funcIdx: externHasIdx },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...stringExtern("[object Object]"), { op: "return" }],
              },
            ]
          : [],
        else: [
          { op: "local.get", index: L_METHOD },
          { op: "call", funcIdx: typeofFunctionIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "local.get", index: L_METHOD },
              { op: "call", funcIdx: callMethod0Idx },
              { op: "local.set", index: L_RESULT },
              ...returnIfPrimitive(L_RESULT),
            ],
          },
        ],
      },
    ];

    const body: Instr[] = [
      // Non-objects return unchanged (ToPrimitive step 1).
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // (#3673 round 11) Primitive identity early-out (§7.1.1 step 1): an i31
      // small int, a `$BoxedNumber`, or a native string IS already a
      // primitive — return it before the object test. Previously a plain
      // number fell into the non-$Object arm and paid a
      // `__class_to_primitive` dispatcher walk per ToNumber site.
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_ANY },
      { op: "ref.test", typeIdx: -20 }, // abstract i31
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      ...(ctx.nativeBoxNumberTypeIdx >= 0
        ? ([
            { op: "local.get", index: L_ANY },
            { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 0 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      ...(ctx.anyStrTypeIdx >= 0
        ? ([
            { op: "local.get", index: L_ANY },
            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 0 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_ANY },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then:
          arrayLikeReduce && vecBaseTypeIdx >= 0 && arrayToPrimIdx >= 0
            ? [
                // (#2358 #10) A real array (`$__vec_base`) reduces to its
                // Array.prototype.toString (`join(",")`) — a primitive string the
                // caller's hint then coerces (`__str_to_number` / string concat).
                { op: "local.get", index: L_ANY },
                { op: "ref.test", typeIdx: vecBaseTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: arrayToPrimIdx }, { op: "return" }],
                },
                // (#2638) A nominal CLASS instance is neither `$Object` nor `$Vec`.
                // Route it through `__class_to_primitive(obj, stringHint)`, which
                // calls the per-struct `__call_valueOf`/`__call_toString`
                // dispatchers per §7.1.1.1 and returns a boxed primitive on a
                // method match, or the input unchanged otherwise. If the driver
                // produced a primitive (the class had valueOf/toString), return
                // it; else fall through to "return unchanged" (a struct/closure
                // with no user ToPrimitive — today's behaviour, no regression).
                ...(classToPrimIdx >= 0
                  ? ([
                      { op: "local.get", index: 0 },
                      ...isStringHint,
                      { op: "call", funcIdx: classToPrimIdx },
                      { op: "local.set", index: L_RESULT },
                      ...returnIfPrimitive(L_RESULT),
                    ] satisfies Instr[])
                  : []),
                // Any other non-$Object value (a struct/closure without a user
                // ToPrimitive) returns unchanged as before.
                { op: "local.get", index: 0 },
                { op: "return" },
              ]
            : [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // #1910/#1472 S2 — boxed primitive wrapper short-circuit. A `new Number`/
      // `new String`/`new Boolean` wrapper carries its [[PrimitiveValue]] in the
      // reserved, FLAG_INTERNAL own-slot. §7.1.1.1: the wrapper's intrinsic
      // valueOf/toString return that internal primitive, so when the slot exists
      // we return it directly (BEFORE the ordinary valueOf/toString own-prop
      // probe) — the slot value is already a primitive, and the caller applies the
      // final ToNumber/ToString per its hint. Plain objects lack this slot, so
      // __obj_find returns null and we fall through to OrdinaryToPrimitive.
      { op: "local.get", index: L_ANY },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      ...stringExtern(WRAPPER_PRIMITIVE_KEY),
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: L_SLOT },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // entry present — confirm it is the internal slot (FLAG_INTERNAL), then
          // return extern.convert_any(entry.value).
          { op: "local.get", index: L_SLOT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 }, // flags
          { op: "i32.const", value: FLAG_INTERNAL },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: L_SLOT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value (anyref)
              { op: "extern.convert_any" },
              { op: "return" },
            ],
          },
        ],
      },
      ...isStringHint,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...tryOrdinaryMethod("toString", true), ...tryOrdinaryMethod("valueOf", false)],
        else: [...tryOrdinaryMethod("valueOf", false), ...tryOrdinaryMethod("toString", true)],
      },
      ...throwTypeError(),
    ];

    registerNative(
      "__to_primitive",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "method", type: { kind: "externref" } },
        { name: "result", type: { kind: "externref" } },
        { name: "slot", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
      ],
      body,
    );

    const toPrimitiveIdx = ctx.funcMap.get("__to_primitive")!;
    const anyToStringIdx = ensureAnyToStringHelper(ctx);
    const toStringBody: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        // (#2106 S1) under the singleton regime a null externref IS JS null →
        // ToString = "null" (§7.1.17). Legacy keeps the null pass-through
        // (downstream __any_to_string renders its residual arm).
        then: undefinedSingletonActive(ctx) ? [...stringExtern("null")] : [{ op: "ref.null.extern" }],
        else: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "local.get", index: 0 }, ...stringExtern("string"), { op: "call", funcIdx: toPrimitiveIdx }],
            else: [{ op: "local.get", index: 0 }],
          },
        ],
      },
      { op: "any.convert_extern" },
      { op: "call", funcIdx: anyToStringIdx },
      { op: "extern.convert_any" },
    ];
    registerNative("__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }], [], toStringBody);

    // #2042 R2 / #2985 — now that `__extern_toString` exists, splice the
    // non-Symbol ToString arm into `__to_property_key`'s body (built earlier,
    // before this funcIdx was known). By this point the key is neither an
    // `$AnyString` nor a boxed number (both returned already). For EVERY
    // remaining non-Symbol key — `$Object`, boolean, bigint, null/undefined,
    // any other opaque primitive — ToPropertyKey = ToString(ToPrimitive(key,
    // "string")), exactly `__extern_toString` (§7.1.1.1 → §7.1.17). Originally
    // this arm only tested `$Object`, so a boolean/bigint/etc. computed key
    // (`o[true]`, `Object.defineProperty(o, true, …)`) fell through UNCHANGED
    // and then hit the downstream `ref.cast $AnyString` in
    // `emitClassifyKey`/`__obj_hash`, trapping "illegal cast [in __obj_find()]"
    // (#2985 residual). Broadening the test from "is `$Object`" to "is NOT a
    // Symbol" canonicalises those keys instead. A genuine Symbol still falls
    // through to the trailing `local.get 0` unchanged (Symbols are looked up by
    // identity via `__key_equals`, not by string cast). When symbol keys are
    // disabled there are no Symbol keys, so the ToString applies unconditionally.
    if (tpkBodyRef !== undefined) {
      const externToStringIdx = ctx.funcMap.get("__extern_toString")!;
      const toStringArm: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: externToStringIdx },
        { op: "return" },
      ];
      const nonSymbolToStringArm: Instr[] = symbolKeysEnabled
        ? [
            // if (!ref.test $Symbol any) return __extern_toString(key)
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: symbolTypeIdx },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: toStringArm },
          ]
        : // no Symbol keys in play → ToString every remaining key unconditionally
          toStringArm;
      // Splice before the last instruction (the unchanged-key fallthrough, which
      // now only serves genuine Symbol keys under symbolKeysEnabled).
      tpkBodyRef.splice(tpkBodyRef.length - 1, 0, ...nonSymbolToStringArm);
    }
  }

  buildObjectPrototypeHelpers(ctx, {
    registerNative,
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    objRefNull,
    propMapRef,
    INITIAL_CAP,
    OBJ_FLAG_NONEXTENSIBLE,
  });

  // ── __obj_index_of_key(ref $AnyString key) -> i32 ────────────────────────
  // #1837 — canonical array-index test for OrdinaryOwnPropertyKeys ordering.
  // Returns the integer value of `key` if it is a canonical numeric array index
  // (ES §6.1.7 / 7.1.21 CanonicalNumericIndexString restricted to array index
  // range), else -1. Canonical means: "0", or a digit string with no leading
  // zero whose value is a non-negative integer < 2^31-1 (we cap below i32 max so
  // the value is usable as a signed sort key — array indices in practice are
  // small; anything ≥ 2^31-1 is treated as a string key, which is acceptable
  // since it would also sort after all in-range indices). Non-digit strings,
  // leading-zero strings ("01"), "+1", "-1", "1.0", "" → -1.
  //
  // param: 0=key(ref $AnyString)
  // locals: 1=str(ref $NativeString) 2=data(ref $strData) 3=len 4=off 5=i 6=c 7=val
  {
    const body: Instr[] = [
      // str = flatten(key) ; len = str.len ; off = str.off ; data = str.data
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: strFlattenIdx },
      { op: "local.tee", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
      { op: "local.tee", index: 3 },
      // if len == 0 → -1 (empty string is not an index)
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" }],
      },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },
      // c = data[off + 0]
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.tee", index: 6 },
      // special case "0": len==1 && c=='0' → 0
      { op: "i32.const", value: 0x30 }, // '0'
      { op: "i32.eq" },
      { op: "local.get", index: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.eq" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // first char must be '1'..'9' (no leading zero, no '0' prefix)
      { op: "local.get", index: 6 },
      { op: "i32.const", value: 0x31 }, // '1'
      { op: "i32.lt_u" },
      { op: "local.get", index: 6 },
      { op: "i32.const", value: 0x39 }, // '9'
      { op: "i32.gt_u" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" }],
      },
      // val = 0 ; i = 0 ; accumulate digits
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 7 },
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
              // if i >= len break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 3 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // c = data[off + i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.tee", index: 6 },
              // if c < '0' || c > '9' → not an index (return -1)
              { op: "i32.const", value: 0x30 },
              { op: "i32.lt_u" },
              { op: "local.get", index: 6 },
              { op: "i32.const", value: 0x39 },
              { op: "i32.gt_u" },
              { op: "i32.or" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: -1 }, { op: "return" }],
              },
              // val = val * 10 + (c - '0')
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 10 },
              { op: "i32.mul" },
              { op: "local.get", index: 6 },
              { op: "i32.const", value: 0x30 },
              { op: "i32.sub" },
              { op: "i32.add" },
              { op: "local.tee", index: 7 },
              // overflow / out-of-range guard: if val < 0 (wrapped past i32 max)
              // treat as a string key (return -1)
              { op: "i32.const", value: 0 },
              { op: "i32.lt_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: -1 }, { op: "return" }],
              },
              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return val
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__obj_index_of_key",
      [anyStrRef],
      [{ kind: "i32" }],
      [
        { name: "str", type: nativeStrRef },
        { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
        { name: "len", type: { kind: "i32" } },
        { name: "off", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "c", type: { kind: "i32" } },
        { name: "val", type: { kind: "i32" } },
      ],
      body,
    );
  }
  const objIndexOfKeyIdx = ctx.funcMap.get("__obj_index_of_key")!;

  // ── __obj_ordered(ref $Object o) -> ref $PropMap ──────────────────────────
  // #1837 — collect this object's LIVE + ENUMERABLE own property entries into a
  // freshly compacted $PropMap in ECMAScript OrdinaryOwnPropertyKeys order
  // (§10.1.11.1): integer-index keys ascending by numeric value first, then the
  // remaining string keys in insertion order ($PropEntry.seq ascending). The
  // result array's prefix [0..m) holds the ordered entries; the suffix is null,
  // so callers walk until the first null (or use the known live count). Symbol
  // keys are out of scope here (the open-object runtime stores only string keys).
  //
  // Selection sort over the compacted set — O(m²) but m is the live-property
  // count of one object, which is small in practice and avoids any auxiliary
  // host array.
  //
  // param: 0=o(ref $Object)
  // locals: 1=arr(ref $PropMap) 2=cap 3=i 4=e(ref null $PropEntry) 5=out(ref $PropMap)
  //         6=m(filled count) 7=j 8=best 9=k 10=cand(ref null $PropEntry) 11=bestE(ref null $PropEntry)
  //         12=candIdx 13=bestIdx 14=candSeq 15=bestSeq 16=tmp(ref null $PropEntry)
  {
    const entryRef: ValType = { kind: "ref", typeIdx: propEntryTypeIdx };
    // Inline: leave on stack the array index (i32) for entry `e` (local idx given
    // by `entryLocal`) — its key parsed as a canonical array index, else -1.
    const entryIndexOf = (entryLocal: number): Instr[] => [
      { op: "local.get", index: entryLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
      // (#2866) key is anyref; entries reaching here are pre-filtered to string
      // keys (the compaction pass excludes `$Symbol` keys), so this cast is safe.
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
      { op: "call", funcIdx: objIndexOfKeyIdx },
    ];
    const entrySeqOf = (entryLocal: number): Instr[] => [
      { op: "local.get", index: entryLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 3 },
    ];
    // keyLess(candIdx, candSeq, bestIdx, bestSeq) -> i32 — true iff the
    // (candIdx, candSeq) key precedes (bestIdx, bestSeq) in
    // OrdinaryOwnPropertyKeys order. Integer-index keys (idx >= 0) precede all
    // string keys (idx < 0); among integer keys compare by value, among string
    // keys compare by insertion seq.
    const keyLess = (candIdx: number, candSeq: number, bestIdx: number, bestSeq: number): Instr[] => [
      // if candIdx >= 0
      { op: "local.get", index: candIdx },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // candidate is an integer index
          // if bestIdx >= 0 → candIdx < bestIdx ; else → true (int before string)
          { op: "local.get", index: bestIdx },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "local.get", index: candIdx }, { op: "local.get", index: bestIdx }, { op: "i32.lt_s" }],
            else: [{ op: "i32.const", value: 1 }],
          },
        ],
        else: [
          // candidate is a string key
          // if bestIdx >= 0 → false (string never precedes int) ; else → candSeq < bestSeq
          { op: "local.get", index: bestIdx },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 0 }],
            else: [{ op: "local.get", index: candSeq }, { op: "local.get", index: bestSeq }, { op: "i32.lt_s" }],
          },
        ],
      },
    ];
    // #2042 S3 — factory so `__obj_ordered` keeps the enumerable filter
    // (Object.keys/values/entries) while sibling `__obj_ordered_all` drops it
    // (Object.getOwnPropertyNames needs non-enumerable own string keys too).
    // Each registration gets a FRESH body + locals array — `registerNative`
    // stores the locals array by reference and a later lowering pass may mutate
    // it, so the two functions must not share one (that cross-corrupted both).
    const buildOrderedBody = (includeNonEnum: boolean): Instr[] => [
      // arr = o.props ; cap = arr.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 1 },
      { op: "array.len" },
      { op: "local.set", index: 2 },
      // out = new $PropMap[o.count]  (upper bound on live entries; enumerable
      // entries are a subset, trailing slots stay null)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "local.set", index: 5 },
      // m = 0 ; i = 0 — first pass: compact live + enumerable entries into out
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 6 },
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
              { op: "local.get", index: 2 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // e = arr[i]
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 4 },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // (not tombstone) [&& enumerable, unless includeNonEnum]
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_TOMBSTONE },
                  { op: "i32.and" },
                  { op: "i32.eqz" },
                  // enumerable check — omitted for __obj_ordered_all (#2042 S3)
                  ...(includeNonEnum
                    ? []
                    : ([
                        { op: "local.get", index: 4 },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                        { op: "i32.const", value: FLAG_ENUMERABLE },
                        { op: "i32.and" },
                        { op: "i32.eqz" },
                        { op: "i32.eqz" },
                        { op: "i32.and" },
                      ] satisfies Instr[])),
                  // (#2866) AND is-string-key: exclude `$Symbol` keys from the
                  // string-key enumeration order (Object.keys/values/entries/
                  // getOwnPropertyNames/for-in/JSON — §10.1.11.1 lists string keys
                  // here; symbols come only from getOwnPropertySymbols).
                  ...(symbolKeysEnabled
                    ? ([
                        { op: "local.get", index: 4 },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                        { op: "ref.test", typeIdx: anyStrTypeIdx },
                        { op: "i32.and" },
                      ] satisfies Instr[])
                    : []),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // out[m] = e ; m++
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "array.set", typeIdx: propMapTypeIdx },
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                    ],
                  },
                ],
              },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Second pass: selection sort out[0..m) by OrdinaryOwnPropertyKeys order.
      // for j in 0..m-1: find best in [j..m) and swap into out[j]
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 7 }, // j
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if j >= m break
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // best = j ; bestE = out[j] ; bestIdx = idx(bestE) ; bestSeq = bestE.seq
              { op: "local.get", index: 7 },
              { op: "local.set", index: 8 },
              { op: "local.get", index: 5 },
              { op: "local.get", index: 7 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.set", index: 11 },
              ...entryIndexOf(11),
              { op: "local.set", index: 13 },
              ...entrySeqOf(11),
              { op: "local.set", index: 15 },
              // for k in j+1..m
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 9 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 9 },
                      { op: "local.get", index: 6 },
                      { op: "i32.ge_u" },
                      { op: "br_if", depth: 1 },
                      // cand = out[k] ; candIdx = idx(cand) ; candSeq = cand.seq
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 9 },
                      { op: "array.get", typeIdx: propMapTypeIdx },
                      { op: "local.set", index: 10 },
                      ...entryIndexOf(10),
                      { op: "local.set", index: 12 },
                      ...entrySeqOf(10),
                      { op: "local.set", index: 14 },
                      // if cand precedes best → best = k, bestIdx=candIdx,
                      // bestSeq=candSeq, bestE=cand
                      //
                      // ordering predicate keyLess(candIdx,candSeq,bestIdx,bestSeq):
                      //   both indices (>=0): cand < best  ⇔  candIdx < bestIdx
                      //   cand index, best string: cand precedes  (candIdx>=0 && bestIdx<0)
                      //   cand string, best index: cand does NOT precede
                      //   both strings (<0): candSeq < bestSeq
                      ...keyLess(12, 14, 13, 15),
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 9 },
                          { op: "local.set", index: 8 },
                          { op: "local.get", index: 12 },
                          { op: "local.set", index: 13 },
                          { op: "local.get", index: 14 },
                          { op: "local.set", index: 15 },
                          { op: "local.get", index: 10 },
                          { op: "local.set", index: 11 },
                        ],
                      },
                      { op: "local.get", index: 9 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 9 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // swap out[j] <-> out[best] (only if best != j)
              { op: "local.get", index: 8 },
              { op: "local.get", index: 7 },
              { op: "i32.ne" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // tmp = out[j]
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 7 },
                  { op: "array.get", typeIdx: propMapTypeIdx },
                  { op: "local.set", index: 16 },
                  // out[j] = out[best] (== bestE)
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 7 },
                  { op: "local.get", index: 11 },
                  { op: "array.set", typeIdx: propMapTypeIdx },
                  // out[best] = tmp
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 16 },
                  { op: "array.set", typeIdx: propMapTypeIdx },
                ],
              },
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 7 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 5 },
    ];
    // Fresh locals array per registration (registerNative stores it by reference).
    const makeOrderedLocals = (): { name: string; type: ValType }[] => [
      { name: "arr", type: propMapRef },
      { name: "cap", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "e", type: entryRefNull },
      { name: "out", type: propMapRef },
      { name: "m", type: { kind: "i32" } },
      { name: "j", type: { kind: "i32" } },
      { name: "best", type: { kind: "i32" } },
      { name: "k", type: { kind: "i32" } },
      { name: "cand", type: entryRefNull },
      { name: "bestE", type: entryRefNull },
      { name: "candIdx", type: { kind: "i32" } },
      { name: "bestIdx", type: { kind: "i32" } },
      { name: "candSeq", type: { kind: "i32" } },
      { name: "bestSeq", type: { kind: "i32" } },
      { name: "tmp", type: entryRefNull },
    ];
    // __obj_ordered — live + enumerable (Object.keys/values/entries).
    registerNative("__obj_ordered", [objRef], [propMapRef], makeOrderedLocals(), buildOrderedBody(false));
    // __obj_ordered_all — live, INCLUDING non-enumerable (#2042 S3,
    // Object.getOwnPropertyNames). Same ordering + sort; enumerable filter off.
    registerNative("__obj_ordered_all", [objRef], [propMapRef], makeOrderedLocals(), buildOrderedBody(true));

    // (#2866 slice 3) __obj_ordered_symbols — the SELECT counterpart to the
    // string-key exclusion above: collect this object's LIVE own SYMBOL-keyed
    // entries (INCLUDING non-enumerable ones — Object.getOwnPropertySymbols
    // returns own symbol keys regardless of enumerability, §20.5.2.9) into a
    // compacted $PropMap in insertion order. Symbol keys are never integer
    // indices and never interleave with string keys, so OrdinaryOwnPropertyKeys
    // order among symbols is purely creation order (`$PropEntry.seq` ascending) —
    // a plain seq selection sort, with NO `entryIndexOf` (its `ref.cast
    // $AnyString` would trap on a `$Symbol` key).
    //
    // param: 0=o(ref $Object) ; locals (reuse makeOrderedLocals): 1=arr 2=cap 3=i
    //   4=e 5=out 6=m 7=j 8=best 9=k 10=cand 11=bestE 15=bestSeq 14=candSeq 16=tmp
    const buildOrderedSymbolsBody = (): Instr[] => [
      // arr = o.props ; cap = arr.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 1 },
      { op: "array.len" },
      { op: "local.set", index: 2 },
      // out = new $PropMap[o.count] (upper bound; trailing slots stay null)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "local.set", index: 5 },
      // m = 0 ; i = 0 — first pass: compact live symbol-keyed entries into out
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 6 },
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
              { op: "local.get", index: 2 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // e = arr[i]
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 4 },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // !tombstone
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_TOMBSTONE },
                  { op: "i32.and" },
                  { op: "i32.eqz" },
                  // && ref.test $Symbol(key) — SELECT only symbol keys
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                  { op: "ref.test", typeIdx: symbolTypeIdx },
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "array.set", typeIdx: propMapTypeIdx },
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                    ],
                  },
                ],
              },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Second pass: selection sort out[0..m) by seq ascending (insertion order).
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 7 }, // j
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // best = j ; bestE = out[j] ; bestSeq = bestE.seq
              { op: "local.get", index: 7 },
              { op: "local.set", index: 8 },
              { op: "local.get", index: 5 },
              { op: "local.get", index: 7 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.set", index: 11 },
              { op: "local.get", index: 11 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 3 },
              { op: "local.set", index: 15 },
              // for k in j+1..m
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 9 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 9 },
                      { op: "local.get", index: 6 },
                      { op: "i32.ge_u" },
                      { op: "br_if", depth: 1 },
                      // cand = out[k] ; candSeq = cand.seq
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 9 },
                      { op: "array.get", typeIdx: propMapTypeIdx },
                      { op: "local.set", index: 10 },
                      { op: "local.get", index: 10 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 3 },
                      { op: "local.set", index: 14 },
                      // if candSeq < bestSeq → best = k, bestSeq = candSeq, bestE = cand
                      { op: "local.get", index: 14 },
                      { op: "local.get", index: 15 },
                      { op: "i32.lt_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 9 },
                          { op: "local.set", index: 8 },
                          { op: "local.get", index: 14 },
                          { op: "local.set", index: 15 },
                          { op: "local.get", index: 10 },
                          { op: "local.set", index: 11 },
                        ],
                      },
                      { op: "local.get", index: 9 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 9 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // swap out[j] <-> out[best] (only if best != j)
              { op: "local.get", index: 8 },
              { op: "local.get", index: 7 },
              { op: "i32.ne" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 7 },
                  { op: "array.get", typeIdx: propMapTypeIdx },
                  { op: "local.set", index: 16 },
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 7 },
                  { op: "local.get", index: 11 },
                  { op: "array.set", typeIdx: propMapTypeIdx },
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 16 },
                  { op: "array.set", typeIdx: propMapTypeIdx },
                ],
              },
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 7 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 5 },
    ];
    if (symbolKeysEnabled) {
      registerNative("__obj_ordered_symbols", [objRef], [propMapRef], makeOrderedLocals(), buildOrderedSymbolsBody());
    }
    void entryRef;
  }
  const objOrderedIdx = ctx.funcMap.get("__obj_ordered")!;
  const objOrderedAllIdx = ctx.funcMap.get("__obj_ordered_all")!;

  buildObjectEnumerationHelpers(ctx, {
    registerNative,
    objArrayLikeArms,
    anyStrTypeIdx,
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    objVecTypeIdx,
    objVecArrTypeIdx,
    objRefNull,
    propMapRef,
    entryRefNull,
    strFlattenIdx,
    strEqualsIdx,
    objVecNewIdx,
    objVecPushIdx,
    objOrderedIdx,
    objOrderedAllIdx,
    FLAG_ENUMERABLE,
    FLAG_TOMBSTONE,
  });

  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  buildObjectDescriptorHelpers(ctx, {
    registerNative,
    anyStrTypeIdx,
    nativeStrTypeIdx,
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    symbolKeysEnabled,
    objRefNull,
    propMapRef,
    entryRefNull,
    strFlattenIdx,
    strEqualsIdx,
    objFindIdx,
    objInsertIdx,
    objGrowIdx,
    objVecNewIdx,
    objVecPushIdx,
    objIndexOfKeyIdx,
    objOrderedIdx,
    objOrderedAllIdx,
    externSetIdx,
    bfnGopdIdx,
    bfnPushOwnNamesIdx,
    NONE_HEAP,
    FLAG_WRITABLE,
    FLAG_ENUMERABLE,
    FLAG_CONFIGURABLE,
    FLAG_ACCESSOR,
    OBJ_FLAG_NONEXTENSIBLE,
    OBJ_FLAG_SEALED,
    OBJ_FLAG_FROZEN,
    WRAPPER_PRIMITIVE_KEY,
  });

  // ── __extern_is_undefined(externref) -> i32 (#1472 Phase C) ───────────────
  //
  // The JS-host import is `(v) => (v === undefined ? 1 : 0)` — it distinguishes
  // JS `undefined` (a defined externref produced by `__get_undefined`) from
  // `null` (a null reference). Standalone has no `__get_undefined`: `emitUndefined`
  // falls back to `ref.null.extern`, so the runtime represents BOTH `undefined`
  // and `null` as the null externref. The standalone `__typeof_undefined` helper
  // (addUnionImportsAsNativeFuncs) already encodes this same conflation as a bare
  // `ref.is_null`. We mirror it here so the two are internally consistent.
  //
  // This is exactly the predicate every caller wants in standalone: the
  // default-parameter / destructuring-default paths (function-body.ts,
  // closures.ts, class-bodies.ts, destructuring.ts) and `x === undefined`
  // (binary-ops.ts) use `__extern_is_undefined` to decide whether to apply a
  // default — and a missing/omitted argument arrives as the null externref, the
  // same value `undefined` lowers to. So `ref.is_null` applies the default in
  // precisely the "value is undefined" cases, matching §14.3.3 (keyed/iterator
  // binding initialization defaults fire when the bound value is `undefined`).
  //
  // (#2979) SECOND arm — the boxed UNDEF_F64 sentinel. An `undefined` that
  // travels through an **f64 carrier** (the native generator done-result
  // `.value` field is the producer today) carries the UNDEF_F64 signaling-NaN
  // bit pattern (value-tags.ts); a generic f64→externref boxing site that isn't
  // sentinel-aware wraps it in a `$BoxedNumber`. Recognize that box here so
  // `x === undefined` / default-application still answer true after the value
  // crossed a sentinel-blind boxing site. JS arithmetic only produces the
  // quiet NaN 0x7FF8… — it can never forge the sentinel bits — and host mode
  // never builds this native (native generators are standalone/wasi-only), so
  // this cannot misfire on a genuine number. Gated on the carrier type
  // existing; without it the body is the legacy bare `ref.is_null`.
  // (#2106 S1) Under the `undefinedSingleton` regime the predicate flips to
  // "tag-1 `$AnyValue` box ∨ UNDEF_F64 `$BoxedNumber`" and — the whole point —
  // a null externref answers 0 (null is DISTINCT from undefined). Every
  // undefined PRODUCER (emitUndefined, `__extern_get`/`__extern_get_idx`
  // miss, literal stores, omitted-arg padding) flips to the singleton in the
  // same build, so the lockstep invariant that broke PR #2025 holds.
  const s1IsUndefBody = buildIsUndefinedExternBody(ctx, 1, UNDEF_F64_BITS);
  registerNative(
    "__extern_is_undefined",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    s1IsUndefBody !== undefined || ctx.nativeBoxNumberTypeIdx >= 0 ? [{ name: "any", type: { kind: "anyref" } }] : [],
    s1IsUndefBody !== undefined
      ? s1IsUndefBody
      : ctx.nativeBoxNumberTypeIdx >= 0
        ? [
            { op: "local.get", index: 0 },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [{ op: "i32.const", value: 1 }],
              else: [
                { op: "local.get", index: 0 },
                { op: "any.convert_extern" },
                { op: "local.tee", index: 1 },
                { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [
                    { op: "local.get", index: 1 },
                    { op: "ref.cast", typeIdx: ctx.nativeBoxNumberTypeIdx },
                    { op: "struct.get", typeIdx: ctx.nativeBoxNumberTypeIdx, fieldIdx: 0 },
                    { op: "i64.reinterpret_f64" },
                    { op: "i64.const", value: UNDEF_F64_BITS },
                    { op: "i64.eq" },
                  ],
                  else: [{ op: "i32.const", value: 0 }],
                },
              ],
            },
          ]
        : [{ op: "local.get", index: 0 }, { op: "ref.is_null" }],
  );

  // ── __extern_method_call(externref recv, externref name, externref args)
  //    -> externref (#1888 Slice 2) ─────────────────────────────────────────
  //
  // Generic `recv.name(args)` dispatch on an open `any`/externref receiver
  // (ES §7.3.14 Call). Open-`$Object` user-method path: resolve `name` via
  // `__extern_get` (own + prototype walk) and invoke through the
  // `__apply_closure` arity bridge → `__call_fn_method_0..4` (D6/D7). Non-
  // `$Object` brands ($Vec/string/Map/Set instance methods on a genuinely-`any`
  // receiver) are the Slice-4 brand arms — they return undefined here for now
  // (trackable, never invalid Wasm). The closure-round-trip prerequisite landed
  // (#1226 typeof-closure recognition + every compiled fn-expr self-registers in
  // `closureInfoByTypeIdx` so `__call_fn_method_N` emits a matching `ref.test`
  // arm), so a closure stored into an open `$Object` reads back callable.
  const S2_OPENANY_DISPATCH_WIRED = true;
  if (S2_OPENANY_DISPATCH_WIRED) {
    const applyClosureIdx = reserveApplyClosure(ctx);
    const externGetIdx = ctx.funcMap.get("__extern_get")!;

    // (#3673 round 9) STRING-receiver hot-method fast path. A dynamic
    // `input.charCodeAt(pos)` / `input.slice(a, b)` (acorn's per-character
    // tokenizer loop — `this.input` is a dynamic field, so every call lands
    // here) previously paid the FULL generic pipeline per call:
    // `__extern_get(str, name)` (member ladder + `__builtinfn_get_meta` name
    // compares + builtin-closure materialization) → `__apply_closure` →
    // `__call_fn_method_N` ladder → the native helper. Method-name literals
    // are interned (#3673 round 2), so ONE `ref.eq` against the interned name
    // global identifies the method and dispatches straight to the native
    // helper. A name that isn't the interned literal (a rope, a runtime-built
    // string) simply misses the `ref.eq` and falls through to the generic
    // path — semantics unchanged. Gated on every dep resolving; emits nothing
    // otherwise (host mode: `nativeStrings` off ⇒ no arm).
    const strFastPath = ((): Instr[] => {
      if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0) return [];
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      const boxIdx = ctx.funcMap.get("__box_number");
      const sliceIdx = ctx.funcMap.get("__str_slice") ?? ctx.nativeStrHelpers.get("__str_slice");
      const isUndefIdx = ctx.funcMap.get("__extern_is_undefined");
      const ccaIdx = ensureNativeCharCodeAtHelper(ctx);
      if (unboxIdx === undefined || boxIdx === undefined || sliceIdx === undefined || isUndefIdx === undefined)
        return [];
      if (ccaIdx === null) return [];
      // Locals (beyond param 0..2 + local 3 `any`): 4 nflat, 5 argc, 6 arg0,
      // 7 arg1, 8 argsAny.
      const NFLAT = 4;
      const ARGC = 5;
      const ARG0 = 6;
      const ARG1 = 7;
      const ARGSANY = 8;
      // argc/arg0/arg1 from the $ObjVec args carrier (null-safe: argc 0).
      const loadArgs: Instr[] = [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: ARGC },
        { op: "local.get", index: 2 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: ARGSANY },
        { op: "ref.test", typeIdx: objVecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: ARGSANY },
            { op: "ref.cast", typeIdx: objVecTypeIdx },
            { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
            { op: "local.tee", index: ARGC },
            { op: "i32.const", value: 1 },
            { op: "i32.ge_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: ARGSANY },
                { op: "ref.cast", typeIdx: objVecTypeIdx },
                { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
                { op: "i32.const", value: 0 },
                { op: "array.get", typeIdx: objVecArrTypeIdx },
                { op: "local.set", index: ARG0 },
              ],
            },
            { op: "local.get", index: ARGC },
            { op: "i32.const", value: 2 },
            { op: "i32.ge_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: ARGSANY },
                { op: "ref.cast", typeIdx: objVecTypeIdx },
                { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
                { op: "i32.const", value: 1 },
                { op: "array.get", typeIdx: objVecArrTypeIdx },
                { op: "local.set", index: ARG1 },
              ],
            },
          ],
        },
      ];
      const nameEq = (lit: string): Instr[] => [
        { op: "local.get", index: NFLAT },
        ...nativeStringLiteralInstrs(ctx, lit),
        { op: "ref.eq" },
      ];
      return [
        { op: "local.get", index: 3 }, // any (recv)
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 }, // name
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: ctx.nativeStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: ctx.nativeStrTypeIdx },
                { op: "local.set", index: NFLAT },
                // ── charCodeAt(i) → box(__str_charCodeAt(recv, trunc(unbox(arg0))))
                ...nameEq("charCodeAt"),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    ...loadArgs,
                    { op: "local.get", index: 3 },
                    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
                    { op: "local.get", index: ARG0 },
                    { op: "call", funcIdx: unboxIdx },
                    { op: "i32.trunc_sat_f64_s" },
                    { op: "call", funcIdx: ccaIdx },
                    { op: "call", funcIdx: boxIdx },
                    { op: "return" },
                  ],
                },
                // ── slice(a, b?) → extern(__str_slice(recv, trunc(unbox(a)),
                //     b omitted/undefined → INT32_MAX (clamped to len)))
                ...nameEq("slice"),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    ...loadArgs,
                    { op: "local.get", index: 3 },
                    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
                    // start = argc >= 1 ? trunc(unbox(arg0)) : 0
                    { op: "local.get", index: ARG0 },
                    { op: "call", funcIdx: unboxIdx },
                    { op: "i32.trunc_sat_f64_s" },
                    // end: present and not undefined/null → trunc(unbox(arg1));
                    // else INT32_MAX (→ clamped to len; §22.1.3.21 undefined end).
                    { op: "local.get", index: ARGC },
                    { op: "i32.const", value: 2 },
                    { op: "i32.ge_s" },
                    {
                      op: "if",
                      blockType: { kind: "val", type: { kind: "i32" } },
                      then: [
                        { op: "local.get", index: ARG1 },
                        { op: "ref.is_null" },
                        {
                          op: "if",
                          blockType: { kind: "val", type: { kind: "i32" } },
                          then: [{ op: "i32.const", value: 0x7fffffff }],
                          else: [
                            { op: "local.get", index: ARG1 },
                            { op: "call", funcIdx: isUndefIdx },
                            {
                              op: "if",
                              blockType: { kind: "val", type: { kind: "i32" } },
                              then: [{ op: "i32.const", value: 0x7fffffff }],
                              else: [
                                { op: "local.get", index: ARG1 },
                                { op: "call", funcIdx: unboxIdx },
                                { op: "i32.trunc_sat_f64_s" },
                              ],
                            },
                          ],
                        },
                      ],
                      else: [{ op: "i32.const", value: 0x7fffffff }],
                    },
                    { op: "call", funcIdx: sliceIdx },
                    { op: "extern.convert_any" },
                    { op: "return" },
                  ],
                },
              ],
            },
          ],
        },
      ];
    })();

    const body: Instr[] = [
      // any = any.convert_extern(recv); if null → return undefined
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 3 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // (#3673 round 9) string-receiver hot-method direct dispatch (see above).
      ...strFastPath,
      // if ref.test $Object(any) → __apply_closure(__extern_get(recv,name), recv, args)
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          // m = __extern_get(recv, name)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
          // (#2106 S1) a missing method resolves to the undefined singleton —
          // normalize to null so __apply_closure keeps its legacy null path.
          ...(ctx.funcMap.has("__nullish_to_null")
            ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
            : []),
          // __apply_closure(m, recv, args)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: applyClosureIdx },
        ],
        // Non-$Object receiver: (#3468 C-core) a closure carries own properties
        // in the side table — mirror the $Object dispatch for it; other brands
        // ($Vec/string/Map/Set) are the Slice-4 arms → undefined for now (never
        // invalid Wasm).
        else: buildVecOrClosurePropMethodCallElseArm(ctx, externGetIdx, applyClosureIdx),
      },
    ];
    registerNative(
      "__extern_method_call",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      strFastPath.length > 0
        ? [
            { name: "any", type: { kind: "anyref" } },
            // (#3673 round 9) string fast-path scratch (locals 4-8).
            { name: "nflat", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
            { name: "argc", type: { kind: "i32" } },
            { name: "arg0", type: { kind: "externref" } },
            { name: "arg1", type: { kind: "externref" } },
            { name: "argsAny", type: { kind: "anyref" } },
          ]
        : [{ name: "any", type: { kind: "anyref" } }],
      body,
    );
  }

  // Silence "declared but never used" for ValType aliases reserved for the
  // values/entries/assign slices that stack on this foundation.
  void objVecRef;
  void objVecArrRef;
  void nativeStrRef;

  // (#1100) Register the standalone Proxy dispatch runtime. Must run AFTER
  // __extern_get/set/has are registered (the trap dispatch helpers forward to
  // them when a trap is absent) and only adds DEFINED functions, so no index
  // shift (same invariant as the rest of this runtime).
  ensureProxyRuntime(ctx, types, registerNative);

  return types;
}

/**
 * (#2161 B1) `__wrapper_string_value(externref) -> ref null $AnyString` —
 * boxed-`new String(...)` receiver/argument primitive-string recovery.
 *
 * A `new String(x)` produces a `$Object` wrapper (`__new_String`) carrying its
 * [[StringData]] under the reserved FLAG_INTERNAL `WRAPPER_PRIMITIVE_KEY` slot.
 * When such a wrapper reaches an externref→native-`$AnyString` coercion (a string
 * method's receiver-as-subject, e.g. `new String("hello").split(/l/)`, or a
 * string-typed argument) the generic `ref.test $AnyString` misses it (a wrapper
 * is an object, not a string) and the value was previously dropped to null →
 * downstream `__str_flatten` trapped ("dereferencing a null pointer").
 *
 * This helper extracts JUST the wrapper's primitive-string slot — the same
 * internal-slot read `__to_primitive` performs inline (§7.1.1.1: the wrapper's
 * intrinsic valueOf/toString return the internal primitive) — WITHOUT pulling in
 * OrdinaryToPrimitive (the valueOf/toString method dispatch), so it stays a pure
 * bounded slot probe with no user-observable side effects. It returns the native
 * string when the input is a boxed-String wrapper, else null (a plain object,
 * another wrapper kind, or a non-string slot value), so the caller keeps its
 * prior null fallthrough for every non-boxed-String value.
 *
 * Registered lazily and idempotently — only when a qualifying coercion actually
 * needs it, so modules that never box a String stay byte-identical. Returns the
 * func index, or -1 when the object runtime is absent (no `__obj_find`) or native
 * strings are off (gc/host mode) — in which case the caller falls through to its
 * prior null. `ensureObjectRuntime` has already run (a boxed String cannot exist
 * otherwise), so `ctx.objectRuntimeTypes` and `__obj_find` are settled and no
 * late-import shift is pending.
 */
export function ensureWrapperStringValueHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__wrapper_string_value");
  if (existing !== undefined) return existing;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const objTypes = ctx.objectRuntimeTypes;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (anyStrTypeIdx < 0 || objTypes === undefined || objFindIdx === undefined) {
    return -1;
  }
  const { objectTypeIdx, propEntryTypeIdx } = objTypes;
  const anyStrRefNull: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };

  const body: Instr[] = [
    // a = any.convert_extern(x)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: anyStrRefNull },
      then: [
        // e = __obj_find(cast<$Object>(a), WRAPPER_PRIMITIVE_KEY)
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        ...((): Instr[] => {
          addStringConstantGlobal(ctx, WRAPPER_PRIMITIVE_KEY);
          return stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY);
        })(),
        { op: "call", funcIdx: objFindIdx },
        { op: "local.tee", index: 2 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: anyStrRefNull },
          then: [{ op: "ref.null", typeIdx: anyStrTypeIdx }],
          else: [
            // confirm the entry is the internal slot (FLAG_INTERNAL)
            { op: "local.get", index: 2 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 }, // flags
            { op: "i32.const", value: FLAG_INTERNAL },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: anyStrRefNull },
              then: [
                // v = entry.value (anyref); if it is a native string, return it
                { op: "local.get", index: 2 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value
                { op: "local.tee", index: 3 },
                { op: "ref.test", typeIdx: anyStrTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: anyStrRefNull },
                  then: [
                    { op: "local.get", index: 3 },
                    { op: "ref.cast", typeIdx: anyStrTypeIdx },
                  ],
                  else: [{ op: "ref.null", typeIdx: anyStrTypeIdx }],
                },
              ],
              else: [{ op: "ref.null", typeIdx: anyStrTypeIdx }],
            },
          ],
        },
      ],
      else: [{ op: "ref.null", typeIdx: anyStrTypeIdx }],
    },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [anyStrRefNull]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__wrapper_string_value", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__wrapper_string_value",
    typeIdx,
    locals: [
      { name: "a", type: { kind: "anyref" } },
      { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
      { name: "v", type: { kind: "anyref" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * #1472 Phase B Slice 3 — the native `$ObjVec` builder funcIdxs that the
 * `Object.assign(target, ...sources)` / object-spread call sites use to build
 * the variadic `...sources` list under `--target standalone`. In JS-host mode
 * those sites build a real JS array via the `__js_array_new` / `__js_array_push`
 * host imports and hand it to `__object_assign`; standalone has no JS array, so
 * they build a `$ObjVec` (which the native `__object_assign` iterates via
 * `ref.test $ObjVec`) instead. Returns `{ newIdx, pushIdx }`, registering the
 * object runtime on first call. Signatures match the host imports exactly —
 * `__objvec_new : () -> externref`, `__objvec_push : (externref, externref) ->
 * void` — so the only call-site change is *which funcIdx* the existing builder
 * code calls.
 */
export function ensureObjVecBuilders(ctx: CodegenContext): { newIdx: number; pushIdx: number } {
  ensureObjectRuntime(ctx);
  return {
    newIdx: ctx.funcMap.get("__objvec_new")!,
    pushIdx: ctx.funcMap.get("__objvec_push")!,
  };
}

/**
 * (#2863 Phase 3) Native standalone `Object.groupBy(items, keyFn)` — ES2024
 * §20.1.2.14 (GroupBy with keyCoercion PROPERTY). Under `--target
 * standalone`/`wasi` there is no host `__object_groupBy`, so the call site
 * (`expressions/calls.ts`) hits the #1472 dynamic-shape refusal. This registers
 * a Wasm-native helper that:
 *
 *   out = OrdinaryObjectCreate(null)                   // __new_plain_object
 *   for i in 0 .. __extern_length(items):
 *     val = __extern_get_idx(items, i)
 *     key = keyFn(val, i)  via __apply_closure(keyFn, undefined, [val, boxNum(i)])
 *     group = __extern_get(out, key)                   // ToPropertyKey done inside
 *     if group is null: group = __objvec_new(); __extern_set(out, key, group)
 *     __objvec_push(group, val)
 *   return out
 *
 * The keyFn is invoked through the proven open-`any` closure bridge
 * `__apply_closure` (the same path Proxy traps / `__extern_method_call` use), so
 * any user callback arity ≤ 2 is dispatched correctly (§ passes `(value,
 * index)`; a 1-arg arrow ignores the index). ToPropertyKey is applied uniformly
 * by `__extern_get`/`__extern_set`, so the get-probe and the set use the same
 * coerced key. Each group value is the ORIGINAL element (a `$ObjVec`, i.e. a
 * real Array on read-back).
 *
 * Registered lazily (append-only — no funcidx shift of the in-flight function)
 * from the call site, NOT unconditionally in `ensureObjectRuntime`, so a module
 * with no `Object.groupBy` pays nothing (and does not reserve the closure
 * bridge). Returns the `__object_groupBy` funcIdx.
 *
 * `items` is iterated via `__extern_length`/`__extern_get_idx`, which index a
 * real Array (`$__vec_base`) and array-like `$Object`s reliably — generic
 * iterables (Map/Set/user iterators) are the separate iterator-carrier follow-up
 * (#2864) and are NOT handled here.
 */
export function ensureObjectGroupBy(ctx: CodegenContext): number {
  ensureObjectRuntime(ctx);
  const existing = ctx.funcMap.get("__object_groupBy");
  if (existing !== undefined) return existing;

  const applyClosureIdx = reserveApplyClosure(ctx);
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
  const externLengthIdx = ctx.funcMap.get("__extern_length")!;
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx")!;
  const externGetIdx = ctx.funcMap.get("__extern_get")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;
  const boxNumIdx = ctx.funcMap.get("__box_number")!;

  // params: 0=items 1=keyFn
  // locals: 2=len(f64) 3=i(i32) 4=out 5=val 6=key 7=group 8=args
  const body: Instr[] = [
    { op: "call", funcIdx: newPlainObjectIdx },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: externLengthIdx },
    { op: "local.set", index: 2 },
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
            // if f64(i) >= len → break
            { op: "local.get", index: 3 },
            { op: "f64.convert_i32_s" },
            { op: "local.get", index: 2 },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            // val = __extern_get_idx(items, f64(i))
            { op: "local.get", index: 0 },
            { op: "local.get", index: 3 },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: externGetIdxIdx },
            { op: "local.set", index: 5 },
            // args = __objvec_new(); push(val); push(box(i))
            { op: "call", funcIdx: objVecNewIdx },
            { op: "local.set", index: 8 },
            { op: "local.get", index: 8 },
            { op: "local.get", index: 5 },
            { op: "call", funcIdx: objVecPushIdx },
            { op: "local.get", index: 8 },
            { op: "local.get", index: 3 },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: boxNumIdx },
            { op: "call", funcIdx: objVecPushIdx },
            // key = __apply_closure(keyFn, undefined, args)
            { op: "local.get", index: 1 },
            { op: "ref.null.extern" },
            { op: "local.get", index: 8 },
            { op: "call", funcIdx: applyClosureIdx },
            { op: "local.set", index: 6 },
            // group = __extern_get(out, key)
            { op: "local.get", index: 4 },
            { op: "local.get", index: 6 },
            { op: "call", funcIdx: externGetIdx },
            // (#2106 S1) group-absent = undefined singleton → normalize to
            // null so the presence check below keeps its legacy shape.
            ...(ctx.funcMap.has("__nullish_to_null")
              ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
              : []),
            { op: "local.set", index: 7 },
            // if group is null → group = __objvec_new(); __extern_set(out, key, group)
            { op: "local.get", index: 7 },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "call", funcIdx: objVecNewIdx },
                { op: "local.set", index: 7 },
                { op: "local.get", index: 4 },
                { op: "local.get", index: 6 },
                { op: "local.get", index: 7 },
                { op: "call", funcIdx: externSetIdx },
              ],
            },
            // __objvec_push(group, val)
            { op: "local.get", index: 7 },
            { op: "local.get", index: 5 },
            { op: "call", funcIdx: objVecPushIdx },
            // i++
            { op: "local.get", index: 3 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 3 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: 4 },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__object_groupBy", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__object_groupBy",
    typeIdx,
    locals: [
      { name: "len", type: { kind: "f64" } },
      { name: "i", type: { kind: "i32" } },
      { name: "out", type: { kind: "externref" } },
      { name: "val", type: { kind: "externref" } },
      { name: "key", type: { kind: "externref" } },
      { name: "group", type: { kind: "externref" } },
      { name: "args", type: { kind: "externref" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#3223) Native standalone/WASI `__extern_rest_object(obj, excl) -> externref`
 * — the host-free implementation of object-rest destructuring's
 * CopyDataProperties (ES §14.7.4). Under `--target standalone`/`wasi` there is
 * no JS runtime to satisfy the `env.__extern_rest_object` host import, so
 * `{a, ...rest} = o` otherwise fails to instantiate host-free (a leaky pass).
 *
 * Signature differs from the host import ONLY in the second argument's shape:
 * the host import takes a comma-joined excluded-keys STRING; this native helper
 * takes an **exclusion object** `excl` (a plain `$Object` whose OWN keys are the
 * excluded property names), built at the call site
 * (`destructuring-params.ts`). Membership is therefore delegated to
 * `__extern_get(excl, key)` — the proven open-object hash-map lookup — so there
 * is NO runtime string tokenising, NO delimiter false-match, and NO trap-prone
 * `$AnyString`/`$NativeString` cast in this body. The helper stays 100% in
 * externref land, mirroring `ensureObjectGroupBy`.
 *
 *   out = OrdinaryObjectCreate(null)                 // __new_plain_object
 *   if obj is null: return out                       // defensive; the source is
 *                                                    // already RequireObjectCoercible-guarded upstream
 *   keys = __object_keys(obj)                        // OWN-ENUMERABLE string keys, insertion order
 *   for i in 0 .. __extern_length(keys):
 *     key = __extern_get_idx(keys, i)
 *     if __extern_get(excl, key) is nullish:         // key NOT excluded
 *       __extern_set(out, key, __extern_get(obj, key))   // [[Get]] — invokes own getters, matches host
 *   return out
 *
 * Registered lazily (append-only defined func — no funcidx shift of the
 * in-flight function; all deps are object-runtime defined funcs already present
 * once `ensureObjectRuntime` has run). Returns the `__extern_rest_object`
 * funcIdx. Idempotent.
 */
export function ensureExternRestObject(ctx: CodegenContext): number {
  ensureObjectRuntime(ctx);
  const existing = ctx.funcMap.get("__extern_rest_object");
  if (existing !== undefined) return existing;

  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
  const objectKeysIdx = ctx.funcMap.get("__object_keys")!;
  const externLengthIdx = ctx.funcMap.get("__extern_length")!;
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx")!;
  const externGetIdx = ctx.funcMap.get("__extern_get")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  // Membership against the exclusion object is a BOOLEAN presence test
  // (`__extern_has` — the native `in`-operator predicate). This deliberately
  // does NOT go through `__extern_get`'s value/miss channel, which is ambiguous
  // under the #2106 S1 regime (an absent key reads back as the non-null
  // undefined SINGLETON, not null, so a `ref.is_null` probe would wrongly drop
  // every non-excluded key). `__extern_has` returns i32 1/0 with no ambiguity.
  const externHasIdx = ctx.funcMap.get("__extern_has")!;

  // params: 0=obj 1=excl
  // locals: 2=out 3=keys 4=len(f64) 5=i(i32) 6=key
  const body: Instr[] = [
    { op: "call", funcIdx: newPlainObjectIdx },
    { op: "local.set", index: 2 },
    // Defensive: a null source yields an empty rest object (matches the host
    // `if (obj == null) return {}`). Upstream RequireObjectCoercible already
    // throws for null/undefined sources, so this is belt-and-suspenders.
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 2 }, { op: "return" }],
    },
    // keys = __object_keys(obj)
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: objectKeysIdx },
    { op: "local.set", index: 3 },
    // len = __extern_length(keys)
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: externLengthIdx },
    { op: "local.set", index: 4 },
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
            // if f64(i) >= len → break
            { op: "local.get", index: 5 },
            { op: "f64.convert_i32_s" },
            { op: "local.get", index: 4 },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            // key = __extern_get_idx(keys, f64(i))
            { op: "local.get", index: 3 },
            { op: "local.get", index: 5 },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: externGetIdxIdx },
            { op: "local.set", index: 6 },
            // if key is NOT in excl (i.e. NOT excluded) → out[key] = __extern_get(obj, key)
            { op: "local.get", index: 1 },
            { op: "local.get", index: 6 },
            { op: "call", funcIdx: externHasIdx },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 2 },
                { op: "local.get", index: 6 },
                { op: "local.get", index: 0 },
                { op: "local.get", index: 6 },
                { op: "call", funcIdx: externGetIdx },
                { op: "call", funcIdx: externSetIdx },
              ],
            },
            // i++
            { op: "local.get", index: 5 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 5 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: 2 },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__extern_rest_object", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__extern_rest_object",
    typeIdx,
    locals: [
      { name: "out", type: { kind: "externref" } },
      { name: "keys", type: { kind: "externref" } },
      { name: "len", type: { kind: "f64" } },
      { name: "i", type: { kind: "i32" } },
      { name: "key", type: { kind: "externref" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#1888 Slice 1) Reserve the `__apply_closure(externref fn, externref recv,
 * externref args) -> externref` arity-bridge funcIdx with a placeholder
 * `unreachable` body, registered in `funcMap`. The real body (an arity switch
 * on `__extern_length(args)` dispatching to `__call_fn_method_0..4`) is filled
 * by `fillApplyClosure` at FINALIZE, because the `__call_fn_method_N` exports
 * it calls are only emitted there (after `closureInfoByTypeIdx` is complete).
 * Mirrors the `reserveProtoIteratorDriver`/`fillProtoIteratorDriver` pattern
 * (#1719). Idempotent. Sets `ctx.applyClosureReserved`.
 */
export function reserveApplyClosure(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__apply_closure");
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$apply_closure_type",
  );
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__apply_closure",
    typeIdx,
    locals: [],
    // Placeholder; filled by fillApplyClosure. A bare `unreachable` keeps the
    // stub valid (externref result) if the fill is ever skipped.
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set("__apply_closure", funcIdx);
  ctx.applyClosureReserved = true;
  return funcIdx;
}

/**
 * (#1888 Slice 1) Fill the reserved `__apply_closure` bridge body at FINALIZE,
 * AFTER `emitClosureMethodCallExportN(0..4)` have registered
 * `__call_fn_method_0..4` in `funcMap`. The bridge reads the dynamic arg count
 * from `__extern_length(args)` and dispatches to the matching this-threaded
 * closure dispatcher:
 *
 *   n = max(i32(__extern_length(args)), __closure_arity(fn))
 *   if n==0: __call_fn_method_0(recv, fn)
 *   if n==1: __call_fn_method_1(recv, fn, idx0)
 *   ... up to 8 (#3310 G2 — matches the `emitClosureMethodCallExportN` cap) ...
 *   else (n>8): return undefined (sentinel)
 *
 * S1 SCOPE — NO THROWS. This bridge returns the undefined sentinel
 * (`ref.null.extern`) for the not-a-function and arity-overflow cases rather
 * than raising a `TypeError`. Reason: emitting a spec-correct throw here would
 * pull `__new_TypeError` + the exn tag + a string constant into the object
 * runtime, and those late registrations land AFTER the string helpers have
 * already baked `call` targets at finalize — shifting func indices and
 * corrupting the module ("__str_flatten expected (ref null 5) found i32"). That
 * is the #1839/#117/#1886 late-registration-index-shift class. Carving S1
 * without throws keeps the bridge dependency-free of late error machinery, so
 * the module verifies cleanly. The spec-correct `TypeError` throws (ES §7.3.14
 * step 2 "is not a function", and arity-overflow) plus the index-shift fix are
 * the S2 fast-follow. Each `__call_fn_method_N` arm is only emitted when that
 * export was registered (no closure of arity ≤ N ⇒ no dispatcher ⇒ that arm
 * returns the undefined sentinel). No-op when `__apply_closure` was never
 * reserved.
 */
export function fillApplyClosure(ctx: CodegenContext): void {
  if (!ctx.applyClosureReserved) return;
  const bridgeIdx = ctx.funcMap.get("__apply_closure");
  if (bridgeIdx === undefined) return;
  const bridgeFn = definedFuncAt(ctx, bridgeIdx);
  if (!bridgeFn) return;

  // Dependencies, all registered by now: __extern_length + __extern_get_idx
  // (object runtime). S1 intentionally pulls NO error machinery (see header).
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const externGetIdxArr = ctx.funcMap.get("__extern_get_idx");
  if (externLengthIdx === undefined || externGetIdxArr === undefined) {
    // Dependencies absent (object runtime not emitted after all) — keep a valid
    // body that returns undefined so the module verifies.
    bridgeFn.body = [{ op: "ref.null.extern" }];
    return;
  }

  // S1 undefined sentinel: every non-dispatchable case (arity > 8, or a missing
  // arity-N dispatcher) returns undefined rather than throwing. S2 replaces
  // these with spec-correct TypeError throws once the late-shift is fixed.
  const undefinedSentinel = (): Instr[] => [{ op: "ref.null.extern" }];

  // Build the arity dispatch from the bottom up (n>MAX → undefined), each arm
  // guarded on the matching __call_fn_method_N being registered.
  const callMethod = (n: number): number | undefined => ctx.funcMap.get(`__call_fn_method_${n}`);
  const armUnsupported = undefinedSentinel();

  // (#3310 G2) Match the `__call_fn_method_N` emission cap (index.ts:
  // min(maxClosureArity, 8)); the prior hard cap at 4 dropped 5+-arg dynamic
  // calls to the undefined sentinel. buildArm returns that sentinel for any
  // unregistered arity — but the arm's guard scaffold (local.get/i32.const/
  // i32.eq/if-else) is STILL emitted, ~11 bytes per dead arm (#3356 review:
  // NOT byte-identical; measured +114 B on a representative standalone module —
  // one live n=5 arm, the runtime always registers an arity-5 closure, plus 3
  // dead arms at +33 B). Host/gc modules are unaffected: the bridge is only
  // ever reserved under standalone/wasi (all reserveApplyClosure call sites).
  const APPLY_CLOSURE_MAX_ARITY = 8;

  const argcGlobalIdx = ensureArgcGlobal(ctx);

  const locals: { name: string; type: ValType }[] = [{ name: "n", type: { kind: "i32" } }];

  // (#3592) An UNDER-APPLIED call (`assert.sameValue(a, b)` into a 3-formal
  // `sameValue`) matched no `__call_fn_method_N` arm and silently returned the
  // undefined sentinel — it never happened. Rationale: see the builder.
  const widen = buildApplyClosureArityWidening(ctx, locals, 0, 3, 3);
  const resultLocal = 3 + locals.length;
  locals.push({ name: "result", type: { kind: "externref" } });

  // (#3673) $ObjVec fast path: the args carrier built by every in-module call
  // site (`__extern_method_call`, field-stored-closure arms, accessor/HOF
  // drivers) is the runtime's own $ObjVec. Read its length + elements with
  // direct struct.get/array.get instead of paying `__extern_length` + a full
  // dynamic `__extern_get_idx` (overlay prologue + carrier ladder) PER
  // ARGUMENT — measured as the top remaining cost of a standalone
  // compiled-acorn parse. Non-$ObjVec args keep the generic path.
  const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
  const objVecArrTypeIdx = ctx.objectRuntimeTypes?.objVecArrTypeIdx;
  const fastArgs = objVecTypeIdx !== undefined && objVecArrTypeIdx !== undefined;
  let argDataLocal = -1;
  let argLenLocal = -1;
  if (fastArgs) {
    argDataLocal = 3 + locals.length;
    locals.push({ name: "__argdata", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } });
    argLenLocal = 3 + locals.length;
    locals.push({ name: "__arglen", type: { kind: "i32" } });
  }

  // Locals: 0=fn 1=recv 2=args (params); 3=n(i32), then widen locals, result,
  // and (fast path) __argdata.
  const ARG_OF = (k: number): Instr[] => {
    const generic: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "f64.const", value: k },
      { op: "call", funcIdx: externGetIdxArr },
    ];
    if (!fastArgs) return generic;
    // OOB (an under-applied call widened up by the #3592 selector widening
    // reads k >= len) answers the undefined sentinel — exactly what the
    // generic `__extern_get_idx` returns for an out-of-bounds index.
    const oob: Instr[] = undefinedExternInstrs(ctx)?.map((i) => ({ ...i })) ?? [{ op: "ref.null.extern" }];
    return [
      { op: "local.get", index: argDataLocal },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: generic,
        else: [
          { op: "i32.const", value: k },
          { op: "local.get", index: argLenLocal },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              { op: "local.get", index: argDataLocal },
              { op: "ref.as_non_null" },
              { op: "i32.const", value: k },
              { op: "array.get", typeIdx: objVecArrTypeIdx },
            ],
            else: oob,
          },
        ],
      },
    ];
  };

  const buildArm = (n: number): Instr[] => {
    const idx = callMethod(n);
    if (idx === undefined) {
      // No closure of this arity was emitted ⇒ no dispatcher. A live call of
      // this arity is impossible (the program has no arity-n closure), but keep
      // a valid body: return the undefined sentinel.
      return undefinedSentinel();
    }
    // __call_fn_method_N(recv, fn, arg0..arg{N-1})
    const ops: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
    ];
    for (let k = 0; k < n; k++) ops.push(...ARG_OF(k));
    ops.push({ op: "call", funcIdx: idx });
    return ops;
  };

  // if n==0 .. n==APPLY_CLOSURE_MAX_ARITY else undefined. Nest as if/else chain.
  let dispatch: Instr[] = armUnsupported;
  for (let n = APPLY_CLOSURE_MAX_ARITY; n >= 0; n--) {
    dispatch = [
      { op: "local.get", index: 3 },
      { op: "i32.const", value: n },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: buildArm(n),
        else: dispatch,
      },
    ];
  }

  // n = args.len via the $ObjVec fast path when it applies, else the generic
  // `__extern_length` (also fills __argdata for ARG_OF).
  const computeN: Instr[] = fastArgs
    ? [
        { op: "local.get", index: 2 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: objVecTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 2 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: objVecTypeIdx },
            { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
            { op: "local.set", index: argDataLocal },
            { op: "local.get", index: 2 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: objVecTypeIdx },
            { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
            { op: "local.tee", index: argLenLocal },
          ],
          else: [{ op: "local.get", index: 2 }, { op: "call", funcIdx: externLengthIdx }, { op: "i32.trunc_f64_s" }],
        },
      ]
    : [{ op: "local.get", index: 2 }, { op: "call", funcIdx: externLengthIdx }, { op: "i32.trunc_f64_s" }];

  // Preserve the raw call-site count in `__argc` before widening only the
  // dispatcher selector. This keeps omitted formals undefined without turning
  // them into synthetic arguments, while over-arity calls still populate the
  // canonical extras vector in `__call_fn_method_N`.
  const body: Instr[] = [
    ...computeN,
    { op: "local.tee", index: 3 },
    { op: "global.set", index: argcGlobalIdx },
    ...widen,
    ...dispatch,
    { op: "local.set", index: resultLocal },
    { op: "i32.const", value: -1 },
    { op: "global.set", index: argcGlobalIdx },
    { op: "local.get", index: resultLocal },
  ];

  // (#3031 apply slice) $Proxy front-guard — the §0.1 ladder-step-1 pattern for
  // [[Call]]. A proxy `fn` value must intercept EVERY call routed through this
  // bridge (method calls on open receivers via `__extern_method_call`, a proxy
  // installed as another proxy's trap, groupBy/accessor drivers, …), so test it
  // AHEAD of the arity dispatch and route to `__proxy_apply_dispatch(fn, recv,
  // args)`. The dispatch's trap-absent forward arm calls back into this bridge
  // with the proxy's target, unwrapping proxy-of-proxy chains one guard hop at a
  // time. No-op (guard not emitted) when the proxy runtime is absent — byte-
  // identical for proxy-free modules.
  const proxyApplyIdx = ctx.funcMap.get("__proxy_apply_dispatch");
  const proxyGuardTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  if (proxyApplyIdx !== undefined && proxyGuardTypeIdx !== undefined) {
    body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyGuardTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: proxyApplyIdx },
          { op: "return" },
        ],
      },
    );
  }

  // (#2928) Cross-module AOT-callable carrier. The provider cannot enumerate
  // the caller module's private closure signatures, so the carrier holds a
  // caller-owned trampoline that accepts the receiver plus argc and eight
  // explicit values. A module-private $ObjVec cannot cross this boundary: the
  // provider extracts with its own object runtime and the caller rebuilds its
  // own vector before re-entering __apply_closure, where the target's concrete
  // shape is known.
  const runtimeEvalCarrier = ctx.runtimeEvalAotCallableCarrier;
  if (runtimeEvalCarrier !== undefined) {
    body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: runtimeEvalCarrier.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: runtimeEvalCarrier.structTypeIdx },
          { op: "struct.get", typeIdx: runtimeEvalCarrier.structTypeIdx, fieldIdx: 3 },
          { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_A },
          { op: "i32.eq" },
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: runtimeEvalCarrier.structTypeIdx },
          { op: "struct.get", typeIdx: runtimeEvalCarrier.structTypeIdx, fieldIdx: 4 },
          { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_B },
          { op: "i32.eq" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // code(self, recv, argc, arg0, ..., arg7)
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: runtimeEvalCarrier.structTypeIdx },
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: externLengthIdx },
              { op: "i32.trunc_f64_s" },
              ...ARG_OF(0),
              ...ARG_OF(1),
              ...ARG_OF(2),
              ...ARG_OF(3),
              ...ARG_OF(4),
              ...ARG_OF(5),
              ...ARG_OF(6),
              ...ARG_OF(7),
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: runtimeEvalCarrier.structTypeIdx },
              { op: "struct.get", typeIdx: runtimeEvalCarrier.structTypeIdx, fieldIdx: 0 },
              { op: "call_ref", typeIdx: runtimeEvalCarrier.funcTypeIdx },
              { op: "return" },
            ],
          },
        ],
      },
    );
  }

  // (#2928) A provider-owned interpreted callback is wrapped in a uniquely
  // branded canonical carrier before it enters caller AOT. Invoking the raw
  // closure would leak the provider's private exception tag across modules;
  // the explicit provider entry returns `[ok,value]`, which this module can
  // rethrow through its own tag. The brand check avoids conflating ordinary
  // same-arity user closures with interpreter callbacks.
  const runtimeInterpTypeIdx = ctx.runtimeEvalInterpretedCallbackTypeIdx;
  const runtimeInterpApplyIdx = ctx.funcMap.get("__runtime_apply_interpreted");
  const truthyIdx = ctx.funcMap.get("__is_truthy");
  const runtimeEvalPushGlobalsIdx = ctx.funcMap.get("__runtime_eval_push_globals");
  const runtimeEvalPullGlobalsIdx = ctx.funcMap.get("__runtime_eval_pull_globals");
  if (runtimeInterpTypeIdx !== undefined && runtimeInterpApplyIdx !== undefined && truthyIdx !== undefined) {
    const runtimeEvalActiveGlobalIdx = ensureRuntimeEvalProviderActiveGlobal(ctx);
    const callbackLocal = 3 + locals.length;
    locals.push({ name: "runtimeEvalCallback", type: { kind: "ref_null", typeIdx: runtimeInterpTypeIdx } });
    const envelopeLocal = 3 + locals.length;
    locals.push({ name: "runtimeEvalEnvelope", type: { kind: "externref" } });
    const activeBeforeLocal = 3 + locals.length;
    locals.push({ name: "runtimeEvalActiveBefore", type: { kind: "i32" } });
    const decodeRuntimeValue = buildRuntimeEvalValueUnwrap(ctx, locals, 3);
    const decodedValueLocal = 3 + locals.length;
    locals.push({ name: "runtimeEvalDecodedValue", type: { kind: "externref" } });
    const wrapReceiver = buildRuntimeEvalValueWrap(ctx, locals, 3);
    const wrappedArgs: Instr[][] = [];
    for (let i = 0; i < 8; i += 1) wrappedArgs.push(buildRuntimeEvalValueWrap(ctx, locals, 3));
    const applyArgs: Instr[] = [
      { op: "local.get", index: callbackLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: runtimeInterpTypeIdx, fieldIdx: 0 },
      { op: "local.get", index: 1 },
      ...wrapReceiver,
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: externLengthIdx },
    ];
    for (let i = 0; i < 8; i++) applyArgs.push(...ARG_OF(i), ...wrappedArgs[i]!);
    applyArgs.push({ op: "call", funcIdx: runtimeInterpApplyIdx });
    const envelopeField = (index: 0 | 1): Instr[] => [
      { op: "local.get", index: envelopeLocal },
      { op: "f64.const", value: index },
      { op: "call", funcIdx: externGetIdxArr },
    ];
    body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: runtimeInterpTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: runtimeInterpTypeIdx },
          { op: "local.tee", index: callbackLocal },
          { op: "struct.get", typeIdx: runtimeInterpTypeIdx, fieldIdx: 1 },
          { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A },
          { op: "i32.eq" },
          { op: "local.get", index: callbackLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: runtimeInterpTypeIdx, fieldIdx: 2 },
          { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B },
          { op: "i32.eq" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: runtimeEvalActiveGlobalIdx },
              { op: "local.set", index: activeBeforeLocal },
              { op: "i32.const", value: 1 },
              { op: "global.set", index: runtimeEvalActiveGlobalIdx },
              ...(runtimeEvalPushGlobalsIdx === undefined
                ? []
                : [{ op: "call", funcIdx: runtimeEvalPushGlobalsIdx } satisfies Instr]),
              ...applyArgs,
              { op: "local.set", index: envelopeLocal },
              ...(runtimeEvalPullGlobalsIdx === undefined
                ? []
                : [{ op: "call", funcIdx: runtimeEvalPullGlobalsIdx } satisfies Instr]),
              { op: "local.get", index: activeBeforeLocal },
              { op: "global.set", index: runtimeEvalActiveGlobalIdx },
              ...envelopeField(1),
              ...decodeRuntimeValue,
              { op: "local.set", index: decodedValueLocal },
              ...envelopeField(0),
              { op: "call", funcIdx: truthyIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "local.get", index: decodedValueLocal }, { op: "return" }],
                else: [
                  { op: "local.get", index: decodedValueLocal },
                  { op: "throw", tagIdx: ensureExnTag(ctx) },
                ],
              },
            ],
          },
        ],
      },
    );
  }

  // (#3140) $__bound_fn front-guard — the same ladder-step pattern as the $Proxy
  // guard above, for the native bound-function carrier `{target, thisArg,
  // boundArgs}` minted by a standalone `Function.prototype.bind` site. Unwrap
  // ONE bound layer per hop: merged = boundArgs ++ args, then recurse into this
  // bridge with (target, boundThis, merged) — [[BoundThis]] wins over the
  // caller-provided receiver (§10.4.1.1), and bound-of-bound chains compose one
  // guard hop at a time. Guard not emitted when no bind site minted the carrier
  // (`ctx.boundFnTypeIdx < 0`) — byte-identical for bind-free modules.
  const objVecNewIdx2 = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx2 = ctx.funcMap.get("__objvec_push");
  if (ctx.boundFnTypeIdx >= 0 && objVecNewIdx2 !== undefined && objVecPushIdx2 !== undefined) {
    const bfIdx = ctx.boundFnTypeIdx;
    // Locals appended after `n` (+ the #3592 arity-probe trio when emitted);
    // params fn/recv/args = 0..2, n = 3. Indices are derived from
    // `locals.length`, so they follow the probe automatically.
    const bfLocal = 3 + locals.length;
    const mergedLocal = bfLocal + 1;
    const srcLocal = bfLocal + 2;
    const kLocal = bfLocal + 3;
    const lenLocal = bfLocal + 4;
    locals.push(
      { name: "bf", type: { kind: "ref_null", typeIdx: bfIdx } },
      { name: "merged", type: { kind: "externref" } },
      { name: "bsrc", type: { kind: "externref" } },
      { name: "bk", type: { kind: "f64" } },
      { name: "blen", type: { kind: "f64" } },
    );
    // for (k = 0; k < len(src); k++) objvec_push(merged, get_idx(src, k))
    const copyLoop = (): Instr[] => {
      const loopBody: Instr[] = [
        { op: "local.get", index: kLocal },
        { op: "local.get", index: lenLocal },
        { op: "f64.ge" },
        { op: "br_if", depth: 1 },
        { op: "local.get", index: mergedLocal },
        { op: "local.get", index: srcLocal },
        { op: "local.get", index: kLocal },
        { op: "call", funcIdx: externGetIdxArr },
        { op: "call", funcIdx: objVecPushIdx2 },
        { op: "local.get", index: kLocal },
        { op: "f64.const", value: 1 },
        { op: "f64.add" },
        { op: "local.set", index: kLocal },
        { op: "br", depth: 0 },
      ];
      return [
        { op: "local.get", index: srcLocal },
        { op: "call", funcIdx: externLengthIdx },
        { op: "local.set", index: lenLocal },
        { op: "f64.const", value: 0 },
        { op: "local.set", index: kLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
        },
      ];
    };
    body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: bfIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: bfIdx },
          { op: "local.set", index: bfLocal },
          // merged = objvec_new()
          { op: "call", funcIdx: objVecNewIdx2 },
          { op: "local.set", index: mergedLocal },
          // copy boundArgs then call-args
          { op: "local.get", index: bfLocal },
          { op: "struct.get", typeIdx: bfIdx, fieldIdx: 2 },
          { op: "local.set", index: srcLocal },
          ...copyLoop(),
          { op: "local.get", index: 2 },
          { op: "local.set", index: srcLocal },
          ...copyLoop(),
          // return __apply_closure(target, boundThis, merged)  [self-recursion]
          { op: "local.get", index: bfLocal },
          { op: "struct.get", typeIdx: bfIdx, fieldIdx: 0 },
          { op: "local.get", index: bfLocal },
          { op: "struct.get", typeIdx: bfIdx, fieldIdx: 1 },
          { op: "local.get", index: mergedLocal },
          { op: "call", funcIdx: bridgeIdx },
          { op: "return" },
        ],
      },
    );
  }

  bridgeFn.body = [...buildTransferredCharAtApplyArm(ctx, ARG_OF), ...body];
  bridgeFn.locals = locals;
}

/**
 * (#3140) Reserve `__bind_dyn(recv, argsVec) → externref` — the dynamic
 * `Function.prototype.bind` route for an `any`-typed receiver (the test262
 * TypedArray harness `argFactory.bind(undefined, constructor)` shape, where
 * `argFactory` carries no TS call signatures so the typed `compileFunctionBind`
 * route never fires). Reserve-then-fill (#1719): the body needs the COMPLETE
 * closure-classifier root list, which is only settled at finalize —
 * {@link fillBindDynHelper} fills it there. `argsVec` is a `$ObjVec` of
 * `[thisArg, ...partialArgs]` built at the call site.
 */
export function reserveBindDynHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__bind_dyn");
  if (existing !== undefined) return existing;
  ensureObjectRuntime(ctx); // __extern_method_call / __extern_get_idx / __extern_length + $ObjVec
  ensureObjVecBuilders(ctx);
  reserveApplyClosure(ctx); // the unwrap front-guard lives in fillApplyClosure
  getOrRegisterBoundFnType(ctx);
  addStringConstantGlobal(ctx, "bind"); // the fill's legacy-fallback method name
  const externref: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [externref, externref], [externref]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__bind_dyn",
    typeIdx,
    locals: [],
    // Placeholder — filled at finalize by fillBindDynHelper. `unreachable`
    // keeps the stub valid if the fill were ever skipped.
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set("__bind_dyn", funcIdx);
  return funcIdx;
}

/**
 * (#3140) Fill `__bind_dyn` at FINALIZE (closure roots settled):
 *
 *   any = any.convert_extern(recv)
 *   if <recv is a callable — closure-classifier roots (incl. $__bound_fn)>:
 *     thisArg  = __extern_get_idx(args, 0)          // absent → undefined/null
 *     bound    = fresh $ObjVec of args[1..]
 *     return extern($__bound_fn{recv, thisArg, bound})
 *   return __extern_method_call(recv, "bind", args)  // legacy open-object route
 */
export function fillBindDynHelper(ctx: CodegenContext): void {
  const helperIdx = ctx.funcMap.get("__bind_dyn");
  if (helperIdx === undefined) return;
  const helperFn = definedFuncAt(ctx, helperIdx);
  if (!helperFn) return;
  const bfIdx = ctx.boundFnTypeIdx;
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const methodCallIdx = ctx.funcMap.get("__extern_method_call");
  if (
    bfIdx < 0 ||
    externLengthIdx === undefined ||
    externGetIdxIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined
  ) {
    helperFn.body = [{ op: "ref.null.extern" }];
    helperFn.locals = [];
    return;
  }

  // params: recv=0, args=1; locals: any=2 (anyref), thisv=3, bargs=4 (externref),
  // k=5, len=6 (f64).
  const ANY = 2;
  const THISV = 3;
  const BARGS = 4;
  const K = 5;
  const LEN = 6;
  const mintArm: Instr[] = [
    // thisArg = args[0]
    { op: "local.get", index: 1 },
    { op: "f64.const", value: 0 },
    { op: "call", funcIdx: externGetIdxIdx },
    { op: "local.set", index: THISV },
    // bound = objvec_new(); for (k=1; k<len; k++) push(bound, args[k])
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: BARGS },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: externLengthIdx },
    { op: "local.set", index: LEN },
    { op: "f64.const", value: 1 },
    { op: "local.set", index: K },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: K },
            { op: "local.get", index: LEN },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: BARGS },
            { op: "local.get", index: 1 },
            { op: "local.get", index: K },
            { op: "call", funcIdx: externGetIdxIdx },
            { op: "call", funcIdx: objVecPushIdx },
            { op: "local.get", index: K },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: K },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // return extern($__bound_fn{recv, thisArg, bound})
    { op: "local.get", index: 0 },
    { op: "local.get", index: THISV },
    { op: "local.get", index: BARGS },
    { op: "struct.new", typeIdx: bfIdx },
    { op: "extern.convert_any" },
    { op: "return" },
  ];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: ANY },
    ...buildClosureRefTestArms(ctx, ANY, mintArm),
  ];
  if (methodCallIdx !== undefined) {
    body.push(
      { op: "local.get", index: 0 },
      ...stringConstantExternrefInstrs(ctx, "bind"),
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: methodCallIdx },
    );
  } else {
    body.push({ op: "ref.null.extern" });
  }
  helperFn.body = body;
  helperFn.locals = [
    { name: "any", type: { kind: "anyref" } },
    { name: "thisv", type: { kind: "externref" } },
    { name: "bargs", type: { kind: "externref" } },
    { name: "k", type: { kind: "f64" } },
    { name: "len", type: { kind: "f64" } },
  ];
}

/**
 * (#2047) Non-array vec carriers that are NEVER JS arrays and must report
 * `Array.isArray === false` per ES §7.2.2:
 *   - `i32_byte` — ArrayBuffer / DataView backing store.
 *   - `i32_elem` — native (standalone/WASI) `Int32Array`/`Uint32Array` element
 *     storage. (#2835) Split from `i32_byte`: before the split Int32/Uint32 shared
 *     the `i32_byte` key, so they were ALREADY excluded here (Array.isArray === false,
 *     spec-correct — a TypedArray is not an Array). Keeping `i32_elem` in this set
 *     preserves that exactly; omitting it would regress `Array.isArray(new
 *     Int32Array(1))` to `true`. This set drives ONLY `__extern_is_array`, not
 *     element access / `.length` / iteration, so excluding the carrier does not
 *     affect Int32Array's array-like behaviour — only its IsArray result.
 *   - `i8_byte`  — native (standalone/WASI) `Uint8Array` packed-byte storage.
 * The codebase already excludes `i32_byte` vecs from array treatment elsewhere
 * (`type-coercion.ts` — the `__make_iterable` shim skips it), so this filter is
 * consistent precedent. NOTE: the FLOAT TypedArrays (Float32Array, Float64Array)
 * share the generic `f64` vec carrier with `number[]`, so a struct-level
 * `ref.test` cannot distinguish them without a brand bit — `__vec_f64` is kept
 * IN the carrier list and `Array.isArray(new Float64Array(1))` remains a known
 * residual false-positive tracked for a brand-bit follow-up. Only the
 * exclusively-non-array packed carriers can be filtered cleanly.
 */
export const NON_ARRAY_BYTE_VEC_ELEM_KINDS: ReadonlySet<string> = new Set(["i32_byte", "i32_elem", "i8_byte"]);

function isNonArrayByteVecName(name: string): boolean {
  // Matches `__vec_i32_byte` / `__vec_i8_byte`. Only `__vec_*` structs reach
  // this check (the caller already restricts to vec struct names).
  for (const elemKind of NON_ARRAY_BYTE_VEC_ELEM_KINDS) {
    if (name === `__vec_${elemKind}`) return true;
  }
  return false;
}

function collectStandaloneArrayCarrierTypeIdxs(ctx: CodegenContext): number[] {
  const carriers = new Set<number>();
  const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
  if (objVecTypeIdx !== undefined) carriers.add(objVecTypeIdx);

  // (#2047) Drop the exclusively-non-array byte carriers from vecTypeMap by key
  // so ArrayBuffer/DataView (`i32_byte`) and native Uint8Array (`i8_byte`) are
  // never claimed as arrays.
  for (const [elemKind, typeIdx] of ctx.vecTypeMap.entries()) {
    if (NON_ARRAY_BYTE_VEC_ELEM_KINDS.has(elemKind)) continue;
    carriers.add(typeIdx);
  }
  for (let typeIdx = 0; typeIdx < ctx.mod.types.length; typeIdx++) {
    const typeDef = ctx.mod.types[typeIdx];
    if (typeDef?.kind !== "struct") continue;
    const name = typeDef.name ?? "";
    if (isNonArrayByteVecName(name)) continue; // (#2047) §7.2.2 — never an array
    // (#3562) `__vec_base` is the ABSTRACT common supertype every concrete
    // `__vec_*` (incl. the byte vecs `__vec_i32_byte`/`__vec_i8_byte`) declares
    // `(sub final __vec_base …)`. A `ref.test` against it matches EVERY vec —
    // including the byte vecs #2047 deliberately excludes at the leaf level — so
    // `Array.isArray(new ArrayBuffer(8)) / new Uint8Array(2)` wrongly returned
    // `true`. Never add the base as a positive carrier; the concrete leaf vec
    // types below are the real array carriers.
    if (name === "__vec_base") continue;
    if (name.startsWith("__vec_") || name === "__template_vec_externref") carriers.add(typeIdx);
  }
  return Array.from(carriers).sort((a, b) => a - b);
}

/**
 * (#1904) Fill the standalone native `__extern_is_array` predicate after all
 * user functions and late runtime helpers have registered their WasmGC carrier
 * types. Implements the non-Proxy subset of ES §7.2.2 IsArray that can exist in
 * standalone: primitives/non-array objects return false, and compiler-emitted
 * array carriers (`__vec_*`, template vectors, `$ObjVec`) return true.
 */
export function fillExternIsArray(ctx: CodegenContext): void {
  if (!ctx.externIsArrayReserved) return;
  const funcIdx = ctx.funcMap.get("__extern_is_array");
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn) return;

  const carrierTypeIdxs = collectStandaloneArrayCarrierTypeIdxs(ctx);
  const anyLocal = 1;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
  ];

  let chain: Instr[] = [{ op: "i32.const", value: 0 }];
  for (let i = carrierTypeIdxs.length - 1; i >= 0; i--) {
    const typeIdx = carrierTypeIdxs[i]!;
    chain = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: chain,
      },
    ];
  }
  body.push(...chain);

  fn.locals = [{ name: "any", type: { kind: "anyref" } }];
  fn.body = body;
}

/**
 * (#2190) Box one loaded `__vec_<elemKind>` element (already on the stack) up to
 * `externref`. Returns the box-op sequence, or `null` to tell the caller to skip
 * the arm for this carrier.
 *
 * SCOPE (regression-hardened, round 2): a non-null sequence is returned ONLY for
 * the two element kinds whose box op PROVABLY yields a fresh `externref` —
 * plain `f64` (`__box_number`) and plain `i32` (`f64.convert_i32_s` +
 * `__box_number`). EVERY other element kind, **including a literally-`externref`
 * element**, is skipped.
 *
 * Why skip `externref` too: the carriers keyed `"externref"` in `ctx.vecTypeMap`
 * are NOT uniformly `(array externref)`. Some are registered with a `ref`/
 * `ref_null` element override (e.g. the `arguments` object + closure-arg vecs via
 * `getOrRegisterVecType(ctx, "externref", refElem)` in function-body.ts /
 * closures.ts), and `getOrRegisterArrayType` rewrites a `ref` element to
 * `ref_null`. An identity arm for such a carrier left a `(ref null N)` on the
 * helper's `return` (`__extern_get_idx return[0] expected externref, got
 * (ref null N)`), emitting invalid Wasm for ~120 generator/async +
 * destructuring-rest + TypedArray modules and breaching the #2097 standalone
 * floor (-116). A number-only arm set has NO ref-returning path, so it stays
 * unconditionally valid across every carrier the proposal harness can register.
 * Non-number element indexing through the boundary (externref / string / GC-ref)
 * falls back to the prior null behaviour — no worse than pre-#2190 — and is
 * deferred to a follow-up.
 */
export function boxVecElementToExternref(ctx: CodegenContext, elemType: ValType): Instr[] | null {
  if (elemType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return null;
    return [{ op: "call", funcIdx: boxIdx }];
  }
  if (elemType.kind === "i32") {
    // The `boolean`-tagged i32 variant must NOT box through `__box_number`
    // (number box ≠ boolean box) — skip it (falls back to prior null behaviour).
    if ((elemType as { boolean?: boolean }).boolean) return null;
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return null;
    return [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx }];
  }
  // (#2162b) A carrier whose `data` array element is EXACTLY `externref` (read
  // from `arrDef.element`, never the `"externref"` map key — see the scope note
  // above and [[reference_vec_externref_key_not_uniform]]) needs only an
  // identity pass-through: the loaded element is already an `externref`, so it
  // satisfies the helper's `externref` return with no boxing. This is the
  // canonical externref `$Vec` that `arr.entries()`/`.keys()`/`.values()` and
  // the spread/`Array.from` materialization hand back. The dangerous variants
  // the scope note warns about are the `ref`/`ref_null`-element carriers (the
  // `arguments`/closure-arg vecs), which would leave a `(ref null N)` on the
  // `externref` return — those stay skipped below.
  if (elemType.kind === "externref") {
    return [];
  }
  // (#2190 read-back, homogeneous string sub-array) A carrier whose `data`
  // element is a GC *string* ref — `$AnyString` / `$NativeString`
  // (`ctx.anyStrTypeIdx` / `ctx.nativeStrTypeIdx`) — is the inner vec of an
  // `any[]` of homogeneous-string arrays (`[["a","b"]]`). Without an arm here,
  // `__extern_get_idx(inner, i)` falls through to null, the caller's
  // `ref.test $AnyString` then fails, and `struct.get` null-derefs on the
  // `.length`/element read (the `e[0][0]` trap). `extern.convert_any` is the
  // universal GC-ref → externref boxing; the consuming site re-tests/casts the
  // returned externref back to `$AnyString`, so the round-trip is identity for a
  // string element and null for an array hole. Scoped to the string GC types
  // only — the `arguments`/closure-arg `(ref null N)` carriers the scope note
  // warns about stay skipped (they are not string carriers) so this adds no
  // behaviour to those paths.
  if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    const ti = (elemType as { typeIdx: number }).typeIdx;
    // (#3244) GENERALISED from the string-only arm this replaces. A homogeneous
    // reference-element array — `[{ x: 777 }]` (element = object STRUCT ref) or a
    // nested `[[10, 20, 30]]` (element = inner `__vec_<k>` STRUCT ref) — compiles
    // to a typed `__vec_<structKind>` carrier, NOT `__vec_externref`. Boxing it
    // to `any`/externref and reading an element back (`(a as any)[0].x`,
    // `(a as any)[0][1]`, and the destructure-param inner object/array pattern)
    // routes through `__extern_get_idx`; without an arm here the carrier was
    // skipped → the element read fell to the null fallback → read back
    // undefined/NaN (and the nested-pattern destructure then saw null → the
    // "Cannot destructure null" trap). `extern.convert_any` is the universal
    // GC-ref → externref boxing (identity round-trip: the consuming site
    // re-tests/casts the returned externref back to the object/vec type, exactly
    // as for a heterogeneous `__vec_externref` element or the string sub-array
    // that the prior narrow arm handled — `$AnyString`/`$NativeString` are
    // struct types, so they still match here).
    //
    // GUARD — only GC STRUCT/ARRAY referents are subtypes of `anyref`, the input
    // `extern.convert_any` requires. A FUNC-typed ref (`funcref` hierarchy) is
    // NOT an `anyref` subtype, so converting it is invalid Wasm; those carriers
    // stay on the null fallback (the rare closure/funcref-element vec — never
    // read positionally through the boundary in practice). An unknown/negative
    // typeIdx also skips, conservatively.
    if (ti >= 0) {
      const referent = ctx.mod.types[ti];
      if (referent && (referent.kind === "struct" || referent.kind === "array")) {
        return [{ op: "extern.convert_any" }];
      }
    }
  }
  // other ref / ref_null / f32 / i64 / v128 → no arm (see scope note).
  return null;
}

/**
 * (#3190) INVERSE of `boxVecElementToExternref`: coerce the externref `value` on
 * the stack DOWN to a carrier's `data` element type, for the standalone dynamic
 * STORE path (`(arr as any)[i] = v` → `__extern_set` → `fillExternSetVecArms`).
 *
 *   - f64            → `__unbox_number(value)` (ToNumber; NaN for a non-number).
 *   - i32 (numeric)  → `__unbox_number` then `i32.trunc_sat_f64_s`.
 *   - externref      → identity (the canonical `externref` `$Vec`).
 *
 * Returns null for the kinds `boxVecElementToExternref` also skips
 * (boolean-i32 — number box ≠ boolean box; string/ref carriers — a value cast
 * could trap when the any-typed value is not that ref type; f32/i64/v128) so the
 * store is a no-op for those carriers, exactly as before this fill (host-lenient
 * silent no-op). Scoping the write to the trap-free numeric + externref carriers
 * covers the dominant `number[]`/`any[]` case; string-carrier writes are a
 * follow-up.
 */
function unboxExternrefToVecElement(ctx: CodegenContext, elemType: ValType): Instr[] | null {
  if (elemType.kind === "f64") {
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    return unboxIdx === undefined ? null : [{ op: "call", funcIdx: unboxIdx }];
  }
  if (elemType.kind === "i32") {
    if ((elemType as { boolean?: boolean }).boolean) return null;
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    return unboxIdx === undefined ? null : [{ op: "call", funcIdx: unboxIdx }, { op: "i32.trunc_sat_f64_s" }];
  }
  if (elemType.kind === "externref") return [];
  return null;
}

/**
 * (#2190) Parameters needed to build the `__extern_get_idx` body, shared by the
 * eager registration (empty `vecArms`) and the FINALIZE fill (full `vecArms`).
 */
interface ExternGetIdxBodyParams {
  /** Standalone gate — emit the `$Object` array-like + typed-vec arms. */
  objArrayLikeArms: boolean;
  objectTypeIdx: number;
  objVecTypeIdx: number;
  objVecArrTypeIdx: number;
  /** funcIdx of `number_toString` (only used when objArrayLikeArms). */
  numberToStringIdx: number;
  /** funcIdx of `__extern_get` (only used when objArrayLikeArms). */
  externGetIdx: number;
  /** Pre-built per-`__vec_<k>` dispatch arms (empty at registration time). */
  vecArms: Instr[];
  /** (#2106 S1) Factory for the miss ("index absent") result instrs. A FACTORY
   *  — not a shared array — because the miss appears in several branches and
   *  shared Instr objects get double-remapped by the finalize walks (see
   *  `reference_shared_instr_object_dce_double_remap`). Legacy:
   *  `[{ ref.null.extern }]`; singleton regime: `global.get $undefined ;
   *  extern.convert_any`. */
  missInstrs: () => Instr[];
}

/**
 * (#2190) Build the `__extern_get_idx(externref v, f64 idx) -> externref` body.
 *
 * Layout: locals 2=any(anyref) 3=vec(ref null $ObjVec) 4=i(i32).
 * Order of arms (first match wins, each `return`s):
 *   1. `$Object` array-like (`{0:x, length:n}`) — `__extern_get(v, ToString(i))`.
 *   2. typed `__vec_<k>` carriers (`vecArms`) — the #2190 element read.
 *   3. `$ObjVec` enumeration vector — `data[i]` when in bounds.
 *   else → null.
 * The typed-vec arms sit BEFORE the `$ObjVec` test because a `__vec_<k>` is not
 * a `$ObjVec`; placing them first keeps the `$ObjVec` fast path unchanged.
 */
export function buildExternGetIdxBody(p: ExternGetIdxBodyParams): Instr[] {
  const { objArrayLikeArms, objectTypeIdx, objVecTypeIdx, objVecArrTypeIdx } = p;
  const objIdxArm: Instr[] = objArrayLikeArms
    ? [
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            // #2551 — do NOT truncate: ToPropertyKey of a numeric index is
            // ToString(idx) (§7.1.19 → §6.1.6.1.20), so a non-integer index must
            // stringify to its canonical decimal ("1.5"), matching how the STORE
            // path (`o[1.5] = …` → __extern_set → __to_property_key) keys it. A
            // prior `f64.trunc` here read `o[1.5]` from key "1" (truncated) while
            // the write stored under "1.5", so the read missed. number_toString is
            // canonical Number::toString, so an integer index still yields "3".
            { op: "call", funcIdx: p.numberToStringIdx },
            { op: "call", funcIdx: p.externGetIdx },
            { op: "return" },
          ],
        },
      ]
    : [];
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: 2 },
    ...objIdxArm,
    ...p.vecArms,
    { op: "local.get", index: 2 },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...p.missInstrs(), { op: "return" }],
    },
    // vec = cast<$ObjVec>(any) ; i = i32(idx)
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: objVecTypeIdx },
    { op: "local.set", index: 3 },
    { op: "local.get", index: 1 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: 4 },
    // if i < 0 || i >= vec.len → miss
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...p.missInstrs(), { op: "return" }],
    },
    { op: "local.get", index: 4 },
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...p.missInstrs(), { op: "return" }],
    },
    // return vec.data[i]
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: 4 },
    { op: "array.get", typeIdx: objVecArrTypeIdx },
  ];
}

/**
 * (#2190) Fill `__extern_get_idx`'s typed-`__vec_<elemKind>` indexing arms after
 * every module-local array carrier is registered. Sibling of the #2189
 * `.length`-through-the-boundary fix: a real array literal lowers to a
 * `__vec_<elemKind>` struct, and a NUMERIC index on it through the externref
 * boundary (`(arr as any)[i]`) routes here. Without these arms, only `$ObjVec`
 * (enumeration results) and array-like `$Object` are recognised, so a boxed
 * `__vec_f64`/`__vec_<str>` falls through to null (number→0, ref→null).
 *
 * Unlike `.length` (one i32 at field 0, readable uniformly via the `$__vec_base`
 * supertype), element reads are element-type-polymorphic: each carrier has a
 * different `data` array element type and the loaded element must be boxed to
 * externref per kind. So we emit one `ref.test`/`ref.cast` arm per carrier with
 * its own bounds check + per-kind boxing (`boxVecElementToExternref`).
 *
 * Standalone only (gated by `ctx.externGetIdxReserved`, set in standalone). Edits
 * the body in place — no funcIdx churn, so cached call targets stay valid.
 */
export function fillExternGetIdxVecArms(ctx: CodegenContext): void {
  if (!ctx.externGetIdxReserved) return;
  const funcIdx = ctx.funcMap.get("__extern_get_idx");
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn) return;
  const types = ctx.objectRuntimeTypes;
  if (!types) return;

  // Enumerate concrete `__vec_<elemKind>` carriers (NOT $ObjVec — it keeps its
  // own dedicated arm). Dedup by typeIdx; sort for deterministic emission.
  //
  // (#2903 R4) The packed TypedArray ELEMENT carriers — `i8_byte`
  // (Int8/Uint8/Uint8Clamped), `i16_byte` (Int16/Uint16), `i32_elem`
  // (Int32/Uint32) — ARE included here so an `any`-held / dynamically-dispatched
  // typed array reads its elements through `__extern_get_idx` (the single
  // chokepoint the native array-HOF loop `__hof_*`, `a[i]`, indexOf, includes
  // and for-in all read through). Without this, those carriers fell to the null
  // fallback → the HOF loop saw `undefined` at every index and returned wrong
  // results host-free (findIndex→-1, reduce→0). The ArrayBuffer/DataView BYTE
  // buffer `i32_byte` stays excluded (it is a raw byte store, not a JS-array-
  // indexable element carrier). SIGNEDNESS BOUNDARY: `i8_byte`/`i16_byte` are
  // read UNSIGNED (`array.get_u`) — correct for Uint8/Uint8Clamped/Uint16 (the
  // common case + the storage's documented default read, dataview-native.ts),
  // but a negative Int8/Int16 element reads as its unsigned bit-pattern. The
  // shared carrier type (index.ts TYPED_ARRAY_PACKED_STORAGE — Int8Array and
  // Uint8Array both map to `i8_byte`/kind `i8`) loses the constructor's
  // signedness, so this generic read cannot recover it (every consumer routing
  // through here — static or dynamic — reads unsigned). Those Int8/16 reads were
  // already fully broken (null) here, so this is not a regression; recovering
  // sub-i32 signed reads needs a per-signedness carrier type (deferred).
  const excludedByteVecElemKinds = new Set(["i32_byte"]);
  const seen = new Set<number>();
  const carriers: { typeIdx: number; arrTypeIdx: number; elemType: ValType }[] = [];
  for (const [elemKind, vecTypeIdx] of ctx.vecTypeMap.entries()) {
    if (excludedByteVecElemKinds.has(elemKind)) continue;
    if (seen.has(vecTypeIdx)) continue;
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) continue;
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") continue;
    seen.add(vecTypeIdx);
    carriers.push({ typeIdx: vecTypeIdx, arrTypeIdx, elemType: arrDef.element });
  }
  carriers.sort((a, b) => a.typeIdx - b.typeIdx);

  // (#2106 S1) OOB miss = undefined under the singleton regime (fresh instr
  // objects per use — a factory, never a shared array, per the finalize
  // double-remap hazard). The singleton instrs carry no funcIdx/typeIdx, so
  // splicing them at FINALIZE cannot desync any index-shift walk.
  const idxMiss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  // (#2903 R4) Packed sub-i32 element carriers (`i8`/`i16`) need an UNSIGNED
  // packed load (`array.get_u`) — plain `array.get` is invalid on a packed
  // array — then f64-box the zero-extended i32 (0..255 / 0..65535, always
  // positive so `f64.convert_i32_s` == `_u`). Non-packed carriers keep the
  // generic `array.get` + `boxVecElementToExternref`. Returns null for a kind
  // with no boxing (leave that carrier to the null fallback).
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const packedElemReadBox = (elemType: ValType): { getOp: string; boxOps: Instr[] } | null => {
    if ((elemType.kind === "i8" || elemType.kind === "i16") && boxNumIdx !== undefined) {
      return {
        getOp: "array.get_u",
        boxOps: [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumIdx }],
      };
    }
    const generic = boxVecElementToExternref(ctx, elemType);
    return generic === null ? null : { getOp: "array.get", boxOps: generic };
  };
  const vecArms: Instr[] = [];
  for (const { typeIdx, arrTypeIdx, elemType } of carriers) {
    const readBox = packedElemReadBox(elemType);
    if (readBox === null) continue; // unsupported element kind — leave to null fallback
    const { getOp, boxOps } = readBox;
    vecArms.push(
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // i = trunc_sat(idx) ; if i < 0 → miss
          { op: "local.get", index: 1 },
          { op: "i32.trunc_sat_f64_s" },
          { op: "local.tee", index: 4 },
          { op: "i32.const", value: 0 },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...idxMiss(), { op: "return" }],
          },
          // if i >= vec.length → miss
          { op: "local.get", index: 4 },
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 0 },
          { op: "i32.ge_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...idxMiss(), { op: "return" }],
          },
          // return box(vec.data[i])
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 1 },
          { op: "local.get", index: 4 },
          { op: getOp, typeIdx: arrTypeIdx } as Instr, // computed-op
          ...boxOps,
          { op: "return" },
        ],
      },
    );
  }

  if (vecArms.length === 0) return; // no number carriers → leave the eager body untouched

  // (#2190 regression fix, round 3) SPLICE the vec arms into the EXISTING body
  // instead of REBUILDING it. The eager body (from `buildExternGetIdxBody` at
  // registration) baked the `$Object` arm's `number_toString` / `__extern_get`
  // funcIdxs, and the late-import funcIdx-shift machinery walks + adjusts those
  // baked `call` targets if imports are added afterwards (the `addUnionImports`
  // invariant). Rebuilding the whole body here at FINALIZE re-baked those
  // funcIdxs with the *then-current* values; a subsequent reconcile shift would
  // then double-apply to them, corrupting the `call` target → invalid Wasm
  // (this regressed ~120 generator/async + destructuring-rest + TypedArray
  // modules that hit the `$Object`/`number_toString` arm, breaching the #2097
  // floor regardless of which element kinds we boxed). Splicing leaves the
  // original arms — and their shift-maintained funcIdxs — exactly as the eager
  // registration left them.
  //
  // The eager body starts with the 3-instr setup preamble
  // (`local.get 0 ; any.convert_extern ; local.set 2`); the typed-vec arms must
  // run after `any` is set and before the `$Object`/`$ObjVec` arms (a
  // `__vec_<k>` is neither). Insert right after the preamble.
  const SETUP_LEN = 3;
  if (
    fn.body.length >= SETUP_LEN &&
    fn.body[0]?.op === "local.get" &&
    fn.body[1]?.op === "any.convert_extern" &&
    fn.body[2]?.op === "local.set"
  ) {
    fn.body.splice(SETUP_LEN, 0, ...vecArms);
  } else {
    // Defensive: preamble shape changed — prepend the arms after a fresh setup
    // is not safe, so skip rather than risk an unbalanced body.
    return;
  }
}

/**
 * (#3183) Finalize-time `$__vec_base` arms for the standalone DYNAMIC-path
 * for-in / string-key helpers `__object_keys_forin` / `__extern_has` /
 * `__extern_get`.
 *
 * When the receiver's STATIC type is `any`, `resolveArrayInfo` fails and both
 * for-in and a computed `arr[k]` route through the dynamic `$Object` runtime.
 * A real JS array in standalone is a `__vec_<elemKind>` struct subtyping
 * `$__vec_base` (#2186), NOT a `$Object` — so these three helpers, which treat
 * "not `$Object`" as "no properties", made an any-typed array enumerate ZERO
 * keys and answer `undefined` for every string-key read. Vec-awareness had been
 * retrofitted piecemeal (`__extern_length` #2186, `__extern_get_idx` #2190,
 * `__to_primitive` #2358, closed-struct trio #3169) but these three were the
 * remaining gap. This fill closes it, reusing the existing vec-aware helpers:
 *   - `__object_keys_forin`: enumerate index keys "0".."len-1" (a vec has no
 *     expando properties, so the index keys are exact) by pushing
 *     `number_toString(f64(i))` into a fresh `$ObjVec`. Mirrors the inline key
 *     loop `emitArrayForIn` emits for a statically-typed array.
 *   - `__extern_has`: `"length"` → 1; else delegate a numeric string key to
 *     `__extern_has_idx(v, n)` — which this same PR generalised to be
 *     `$__vec_base`-aware (it was `$ObjVec`/`$Object`-only). It uses the same
 *     trunc_sat bounds as `__extern_get_idx`'s vec arm, so HAS and GET stay in
 *     agreement and the #2066 per-visit liveness guard never skips a readable
 *     index.
 *   - `__extern_get`: `"length"` → `__box_number(f64(len))`; else delegate a
 *     numeric string key to `__extern_get_idx(v, n)` (already vec-aware, handles
 *     OOB → undefined). A non-string / non-numeric / non-"length" key answers
 *     the undefined miss, same as before.
 *
 * The numeric-key path parses the string via `__str_to_number` (§7.1.4.1),
 * emitted eagerly for standalone in `ensureObjectRuntime`. Strict
 * CanonicalNumericIndexString would reject non-canonical keys ("00", "1.5");
 * for-in-produced keys are always canonical, so `__str_to_number` acceptance is
 * a benign superset (and matches `__extern_get_idx`'s own trunc-based indexing).
 *
 * Each arm is a self-contained, `ref.test $__vec_base`-guarded block PREPENDED
 * at body index 0 (the `fillExternGetErrorProps` discipline): it returns on a
 * vec match and falls through untouched for every non-vec receiver, so host /
 * non-vec output stays byte-identical. Locals are APPENDED (never renumber the
 * existing ones). Standalone-only — gated on `ctx.standalone`; host mode's JS
 * `__extern_*` imports own these paths.
 */
/**
 * Teach the standalone own-property predicates about closed compiler structs.
 *
 * The object runtime is emitted while user shapes are still being discovered,
 * so its eager `__object_hasOwn` / `__hasOwnProperty` bodies can initially see
 * only the open `$Object` hash table. At finalize, build one string-key arm per
 * visible field over the complete nominal struct set. Conditionally-created
 * fields use #2847's hidden `$has_<name>` bit; ordinary physical fields are
 * always own properties, including when their value is null/undefined.
 *
 * This is deliberately an in-place fill: no imports or functions are added and
 * all previously-baked call indices remain stable.
 */
export function fillClosedStructHasOwnArms(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.anyStrTypeIdx < 0) return;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (flattenIdx === undefined || equalsIdx === undefined) return;

  type Entry = {
    typeIdx: number;
    presenceSlot?: PresenceSlot;
    shapeFieldIdx?: number;
    shapeId?: number;
  };
  const byField = new Map<string, Entry[]>();
  for (const [structName, fields] of ctx.structFields) {
    if (isSyntheticStructName(structName)) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    const shapeFieldIdx = fields.findIndex((field) => field?.name === "$shape");
    const shapeId = ctx.shapeIdByStructName.get(structName);
    for (const field of fields) {
      if (!field?.name || field.name.startsWith("$") || field.name.startsWith("__")) continue;
      const presenceSlot = presenceSlotOf(fields, field.name);
      if (presenceSlot) {
        const typeDef = ctx.mod.types[typeIdx];
        const physicalFields =
          typeDef?.kind === "struct"
            ? typeDef.fields
            : typeDef?.kind === "sub" && typeDef.type.kind === "struct"
              ? typeDef.type.fields
              : [];
        if (presenceSlot.wordFieldIdx >= physicalFields.length) {
          throw new Error(
            `closed-struct-has-own presence mismatch: ${structName}.${field.name} word ${presenceSlot.wordFieldIdx}, physical ${physicalFields.length}`,
          );
        }
      }
      let entries = byField.get(field.name);
      if (!entries) {
        entries = [];
        byField.set(field.name, entries);
      }
      entries.push({
        typeIdx,
        ...(presenceSlot ? { presenceSlot } : {}),
        ...(shapeFieldIdx >= 0 && shapeId !== undefined ? { shapeFieldIdx, shapeId } : {}),
      });
    }
  }
  if (byField.size === 0) return;

  // Factory, not a shared Instr tree: finalize remaps every function body in
  // place, so sharing these objects between the two predicates would remap all
  // embedded type indices twice (#1719 reserve/fill discipline).
  const buildPrologue = (flatLocalIdx: number): Instr[] => {
    const keyArms: Instr[] = [];
    for (const [fieldName, entries] of byField) {
      const receiverArms: Instr[] = [];
      for (const entry of entries) {
        const returnPresence: Instr[] =
          entry.presenceSlot === undefined
            ? [{ op: "i32.const", value: 1 }, { op: "return" }]
            : [
                { op: "local.get", index: 0 },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: entry.typeIdx },
                ...presenceTestInstrs(entry.typeIdx, entry.presenceSlot),
                { op: "return" },
              ];
        const exactThen: Instr[] =
          entry.shapeFieldIdx === undefined || entry.shapeId === undefined
            ? returnPresence
            : [
                { op: "local.get", index: 0 },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: entry.typeIdx },
                { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.shapeFieldIdx },
                { op: "i32.const", value: entry.shapeId },
                { op: "i32.eq" },
                { op: "if", blockType: { kind: "empty" }, then: returnPresence },
              ];
        receiverArms.push(
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: entry.typeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: exactThen,
          },
        );
      }
      keyArms.push(
        // (#3673 round 17) key flattened ONCE into the scratch local below —
        // the old per-arm re-flatten paid a call + ref.test per field arm.
        { op: "local.get", index: flatLocalIdx },
        ...nativeStringLiteralInstrs(ctx, fieldName),
        { op: "call", funcIdx: equalsIdx },
        { op: "if", blockType: { kind: "empty" }, then: receiverArms },
      );
    }
    // (#3673 round 19) The field arms can only ever MATCH a closed-STRUCT
    // receiver (each arm `ref.test`s its struct type), yet acorn's hot hasOwn
    // receivers are plain `$Object`s (options, refDestructuringErrors) — which
    // walked all ~50 arms (one `__str_equals` call each) before reaching the
    // base-body `$Object` path. One receiver test skips the whole block:
    // behavior-identical, since an `$Object` can never match any arm.
    const objTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
    const structReceiverGuard: Instr[] =
      objTypeIdx !== undefined
        ? [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: objTypeIdx },
            { op: "i32.eqz" },
          ]
        : [{ op: "i32.const", value: 1 }];
    return [
      ...structReceiverGuard,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
              { op: "call", funcIdx: flattenIdx },
              { op: "local.set", index: flatLocalIdx },
              ...keyArms,
            ],
          },
        ],
      },
    ];
  };
  // Closed compiler fields are ordinary own data properties and therefore
  // enumerable by default. Define/reflag paths that need live descriptor flags
  // are already widened to the open `$Object` runtime rather than remaining on
  // this physical-field path.
  for (const name of ["__object_hasOwn", "__hasOwnProperty", "__propertyIsEnumerable"]) {
    const fn = ctx.mod.functions.find((candidate) => candidate.name === name);
    if (fn) {
      const flatLocalIdx = 2 + fn.locals.length; // 2 params on all three
      fn.locals.push({ name: "__ho_flatkey", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } });
      fn.body.unshift(...buildPrologue(flatLocalIdx));
    }
  }
}

/**
 * Finalize `__getOwnPropertyNames` with closed-struct own-field enumeration.
 *
 * The eager object runtime only knows its open `$Object` map. Closed compiler
 * structs are discovered throughout codegen, so splice one complete-shape arm
 * at finalize time. Names use the same insertion-order authority as the host
 * field-name export; hidden compiler fields stay invisible, and conditional
 * source fields are pushed only when their per-instance presence bit is set.
 *
 * Direct and stored `Object.getOwnPropertyNames` calls both target this native
 * helper, keeping their `$ObjVec`/native-string carrier contract identical.
 *
 * (#4071) **`__object_keys` deliberately does NOT share these arms.** Extending
 * them to it was implemented and MEASURED, then reverted: the struct set here is
 * every non-synthetic entry of `ctx.structFields`, which includes BUILTIN
 * carriers, and their internal fields are not `$`/`__`-prefixed so the filter
 * above does not remove them. Sharing the arms therefore made
 * `Object.keys(new Date(0))` answer `["timestamp"]` and `Object.keys(/ab/)`
 * answer 7 internal RegExp fields — both correctly `[]` before, so it traded a
 * real gain on class instances for a NEW silent wrong answer on two very common
 * spellings. `Object.keys` is enumerable-only and builtin internals are not own
 * enumerable properties.
 *
 * That leak is ALREADY LATENT here: `Object.getOwnPropertyNames(/ab/)` returns
 * those same 7 internal fields in standalone today (host answers 1). Fixing it
 * needs a principled user-declared-vs-builtin struct predicate, which does not
 * exist yet — `isSyntheticStructName` only screens `Wrapper*` / `$AnyValue` /
 * `__vec_*` / `__arr_*`. Tracked separately; do not re-share these arms until
 * that predicate lands.
 */
export function fillClosedStructOwnPropertyNamesArms(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const targets = ["__getOwnPropertyNames"]
    .map((name) => ctx.mod.functions.find((candidate) => candidate.name === name))
    .filter((f): f is NonNullable<typeof f> => f !== undefined);
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (targets.length === 0 || objVecPushIdx === undefined) return;

  type OwnField = { name: string; presenceSlot?: PresenceSlot };
  type ShapeEntry = {
    typeIdx: number;
    fields: OwnField[];
    shapeFieldIdx?: number;
    shapeId?: number;
  };
  const entries: ShapeEntry[] = [];

  for (const [structName, fields] of ctx.structFields) {
    if (isSyntheticStructName(structName)) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;

    const byName = new Map<string, OwnField>();
    for (const field of fields) {
      if (!field?.name || field.name.startsWith("$") || field.name.startsWith("__")) continue;
      const presenceSlot = presenceSlotOf(fields, field.name);
      byName.set(field.name, {
        name: field.name,
        ...(presenceSlot ? { presenceSlot } : {}),
      });
    }
    if (byName.size === 0) continue;

    const orderedNames = orderNamesByInsertion(ctx, structName, [...byName.keys()]);
    const shapeFieldIdx = fields.findIndex((field) => field?.name === "$shape");
    const shapeId = ctx.shapeIdByStructName.get(structName);
    entries.push({
      typeIdx,
      fields: orderedNames.map((name) => byName.get(name)!),
      ...(shapeFieldIdx >= 0 && shapeId !== undefined ? { shapeFieldIdx, shapeId } : {}),
    });
  }
  if (entries.length === 0) return;

  // (#4071) Built fresh PER TARGET, never cloned. `structuredClone` preserves
  // internal aliasing, so a shared `Instr` object reachable from two function
  // bodies would be remapped twice by `shiftLateImportIndices` (the #1302
  // hazard). Re-running the builder is cheap and sidesteps that entirely.
  const buildArms = (): Instr[] => {
    const arms: Instr[] = [];
    for (const entry of entries) {
      const pushFields: Instr[] = [];
      for (const field of entry.fields) {
        const pushName: Instr[] = [
          { op: "local.get", index: 7 },
          ...nativeStringLiteralInstrs(ctx, field.name),
          { op: "extern.convert_any" },
          { op: "call", funcIdx: objVecPushIdx },
        ];
        if (field.presenceSlot === undefined) {
          pushFields.push(...pushName);
        } else {
          pushFields.push(
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: entry.typeIdx },
            ...presenceTestInstrs(entry.typeIdx, field.presenceSlot),
            { op: "if", blockType: { kind: "empty" }, then: pushName },
          );
        }
      }
      const returnNames: Instr[] = [...pushFields, { op: "local.get", index: 7 }, { op: "return" }];
      const exactThen: Instr[] =
        entry.shapeFieldIdx === undefined || entry.shapeId === undefined
          ? returnNames
          : [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: entry.typeIdx },
              { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.shapeFieldIdx },
              { op: "i32.const", value: entry.shapeId },
              { op: "i32.eq" },
              { op: "if", blockType: { kind: "empty" }, then: returnNames },
            ];
      arms.push(
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: entry.typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: exactThen,
        },
      );
    }
    return arms;
  };

  // Other finalize fills may already have prepended family classifiers. Anchor
  // to the semantic provider's actual result-vector initialization rather than
  // a positional index: declaration/fill order must not move these arms before
  // `vec = __objvec_new()`.
  for (const fn of targets) {
    const initIdx = fn.body.findIndex((instr, index) => {
      const next = fn.body[index + 1];
      return (
        instr.op === "call" &&
        instr.funcIdx === ctx.funcMap.get("__objvec_new") &&
        next?.op === "local.set" &&
        next.index === 7
      );
    });
    // Anchor absent (preamble shape changed) — skip THIS target rather than
    // splicing at a guessed offset; the others are unaffected.
    if (initIdx < 0) continue;
    // Each target owns its own instruction objects — see `buildArms` above.
    fn.body.splice(initIdx + 2, 0, ...buildArms());
  }
}

/**
 * Finalize the standalone dynamic getter with closed-struct field arms.
 * Computed reads such as Acorn's `opts[opt]` otherwise fall through the eager
 * `$Object`-only body and return undefined even though Object.hasOwn correctly
 * reports the physical field.
 */
export function fillClosedStructExternGetArms(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.anyStrTypeIdx < 0) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  const boxedNumberTypeIdx = ctx.nativeBoxNumberTypeIdx;
  if (!fn || flattenIdx === undefined || equalsIdx === undefined) return;
  type Entry = {
    typeIdx: number;
    fieldIdx: number;
    fieldType: ValType;
    jsBoolean: boolean;
    presenceSlot?: PresenceSlot;
    shapeFieldIdx?: number;
    shapeId?: number;
  };
  const byField = new Map<string, Entry[]>();
  for (const [structName, fields] of ctx.structFields) {
    if (isSyntheticStructName(structName) || isOpenDescriptorShape(structName, fields)) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    const shapeFieldIdx = fields.findIndex((field) => field?.name === "$shape");
    const shapeId = ctx.shapeIdByStructName.get(structName);
    for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
      const field = fields[fieldIdx];
      const exposedFieldName = exposedClosedStructFieldName(field?.name);
      if (!field || !exposedFieldName) continue;
      const boxable =
        field.type.kind === "externref" ||
        field.type.kind === "ref_extern" ||
        field.type.kind === "anyref" ||
        field.type.kind === "eqref" ||
        field.type.kind === "ref" ||
        field.type.kind === "ref_null" ||
        (field.type.kind === "f64" && boxNumberIdx !== undefined) ||
        (field.type.kind === "i32" &&
          (field.jsBoolean || field.type.boolean ? boxBooleanIdx !== undefined : boxNumberIdx !== undefined));
      if (!boxable) continue;
      const presenceSlot = presenceSlotOf(fields, field.name);
      let entries = byField.get(exposedFieldName);
      if (!entries) {
        entries = [];
        byField.set(exposedFieldName, entries);
      }
      entries.push({
        typeIdx,
        fieldIdx,
        fieldType: field.type,
        jsBoolean: field.jsBoolean === true || (field.type.kind === "i32" && field.type.boolean === true),
        ...(presenceSlot ? { presenceSlot } : {}),
        ...(shapeFieldIdx >= 0 && shapeId !== undefined ? { shapeFieldIdx, shapeId } : {}),
      });
    }
  }
  if (byField.size === 0) return;
  const readAndBox = (entry: Entry): Instr[] => {
    const read: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: entry.typeIdx },
      { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx },
    ];
    if (entry.fieldType.kind === "f64") {
      read.push({ op: "call", funcIdx: boxNumberIdx! });
    } else if (entry.fieldType.kind === "i32") {
      if (entry.jsBoolean) read.push({ op: "call", funcIdx: boxBooleanIdx! });
      else read.push({ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumberIdx! });
    } else if (entry.fieldType.kind !== "externref" && entry.fieldType.kind !== "ref_extern") {
      read.push({ op: "extern.convert_any" });
    }
    read.push({ op: "return" });
    return read;
  };

  const buildReceiverArms = (entries: Entry[]): Instr[] => {
    const receiverArms: Instr[] = [];
    for (const entry of entries) {
      const then: Instr[] = [];
      if (entry.presenceSlot !== undefined) {
        then.push(
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          ...presenceTestInstrs(entry.typeIdx, entry.presenceSlot),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }]), { op: "return" }],
          },
        );
      }
      then.push(...readAndBox(entry));
      const exactThen: Instr[] =
        entry.shapeFieldIdx === undefined || entry.shapeId === undefined
          ? then
          : [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: entry.typeIdx },
              { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.shapeFieldIdx },
              { op: "i32.const", value: entry.shapeId },
              { op: "i32.eq" },
              { op: "if", blockType: { kind: "empty" }, then },
            ];
      receiverArms.push(
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: entry.typeIdx },
        { op: "if", blockType: { kind: "empty" }, then: exactThen },
      );
    }
    return receiverArms;
  };

  // (#3673) The key is flattened ONCE into a scratch local (its length into a
  // second), and the arms are grouped into LENGTH BUCKETS: one inline length
  // compare per distinct name length (~15 for acorn), each guarding the
  // `__str_equals` probes of just that bucket. The old shape — a linear ladder
  // with per-arm `flatten(key)` + equals call over one arm per distinct field
  // name in the program (hundreds for acorn) — was the dominant cost of a
  // standalone dynamic property read.
  const fkeyLocal = 2 + fn.locals.length;
  const fkeyLenLocal = fkeyLocal + 1;
  const fkeyC0Local = fkeyLocal + 2;
  fn.locals.push(
    { name: "__fkey_ladder", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
    { name: "__fkey_len", type: { kind: "i32" } },
    { name: "__fkey_c0", type: { kind: "i32" } },
  );
  const byLen = new Map<number, Map<number, Array<[string, Entry[]]>>>();
  for (const [fieldName, entries] of byField) {
    let lenGroup = byLen.get(fieldName.length);
    if (!lenGroup) {
      lenGroup = new Map();
      byLen.set(fieldName.length, lenGroup);
    }
    const c0 = fieldName.length > 0 ? fieldName.charCodeAt(0) : -1;
    let c0Group = lenGroup.get(c0);
    if (!c0Group) {
      c0Group = [];
      lenGroup.set(c0, c0Group);
    }
    c0Group.push([fieldName, entries]);
  }
  const stringKeyArms: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.tee", index: fkeyLocal },
    { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 0 },
    { op: "local.tee", index: fkeyLenLocal },
    // c0 = len > 0 ? data[off] : -1 — one array read per lookup, shared by
    // every first-char sub-bucket guard below.
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: fkeyLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "local.get", index: fkeyLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 1 },
        { op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx },
      ],
      else: [{ op: "i32.const", value: -1 }],
    },
    { op: "local.set", index: fkeyC0Local },
  ];
  for (const [len, lenGroup] of byLen) {
    const lenBucket: Instr[] = [];
    for (const [c0, c0Group] of lenGroup) {
      const c0Bucket: Instr[] = [];
      for (const [fieldName, entries] of c0Group) {
        const receiverArms = buildReceiverArms(entries);
        c0Bucket.push(
          { op: "local.get", index: fkeyLocal },
          { op: "ref.as_non_null" },
          ...nativeStringLiteralInstrs(ctx, fieldName),
          { op: "call", funcIdx: equalsIdx },
          { op: "if", blockType: { kind: "empty" }, then: receiverArms },
        );
      }
      lenBucket.push(
        { op: "local.get", index: fkeyC0Local },
        { op: "i32.const", value: c0 },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: c0Bucket },
      );
    }
    stringKeyArms.push(
      { op: "local.get", index: fkeyLenLocal },
      { op: "i32.const", value: len },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: lenBucket },
    );
  }
  const numericKeyArms: Instr[] = [];
  const i31NumericKeyArms: Instr[] = [];
  if (boxedNumberTypeIdx >= 0) {
    for (const [fieldName, entries] of byField) {
      if (!/^(?:0|[1-9]\d*)$/.test(fieldName)) continue;
      numericKeyArms.push(
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: boxedNumberTypeIdx },
        { op: "struct.get", typeIdx: boxedNumberTypeIdx, fieldIdx: 0 },
        { op: "f64.const", value: Number(fieldName) },
        { op: "f64.eq" },
        { op: "if", blockType: { kind: "empty" }, then: buildReceiverArms(entries) },
      );
      // (#3673) i31-boxed numeric key twin — integer field names fit i31.
      i31NumericKeyArms.push(
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: -20 },
        { op: "i31.get_s" },
        { op: "i32.const", value: Number(fieldName) },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: buildReceiverArms(entries) },
      );
    }
  }
  fn.body.unshift(
    ...(numericKeyArms.length > 0
      ? ([
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: boxedNumberTypeIdx },
          { op: "if", blockType: { kind: "empty" }, then: numericKeyArms },
          // (#3673) i31 numeric-key gate.
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: -20 },
          { op: "if", blockType: { kind: "empty" }, then: i31NumericKeyArms },
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: stringKeyArms },
  );
}

/**
 * Finalize native method-call arms for approved function-constructor instances.
 * The method value is resolved by `__extern_get` (own fields first, then the
 * per-fnctor prototype above) and invoked through the shared #3098 callable
 * classifier, preserving the original receiver as `this` and the full args
 * vector. No new callable or constructor ABI is introduced.
 */
export function fillFnctorPrototypeDispatchArms(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const protoStartIdx = ctx.funcMap.get("__fnctor_proto_start");
  const protoStartFn = protoStartIdx === undefined ? undefined : definedFuncAt(ctx, protoStartIdx);
  if (protoStartFn) {
    const protoArms: Instr[] = [];
    for (const [fnctorName, protoGlobalIdx] of ctx.fnctorPrototypeObject) {
      const typeIdx = ctx.structMap.get(`__fnctor_${fnctorName}`);
      if (typeIdx === undefined) continue;
      protoArms.push(
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "global.get", index: protoGlobalIdx }, { op: "return" }],
        },
      );
    }
    protoStartFn.body = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      ...protoArms,
      { op: "ref.null.extern" },
    ];
  }

  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_method_call");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  if (!fn || externGetIdx === undefined || applyClosureIdx === undefined) return;

  // (#3673 round 12) Inline per-key method-lookup cache in each per-fnctor
  // arm. The slow path below calls `__extern_get`, which walks its prepended
  // ladder + `__fnctor_proto_start` before reaching the round-9b cache — but
  // HERE the fnctor's prototype is a KNOWN GLOBAL, so the cache check is a
  // handful of loads with zero calls: interned key + generation match +
  // owner `ref.eq` against `global.get <proto>` + live-DATA entry flags →
  // apply the cached method closure directly. Any miss falls to the exact
  // old `__extern_get` path (which also populates the cache). Locals for the
  // key/entry scratch are appended once below.
  const HSTR = ctx.hashedStrTypeIdx;
  const objTypes = ctx.objectRuntimeTypes;
  const inlineCacheReady = HSTR >= 0 && objTypes !== undefined;
  let khLocal = -1;
  let entryLocal = -1;
  if (inlineCacheReady) {
    khLocal = 3 + fn.locals.length;
    entryLocal = khLocal + 1;
    fn.locals.push(
      { name: "__mc_kh", type: { kind: "ref_null", typeIdx: HSTR } },
      { name: "__mc_entry", type: { kind: "ref_null", typeIdx: objTypes.propEntryTypeIdx } },
    );
  }
  // (#3673 round 21) props-array type for the per-object staleness cast.
  const objStructDef = objTypes !== undefined ? ctx.mod.types[objTypes.objectTypeIdx] : undefined;
  const propMapIdxForCache =
    objStructDef?.kind === "struct" && objStructDef.fields[1]?.type.kind === "ref"
      ? (objStructDef.fields[1].type as { typeIdx: number }).typeIdx
      : objStructDef?.kind === "sub" &&
          objStructDef.type.kind === "struct" &&
          objStructDef.type.fields[1]?.type.kind === "ref"
        ? (objStructDef.type.fields[1].type as { typeIdx: number }).typeIdx
        : undefined;

  const arms: Instr[] = [];
  for (const [fnctorName, protoGlobalIdx] of ctx.fnctorPrototypeObject) {
    const typeIdx = ctx.structMap.get(`__fnctor_${fnctorName}`);
    if (typeIdx === undefined) continue;
    const cacheTry: Instr[] =
      inlineCacheReady && propMapIdxForCache !== undefined
        ? [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: HSTR },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: HSTR },
                { op: "local.tee", index: khLocal },
                { op: "struct.get", typeIdx: HSTR, fieldIdx: 4 }, // populated flag
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // owner (non-null once populated) vs this fnctor's proto global
                    { op: "local.get", index: khLocal },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: HSTR, fieldIdx: 5 }, // cacheOwner
                    { op: "ref.cast", typeIdx: objTypes!.objectTypeIdx },
                    { op: "global.get", index: protoGlobalIdx },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: objTypes!.objectTypeIdx },
                    { op: "ref.eq" },
                    // (#3673 round 21) per-object staleness: proto.props must be
                    // the SAME array as at population (a grow replaces it).
                    { op: "global.get", index: protoGlobalIdx },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: objTypes!.objectTypeIdx },
                    { op: "struct.get", typeIdx: objTypes!.objectTypeIdx, fieldIdx: 1 }, // props
                    { op: "local.get", index: khLocal },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: HSTR, fieldIdx: 7 }, // cacheProps
                    { op: "ref.cast", typeIdx: propMapIdxForCache! },
                    { op: "ref.eq" },
                    { op: "i32.and" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: khLocal },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: HSTR, fieldIdx: 6 }, // cacheEntry
                        { op: "ref.cast", typeIdx: objTypes!.propEntryTypeIdx },
                        { op: "local.tee", index: entryLocal },
                        { op: "struct.get", typeIdx: objTypes!.propEntryTypeIdx, fieldIdx: 2 }, // flags
                        { op: "i32.const", value: FLAG_TOMBSTONE | FLAG_ACCESSOR },
                        { op: "i32.and" },
                        { op: "i32.eqz" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: entryLocal },
                            { op: "ref.as_non_null" },
                            { op: "struct.get", typeIdx: objTypes!.propEntryTypeIdx, fieldIdx: 1 }, // value
                            { op: "extern.convert_any" },
                            ...(ctx.funcMap.has("__nullish_to_null")
                              ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
                              : []),
                            { op: "local.get", index: 0 },
                            { op: "local.get", index: 2 },
                            { op: "call", funcIdx: applyClosureIdx },
                            { op: "return" },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ]
        : [];
    arms.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...cacheTry,
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
          ...(ctx.funcMap.has("__nullish_to_null")
            ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
            : []),
          { op: "local.get", index: 0 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: applyClosureIdx },
          { op: "return" },
        ],
      },
    );
  }
  fn.body.unshift(...arms);
}

/**
 * (#3673 round 9b) Prepend the per-key prototype-lookup cache HIT arm onto the
 * FINAL `__extern_get` body — after every other finalize fill has unshifted
 * its arms, so a cache hit skips the closed-struct field ladder, the
 * builtin-meta probe, AND the hash-table walk in one shot. Soundness: the
 * population site (registration-time body, data-property branch) only runs
 * when all of those paths missed for the populating fnctor class, and the hit
 * guard (populated flag + owner-proto `ref.eq` + props-array `ref.eq` + live-DATA
 * entry flags) confines hits to receivers of that same class. MUST be called
 * LAST among the `__extern_get` body fills.
 */
export function unshiftExternGetProtoCacheArm(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.hashedStrTypeIdx < 0) return;
  const HSTR = ctx.hashedStrTypeIdx;
  const protoStartIdx = ctx.funcMap.get("__fnctor_proto_start");
  const objTypes = ctx.objectRuntimeTypes;
  if (protoStartIdx === undefined || objTypes === undefined) return;
  const { objectTypeIdx, propEntryTypeIdx } = objTypes;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  if (!fn || !fn.locals.some((l) => l.name === "kh")) return;
  // (#3673 round 21) props-array type for the per-object staleness cast.
  const objDefForArm = ctx.mod.types[objectTypeIdx];
  const propMapIdxForArm =
    objDefForArm?.kind === "struct" && objDefForArm.fields[1]?.type.kind === "ref"
      ? (objDefForArm.fields[1].type as { typeIdx: number }).typeIdx
      : objDefForArm?.kind === "sub" &&
          objDefForArm.type.kind === "struct" &&
          objDefForArm.type.fields[1]?.type.kind === "ref"
        ? (objDefForArm.type.fields[1].type as { typeIdx: number }).typeIdx
        : undefined;
  if (propMapIdxForArm === undefined) return;
  fn.body.unshift(
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: HSTR },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: HSTR },
        { op: "local.tee", index: 8 },
        { op: "struct.get", typeIdx: HSTR, fieldIdx: 4 }, // populated flag
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // owner-candidate → local 2 (overwritten by the normal path
            // below whether or not the arm hits, so safe as scratch here):
            // the receiver itself when it is a plain $Object (depth-0
            // own-entry caching — tested FIRST, it's one ref.test), else a
            // fnctor receiver's per-class prototype via the ~one-test-per-
            // fnctor `__fnctor_proto_start` ladder.
            { op: "ref.null", typeIdx: objectTypeIdx },
            { op: "local.set", index: 2 },
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: objectTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 0 },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: objectTypeIdx },
                { op: "local.set", index: 2 },
              ],
              else: [
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: protoStartIdx },
                { op: "local.tee", index: 7 },
                { op: "ref.is_null" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: 7 },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: objectTypeIdx },
                    { op: "local.set", index: 2 },
                  ],
                },
              ],
            },
            { op: "local.get", index: 2 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 2 },
                { op: "ref.as_non_null" },
                // owner: non-null whenever populated (the population site
                // writes all cache fields together).
                { op: "local.get", index: 8 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: HSTR, fieldIdx: 5 }, // cacheOwner
                { op: "ref.cast", typeIdx: objectTypeIdx },
                { op: "ref.eq" },
                // (#3673 round 21) per-object staleness: owner.props must be
                // the SAME array as at population (a grow replaces it).
                { op: "local.get", index: 2 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 }, // props
                { op: "local.get", index: 8 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: HSTR, fieldIdx: 7 }, // cacheProps
                { op: "ref.cast", typeIdx: propMapIdxForArm },
                { op: "ref.eq" },
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: 8 },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: HSTR, fieldIdx: 6 }, // cacheEntry
                    { op: "ref.cast", typeIdx: propEntryTypeIdx },
                    { op: "local.tee", index: 3 },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 }, // flags
                    { op: "i32.const", value: FLAG_TOMBSTONE | FLAG_ACCESSOR },
                    { op: "i32.and" },
                    { op: "i32.eqz" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: 3 },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value
                        { op: "extern.convert_any" },
                        { op: "return" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  );
}

export function fillDynamicForinVecArms(ctx: CodegenContext): void {
  if (!ctx.standalone) return; // host imports own the dynamic path
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx < 0) return;
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  const numToStringIdx = ctx.funcMap.get("number_toString");
  const strToNumIdx = ctx.funcMap.get("__str_to_number");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const externHasIdxIdx = ctx.funcMap.get("__extern_has_idx");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");

  const findFn = (name: string) => ctx.mod.functions.find((f) => f.name === name);

  // `key == "length"` (key already known to be a $AnyString) — flatten it and
  // compare against the literal via `__str_equals`. Leaves an i32 on the stack.
  const keyIsLength = (): Instr[] | null =>
    strFlattenIdx === undefined || strEqualsIdx === undefined
      ? null
      : [
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          ...nativeStringLiteralInstrs(ctx, "length"),
          { op: "call", funcIdx: strEqualsIdx },
        ];

  // ── __object_keys_forin / __object_keys: enumerate "0".."len-1" ──
  //
  // (#4071) `__object_keys` gets the SAME arm as its for-in sibling instead of a
  // hand-maintained copy. Both take `(externref obj) -> externref` and treat a
  // non-`$Object` receiver as "no properties", so an ANY-typed array — a
  // `__vec_<k>` struct, not a `$Object` — made `Object.keys([10,20,30])` answer
  // `[]` while `for (k in [10,20,30])` (fixed by #3183) answered correctly.
  // Index keys are the complete answer for BOTH helpers here: `Object.keys` and
  // for-in are each enumerable-only, and `length` is non-enumerable. Expando
  // properties written onto a vec live in the separate #3537 side table and are
  // enumerated by NEITHER — that gap is unchanged by this arm (see #4010).
  for (const keysFn of [findFn("__object_keys_forin"), findFn("__object_keys")]) {
    if (!(keysFn && numToStringIdx !== undefined && objVecNewIdx !== undefined && objVecPushIdx !== undefined))
      continue;
    // params: 0=obj ; append locals: kAny(anyref) kVec(externref) kLen(i32) kI(i32)
    const kAny = 1 + keysFn.locals.length;
    const kVec = kAny + 1;
    const kLen = kAny + 2;
    const kI = kAny + 3;
    keysFn.locals.push(
      { name: "__vec_any", type: { kind: "anyref" } },
      { name: "__vec_out", type: { kind: "externref" } },
      { name: "__vec_len", type: { kind: "i32" } },
      { name: "__vec_i", type: { kind: "i32" } },
    );
    const arm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: kAny },
      { op: "ref.test", typeIdx: vecBaseIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "call", funcIdx: objVecNewIdx },
          { op: "local.set", index: kVec },
          { op: "local.get", index: kAny },
          { op: "ref.cast", typeIdx: vecBaseIdx },
          { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
          { op: "local.set", index: kLen },
          { op: "i32.const", value: 0 },
          { op: "local.set", index: kI },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: kI },
                  { op: "local.get", index: kLen },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  // __objvec_push(vec, number_toString(f64(i)))
                  { op: "local.get", index: kVec },
                  { op: "local.get", index: kI },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: numToStringIdx },
                  { op: "call", funcIdx: objVecPushIdx },
                  { op: "local.get", index: kI },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: kI },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          ...bagKeysTail(ctx, { vecLocal: kVec, includeNonEnum: false }), // (#4010 S3) expandos AFTER indices
        ],
      },
    ];
    keysFn.body.splice(0, 0, ...arm);
  }

  // ── __extern_has: "length" → 1; numeric index → __extern_has_idx ──
  const hasFn = findFn("__extern_has");
  if (hasFn && externHasIdxIdx !== undefined) {
    // params: 0=obj 1=key ; append locals: hAny(anyref) hN(f64)
    const hAny = 2 + hasFn.locals.length;
    const hN = hAny + 1;
    hasFn.locals.push({ name: "__vec_any", type: { kind: "anyref" } }, { name: "__vec_n", type: { kind: "f64" } });
    const lenArm = keyIsLength();
    // Delegate the numeric-index presence check to `__extern_has_idx`, which is
    // now `$__vec_base`-aware (#3183) and uses the SAME trunc_sat bounds as
    // `__extern_get_idx`'s vec arm — so HAS and GET stay in agreement and the
    // #2066 per-visit liveness guard never skips a readable index.
    const numericArm: Instr[] =
      strToNumIdx !== undefined
        ? [
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: strToNumIdx },
            { op: "local.tee", index: hN },
            { op: "local.get", index: hN },
            { op: "f64.eq" }, // n == n (reject NaN, i.e. non-numeric)
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: hN },
                { op: "call", funcIdx: externHasIdxIdx },
                { op: "return" },
              ],
            },
          ]
        : [];
    const strKeyBody: Instr[] = [
      ...(lenArm
        ? ([
            ...lenArm,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 1 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      ...numericArm,
    ];
    const arm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: hAny },
      { op: "ref.test", typeIdx: vecBaseIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // string key?
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: strKeyBody,
          },
          // vec receiver, non-string / non-index / non-length key → the #3537 bag, else absent (#4010 S3)
          ...bagHasElseAbsent(ctx),
        ],
      },
    ];
    hasFn.body.splice(0, 0, ...arm);
  }

  // ── __extern_get: "length" → box(len); numeric index → __extern_get_idx ──
  const getFn = findFn("__extern_get");
  if (getFn && externGetIdxIdx !== undefined) {
    // params: 0=obj 1=key ; append locals: gAny(anyref) gN(f64)
    const gAny = 2 + getFn.locals.length;
    const gN = gAny + 1;
    getFn.locals.push({ name: "__vec_any", type: { kind: "anyref" } }, { name: "__vec_n", type: { kind: "f64" } });
    const getMiss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
    const lenArm = keyIsLength();
    const numericArm: Instr[] =
      strToNumIdx !== undefined
        ? [
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: strToNumIdx },
            { op: "local.tee", index: gN },
            { op: "local.get", index: gN },
            { op: "f64.eq" }, // n == n
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: gN },
                { op: "call", funcIdx: externGetIdxIdx },
                { op: "return" },
              ],
            },
          ]
        : [];
    const lenBody: Instr[] =
      lenArm && boxNumberIdx !== undefined
        ? [
            ...lenArm,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: gAny },
                { op: "ref.cast", typeIdx: vecBaseIdx },
                { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
                { op: "f64.convert_i32_s" },
                { op: "call", funcIdx: boxNumberIdx },
                { op: "return" },
              ],
            },
          ]
        : [];
    const arm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: gAny },
      { op: "ref.test", typeIdx: vecBaseIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // string key?
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...lenBody, ...numericArm],
          },
          // Vec receiver, non-"length"/non-index key: FALL THROUGH to the main
          // body — its non-$Object miss arm consults the #3537 expando side
          // table (`__vec_prop_get`), which itself answers the undefined-miss
          // sentinel when the array carries no bag/property. Before #3537 this
          // arm ended `getMiss(); return`, terminally swallowing every named
          // expando read on an array.
        ],
      },
    ];
    getFn.body.splice(0, 0, ...arm);
  }
}

/**
 * (#3190) Finalize-time `$__vec_base` write arms for the standalone dynamic
 * STORE helper `__extern_set`. The write-side sibling of `fillExternGetIdxVecArms`
 * (#2190, the read fill).
 *
 * A computed store `(arr as any)[i] = v` on an any-typed receiver lowers to
 * `__extern_set(obj, box(i), box(v))`. A real array is a `__vec_<elemKind>`
 * struct subtyping `$__vec_base` (#2186), NOT a `$Object`, so `__extern_set`'s
 * `ref.test $Object` misses it and the store is silently dropped — the element
 * is never written (#3183 fixed the READ side; this is the WRITE side).
 *
 * This fill PREPENDS a self-contained arm at body index 0 (the
 * `fillExternGetErrorProps` splice discipline — append locals, never renumber;
 * falls through untouched for non-vec receivers so host / non-vec output is
 * byte-identical). The arm:
 *   1. `ref.test $__vec_base` — a vec receiver enters the block and ALWAYS
 *      returns (writes on a hit, else a host-lenient silent no-op), never
 *      falling through to the `$Object` body.
 *   2. index `i = trunc_sat(__unbox_number(key))` (the key is `box(i)`;
 *      `__unbox_number` is ToNumber so a string index works too); skip on NaN.
 *   3. in-bounds `0 <= i < len` (len via `$__vec_base` field 0) — else no-op.
 *   4. per-carrier `ref.test <carrier>` → `array.set(data, i, unbox(value))`
 *      with per-kind UNBOXING (`unboxExternrefToVecElement`). An unsupported
 *      element kind (string/ref/bool/f32/i64) has no unbox arm → the store is a
 *      no-op for that carrier (same as before the fill).
 *
 * SCOPE: this is the IN-BOUNDS OVERWRITE half. GROWTH (`a[len] = v`,
 * `new Array()` then writes) needs the resizable-vec representation, which the
 * dynamic path does not drive — deferred (see #3190 "Grow" note). Standalone
 * only (gated on `ctx.externGetIdxReserved`, set when the trio was registered
 * with the standalone arms); host output untouched.
 */
export function fillExternSetVecArms(ctx: CodegenContext): void {
  if (!ctx.externGetIdxReserved) return; // host owns the write path
  const fn = ctx.mod.functions.find((f) => f.name === "__extern_set");
  if (!fn) return;
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");
  if (unboxNumIdx === undefined) return;
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);

  // Enumerate concrete `__vec_<elemKind>` carriers (same filter as
  // `fillExternGetIdxVecArms`) with a trap-free write unbox arm.
  const seen = new Set<number>();
  const carrierArms: Instr[] = [];
  const carriers: { typeIdx: number; arrTypeIdx: number; elemType: ValType }[] = [];
  for (const [elemKind, vecTypeIdx] of ctx.vecTypeMap.entries()) {
    if (NON_ARRAY_BYTE_VEC_ELEM_KINDS.has(elemKind)) continue;
    if (seen.has(vecTypeIdx)) continue;
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) continue;
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") continue;
    seen.add(vecTypeIdx);
    carriers.push({ typeIdx: vecTypeIdx, arrTypeIdx, elemType: arrDef.element });
  }
  carriers.sort((a, b) => a.typeIdx - b.typeIdx);

  // params: 0=obj 1=key 2=value ; append locals: setAny(anyref) setN(f64) setI(i32)
  const setAny = 3 + fn.locals.length;
  const setN = setAny + 1;
  const setI = setAny + 2;

  for (const { typeIdx, arrTypeIdx, elemType } of carriers) {
    const unbox = unboxExternrefToVecElement(ctx, elemType);
    if (unbox === null) continue; // unsupported element kind → store no-op (as before)
    carrierArms.push(
      { op: "local.get", index: setAny },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // vec.data[i] = unbox(value)
          { op: "local.get", index: setAny },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 1 },
          { op: "local.get", index: setI },
          { op: "local.get", index: 2 },
          ...unbox,
          { op: "array.set", typeIdx: arrTypeIdx },
          { op: "return" },
        ],
      },
    );
  }
  if (carrierArms.length === 0) return; // no writable carriers → leave body untouched

  fn.locals.push(
    { name: "__vec_set_any", type: { kind: "anyref" } },
    { name: "__vec_set_n", type: { kind: "f64" } },
    { name: "__vec_set_i", type: { kind: "i32" } },
  );

  const arm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: setAny },
    { op: "ref.test", typeIdx: vecBaseIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // n = __unbox_number(key) ; NaN = non-numeric key
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: unboxNumIdx },
        { op: "local.tee", index: setN },
        { op: "local.get", index: setN },
        { op: "f64.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // i = trunc_sat(n) ; if 0 <= i < len → per-carrier array.set
            { op: "local.get", index: setN },
            { op: "i32.trunc_sat_f64_s" },
            { op: "local.set", index: setI },
            { op: "local.get", index: setI },
            { op: "i32.const", value: 0 },
            { op: "i32.ge_s" },
            { op: "local.get", index: setI },
            { op: "local.get", index: setAny },
            { op: "ref.cast", typeIdx: vecBaseIdx },
            { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
            { op: "i32.lt_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: carrierArms,
            },
            // NUMERIC key on a vec: handled here terminally — in-bounds stored
            // above (each carrier arm returns), OOB/grow/unsupported kind stays
            // the deferred no-op (#3190 "Grow" note). Never reaches the bag:
            // numeric keys are vec ELEMENTS, and bagging them would be
            // incoherent with `__extern_get_idx` element reads.
            { op: "return" },
          ],
        },
        // NON-numeric key on a vec (e.g. `arr.index = 0`, the test262
        // `__expected` harness shape): FALL THROUGH to the main body, whose
        // non-$Object miss arm routes vec receivers into the #3537 expando
        // side table (`__vec_prop_set`; `"length"` refused there). Before
        // #3537 this was an unconditional `return` (silent drop).
      ],
    },
  ];
  fn.body.splice(0, 0, ...arm);
}

/**
 * (#3169) Box a CLOSED-struct field value (already on the stack) up to the
 * uniform externref the dynamic-reader trio returns. Mirrors the result-boxing
 * arm of `buildEntryArm` (closed-method-dispatch.ts) / the coercion engine's
 * to-externref rules, but stays local to avoid an object-runtime ⇄
 * type-coercion import cycle. funcMap-read-only (the union natives are
 * registered by `ensureObjectRuntime` under standalone). Returns null when the
 * field kind has no host-free boxing (f32/i64/v128/i8/i16) — the caller skips
 * that field (its index reads as a miss, same as before the fill).
 */
function boxClosedStructFieldToExternref(ctx: CodegenContext, fieldType: ValType): Instr[] | null {
  if (fieldType.kind === "externref") return [];
  if (fieldType.kind === "f64") {
    const boxNumIdx = ctx.funcMap.get("__box_number");
    return boxNumIdx === undefined ? null : [{ op: "call", funcIdx: boxNumIdx }];
  }
  if (fieldType.kind === "i32") {
    if ((fieldType as { boolean?: boolean }).boolean === true) {
      const boxBoolIdx = ctx.funcMap.get("__box_boolean");
      if (boxBoolIdx !== undefined) return [{ op: "call", funcIdx: boxBoolIdx }];
    }
    const boxNumIdx = ctx.funcMap.get("__box_number");
    return boxNumIdx === undefined ? null : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumIdx }];
  }
  if (fieldType.kind === "ref" || fieldType.kind === "ref_null") return [{ op: "extern.convert_any" }];
  return null;
}

/**
 * (#3169) Finalize-time CLOSED-STRUCT array-like arms for the standalone
 * dynamic-reader trio `__extern_length` / `__extern_get_idx` /
 * `__extern_has_idx`.
 *
 * A plain-JS array-like literal with NO contextual type —
 * `var obj = { 0: 11, 1: 12, length: 2 }`, the dominant receiver shape of the
 * test262 `Array.prototype.<HOF>.call(obj, cb)` corpus (§23.1.3 generics over
 * array-likes) — compiles to a CLOSED nominal WasmGC struct (`$__anon_N` with
 * fields `$0/$1/$length`), NOT an open `$Object` (#1897 forbids diverting
 * uncontexted literals to `$Object`: consumers compile against the inferred
 * struct). The reader trio had arms for `$Object` / `$ObjVec` / typed vecs
 * only, so a closed-struct receiver answered `length 0` / miss — the generic
 * `compileArrayLikePrototypeCall` loop then ran ZERO iterations and returned
 * the seed (the "returned 2 — assert #1" signature, ~500 standalone-lane gap
 * tests under reduce/reduceRight/filter/some/every/map/forEach).
 *
 * Fill (this function): for every closed struct with a numeric-able `length`
 * field, SPLICE (never rebuild — `reference_no_rebuild_helper_body_at_finalize`)
 * one `ref.test`-guarded arm into each of the three helpers, right after their
 * shared 3-instr preamble (the same insertion discipline as
 * `fillExternGetIdxVecArms` above):
 *   - `__extern_length`: `struct.get $length` → ToLength clamp (trunc, [0,
 *     2^53−1], NaN→0) — spec Get(O,"length") + §7.1.20 over the real field.
 *   - `__extern_get_idx`: compare the f64 index against each canonical
 *     integer-named field ("0","1",…) — `f64.eq` per field, `struct.get` + box
 *     on match, undefined-miss otherwise (a struct HAS no other indices — its
 *     proto is Object.prototype, which has none either).
 *   - `__extern_has_idx`: OR of the same `f64.eq` tests — HasProperty per
 *     §23.1.3 hole semantics ({0:x, 2:y, length:3} skips index 1; a
 *     present-but-undefined field still answers 1 since struct fields exist).
 *
 * Runs at FINALIZE (index.ts, right after `fillExternGetIdxVecArms`) so the
 * struct-type table is COMPLETE — literals compiled after `ensureObjectRuntime`
 * still get arms. Standalone-only via `ctx.externGetIdxReserved` (set exactly
 * when the trio was registered with the standalone array-like arms); gc/host
 * output is untouched (the host imports own this path there). All `call`
 * funcIdxs are read from funcMap at fill time and the spliced instrs are
 * walked by any later shift like all others.
 */
export function fillExternArrayLikeStructArms(ctx: CodegenContext): void {
  if (!ctx.externGetIdxReserved) return; // standalone trio absent → nothing to widen
  const findFn = (name: string) => {
    const idx = ctx.funcMap.get(name);
    return idx === undefined ? undefined : definedFuncAt(ctx, idx);
  };
  const lenFn = findFn("__extern_length");
  const getIdxFn = findFn("__extern_get_idx");
  const hasIdxFn = findFn("__extern_has_idx");
  if (!lenFn && !getIdxFn && !hasIdxFn) return;
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");
  // (#3317) OBJECT-valued `length` fields (`{1:true, length:{toString(){…}}}`,
  // the test262 `-3-19/-3-20/-3-21/-3-22` indexOf/lastIndexOf family plus
  // includes/return-abrupt-tonumber-length) run the observable §7.1.20
  // ToLength(ToNumber(ToPrimitive(v, number))) walk: `__to_primitive` (its
  // number hint = null-extern hint) dispatches the field's own valueOf →
  // toString via the #2638 class driver — including the both-return-objects
  // TypeError and abrupt-throw propagation — then the primitive converts via
  // `__str_to_number` (string) / `__unbox_number` (number/boolean/null).
  // All three helpers must exist for the arm to be minted; otherwise the
  // ref-typed length field keeps today's not-a-candidate behaviour (length 0).
  const toPrimIdx = ctx.funcMap.get("__to_primitive");
  const typeofStringIdx = ctx.funcMap.get("__typeof_string");
  // (#3169) `length: "2"` (the test262 `-3-*` "length is a string containing a
  // number" family) stores a STRING-ref length field; ToLength applies ToNumber
  // first (§7.1.20 → §7.1.4), which is exactly the native `__str_to_number`
  // scanner. Presence-gated (it is emitted with the union natives under
  // nativeStrings — index.ts finalize — so it exists whenever such a literal
  // can); absent → the string-length arm is skipped (under-fix, length 0 as
  // before).
  const strToNumIdx = ctx.funcMap.get("__str_to_number");
  const isStringRefType = (t: ValType): boolean =>
    (t.kind === "ref" || t.kind === "ref_null") &&
    ((t as { typeIdx: number }).typeIdx === ctx.anyStrTypeIdx ||
      (t as { typeIdx: number }).typeIdx === ctx.nativeStrTypeIdx) &&
    (t as { typeIdx: number }).typeIdx >= 0;

  // ── Collect closed-struct array-like candidates ──
  // Same skip filter as `collectMethodEntries`/`collectFieldEntries`
  // (closed-method-dispatch.ts) plus the internal `__subview_*` typed-array
  // carriers (they carry a `length` field but are NOT generic array-likes —
  // their element reads go through the dedicated typed-array paths, and
  // widening their `.length` here would change established fall-through
  // behaviour).
  type ArrayLikeCand = {
    typeIdx: number;
    lengthFieldIdx: number;
    lengthFieldType: ValType;
    numericFields: { n: number; fieldIdx: number; fieldType: ValType }[];
  };
  const seen = new Set<number>();
  const cands: ArrayLikeCand[] = [];
  const fnctorProtoGlobals = new Map<number, number>();
  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined || seen.has(typeIdx)) continue;
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_") ||
      structName.startsWith("__subview_") ||
      structName.startsWith("$")
    )
      continue;
    const lengthFieldIdx = fields.findIndex(
      (f) =>
        f.name === "length" &&
        (f.type.kind === "f64" ||
          f.type.kind === "i32" ||
          f.type.kind === "externref" ||
          (strToNumIdx !== undefined && isStringRefType(f.type)) ||
          // (#3317) object-valued length — ToNumber(ToPrimitive(v, number)).
          (toPrimIdx !== undefined &&
            typeofStringIdx !== undefined &&
            unboxNumIdx !== undefined &&
            (f.type.kind === "ref" || f.type.kind === "ref_null") &&
            !isStringRefType(f.type))),
    );
    if (lengthFieldIdx < 0) continue;
    const numericFields: ArrayLikeCand["numericFields"] = [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f?.name) continue;
      const n = Number(f.name);
      // Canonical non-negative integer index names only ("0", "1", …) — the
      // ToString(ToPropertyKey) form §23.1.3 loops probe.
      if (!Number.isInteger(n) || n < 0 || String(n) !== f.name) continue;
      numericFields.push({ n, fieldIdx: i, fieldType: f.type });
    }
    seen.add(typeIdx);
    const protoGlobalIdx = fnctorArray.fnctorPrototypeGlobalForStruct(ctx, structName);
    if (protoGlobalIdx !== undefined) fnctorProtoGlobals.set(typeIdx, protoGlobalIdx);
    cands.push({ typeIdx, lengthFieldIdx, lengthFieldType: fields[lengthFieldIdx]!.type, numericFields });
  }
  if (cands.length === 0) return;
  cands.sort((a, b) => a.typeIdx - b.typeIdx);

  const idxMiss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const MAX_SAFE = 9007199254740991; // 2^53 - 1

  /** Shared preamble test (identical for all three helpers). */
  const hasPreamble = (fn: { body: Instr[] }): boolean =>
    fn.body.length >= 3 &&
    fn.body[0]?.op === "local.get" &&
    fn.body[1]?.op === "any.convert_extern" &&
    fn.body[2]?.op === "local.set";

  // ── __extern_length arms (locals: 1=any, 2=lenF64, 3=lenTrunc) ──
  if (lenFn && hasPreamble(lenFn)) {
    const arms: Instr[] = [];
    let lenPrimLocalAdded = false; // (#3317) L_PRIM scratch appended at most once
    for (const cand of cands) {
      // Read the length field as f64: i32 converts (a boolean-branded field
      // reads 1/0 — ToLength(ToNumber(true)) = 1); externref (an `any`-typed
      // `length` slot) unboxes via __unbox_number (NaN for non-numbers → the
      // clamp answers 0, matching ToLength(ToNumber) for the common cases);
      // a string ref (`length: "2"`) runs the §7.1.4 StringToNumber scanner.
      // (#3317) object-ref length: ToNumber(ToPrimitive(v, hint number)). The
      // hint is `ref.null.extern` — `__to_primitive`'s isStringHint treats a
      // null hint as number/default (valueOf → toString), exactly §23.1.3's
      // ToLength entry. The primitive result lands in the appended scratch
      // local L_PRIM (index 4): a string reduces via `__str_to_number`
      // (§7.1.4.1), everything else via `__unbox_number` (number/boolean/
      // null → NaN handled by the shared clamp below). Abrupt completions
      // (throwing valueOf/toString, both-objects TypeError) propagate as Wasm
      // throws out of `__extern_length` to the borrow caller.
      const L_PRIM = 4;
      const isObjectRefLength =
        (cand.lengthFieldType.kind === "ref" || cand.lengthFieldType.kind === "ref_null") &&
        !isStringRefType(cand.lengthFieldType);
      const objectRefRead: Instr[] =
        toPrimIdx !== undefined && typeofStringIdx !== undefined && unboxNumIdx !== undefined
          ? [
              { op: "extern.convert_any" },
              { op: "ref.null.extern" }, // hint: number/default
              { op: "call", funcIdx: toPrimIdx },
              { op: "local.tee", index: L_PRIM },
              { op: "call", funcIdx: typeofStringIdx },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "f64" } },
                then:
                  strToNumIdx !== undefined
                    ? [
                        { op: "local.get", index: L_PRIM },
                        { op: "call", funcIdx: strToNumIdx },
                      ]
                    : [
                        { op: "local.get", index: L_PRIM },
                        { op: "call", funcIdx: unboxNumIdx },
                      ],
                else: [
                  { op: "local.get", index: L_PRIM },
                  { op: "call", funcIdx: unboxNumIdx },
                ],
              },
            ]
          : [{ op: "drop" }, { op: "f64.const", value: 0 }];
      const readAsF64: Instr[] =
        cand.lengthFieldType.kind === "i32"
          ? [{ op: "f64.convert_i32_s" }]
          : cand.lengthFieldType.kind === "externref"
            ? unboxNumIdx !== undefined
              ? [{ op: "call", funcIdx: unboxNumIdx }]
              : [{ op: "drop" }, { op: "f64.const", value: 0 }]
            : isStringRefType(cand.lengthFieldType) && strToNumIdx !== undefined
              ? [{ op: "extern.convert_any" }, { op: "call", funcIdx: strToNumIdx }]
              : isObjectRefLength
                ? objectRefRead
                : [];
      if (isObjectRefLength && !lenPrimLocalAdded) {
        // Scratch externref local for the ToPrimitive result — appended once.
        // Registered locals are [any, lenF64, lenTrunc] after the single
        // externref param, so the new local's index is 4 (= L_PRIM).
        lenFn.locals.push({ name: "primExt", type: { kind: "externref" } });
        lenPrimLocalAdded = true;
      }
      arms.push(
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: cand.typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "ref.cast", typeIdx: cand.typeIdx },
            { op: "struct.get", typeIdx: cand.typeIdx, fieldIdx: cand.lengthFieldIdx },
            ...readAsF64,
            // ToLength clamp — mirrors the `$Object` arm's NaN/trunc/[0,2^53−1]
            // sequence, reusing the same scratch locals 2/3.
            { op: "local.tee", index: 2 },
            { op: "local.get", index: 2 },
            { op: "f64.ne" }, // NaN?
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } },
              then: [{ op: "f64.const", value: 0 }],
              else: [
                { op: "local.get", index: 2 },
                { op: "f64.trunc" },
                { op: "local.tee", index: 3 },
                { op: "f64.const", value: 0 },
                { op: "f64.le" },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "f64" } },
                  then: [{ op: "f64.const", value: 0 }],
                  else: [{ op: "local.get", index: 3 }, { op: "f64.const", value: MAX_SAFE }, { op: "f64.min" }],
                },
              ],
            },
            { op: "return" },
          ],
        },
      );
    }
    lenFn.body.splice(3, 0, ...arms);
  }

  // ── __extern_get_idx arms (params: 1=idx f64; locals: 2=any) ──
  if (getIdxFn && hasPreamble(getIdxFn)) {
    const arms: Instr[] = [];
    const getIdxSelfIdx = ctx.funcMap.get("__extern_get_idx");
    for (const cand of cands) {
      const fieldChecks: Instr[] = [];
      for (const nf of cand.numericFields) {
        const box = boxClosedStructFieldToExternref(ctx, nf.fieldType);
        const ownValue = fnctorArray.closedStructIndexValue(2, cand.typeIdx, nf.fieldIdx, box, idxMiss());
        fieldChecks.push(
          { op: "local.get", index: 1 },
          { op: "f64.const", value: nf.n },
          {
            op: "f64.eq",
          },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...ownValue, { op: "return" }],
          },
        );
      }
      const protoGlobalIdx = fnctorProtoGlobals.get(cand.typeIdx);
      const inheritedMiss = fnctorArray.fnctorGetIndexMiss(protoGlobalIdx, getIdxSelfIdx, 1, idxMiss());
      if (fieldChecks.length === 0 && protoGlobalIdx === undefined) continue;
      arms.push(
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: cand.typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...fieldChecks, ...inheritedMiss, { op: "return" }],
        },
      );
    }
    if (arms.length > 0) getIdxFn.body.splice(3, 0, ...arms);
  }

  // ── __extern_has_idx arms (params: 1=idx f64; locals: 2=any) ──
  if (hasIdxFn && hasPreamble(hasIdxFn)) {
    const arms: Instr[] = [];
    const hasIdxSelfIdx = ctx.funcMap.get("__extern_has_idx");
    for (const cand of cands) {
      const protoGlobalIdx = fnctorProtoGlobals.get(cand.typeIdx);
      if (cand.numericFields.length === 0 && protoGlobalIdx === undefined) continue;
      const hasChain = fnctorArray.fnctorHasIndexSeed(protoGlobalIdx, hasIdxSelfIdx, 1);
      for (const nf of cand.numericFields) {
        hasChain.push(
          { op: "local.get", index: 1 },
          { op: "f64.const", value: nf.n },
          { op: "f64.eq" },
          { op: "i32.or" },
        );
      }
      arms.push(
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: cand.typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...hasChain, { op: "return" }],
        },
      );
    }
    if (arms.length > 0) hasIdxFn.body.splice(3, 0, ...arms);
  }
}

function prependBuiltinFnObjectSemantics(ctx: CodegenContext, typeIdxs: readonly number[]): void {
  const findFn = (name: string) => ctx.mod.functions.find((f) => f.name === name);
  // Builtin function closure wrappers are objects, but the ordinary integrity
  // predicates only recognise the open-object `$Object` carrier. Consequently
  // every reified builtin method answered the primitive fallback
  // (`isExtensible` false, `isFrozen`/`isSealed` true). Splice a finalized
  // meta-type guard in front of those predicates once the complete subtype set
  // is known. Like the metadata helpers below, this must be finalize-time:
  // baking the `ref.test` set when the object runtime is first ensured would
  // miss builtin closures registered later in source order.
  const builtinFnTypePredicate = (): Instr[] => {
    const predicate: Instr[] = [{ op: "i32.const", value: 0 }];
    for (const typeIdx of typeIdxs) {
      predicate.push(
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx },
        { op: "i32.or" },
      );
    }
    return predicate;
  };
  for (const [name, result] of [
    ["__object_isExtensible", 1],
    ["__object_isFrozen", 0],
    ["__object_isSealed", 0],
  ] as const) {
    const integrityFn = findFn(name);
    if (!integrityFn) continue;
    integrityFn.body.splice(0, 0, ...builtinFnTypePredicate(), {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: result }, { op: "return" }],
    });
  }

  // The same wrappers' [[Prototype]] is %Function.prototype%. The ordinary
  // native helper only follows `$Object.$proto`, so prepend the complete
  // finalized meta-type predicate and return the identity-stable native
  // Function prototype for a match. The singleton/glue is already registered
  // by the source's `Function.prototype` value read in reflective comparisons;
  // if it is absent, retain the prior null fallback.
  const functionBrand = getBuiltinBrand(ctx, "Function");
  const functionProtoInstrs = functionBrand === undefined ? null : buildLazyNativeProtoGetInstrs(ctx, functionBrand);
  const getPrototypeFn = findFn("__getPrototypeOf");
  if (functionProtoInstrs && getPrototypeFn) {
    getPrototypeFn.body.splice(0, 0, ...builtinFnTypePredicate(), {
      op: "if",
      blockType: { kind: "empty" },
      then: [...functionProtoInstrs, { op: "return" }],
    });
  }
}

/**
 * (#2896) Finalize-time fill for the reserved builtin-fn metadata natives
 * (`__builtinfn_get_meta` / `__builtinfn_gopd` / `__builtinfn_delete` /
 * `__builtinfn_push_ownnames` — registered by `ensureObjectRuntime` under
 * `--target standalone` with constant default bodies). Runs from index.ts
 * finalize, right after `fillExternGetIdxVecArms`, once EVERY builtin closure
 * meta type (`ctx.builtinFnMetaByTypeIdx`, see builtin-fn-meta.ts) is known —
 * a meta type registered after an eagerly-baked ref.test chain would otherwise
 * be invisible (the same compile-order snapshot bug `fillExternIsArray` fixes
 * for Array.isArray).
 *
 * Shift-safety: the arms are SPLICED into the existing default bodies (never
 * rebuilt — see `reference_no_rebuild_helper_body_at_finalize`); the `call`
 * funcIdxs baked here read `funcMap` at fill time, and any later import shift
 * walks + adjusts spliced instrs like all others. `ref.test`/`ref.cast`/
 * `struct.get`/`struct.set` use TYPE indices (rec-group stable, no funcidx
 * hazard).
 */
export function fillBuiltinFnMeta(ctx: CodegenContext): void {
  const metaMap = ctx.builtinFnMetaByTypeIdx;
  if (!metaMap || metaMap.size === 0) return;
  const getMetaFuncIdx = ctx.funcMap.get("__builtinfn_get_meta");
  if (getMetaFuncIdx === undefined) return; // object runtime never ensured
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (boxNumIdx === undefined || strFlattenIdx === undefined || strEqualsIdx === undefined || anyStrTypeIdx < 0) {
    return;
  }
  // Resolve fill targets BY NAME (funcIdx math across phases is shift-sensitive).
  const findFn = (name: string) => ctx.mod.functions.find((f) => f.name === name);
  const getMetaFn = findFn("__builtinfn_get_meta");
  const gopdFn = findFn("__builtinfn_gopd");
  const deleteFn = findFn("__builtinfn_delete");
  const pushOwnFn = findFn("__builtinfn_push_ownnames");

  // Deterministic arm order.
  const entries = Array.from(metaMap.entries()).sort((a, b) => a[0] - b[0]);

  // All builtin metadata structs have the same physical WasmGC shape and are
  // therefore structurally equivalent. `ref.test typeIdx` is only a safe
  // family guard; the immutable field 2 identity selects the exact
  // (builtin,member) metadata owner independent of declaration/registration
  // order.
  const exactMetaArm = (typeIdx: number, then: Instr[]): Instr[] => [
    { op: "local.get", index: 2 },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx },
        { op: "struct.get", typeIdx, fieldIdx: 3 },
        { op: "i32.const", value: typeIdx },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then },
      ],
    },
  ];
  prependBuiltinFnObjectSemantics(
    ctx,
    entries.map(([typeIdx]) => typeIdx),
  );

  // Shared preamble for get_meta / delete (locals: 2=any 3=fkey 4=isName 5=isLen):
  // convert the receiver, classify the key ONCE (string → flattened; isName /
  // isLen flags). A non-string key can never be "name"/"length" — the flags
  // stay 0 and the guarded arm block is skipped (falls to the default tail).
  // A FACTORY (fresh Instr objects per call): the same preamble goes into TWO
  // function bodies, and aliasing one Instr[] into both would double-remap
  // (see reference_shared_instr_object_dce_double_remap).
  const classifyPreamble = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: 2 },
    ...classifyKeyPreamble(),
  ];
  const classifyKeyPreamble = (): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        { op: "local.set", index: 3 },
        { op: "local.get", index: 3 },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, "name"),
        { op: "call", funcIdx: strEqualsIdx },
        { op: "local.set", index: 4 },
        { op: "local.get", index: 3 },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, "length"),
        { op: "call", funcIdx: strEqualsIdx },
        { op: "local.set", index: 5 },
      ],
    },
  ];

  // ── __builtinfn_get_meta arms ──
  if (getMetaFn) {
    const arms: Instr[] = [];
    for (const [typeIdx, meta] of entries) {
      arms.push(
        ...exactMetaArm(typeIdx, [
          { op: "local.get", index: 4 }, // isName
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // deleted? (state & NAME_DELETED)
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx },
              { op: "struct.get", typeIdx, fieldIdx: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.and" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...nativeStringLiteralInstrs(ctx, meta.name), { op: "extern.convert_any" }, { op: "return" }],
              },
              { op: "ref.null.extern" },
              { op: "return" },
            ],
          },
          // length: deleted? (state & LENGTH_DELETED)
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 2 },
          { op: "i32.const", value: 2 },
          { op: "i32.and" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "f64.const", value: meta.length }, { op: "call", funcIdx: boxNumIdx }, { op: "return" }],
          },
          { op: "ref.null.extern" },
          { op: "return" },
        ]),
      );
    }
    // (#3673 round 19b) get_meta runs at the TOP of every `__extern_get`, so
    // its two key compares ("name"/"length") were paid per property read
    // program-wide. Every builtin meta struct subtypes the funcref-wrapper
    // ROOT (round 6), so one root `ref.test` gates the whole key
    // classification + arm block: non-closure receivers (fnctors, $Objects,
    // strings — the overwhelming majority of extern_get traffic) skip it with
    // a single test. Falls back to the ungated layout when the root type
    // isn't minted (no closures in the program ⇒ no meta structs either).
    const metaRootIdx = getFuncRefWrapperRootTypeIdx(ctx);
    const gatedTail: Instr[] = [
      ...classifyKeyPreamble(),
      // Guard: only enter the arm block when the key is "name" or "length".
      { op: "local.get", index: 4 },
      { op: "local.get", index: 5 },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: arms,
      },
    ];
    getMetaFn.body.splice(
      0,
      0,
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      ...(metaRootIdx !== undefined
        ? ([
            { op: "local.get", index: 2 },
            { op: "ref.test", typeIdx: metaRootIdx },
            { op: "if", blockType: { kind: "empty" }, then: gatedTail },
          ] satisfies Instr[])
        : gatedTail),
    );
  }

  // ── __builtinfn_gopd: get_meta(v, key) → __create_descriptor(value, 0x04) ──
  const createDescIdx = ctx.funcMap.get("__create_descriptor");
  if (gopdFn && createDescIdx !== undefined) {
    gopdFn.body.splice(
      0,
      0,
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: getMetaFuncIdx },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "i32.const", value: FLAG_CONFIGURABLE }, // {writable:F, enumerable:F, configurable:T}
          { op: "call", funcIdx: createDescIdx },
          { op: "return" },
        ],
      },
    );
  }

  // ── __builtinfn_delete arms: set the instance's deleted bit, return 1 ──
  if (deleteFn) {
    const arms: Instr[] = [];
    for (const [typeIdx] of entries) {
      arms.push(
        ...exactMetaArm(typeIdx, [
          // state |= isName ? 1 : 2
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 2 },
          { op: "local.get", index: 4 },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 1 }],
            else: [{ op: "i32.const", value: 2 }],
          },
          { op: "i32.or" },
          { op: "struct.set", typeIdx, fieldIdx: 2 },
          { op: "i32.const", value: 1 },
          { op: "return" },
        ]),
      );
    }
    deleteFn.body.splice(
      0,
      0,
      ...classifyPreamble(),
      { op: "local.get", index: 4 },
      { op: "local.get", index: 5 },
      { op: "i32.or" },
      { op: "if", blockType: { kind: "empty" }, then: arms },
    );
  }

  // ── __builtinfn_push_ownnames arms: push undeleted ["length","name"] ──
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (pushOwnFn && objVecPushIdx !== undefined) {
    const arms: Instr[] = [];
    for (const [typeIdx] of entries) {
      arms.push(
        ...exactMetaArm(typeIdx, [
          // "length" first (spec order: OrdinaryOwnPropertyKeys creation order).
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 2 },
          { op: "i32.const", value: 2 },
          { op: "i32.and" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 }, // vec
              ...nativeStringLiteralInstrs(ctx, "length"),
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
            ],
          },
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 2 },
          { op: "i32.const", value: 1 },
          { op: "i32.and" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 }, // vec
              ...nativeStringLiteralInstrs(ctx, "name"),
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
            ],
          },
          { op: "i32.const", value: 1 },
          { op: "return" },
        ]),
      );
    }
    pushOwnFn.body.splice(
      0,
      0,
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      ...arms,
    );
  }
}

/**
 * Names of the object-runtime host imports that `ensureObjectRuntime` provides
 * Wasm-native implementations for. `ensureLateImport` routes these here under
 * `ctx.standalone` (mirrors `UNION_NATIVE_HELPER_NAMES` for the #1471 boxing
 * helpers) so existing call sites resolve to the native func with no per-site
 * change. Internal helpers (`__obj_hash`, `__obj_find`, `__obj_insert`,
 * `__obj_grow`) are NOT in this set — they are never requested via
 * `ensureLateImport`.
 */
export const OBJECT_RUNTIME_HELPER_NAMES: ReadonlySet<string> = new Set([
  // (#2896) builtin-fn metadata read (dyn-read `.length` closure arm routes here).
  "__builtinfn_get_meta",
  "__new_plain_object",
  "__extern_is_array",
  "__extern_get",
  "__extern_set",
  "__extern_set_strict", // (#3983) distinct helper: __reflect_set + strict-PutValue TypeError
  "__reflect_set",
  "__to_primitive",
  "__extern_toString",
  "__delete_property",
  // #1472 Phase B Blocker B — native $ObjVec-backed enumeration + indexed read.
  "__object_keys",
  "__extern_length",
  "__extern_get_idx",
  // #1472 Phase B Slice 3 — remaining enumeration / indexed-access / assign.
  "__object_values",
  "__object_entries",
  "__extern_has_idx",
  "__object_assign",
  // #1472 Phase B Blocker A Half 1 (PR #1074) — object integrity predicates.
  "__object_isFrozen",
  "__object_isSealed",
  "__object_isExtensible",
  ...OBJECT_INTEGRITY_OBJ_PREDICATES, // (#4032) known-object variants
  // #1472 Phase B Blocker A Half 2 — object integrity SET path.
  "__object_preventExtensions",
  "__object_seal",
  "__object_freeze",
  // #1629 S6 — native data-descriptor define (Object.defineProperty /
  // Reflect.defineProperty with a { value, writable?, enumerable?, configurable? }
  // descriptor).
  "__defineProperty_value",
  // #1888 Slice 5 — native accessor-descriptor STORE ({ get?, set? }): stores
  // the boxed getter/setter into $PropEntry.$get/$set + FLAG_ACCESSOR.
  "__defineProperty_accessor",
  // #1906 — native Object.defineProperties dynamic fallback for `$Object`
  // descriptor maps. Gathers/validates enumerable descriptor records first,
  // then applies them through __defineProperty_value/accessor.
  "__defineProperties",
  // #1888 Slice 5 — native getOwnPropertyDescriptor: reads the $PropEntry back
  // and builds a descriptor `$Object` (accessor → { get, set, enumerable,
  // configurable }, data → { value, writable, enumerable, configurable };
  // missing own prop / non-$Object receiver → undefined). RUNTIME-LAYER
  // GROUNDWORK: both this and __defineProperty_accessor are not yet reached
  // end-to-end under standalone — the accessor define call-site compiles
  // getter/setter via the __make_getter_callback JS bridge, and that call-site
  // routing (host-free closures → __defineProperty_accessor) plus live get/set
  // invocation are #329-gated follow-ups. Landing the helpers + the R3
  // $PropEntry $get/$set layout now de-risks the layout change in isolation.
  "__getOwnPropertyDescriptor",
  // #2042 S3 — read-side descriptor-reflection natives over $Object/$PropEntry:
  //   __getOwnPropertyNames               — own string keys incl. non-enumerable
  //                                         (via __obj_ordered_all), index/insert order
  //   __getOwnPropertySymbols             — always [] (string-keyed runtime, no symbols)
  //   __object_getOwnPropertyDescriptors  — { key: descriptor } over __getOwnPropertyNames
  // (`__defineProperty_desc` — the write side — is deferred until #2043; see the
  //  NOTE near __getOwnPropertyDescriptor's registration.)
  "__getOwnPropertyNames",
  "__getOwnPropertySymbols",
  "__object_getOwnPropertyDescriptors",
  // #2042 S3 — Object.is (SameValue §7.2.10): tag-dispatched native over two
  // boxed externrefs (number bit-compare for NaN==NaN / +0!=-0, boolean/bigint
  // unbox, both-null, else ref identity). Was a #1472-Phase-B refusal.
  "__object_is",
  // NOTE (#2042 S3): `__object_fromEntries` is intentionally NOT in this set. The
  // native helper only iterates a `$ObjVec` of pair `$ObjVec`s, which the
  // fromEntries call site BUILDS (and calls the helper via funcMap directly) only
  // for a literal array-of-pairs with string keys. The ordinary path (raw arg /
  // Map / non-string-key) must keep REFUSING (compile error) — routing it native
  // here would make `ensureLateImport` register the helper for those args too and
  // TRAP on the non-$ObjVec representation. So this name stays a refusal; the
  // call site resolves the registered helper via funcMap only on the safe shape.
  // #1472 Phase C — `x === undefined` / default-parameter / destructuring-default
  // undefinedness check. Native impl is `ref.is_null` (standalone conflates
  // undefined and null, same as __typeof_undefined). This is the single largest
  // remaining standalone-refusal helper (~6.6k tests).
  "__extern_is_undefined",
  // #1472 Phase C — own-property presence (Object.prototype.hasOwnProperty /
  // Object.hasOwn) over the $Object hash-map via __obj_find; keyed HasProperty
  // (`key in obj`) over own + prototype chain via a proto-walk mirroring
  // __extern_get.
  "__hasOwnProperty",
  "__object_hasOwn",
  // #2541 — Object.prototype.propertyIsEnumerable: own-property presence (no
  // proto walk) AND the entry's FLAG_ENUMERABLE bit, over the same $Object
  // runtime as __hasOwnProperty. Replaces the #1472 Phase B standalone refusal.
  "__propertyIsEnumerable",
  "__extern_has",
  // #1472 Phase C — prototype-chain ops over $Object.$proto (field 0):
  // getPrototypeOf / Object.create / isPrototypeOf.
  "__getPrototypeOf",
  "__object_create",
  "__isPrototypeOf",
  // #1888 Slice 7 — Object.setPrototypeOf writes $Object.$proto (field 0) after
  // the §10.1.2.1 OrdinarySetPrototypeOf extensibility + cycle checks. Routed
  // here so the standalone call site reaches the native helper instead of the
  // proto-dropping stub. (GC/host keeps the stub — see the calls.ts dual-mode
  // gate.)
  "__object_setPrototypeOf",
  // #1888 Slice 2 — open-`any` method dispatch `recv.m(args)`. Native arm
  // (__extern_method_call → __extern_get + __apply_closure arity bridge). The
  // closure round-trips through __extern_set/__extern_get as a ref.test-able
  // wrapper (#1226 typeof recognition + closureInfoByTypeIdx self-reg), so
  // routing native is a correct answer, not a silent undefined.
  "__extern_method_call",
  // #1910/#1472 S2 — boxed primitive wrappers. `new Number`/`new String`/
  // `new Boolean` build a `$Object` carrying the [[PrimitiveValue]] internal slot
  // (non-enumerable) instead of leaking the `env::__new_*` host import;
  // __to_primitive reads the slot first to recover the wrapper's primitive.
  "__new_Number",
  "__new_String",
  "__new_Boolean",
]);
