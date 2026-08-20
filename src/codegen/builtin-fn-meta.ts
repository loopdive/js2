// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2896) Standalone native function-object metadata.
 *
 * A builtin function value under `--target standalone` is a closure wrapper
 * struct (`getOrCreateFuncRefWrapperTypes`); it carries no `name`/`length`, so
 * every REFLECTIVE read (`Object.getOwnPropertyDescriptor(fn, "name")`,
 * `fn[key]` with a runtime key, `hasOwnProperty`, `getOwnPropertyNames`) sees
 * nothing — which fails test262's `propertyHelper.js verifyProperty` for every
 * builtin `name.js` / `length.js` / `prop-desc.js` even where a compile-time
 * direct-access meta fold exists (the helper's receiver/key are runtime params).
 *
 * ## Mechanism — per-(builtin, member) meta SUBTYPE, constant metadata per type
 *
 * For each distinct builtin function we materialize, register a UNIQUE struct
 * subtype of its signature wrapper:
 *
 *   `$__builtinfn_<n> {
 *      funcref func;
 *      (mut i32) bfnstate;
 *      i32 bfnid;
 *    } <: $__fn_wrap_<sig>`
 *
 * - Being a SUBTYPE of the signature wrapper keeps every existing call path
 *   working untouched (static closure calls, reflective `.call`, any-typed
 *   callback dispatch — they cast to the sig wrapper / root, and a subtype
 *   passes).
 * - The metadata itself ({name, length}) is statically known per (builtin,
 *   member), so it lives in `ctx.builtinFnMetaByTypeIdx` keyed by the meta type
 *   index. WasmGC structurally canonicalizes the otherwise-identical meta
 *   subtypes, so `ref.test <metaType>` is not an identity discriminator. The
 *   immutable `bfnid` field anchors each instance to its exact metadata entry;
 *   reflective natives require both the family `ref.test` and matching id.
 * - `bfnstate` is the one piece of per-INSTANCE state: a deleted-bits mask
 *   (bit 0 = `name` deleted, bit 1 = `length` deleted). `verifyProperty`'s
 *   `isConfigurable` arm `delete`s the property and then requires
 *   `hasOwnProperty` to report false, so delete must genuinely work.
 *   `struct.new` sites therefore push an extra `i32.const 0`
 *   (`pushBuiltinFnClosureValueInstrs` below).
 */
import type { Instr } from "../ir/types.js";
import type { ClosureInfo, CodegenContext } from "./context/types.js";
import { closureArityField, closureBagField, closureBagInitInstr } from "./closures/funcref-wrapper-types.js";

/**
 * (#4241) Field indices of the meta-typed closure subtype, derived from the
 * shared closure header rather than spelled as bare literals — the header grew
 * a `$bag` slot at index 2 and these two shifted with it.
 * Layout: `[func, $arity, $bag, bfnstate, bfnid]`.
 */
export const BFN_STATE_FIELD_IDX = 3;
export const BFN_ID_FIELD_IDX = 4;

/**
 * Spec `{name, length}` for the builtin STATIC method closures wired in
 * `ensureStandaloneBuiltinStaticMethodClosure` (property-access.ts). Keep in
 * sync with its `switch (key)`. Also consumed by the direct-access
 * `.name`/`.length` meta fold so the constant fold and the runtime descriptor
 * agree.
 */
export const STANDALONE_STATIC_METHOD_META: Record<string, { name: string; length: number }> = {
  "Array.isArray": { name: "isArray", length: 1 },
  "Object.assign": { name: "assign", length: 2 },
  "Object.keys": { name: "keys", length: 1 },
  "Object.getOwnPropertyDescriptor": { name: "getOwnPropertyDescriptor", length: 2 },
  // (#2933) Fixed-arity Reflect.* namespace static-method value reads. Spec
  // `length` per §28.1 (receiver arg is optional and not counted).
  "Reflect.get": { name: "get", length: 2 },
  "Reflect.has": { name: "has", length: 2 },
  "Reflect.set": { name: "set", length: 3 },
  "Reflect.ownKeys": { name: "ownKeys", length: 1 },
  "Reflect.getOwnPropertyDescriptor": { name: "getOwnPropertyDescriptor", length: 2 },
  "Reflect.defineProperty": { name: "defineProperty", length: 3 },
  // (#2933) JSON.stringify as a VALUE — the fixed 1-arg compact form. The value
  // closure serialises via the native `__json_stringify_root` (host-free), the
  // SAME entry the direct `JSON.stringify(o)` call path uses. Spec `.length` is
  // 3 (value, replacer, space); the host-free closure supports only the leading
  // value arg (replacer/space out of scope, matching the standalone call-path
  // narrowing), but `.length` reports the spec arity.
  "JSON.stringify": { name: "stringify", length: 3 },
  // (#2933) Math.max/Math.min as VALUES — genuinely VARIADIC; reified with the
  // canonical variadic closure convention (one `$vec_externref` args param, see
  // `ctx.variadicBuiltinClosure`). Spec `.length` is 2 for both (§21.3.2.24/.25).
  "Math.max": { name: "max", length: 2 },
  "Math.min": { name: "min", length: 2 },
  // (#2963 Tier 2a) Number.is* fixed 1-arg predicates as VALUES. `.name` === the
  // property key (§10.2.9); `.length` 1 (§21.1.2.x). These agree byte-for-byte
  // with the generic `BUILTIN_STATIC_METHOD_ARITY` fallback, listed explicitly
  // per the file-header sync rule for newly-wired closures.
  "Number.isInteger": { name: "isInteger", length: 1 },
  "Number.isFinite": { name: "isFinite", length: 1 },
  "Number.isNaN": { name: "isNaN", length: 1 },
  "Number.isSafeInteger": { name: "isSafeInteger", length: 1 },
  // (#2963 Tier 2b) Object.is fixed 2-arg SameValue as a VALUE (§20.1.2.13).
  "Object.is": { name: "is", length: 2 },
};

/**
 * (#2896) Spec arity of every standard builtin STATIC method (own
 * function-valued data properties of the global constructors/namespaces), for
 * the direct-access `<Builtin>.<method>.length` / `.name` meta fold. `.name`
 * equals the property key for all of these (§10.2.9); `.length` values are the
 * ECMA-262 declared arities (generated from a conforming host — V8/Node — and
 * spot-checked against the spec). This is a compile-time COMPANION of the
 * runtime metadata substrate above: the fold answers direct syntactic reads
 * (no closure materialization, so it also covers methods whose value-read is
 * not yet wired host-free); the meta subtypes answer reflective/runtime reads
 * for the wired closures.
 *
 * (#3181) The whole table AND every inner record are NULL-PROTOTYPED via
 * `nullProtoDeep`. A plain object literal inherits `Object.prototype`, so an
 * inner lookup of an `Object.prototype` method name (`toString`/`valueOf`/
 * `hasOwnProperty`/`constructor`…) returned the INHERITED FUNCTION rather than
 * `undefined` — making the fold at property-access.ts:1126 treat e.g.
 * `Number.toString.length` as "found" and emit the `Function` as an f64 → NaN.
 * With null prototypes, only the explicitly-listed static methods match; every
 * other name resolves `undefined` and routes through the normal path.
 */
const nullProtoDeep = (rec: Record<string, Record<string, number>>): Record<string, Record<string, number>> => {
  const out: Record<string, Record<string, number>> = Object.create(null);
  for (const key of Object.keys(rec)) {
    out[key] = Object.assign(Object.create(null) as Record<string, number>, rec[key]);
  }
  return out;
};

export const BUILTIN_STATIC_METHOD_ARITY: Record<string, Record<string, number>> = nullProtoDeep({
  Array: { isArray: 1, from: 1, fromAsync: 1, of: 0 },
  ArrayBuffer: { isView: 1 },
  BigInt: { asUintN: 2, asIntN: 2 },
  Date: { now: 0, parse: 1, UTC: 7 },
  Error: { isError: 1 },
  Map: { groupBy: 2 },
  Number: { isFinite: 1, isInteger: 1, isNaN: 1, isSafeInteger: 1, parseFloat: 1, parseInt: 2 },
  Object: {
    assign: 2,
    getOwnPropertyDescriptor: 2,
    getOwnPropertyDescriptors: 1,
    getOwnPropertyNames: 1,
    getOwnPropertySymbols: 1,
    hasOwn: 2,
    is: 2,
    preventExtensions: 1,
    seal: 1,
    create: 2,
    defineProperties: 2,
    defineProperty: 3,
    freeze: 1,
    getPrototypeOf: 1,
    setPrototypeOf: 2,
    isExtensible: 1,
    isFrozen: 1,
    isSealed: 1,
    keys: 1,
    entries: 1,
    fromEntries: 1,
    values: 1,
    groupBy: 2,
  },
  Promise: { all: 1, allSettled: 1, any: 1, race: 1, resolve: 1, reject: 1, withResolvers: 0, try: 1 },
  Proxy: { revocable: 2 },
  Reflect: {
    defineProperty: 3,
    deleteProperty: 2,
    apply: 3,
    construct: 2,
    get: 2,
    getOwnPropertyDescriptor: 2,
    getPrototypeOf: 1,
    has: 2,
    isExtensible: 1,
    ownKeys: 1,
    preventExtensions: 1,
    set: 3,
    setPrototypeOf: 2,
  },
  RegExp: { escape: 1 },
  String: { fromCharCode: 1, fromCodePoint: 1, raw: 1 },
  Symbol: { for: 1, keyFor: 1 },
  Math: {
    abs: 1,
    acos: 1,
    acosh: 1,
    asin: 1,
    asinh: 1,
    atan: 1,
    atanh: 1,
    atan2: 2,
    ceil: 1,
    cbrt: 1,
    expm1: 1,
    clz32: 1,
    cos: 1,
    cosh: 1,
    exp: 1,
    floor: 1,
    fround: 1,
    hypot: 2,
    imul: 2,
    log: 1,
    log1p: 1,
    log2: 1,
    log10: 1,
    max: 2,
    min: 2,
    pow: 2,
    random: 0,
    round: 1,
    sign: 1,
    sin: 1,
    sinh: 1,
    sqrt: 1,
    tan: 1,
    tanh: 1,
    trunc: 1,
    f16round: 1,
  },
  JSON: { parse: 2, stringify: 3, rawJSON: 1, isRawJSON: 1 },
  Atomics: {
    load: 2,
    store: 3,
    add: 3,
    sub: 3,
    and: 3,
    or: 3,
    xor: 3,
    exchange: 3,
    compareExchange: 4,
    isLockFree: 1,
    wait: 4,
    waitAsync: 4,
    notify: 3,
    pause: 0,
  },
  Iterator: { from: 1 },
  Uint8Array: { fromBase64: 1, fromHex: 1 },
});

/**
 * Register (idempotently, keyed by `cacheKey`) the unique metadata-carrying
 * struct subtype for one builtin function closure and return its type index.
 *
 * - `baseStructTypeIdx` — the signature wrapper struct (the supertype).
 * - `baseClosureInfo` — the signature wrapper's ClosureInfo; a copy with
 *   `structTypeIdx` re-pointed at the meta type is registered in
 *   `ctx.closureInfoByTypeIdx` so the static closure-call path and the
 *   reflective `.call` recovery resolve the meta-typed value exactly like the
 *   base wrapper (the lifted func type takes `(ref $sigWrapper)` self — a meta
 *   instance passes as a subtype).
 */
export function ensureBuiltinFnMetaType(
  ctx: CodegenContext,
  baseStructTypeIdx: number,
  baseClosureInfo: ClosureInfo,
  cacheKey: string,
  name: string,
  length: number,
): number {
  if (!ctx.builtinFnMetaTypeByKey) ctx.builtinFnMetaTypeByKey = new Map();
  const existing = ctx.builtinFnMetaTypeByKey.get(cacheKey);
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `__builtinfn_meta_${typeIdx}_struct`,
    fields: [
      // Field 0 must mirror the supertype exactly (same type + mutability) —
      // as must the #3673 $arity slot at index 1.
      { name: "func", type: { kind: "funcref" as const }, mutable: false },
      closureArityField(),
      closureBagField(),
      // Deleted-bits mask: bit 0 = "name" deleted, bit 1 = "length" deleted.
      { name: "bfnstate", type: { kind: "i32" as const }, mutable: true },
      // Stable per-module metadata identity. Structurally-equivalent meta
      // subtypes cannot be distinguished by ref.test alone.
      { name: "bfnid", type: { kind: "i32" as const }, mutable: false },
    ],
    superTypeIdx: baseStructTypeIdx,
  });

  ctx.closureInfoByTypeIdx.set(typeIdx, { ...baseClosureInfo, structTypeIdx: typeIdx });
  if (!ctx.builtinFnMetaByTypeIdx) ctx.builtinFnMetaByTypeIdx = new Map();
  ctx.builtinFnMetaByTypeIdx.set(typeIdx, { name, length });
  ctx.builtinFnMetaTypeByKey.set(cacheKey, typeIdx);
  return typeIdx;
}

