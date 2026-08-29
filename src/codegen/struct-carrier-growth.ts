// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// struct-carrier-growth.ts (#5180) — may this struct be grown in place?
//
// The dynamic field auto-registration in `finalizeStructAndDynamicMemberGet`
// (property-access-dispatch.ts) appends a missing property to
// `ctx.structFields.get(<name>)` and relies — in a comment, not in code — on
// that array BEING the emitted type's own `fields` array. For most shapes it
// is: `commitClassStructLayout`, the `__anon_` minter and the fnctor layouts
// all `structFields.set(name, fields)` with the same array they handed to
// `mod.types.push`.
//
// A handful of compiler-owned builtin CARRIERS do not. `ensureDateStruct`
// (expressions/builtins.ts and index.ts) writes
// `mod.types.push({ name: "__Date", fields: [timestamp] })` and
// `structFields.set("__Date", [timestamp])` from two SEPARATE literals, so a
// push to the metadata array leaves the emitted struct at its real arity. Every
// consumer keyed on `structFields` then works from a field list the module does
// not have: `findAlternateStructsForField` reports `__Date` as a candidate for
// `valueOf` at field 1, and `alternateFieldArmRead` emits
// `struct.get $__Date 1` on a one-field struct.
//
// That failure is worse than invalid wasm. The emitter's #2043 index check
// refuses to encode the instruction, so `compile()` returns ONE hard error and
// an EMPTY binary — the whole module is lost, not one function.
//
// The divergence became reachable when #5204 (8f161cbf15) added the
// carrier-name fallback to `resolveStructNameForExpr`: a receiver whose checker
// type has no struct name now resolves to whatever WasmGC struct it lowers to,
// so `new Date(0).valueOf` reaches the auto-registration site with
// `typeName === "__Date"`. It measurably stopped the linked
// @js-temporal/polyfill bundle from emitting a binary at all (`JSBI___toPrimitive`,
// whose `static __toPrimitive(i)` reads `i.valueOf`).
//
// The guard is deliberately the *invariant*, not a name list: a carrier that
// registers one shared array stays growable, and any future carrier that
// registers two is protected the day it is added. A refused growth is not a
// lost read — the caller falls through to the dynamic/host terminal, which is
// where such a read went before #5204.

import type { FieldDef, StructTypeDef } from "../ir/types.js";

/**
 * Is `fields` (from `ctx.structFields`) the very array the emitted struct
 * carries, so appending to it also grows the module type?
 */
export function structGrowsWithMetadata(typeDef: StructTypeDef, fields: readonly FieldDef[]): boolean {
  return typeDef.fields === fields;
}
