// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — the generic boxed-any runtime operations the dispatch loop
// delegates to (design constraint 1; doc §13 "helpers, not the loop").
//
// ── The free value-representation bridge (the crux, §4.2) ─────────────────────
// Every op here is written as the plain native TypeScript operation on
// `any`-typed operands. That single authoring choice makes the value bridge
// FREE in both directions:
//   • In Node (E1), `a + b` on two real JS values runs JavaScript's own `+`
//     (full ToPrimitive/ToString/ToNumber), so the interpreter's arithmetic is
//     bit-identical to `eval` by construction — the differential harness's whole
//     premise.
//   • When js2wasm self-compiles this file (E2), `a + b` on two `any` operands
//     lowers to the AOT `__any_add` generic runtime op (verified in
//     `src/codegen/binary-ops.ts` — `compileAnyBinaryDispatch`). Likewise `===`
//     → the strict-eq helper (preserving `ref.eq` object identity), member
//     access → `__dyn_member_get`/`__extern_set`, `typeof` → the typeof helper.
// So ToPrimitive/ToNumber genuinely live in these helpers, never in the loop,
// and no opcode carries a runtime-type assumption (acceptance #4).
//
// These functions are pure and fully inside the js2wasm-compilable subset.

import type { JSValue } from "./types.js";

// ── arithmetic ───────────────────────────────────────────────────────────────
// NB operand order: the ISA computes `acc = op(regs[r], acc)`, so the caller
// passes (left = regs[r], right = acc). Order matters for `-`,`/`,`%`,`<`,`<=`
// and string concatenation — the emitter is responsible for landing the syntactic
// left operand in the register and the right in the accumulator.
export function anyAdd(a: JSValue, b: JSValue): JSValue {
  return a + b;
}
export function anySub(a: JSValue, b: JSValue): JSValue {
  return a - b;
}
export function anyMul(a: JSValue, b: JSValue): JSValue {
  return a * b;
}
export function anyDiv(a: JSValue, b: JSValue): JSValue {
  return a / b;
}
export function anyMod(a: JSValue, b: JSValue): JSValue {
  return a % b;
}
export function anyShl(a: JSValue, b: JSValue): JSValue {
  return a << b;
}
export function anyShr(a: JSValue, b: JSValue): JSValue {
  return a >> b;
}
export function anyBitOr(a: JSValue, b: JSValue): JSValue {
  return a | b;
}
export function anyBitAnd(a: JSValue, b: JSValue): JSValue {
  return a & b;
}
export function anyBitXor(a: JSValue, b: JSValue): JSValue {
  return a ^ b;
}
export function anyShrU(a: JSValue, b: JSValue): JSValue {
  return a >>> b;
}
export function anyNeg(a: JSValue): JSValue {
  return -a;
}

// ── logical / type ───────────────────────────────────────────────────────────
export function anyLogicalNot(a: JSValue): JSValue {
  return !a;
}
export function anyTypeof(a: JSValue): JSValue {
  return typeof a;
}
/** ToBoolean — the JumpIfTrue / JumpIfFalse / Not truthiness test (doc: "ToBoolean via __is_truthy"). */
export function isTruthy(a: JSValue): boolean {
  return !!a;
}

// ── comparison ───────────────────────────────────────────────────────────────
export function anyLooseEq(a: JSValue, b: JSValue): JSValue {
  // Intentional abstract (`==`) equality — the `Eq` opcode's whole purpose.
  // biome-ignore lint/suspicious/noDoubleEquals: `Eq` implements JS `==`.
  return a == b;
}
export function anyStrictEq(a: JSValue, b: JSValue): JSValue {
  return a === b;
}
export function anyLt(a: JSValue, b: JSValue): JSValue {
  return a < b;
}
export function anyLe(a: JSValue, b: JSValue): JSValue {
  return a <= b;
}
// (#3356) `>`/`>=` are their OWN ops, not swapped Lt/Le: §13.10.1 evaluates
// `a > b` as IsLessThan(b, a, LeftFirst=FALSE) — the false flag makes
// ToPrimitive run in SOURCE order (a first). Native `b < a` is LeftFirst=true
// (coerces b first), so the swap desugar observably reversed valueOf/toString
// side effects. Native `>`/`>=` carry the correct flag by construction.
export function anyGt(a: JSValue, b: JSValue): JSValue {
  return a > b;
}
export function anyGe(a: JSValue, b: JSValue): JSValue {
  return a >= b;
}