/**
 * The instruction sequence that materializes a builtin closure VALUE from a
 * factory result. A meta-typed closure struct has the extra `(mut i32)
 * bfnstate` + `bfnid` fields, so its `struct.new` needs two more operands than
 * the plain `ref.func` + `struct.new` sequence; non-meta types keep the old
 * shape.
 */
export function pushBuiltinFnClosureValueInstrs(
  ctx: CodegenContext,
  closure: { type: { kind: "ref"; typeIdx: number }; funcIdx: number },
): Instr[] {
  const isMeta = ctx.builtinFnMetaByTypeIdx?.has(closure.type.typeIdx) ?? false;
  const instrs: Instr[] = [{ op: "ref.func", funcIdx: closure.funcIdx }];
  // (#3673) $arity field 1 — the builtin's spec `length` when meta-typed,
  // else the registered closure signature's param count.
  const arity = isMeta
    ? (ctx.builtinFnMetaByTypeIdx?.get(closure.type.typeIdx)?.length ?? 0)
    : (ctx.closureInfoByTypeIdx.get(closure.type.typeIdx)?.paramTypes.length ?? 0);
  instrs.push({ op: "i32.const", value: arity });
  instrs.push(closureBagInitInstr()); // (#4241) $bag field 2
  if (isMeta) {
    instrs.push({ op: "i32.const", value: 0 }, { op: "i32.const", value: closure.type.typeIdx });
  }
  instrs.push({ op: "struct.new", typeIdx: closure.type.typeIdx });
  return instrs;
}

