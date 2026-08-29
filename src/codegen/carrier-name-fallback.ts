// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// carrier-name-fallback.ts (#5187) — when may a receiver be NAMED by the WasmGC
// carrier it lowers to?
//
// #5204 (`8f161cbf15`) gave `resolveStructNameForExpr` a last-resort fallback:
// when the checker cannot name a receiver's struct, answer with the struct name
// of the wasm carrier the receiver lowers to. That is what lets the
// self-hosting lane read fields off receivers whose checker type the struct
// registry does not key by name.
//
// Unconditional, it also names carriers for receivers that have no business on
// the struct path. A JS array lowers to a `__vec_<elem>` carrier whose only
// fields are `length` and `data`; an ad-hoc property (`a.foo = 7`) is a
// host/side-map property, not a slot. Naming the vec sent the READ down the
// struct path while the WRITE stayed dynamic, so `a.foo` read back `null` —
// which is why the whole `RegExp/prototype/exec` family regressed: its fixture
// is `__expected = ["1"]; __expected.index = 0`.
//
// The discriminator is NOT the carrier's name. `__regexp_match_vec` is a vec
// too, and `m.index` on an exec result is a genuine field read that must keep
// resolving — screening by `isSyntheticStructName` fixes the array case and
// breaks that one (measured: `built-ins/RegExp/prototype/exec` 43 → 42 pass).
//
// The discriminator is whether the carrier actually HAS the member. The
// fallback exists to reach a field the checker could not name; if the member is
// not a field of that struct, naming it cannot help and can only divert the
// access away from the dynamic path that does know where the value lives.
//
// Private identifiers are excluded outright: brand-checked private dispatch
// resolves its declaring class exactly and must never be redirected by a
// carrier guess.

import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * The struct name a receiver may borrow from its wasm carrier for an access to
 * `accessedMember`, or `undefined` when the access must stay on the dynamic
 * path.
 *
 * Answers `undefined` for a non-ref carrier, an unknown/private member, and —
 * the #5187 case — a member that is not a physical field of that struct.
 */
export function carrierNameForAccess(
  ctx: CodegenContext,
  resolvedCarrier: ValType | undefined,
  accessedMember: ts.MemberName | undefined,
): string | undefined {
  if (resolvedCarrier?.kind !== "ref" && resolvedCarrier?.kind !== "ref_null") return undefined;
  if (accessedMember === undefined || ts.isPrivateIdentifier(accessedMember)) return undefined;
  const carrierName = ctx.typeIdxToStructName.get(resolvedCarrier.typeIdx);
  if (carrierName === undefined) return undefined;
  const fields = ctx.structFields.get(carrierName);
  return fields?.some((field) => field.name === accessedMember.text) === true ? carrierName : undefined;
}