// ── dynamic property access (the SAME MOP the AOT path uses — #3053/#3031) ────
// GetProp (named key from the const pool) and GetElem (dynamic key in a
// register) are one operation `obj[key]`; the opcodes differ only in where the
// key comes from. Prototype chain / getters / Proxy semantics come free via JS's
// own member access in Node, and via `__dyn_member_get` in js2wasm.
export function anyGet(obj: JSValue, key: JSValue): JSValue {
  // A computed string can cross the interpreter's externref register/cell
  // plane as a native-string payload. The generic dynamic MOP does not recover
  // that receiver before its `length` lookup; narrowing here selects the typed
  // native-string accessor while leaving every other receiver/key unchanged.
  if (typeof obj === "string" && key === "length") return obj.length;
  return obj[key];
}
/** Assign and return the assigned value (JS assignment-expression semantics). */
export function anySet(obj: JSValue, key: JSValue, value: JSValue): JSValue {
  obj[key] = value;
  return value;
}

/** Ordinary property deletion without the caller's strict-mode post-check.
 * Reflect returns the raw [[Delete]] Boolean, allowing the bytecode loop to
 * return false for sloppy code or raise TypeError for strict code. */
export function anyDelete(obj: JSValue, key: JSValue): boolean {
  return Reflect.deleteProperty(obj, key);
}

// ── object / array literal builders (%ObjectLiteral% / %ArrayLiteral%) ────────
// The emitter lowers object/array literals to these builtins rather than
// dedicated opcodes (doc "Emitter notes" — fewer ops, same cost class).

/** Build `{ k0: v0, k1: v1, … }` from a flat [key, value, key, value, …] window. */
export function buildObjectLiteral(pairs: JSValue[]): JSValue {
  const obj: JSValue = {};
  let i = 0;
  const n = pairs.length;
  for (;;) {
    if (i + 1 >= n) break;
    obj[pairs[i]] = pairs[i + 1];
    i += 2;
  }
  return obj;
}

/** Build `/pattern/flags` (#4137). The emitter passes the source-exact pattern
 * text and flag string from `node.regex`, so no literal re-parsing happens here;
 * constructing the intrinsic directly also makes the literal immune to a
 * user-shadowed `RegExp` binding. A fresh object per evaluation is required by
 * §13.2.7.3 (each evaluation gets its own `lastIndex`). */
export function buildRegExpLiteral(pattern: JSValue, flags: JSValue): JSValue {
  return new RegExp(pattern, flags);
}

/** Build `[ e0, e1, … ]` from the element window. */
export function buildArrayLiteral(elems: JSValue[]): JSValue {
  const arr: JSValue = [];
  let i = 0;
  const n = elems.length;
  for (;;) {
    if (i >= n) break;
    arr[i] = elems[i];
    i += 1;
  }
  return arr;
}

// ── bounded iteration carriers ──────────────────────────────────────────────
/** Snapshot the enumerable own string keys used by the Phase-1 for-in path.
 * Null/undefined produce no iterations, matching ForIn/OfHeadEvaluation. The
 * full inherited-key/liveness algorithm remains a later MOP widening; eval's
 * current object-literal corpus needs the ordered own-key subset. */
export function buildForInKeys(value: JSValue): JSValue[] {
  if (value === null || value === undefined) return [];
  return Object.keys(value);
}

/** Materialize the bounded array/string iterable subset as a value vector.
 * Unsupported iterator objects throw loudly instead of silently skipping the
 * body. Arrays cover the eval/Annex-B gate; strings are included because the
 * same index walk is host-free in the self-compiled provider. */
export function buildForOfValues(value: JSValue): JSValue[] {
  if (value === null || value === undefined) throw new TypeError("value is not iterable");
  if (!Array.isArray(value) && typeof value !== "string") throw new TypeError("value is not iterable");
  const values: JSValue[] = [];
  let i = 0;
  const length = value.length;
  for (;;) {
    if (i >= length) break;
    values.push(value[i]);
    i += 1;
  }
  return values;
}
