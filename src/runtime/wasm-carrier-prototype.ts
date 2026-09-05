// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5325) `[[Prototype]]` of a WasmGC carrier that represents a BUILT-IN.
//
// `Object.getPrototypeOf` on a receiver that reaches the host as an opaque
// WasmGC value had exactly two answers: `%Object.prototype%` when
// `__is_data_struct` said "named data struct", and whatever the native walk
// produced (`null`) otherwise. Compiled `new Date()`, `[1, 2]` and a compiled
// closure are all carriers, so all three got a wrong answer. Measured against
// redux's own `isPlainObject`, which walks the chain to its terminal and then
// compares `getPrototypeOf(obj) === terminal || getPrototypeOf(obj) === null`:
//
//   new Date()    → data struct  → %Object.prototype% → IS the walk terminal
//   [1, 2]        → not a struct → null → takes the `=== null` disjunct
//   function(){}  → not a struct → null → same
//
// so `isPlainObject` answered TRUE for every one of them, and a second hop off
// the array threw "Cannot convert null to object".
//
// Only reachable through a CALL boundary: codegen folds `Object.getPrototypeOf`
// at compile time on a cascade keyed on the argument's expression shape
// (`new Date()`, an array literal, a `ctx.classSet` instance …), and every one
// of those folds makes zero host calls. A bare parameter identifier — i.e.
// every `isPlainObject(value)`-style guard in published JS — matches none of
// them and lands here.
//
// The discriminators are the module's own positive markers, the same ones the
// rest of the runtime gates on. Returning the HOST realm's `X.prototype` is the
// right identity: in JS-host mode every compiled `X.prototype` read resolves to
// that same object (verified across Object/Array/Date/Function/RegExp/Error/
// Map/Set/String/Number/Boolean), so `getPrototypeOf(d) === Date.prototype`
// holds by `===`, and the next hop off it is a real host object whose own
// prototype the native walk already knows.
//
// DELIBERATELY NOT ANSWERED — each would swap a wrong answer for a different
// wrong one, so both keep the caller's existing behaviour:
//
//   - the byte-backed vec carriers, which serve BOTH `ArrayBuffer` and
//     `DataView` and cannot be told apart from each other here. `__dv_byte_len`
//     is their positive discriminator (-1 for an ordinary array), so they are
//     EXCLUDED from the `Array.prototype` answer rather than mislabelled.
//   - a compiled CLASS INSTANCE. It is a named data struct, and so is the
//     class's own prototype singleton (`emitLazyProtoGet` materializes it as a
//     struct of the same type); nothing the module exports separates them. That
//     arm needs a new codegen-side discriminator and keeps the caller's
//     `%Object.prototype%` default.

/**
 * The built-in prototype for `obj`, or `undefined` when `obj` is not a
 * recognised built-in carrier (the caller then keeps its own fallback).
 *
 * Callers must consult the explicit `setPrototypeOf` link, the `Object.create`
 * record and the fnctor instance→ctor link FIRST: a receiver that already has a
 * user-visible prototype is not answered here.
 */
export function wasmCarrierBuiltinPrototype(
  obj: unknown,
  exports: Record<string, Function> | undefined,
): unknown | undefined {
  if (!exports) return undefined;
  const isDate = exports["__\0js2_is_date"] as ((value: unknown) => number) | undefined;
  if (typeof isDate === "function") {
    try {
      if (isDate(obj) === 1) return Date.prototype;
    } catch {
      // Missing/stale bridge export — fall through to the next discriminator.
    }
  }
  const isVec = exports.__is_vec as ((value: unknown) => number) | undefined;
  if (typeof isVec === "function") {
    try {
      if (isVec(obj) === 1) return isByteBackedVecCarrier(obj, exports) ? undefined : Array.prototype;
    } catch {
      // Missing/stale bridge export — fall through to the next discriminator.
    }
  }
  const isClosure = exports.__is_closure as ((value: unknown) => number) | undefined;
  if (typeof isClosure === "function") {
    try {
      if (isClosure(obj) === 1) return Function.prototype;
    } catch {
      // Missing/stale bridge export — keep the caller's existing fallback.
    }
  }
  return undefined;
}

/** True for the i32_byte vec struct that backs `ArrayBuffer` / `DataView`. */
function isByteBackedVecCarrier(obj: unknown, exports: Record<string, Function> | undefined): boolean {
  const byteLen = exports?.__dv_byte_len as ((value: unknown) => number) | undefined;
  if (typeof byteLen !== "function") return false;
  try {
    return byteLen(obj) >= 0;
  } catch {
    return false;
  }
}
