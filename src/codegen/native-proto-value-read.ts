// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2984 Phase 2) Standalone `<Builtin>.prototype.<member>` VALUE-read
// resolution policy — the subsystem module behind
// `tryCompileStandaloneBuiltinProtoMemberRead` (property-access.ts).
//
// A builtin-proto member value read resolves in three tiers:
//
//   1. OWN member (advertised in the receiver brand's glue CSV) — the
//      brand-keyed native-method/getter closure. Members whose native body is
//      not wired yet reify through the factory's `refusalBodyFallback`
//      (methods only): an identity-stable closure with spec `.name`/`.length`
//      whose INVOCATION throws a catchable TypeError (the #2193/#2651
//      degrade-to-catchable pattern). This is what makes the ES5 gOPD
//      identity assertion (`gOPD(Date.prototype, "getTime").value ===
//      Date.prototype.getTime`) hold — the #2885 Site-2 descriptor synthesis
//      (calls.ts) and this value read share one singleton per (brand, member).
//   2. INHERITED member — not own, but advertised by `Object.prototype`'s
//      glue. Every builtin prototype ultimately inherits Object.prototype's
//      methods, and the spec value of the inherited read IS the
//      Object.prototype member itself: `Function.prototype.valueOf ===
//      Object.prototype.valueOf` (Sputnik S15.3.4_A4). Resolve through the
//      OBJECT-brand singleton so both syntactic reads yield the same value.
//      NOTE: gOPD keeps own-property semantics — the Site-2 synthesis gates on
//      the receiver's OWN CSV and returns `undefined` for inherited members.
//   3. UNKNOWN member — `null`: the caller falls through to the dynamic path
//      (runtime `undefined`), never minting a phantom closure. (Pre-#2984 the
//      Array family could mint a throwing closure for an unknown member — the
//      `emitArrayProtoMemberBody` non-slice arm accepts any name — so the own-
//      CSV gate here also tightens that latent hole to spec `undefined`.)
//
// The reflective `.call(...)` route (`emitReflectiveNativeProtoClosureCall`,
// calls.ts) deliberately does NOT use this resolver: it relies on the
// factory's null return to fall through to its working legacy lowering
// (`Object.prototype.hasOwnProperty.call(o, k)` — the propertyHelper.js
// idiom), and a throwing refusal body would regress it.

import type { CodegenContext } from "./context/types.js";
import { getNativeProtoBuiltinGlue, ensureStandaloneNativeMethodClosure } from "./native-proto.js";
import { ensureObjectNativeProtoGlue } from "./array-object-proto.js";

/** The `{ type, funcIdx }` closure handle the native-method factory returns. */
export type NativeProtoClosure = { type: { kind: "ref"; typeIdx: number }; funcIdx: number };

/**
 * Resolve a standalone `<Builtin>.prototype.<member>` VALUE read to its
 * native-method/getter closure per the three-tier policy above. Returns the
 * closure plus the resolved kind (`"getter"` only for OWN accessor members —
 * the caller invokes those instead of returning the closure value), or `null`
 * to fall through to the dynamic path.
 */
export function resolveStandaloneProtoMemberValueClosure(
  ctx: CodegenContext,
  brand: number,
  builtinName: string,
  member: string,
): { closure: NativeProtoClosure; kind: "method" | "getter" } | null {
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return null;

  // Tier 1 — own member.
  if (glue.memberCsv.split(",").includes(member)) {
    const kind = glue.memberKind(member);
    // Annex B §B.2.6 defines toGMTString as the same function object as
    // toUTCString. Value reads bypass prototype seeding, so canonicalize here
    // as well as in the seeded-property path.
    const closureMember = builtinName === "Date" && member === "toGMTString" ? "toUTCString" : member;
    const closure = ensureStandaloneNativeMethodClosure(ctx, brand, closureMember, kind, {
      refusalBodyFallback: true,
    });
    return closure ? { closure, kind } : null;
  }

  // Tier 2 — inherited from Object.prototype (methods only; Object.prototype
  // itself advertises no accessor getters in its glue CSV).
  if (builtinName !== "Object") {
    const objBrand = ensureObjectNativeProtoGlue(ctx);
    const objGlue = objBrand !== undefined ? getNativeProtoBuiltinGlue(ctx, objBrand) : undefined;
    if (
      objBrand !== undefined &&
      objGlue &&
      objGlue.memberCsv.split(",").includes(member) &&
      objGlue.memberKind(member) === "method"
    ) {
      const closure = ensureStandaloneNativeMethodClosure(ctx, objBrand, member, "method", {
        refusalBodyFallback: true,
      });
      if (closure) return { closure, kind: "method" };
    }
  }

  // Tier 3 — unknown member: dynamic fall-through.
  return null;
}
