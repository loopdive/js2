// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4174) Native-string materialization helpers — flatten at the RIGHT place.
 *
 * The 2026-08-06 standalone-acorn profile attributed 3.7% of total parse
 * self-time to `__str_flatten`, entered once per scanned character from the
 * tokenizer's `skipSpace`/`fullCharCodeAt`. Two compounding causes:
 *
 * 1. `String(x)` lowered to identity for string arguments (and to
 *    `__extern_toString`, whose string arm is also identity, for dynamic
 *    ones). acorn's Parser seeds `this.input = String(input)`; when `input`
 *    is a rope (the standalone benchmark builds it by concatenation), the
 *    ConsString was stored as-is. `__str_flatten`'s #3673 memoization
 *    rewrites the cons's CHILDREN in place but cannot change the object's
 *    type, so the value stays cons-shaped forever and every subsequent
 *    flatten call re-runs the multi-branch memoized-cons dispatch.
 * 2. The legacy native `charCodeAt` arm called `__str_flatten`
 *    unconditionally, paying a cross-function call per character just to
 *    discover the receiver was (or now is) already flat.
 *
 * This module provides flatten-at-materialization helpers for the explicit
 * `String(x)` builtin lowering, and the inline already-flat fast path for the
 * per-character read. Flattening is deliberately NOT added to the generic
 * ToString coercions (`__extern_toString` / `__any_to_string`): those run on
 * `+`/template concat operands, where eager flattening would turn
 * `s += chunk` loops O(n²). `String(x)` is a rare, explicit normalization
 * point — the exact place a "flatten once, read many" invariant belongs.
 *
 * Semantics: a FlatString has identical content to the rope it replaces and
 * JS cannot observe string reference identity, so none of these helpers
 * change observable behavior. Null and non-string values pass through
 * unchanged (`ref.test` fails on both).
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";

/** Look up `__str_flatten`'s shift-maintained funcIdx (#1618), if emitted. */
function strFlattenIdx(ctx: CodegenContext): number | undefined {
  return ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten");
}

/**
 * Flatten a possibly-rope native string held in an externref on the stack.
 *
 * Stack effect: externref → externref. No-op emission outside native-strings
 * mode (host strings have no rope representation) or when the flatten helper
 * is absent (no string machinery in the module — nothing to flatten).
 */
export function emitStringExternResultFlatten(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0 || ctx.anyStrTypeIdx < 0) return;
  const flattenIdx = strFlattenIdx(ctx);
  if (flattenIdx === undefined) return;
  const tmp = allocLocal(fctx, `__strflat_ext_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: tmp });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [
      { op: "local.get", index: tmp },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      { op: "call", funcIdx: flattenIdx },
      { op: "extern.convert_any" },
    ],
    else: [{ op: "local.get", index: tmp }],
  });
}

/**
 * Flatten a possibly-rope `ref`/`ref_null $AnyString` on the stack, preserving
 * the incoming ValType EXACTLY.
 *
 * Preserving the ValType is load-bearing: downstream signature inference (the
 * IR/legacy two-lane "typeIdx parity" contract, src/ir/integration.ts)
 * derives function types from expression result types, so widening `ref` →
 * `ref_null` here demoted acorn's `tokenizer` IR body with a "function
 * typeIdx parity mismatch" fallback during development. For a non-null input
 * the null-passthrough arm is unreachable; non-nullness is re-asserted for
 * the stack type instead of widening the reported type.
 *
 * Returns the (unchanged) result ValType, or `null` when not applicable —
 * caller falls back to its existing identity return.
 */
export function emitStringRefResultFlatten(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argType: ValType,
): ValType | null {
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return null;
  if (argType.kind !== "ref" && argType.kind !== "ref_null") return null;
  // Only `$AnyString` may carry a rope; a `ref $NativeString` is flat by
  // construction and any other struct type is not a string.
  if (argType.typeIdx !== ctx.anyStrTypeIdx) return null;
  const flattenIdx = strFlattenIdx(ctx);
  if (flattenIdx === undefined) return null;
  const anyStrNullable: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  const tmp = allocLocal(fctx, `__strflat_ref_${fctx.locals.length}`, anyStrNullable);
  fctx.body.push({ op: "local.set", index: tmp });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "ref.test", typeIdx: ctx.nativeStrTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: anyStrNullable },
    then: [{ op: "local.get", index: tmp }],
    else: [
      { op: "local.get", index: tmp },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: anyStrNullable },
        // Null passes through unchanged, matching the old identity lowering
        // (a null here is a static-type lie; it traps later exactly where it
        // always did, not at the String() site).
        then: [{ op: "local.get", index: tmp }],
        else: [
          { op: "local.get", index: tmp },
          { op: "call", funcIdx: flattenIdx },
        ],
      },
    ],
  });
  if (argType.kind === "ref") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  return argType;
}

/**
 * Inline already-flat fast path for the per-character read (`charCodeAt`):
 * test flatness at the call site and only enter `__str_flatten` on the
 * rope/Utf8 arm — the same dispatch the IR-path `__str_charCodeAt` helper
 * uses (#3156). A null receiver fails the test and reaches `__str_flatten`,
 * which traps on deref exactly as the old unconditional call did.
 *
 * Stack effect: `ref/ref_null $AnyString` → `ref_null $NativeString`.
 */
export function emitFlattenWithInlineFlatFastPath(
  ctx: CodegenContext,
  fctx: FunctionContext,
  flattenIdx: number,
): void {
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const recvLocal = allocLocal(fctx, `__charCodeAt_recv_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: ctx.anyStrTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: recvLocal });
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "ref.test", typeIdx: strTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "ref_null", typeIdx: strTypeIdx } },
    then: [
      { op: "local.get", index: recvLocal },
      { op: "ref.cast", typeIdx: strTypeIdx },
    ],
    else: [
      { op: "local.get", index: recvLocal },
      { op: "call", funcIdx: flattenIdx },
    ],
  });
}
