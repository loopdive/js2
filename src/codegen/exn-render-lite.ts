// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6666) The "lite" body of `__exn_render_prepare` — the host-free renderer a
 * standalone/WASI module publishes when its source has NO `throw` statement.
 *
 * #5384 kept the full renderer (`__any_to_string` → `number_toString` → the Ryu
 * tables) only for a module with a source `throw`, because the export-boundary
 * bridge arms `__exn_tag` for essentially every standalone module and a
 * tag-gated full renderer measured 6,076 → 49,032 B on an arith-only module.
 * But a module without a source throw still throws: every compiler-synthesized
 * raise — the ReferenceError for an unresolved identifier, a null-guard
 * TypeError, the boundary's own TypeError — is an `$Error_struct` built from a
 * constant message. Without a renderer those payloads read as the #2870 opaque
 * label ("non-stringifiable payload"), which is how jest's standalone
 * module-init failure stayed undiagnosable (#6666).
 *
 * Every compiler-synthesized payload is an `$Error_struct` or (the
 * no-constructor degrade in `buildThrowJsErrorInstrs`) a bare native string, so
 * those two arms are all this body renders:
 *
 *   - null payload        → -1 (the harness keeps its legacy label)
 *   - `$Error_struct`     → §20.5.3.4 via `__error_to_string` ("TypeError: m")
 *   - native `$AnyString` → the string itself
 *   - anything else       → 0 (unrendered; the harness falls back to the label)
 *
 * It reaches only `__error_to_string` / `__str_concat` / `__str_flatten`, never
 * the number formatter, so #5384's 49 kB cascade does not return: measured
 * 2026-09-28 at -O3, +520 B on the untyped arith floor, +183 B on a module that
 * already carries the string runtime.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * No source `throw` and no published host bridge => the only payloads are
 * compiler-synthesized `$Error_struct`s / strings, so the lite body suffices
 * (the full renderer stays for the test262 harness's `hostBridge: "always"`).
 */
export function usesLiteExnRender(ctx: CodegenContext): boolean {
  return !ctx.emitHostBridge && !ctx.usesSourceThrowStatement;
}

/** Store the flattened `$AnyString` on the stack into the buffer and return its length. */
function storeAndReturnLen(flattenIdx: number, bufGlobalIdx: number, flatTypeIdx: number): Instr[] {
  return [
    { op: "call", funcIdx: flattenIdx },
    { op: "global.set", index: bufGlobalIdx },
    { op: "global.get", index: bufGlobalIdx },
    { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
    { op: "return" },
  ];
}

/**
 * Build the lite `__exn_render_prepare(payload: externref) -> i32` body. All
 * indices are resolved by the caller before any body is built (the
 * index-shift-safety contract of `emitExceptionRenderExports`); this function
 * adds no functions, globals or imports.
 */
export function liteExnRenderPrepareBody(
  ctx: CodegenContext,
  bufGlobalIdx: number,
  flattenIdx: number,
  flatTypeIdx: number,
): Instr[] {
  const payload: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: -1 }, { op: "return" }] },
  ];
  const errToStrIdx = ctx.nativeStrHelpers.get("__error_to_string");
  const errStructIdx = ctx.errorStructTypeIdx;
  if (errToStrIdx !== undefined && errStructIdx >= 0) {
    body.push(
      ...payload,
      { op: "ref.test", typeIdx: errStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...payload,
          { op: "call", funcIdx: errToStrIdx },
          ...storeAndReturnLen(flattenIdx, bufGlobalIdx, flatTypeIdx),
        ],
      },
    );
  }
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx >= 0) {
    body.push(
      ...payload,
      { op: "ref.test", typeIdx: anyStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...payload,
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          ...storeAndReturnLen(flattenIdx, bufGlobalIdx, flatTypeIdx),
        ],
      },
    );
  }
  body.push({ op: "i32.const", value: 0 });
  return body;
}
