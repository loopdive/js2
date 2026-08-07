// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4176) The builtin-brand TABLE, extracted from native-proto.ts into a
 * dependency-free module. Two consumers need it without the rest of the
 * native-proto machinery:
 *
 *  - `array-holes.ts` — the `scanForArrayHoles` PRE-SCAN runs before any
 *    codegen and must stay import-light; pulling native-proto.ts from it
 *    created an ESM cycle that crashed module init with a TDZ error
 *    (`collections-brand.ts: Cannot access 'COLLECTION_KIND' before
 *    initialization`).
 *  - `proto-index-store.ts` — needs only the base/count/offset arithmetic.
 *
 * native-proto.ts re-exports everything here, so existing importers are
 * unaffected. The table itself is unchanged — see native-proto.ts for the
 * per-slot history and the append-only contract.
 */

/** Brand ids sit far below zero so they can never collide with a class tag. */
export const BUILTIN_BRAND_BASE = -0x4000_0000; // far from any plausible classTag count

/**
 * The fixed builtin-brand table. Each builtin that gets (or will get) a
 * `$NativeProto` carries one of these ids in emitted code as
 * `$NativeProto.$brand`, so **offsets are an append-only stable contract —
 * never renumber or reuse a slot** (a changed brand silently mis-dispatches).
 */
export const BUILTIN_BRAND_TABLE: Readonly<Record<string, number>> = {
  // ── RegExp / Array / TypedArray family ───────────────────────────────────
  RegExp: BUILTIN_BRAND_BASE + 1,
  Array: BUILTIN_BRAND_BASE + 2,
  "%TypedArray%": BUILTIN_BRAND_BASE + 3,
  Int8Array: BUILTIN_BRAND_BASE + 4,
  Uint8Array: BUILTIN_BRAND_BASE + 5,
  Uint8ClampedArray: BUILTIN_BRAND_BASE + 6,
  Int16Array: BUILTIN_BRAND_BASE + 7,
  Uint16Array: BUILTIN_BRAND_BASE + 8,
  Int32Array: BUILTIN_BRAND_BASE + 9,
  Uint32Array: BUILTIN_BRAND_BASE + 10,
  Float32Array: BUILTIN_BRAND_BASE + 11,
  Float64Array: BUILTIN_BRAND_BASE + 12,
  BigInt64Array: BUILTIN_BRAND_BASE + 13,
  BigUint64Array: BUILTIN_BRAND_BASE + 14,
  ArrayBuffer: BUILTIN_BRAND_BASE + 15,
  SharedArrayBuffer: BUILTIN_BRAND_BASE + 16,
  DataView: BUILTIN_BRAND_BASE + 17,

  // ── Core object model ────────────────────────────────────────────────────
  Object: BUILTIN_BRAND_BASE + 18,
  Function: BUILTIN_BRAND_BASE + 19,

  // ── Primitive wrappers ───────────────────────────────────────────────────
  String: BUILTIN_BRAND_BASE + 20,
  Number: BUILTIN_BRAND_BASE + 21,
  Boolean: BUILTIN_BRAND_BASE + 22,
  BigInt: BUILTIN_BRAND_BASE + 23,
  Symbol: BUILTIN_BRAND_BASE + 24,

  // ── Collections / misc builtins (reserved for later slices) ──────────────
  Map: BUILTIN_BRAND_BASE + 25,
  Set: BUILTIN_BRAND_BASE + 26,
  WeakMap: BUILTIN_BRAND_BASE + 27,
  WeakSet: BUILTIN_BRAND_BASE + 28,
  WeakRef: BUILTIN_BRAND_BASE + 29,
  Promise: BUILTIN_BRAND_BASE + 30,
  Date: BUILTIN_BRAND_BASE + 31,
  Iterator: BUILTIN_BRAND_BASE + 32,

  // ── Error family (reserved) ──────────────────────────────────────────────
  Error: BUILTIN_BRAND_BASE + 33,
  TypeError: BUILTIN_BRAND_BASE + 34,
  RangeError: BUILTIN_BRAND_BASE + 35,
  SyntaxError: BUILTIN_BRAND_BASE + 36,
  URIError: BUILTIN_BRAND_BASE + 37,
  EvalError: BUILTIN_BRAND_BASE + 38,
  ReferenceError: BUILTIN_BRAND_BASE + 39,

  // ── Resource-management / weak builtins ──────────────────────────────────
  FinalizationRegistry: BUILTIN_BRAND_BASE + 40,
  // (#2861) TC39 Explicit Resource Management stacks — `<Stack>.prototype`
  // value reads (use/adopt/defer/move/dispose[Async]/disposed getter). The
  // resource list lives on the INSTANCE, never the proto, so the proto value
  // object is pure (member CSV only).
  DisposableStack: BUILTIN_BRAND_BASE + 41,
  AsyncDisposableStack: BUILTIN_BRAND_BASE + 42,
  // (#2861) SuppressedError (ES2026 error aggregation) — an Error subclass, so
  // its `.prototype` value read reuses the shared NativeError glue shape
  // (`toString` member; constructor/name/message data props via the meta-fold).
  SuppressedError: BUILTIN_BRAND_BASE + 43,

  // ── #3236 S1: %GeneratorPrototype% (sync generator instance proto) ─────────
  // Not a global-constructor `.prototype` like the others — it is the intrinsic
  // %GeneratorPrototype% reached via `genFn.prototype` / `getPrototypeOf(genFn)
  // .prototype`. Reusing the native-proto glue gives its `next`/`return`/`throw`
  // members descriptor-carrying (§17 {w:T,e:F,c:T}) brand-checked callable
  // closure values for free (host-free). Invoking a member on a non-Generator
  // `this` degrades to the shared catchable TypeError (GeneratorValidate,
  // §27.5.1.2) — every GeneratorPrototype value-call test passes a non-generator
  // `this` and expects exactly that.
  GeneratorPrototype: BUILTIN_BRAND_BASE + 44,

  // Next free slot: BUILTIN_BRAND_BASE + 45 (append only).
};

/**
 * (#4176) Number of reserved builtin-brand slots — the proto-named-key store
 * sizes its per-brand companion table off this. Keep in lockstep with the
 * "next free slot" comment above (append-only contract).
 */
export const BUILTIN_BRAND_COUNT = 45;

/**
 * (#4176) Static brand OFFSET (0-based slot in the brand band) for a builtin
 * name, or `undefined`. Pure table lookup — safe for pre-scan predicates that
 * run before any context exists.
 */
export function builtinBrandOffsetOf(name: string): number | undefined {
  const brand = BUILTIN_BRAND_TABLE[name];
  return brand === undefined ? undefined : brand - BUILTIN_BRAND_BASE;
}

/** (#4176) Is `name` a global constructor with a reserved builtin brand? */
export function isBrandedBuiltinName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_BRAND_TABLE, name);
}
