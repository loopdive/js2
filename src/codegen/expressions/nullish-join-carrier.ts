// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5366) The join carrier for `a ?? b` when the two arms compile to different
 * wasm types.
 *
 * `??` used to pick the RIGHT arm's type outright, so the left arm was coerced
 * into it — and `coerceType` lowers an unproven reference narrowing as a
 * GUARDED downcast (`ref.test` … else `ref.null`). A left value whose runtime
 * shape is not the right arm's struct therefore did not fail loudly: it became
 * `null`. hono's `this.router = options.router ?? new SmartRouter(...)` is the
 * canonical shape — the caller-supplied `RegExpRouter` failed the cast against
 * `$SmartRouter` and `app.router` read back `null`, while the default path (an
 * actual `SmartRouter`) worked.
 *
 * `&&` and `||` have always joined a non-numeric mismatch at `externref`, and
 * the conditional operator joins two internal refs at their nearest declared
 * common ancestor (see `compileConditionalExpression`). This module gives `??`
 * the same discipline while keeping the lossless carrier-preserving cases the
 * old rule got right:
 *
 * - the right arm is `$AnyValue` — the designed union carrier, which BOXES the
 *   left arm rather than downcasting it;
 * - the two arms are the same struct, differing only in nullability.
 */
import type { ValType } from "../../ir/types.js";
import { isAnyValue } from "../shared.js";
import type { CodegenContext } from "../context/types.js";
import { nearestDeclaredStructCommonAncestor } from "../struct-hierarchy-layout.js";

/** True for the two internal WasmGC reference carriers. */
function isInternalRef(type: ValType): type is Extract<ValType, { kind: "ref" | "ref_null" }> {
  return type.kind === "ref" || type.kind === "ref_null";
}

/**
 * Pick the type both arms of a `??` can be held in without a null-substituting
 * downcast. `lhs` is the left arm's type, `rhs` the right arm's; the caller has
 * already established that they do not match.
 */
export function nullishJoinCarrier(ctx: CodegenContext, lhs: ValType, rhs: ValType): ValType {
  // A numeric right arm against a reference left arm: externref is the only
  // carrier that holds both (pre-existing rule, kept verbatim).
  if (rhs.kind === "f64" && (lhs.kind === "externref" || isInternalRef(lhs))) {
    return { kind: "externref" };
  }

  if (isInternalRef(lhs) && isInternalRef(rhs)) {
    // `$AnyValue` on exactly one side is a box/unbox, not a downcast; leave
    // that pairing to the existing coercion so the tagged representation is
    // preserved.
    if (isAnyValue(lhs, ctx) !== isAnyValue(rhs, ctx)) return rhs;
    if (lhs.typeIdx === rhs.typeIdx) return { kind: "ref_null", typeIdx: rhs.typeIdx };
    const ancestor = nearestDeclaredStructCommonAncestor(ctx.mod, lhs, rhs);
    return ancestor !== undefined ? { kind: "ref_null", typeIdx: ancestor } : { kind: "externref" };
  }

  // A host-plane left arm carries an arbitrary JS value. Narrowing it to the
  // right arm's concrete struct is exactly the unproven downcast above, so join
  // on the host plane; the right arm converts into it losslessly.
  if ((lhs.kind === "externref" || lhs.kind === "ref_extern") && isInternalRef(rhs) && !isAnyValue(rhs, ctx)) {
    return { kind: "externref" };
  }

  return rhs;
}
