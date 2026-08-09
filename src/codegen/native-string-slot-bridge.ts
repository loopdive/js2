// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3989 — the externref-slot <-> native-string bridge for string compound
// assignment, as ONE symmetric pair.
//
// `__str_concat` accepts and returns `ref $AnyString`. But the store slot for
// an `any`/untyped binding — an unannotated param, or a `var` initialised with
// a String OBJECT wrapper (`new String("t")`) — is `externref`. So a string
// `+=` against such a slot has to cross the boundary TWICE: once inbound
// (slot -> `ref $AnyString`, before the concat) and once outbound
// (`ref $AnyString` -> slot, after it).
//
// These two halves were previously written inline at the call site and drifted:
// #3472 added the inbound coercion and left the outbound one missing, so the
// concat result was stored straight into an externref slot and the module
// failed to VALIDATE (`global.set[0] expected type externref, found call of
// type (ref null 6)`) — which costs the whole file, not the statement. Keeping
// the pair in one module is the point: they are inverses, and a future change
// to one is now visibly a change to half of a pair.
//
// Both directions are gated on the SAME condition (`noJsHost` + externref
// slot). In JS-host `nativeStrings` mode the inbound coercion is deliberately
// skipped — `__extern_toString` is a host import there, and adding it mid-body
// would shift function indices (#1175) — so those modules never reach the
// store either. Matching the gate keeps that lane byte-identical rather than
// half-fixing it.

import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

/**
 * True when this slot needs the externref bridge: no JS host available AND the
 * slot is `externref` rather than a native `ref $AnyString`.
 *
 * `noJsHost` is the standalone / WASI lane. Under a JS host the inbound
 * coercion cannot be emitted without shifting function indices (#1175), so the
 * bridge is skipped in BOTH directions and the lane stays byte-identical.
 */
export function slotNeedsExternrefBridge(ctx: CodegenContext, slotType: ValType | undefined): boolean {
  const noJsHost = ctx.standalone === true || ctx.wasi === true;
  return noJsHost && slotType?.kind === "externref";
}

/**
 * INBOUND (#3472): the loaded `externref` current value -> `ref $AnyString`,
 * so `__str_concat` receives the `(ref null $AnyString)` it declares.
 *
 * Routed through ToString (§7.1.17) rather than a bare `ref.cast` so a runtime
 * number / undefined / object stringifies correctly instead of trapping — the
 * same `__extern_toString` path `compileNativeConcatOperand` uses for a dynamic
 * externref `+` operand. `__extern_toString` is a NATIVE defined function in
 * this lane (OBJECT_RUNTIME_HELPER_NAMES), so registering it adds no import and
 * shifts no function index — callers may safely hold a `funcIdx` across it.
 */
export function emitExternrefSlotToAnyStr(ctx: CodegenContext, fctx: FunctionContext): void {
  const externToStr = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (externToStr !== undefined) {
    fctx.body.push({ op: "call", funcIdx: externToStr });
  }
  // externref → ref $AnyString (mirrors emitNativeStringRefFromExternref).
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
}

/**
 * OUTBOUND (#3989): the `ref $AnyString` concat result -> `externref`, so it
 * can be stored back into the slot it came from.
 *
 * `extern.convert_any` is the exact inverse of the `any.convert_extern` the
 * inbound direction uses, so the round trip is slot-type-preserving. Adds no
 * import (no funcIdx shift) and is stack-neutral: one value in, one value out.
 */
export function emitAnyStrToExternrefSlot(fctx: FunctionContext): void {
  fctx.body.push({ op: "extern.convert_any" });
}