/**
 * (#2963) IDENTITY-STABLE reified builtin-function value. Instead of a fresh
 * `struct.new` per read (which gives `Promise.resolve !== Promise.resolve` —
 * two distinct closure instances), materialize the closure struct into a
 * MODULE-LEVEL SINGLETON: one `(ref null <structType>)` mutable global per
 * (builtin, member), lazily initialized on first read, so every read of the
 * same builtin value yields the SAME ref.
 *
 * Why a lazy null-guard in the FUNCTION BODY rather than a global const-init:
 * the singleton's `struct.new` takes a `ref.func <closureFuncIdx>` operand, and
 * `closureFuncIdx` is a DEFINED-function index that shifts whenever a late
 * import is added (`addUnionImports` / `shiftLateImportIndices` / the
 * string-import shifter). Those shifters walk function bodies + nested
 * `.then`/`.body`/`.else` arrays (verified) but do NOT walk
 * `ctx.mod.globals[].init`, so a `ref.func` embedded in a const-init would go
 * stale and reference the wrong function. Emitting the materialization inside
 * an `if (ref.is_null) { … }` guard in `fctx.body` keeps the `ref.func` in a
 * shift-covered array — the same discipline as every other funcidx bake site.
 *
 * The mutable `bfnstate` (delete-bits) field being shared across all reads is
 * spec-correct: a builtin method is ONE function object, so `delete fn.name`
 * seen through any reference mutates the same object (test262 `verifyProperty`
 * `isConfigurable` arm).
 *
 * Stack: `[] → [(ref <structType>)]` (non-null, exactly what
 * `pushBuiltinFnClosureValueInstrs` produced, so callers' result type is
 * unchanged).
 */
export function pushBuiltinFnSingletonValueInstrs(
  ctx: CodegenContext,
  closure: { type: { kind: "ref"; typeIdx: number }; funcIdx: number },
): Instr[] {
  const typeIdx = closure.type.typeIdx;
  if (!ctx.builtinFnSingletonGlobalByTypeIdx) ctx.builtinFnSingletonGlobalByTypeIdx = new Map();
  let globalIdx = ctx.builtinFnSingletonGlobalByTypeIdx.get(typeIdx);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__builtinfn_singleton_${typeIdx}`,
      // (ref null <structType>) — starts null, set once on first read.
      type: { kind: "ref_null", typeIdx },
      mutable: true,
      init: [{ op: "ref.null", typeIdx }],
    });
    ctx.builtinFnSingletonGlobalByTypeIdx.set(typeIdx, globalIdx);
  }

  return [
    { op: "global.get", index: globalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...pushBuiltinFnClosureValueInstrs(ctx, closure), { op: "global.set", index: globalIdx }],
    },
    { op: "global.get", index: globalIdx },
    { op: "ref.as_non_null" },
  ];
}
