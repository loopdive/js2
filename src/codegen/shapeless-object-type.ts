// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5348) Shapeless object types — the ones a WasmGC struct cannot represent.
 *
 * `{}` is the canonical case: no properties, no index signature, no call or
 * construct signature. A struct registered for such a type has ZERO fields, so
 * it cannot carry any of the value's real properties, and `Object.keys` on a
 * value that resolves to it enumerates those zero fields instead of the live
 * host object. Struct registration is a global mutation of `ctx.anonTypeMap`,
 * so that answer then leaks to every other `{}`-typed value in the program —
 * which is how redux's `combineReducers` lost referential identity (#5348).
 *
 * Shapeless types therefore stay on the externref/host-MOP path.
 *
 * Uses the `ts.Type` accessors rather than the raw TS checker, so the query
 * adds no direct checker references and stays off the oracle ratchet
 * (#1930/#3273).
 */
import { ts } from "../ts-api.js";

/** True when `type` is an object type with no members of any kind. */
export function isShapelessObjectType(type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  return (
    type.getProperties().length === 0 &&
    type.getCallSignatures().length === 0 &&
    type.getConstructSignatures().length === 0 &&
    type.getStringIndexType() === undefined &&
    type.getNumberIndexType() === undefined
  );
}
