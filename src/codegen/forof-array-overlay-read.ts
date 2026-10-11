// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster G, slice G4) Overlay-aware element read for the `for…of`
 * fast array loop, standalone only.
 *
 * `%ArrayIteratorPrototype%.next` performs `Get(array, index)` (§23.1.5.1 step
 * 8.b), so an accessor installed on an index — or a deleted index shadowed by
 * `Array.prototype[i]` — must be observed, and a throwing getter must propagate
 * (`for-of/array-key-get-error.js`). The direct `compileForOfArray` loop reads
 * the dense backing (`array.get`), which never sees the #3251 vec overlay.
 *
 * This is the same routing the typed element read (`typed-lane-overlay-route.ts`)
 * and the HOF filter (`array-filter-spec-access.ts`) already take, behind the
 * SAME compile-time gate: `overlayRouteActive(ctx)` is set only by the
 * `scanForArrayHoles` pre-pass when the module contains a non-data descriptor
 * define, an index delete, or an inherited numeric property write. When the
 * gate is clear — approximately every real program — nothing here emits and the
 * loop's bytes are unchanged.
 *
 * Exclusions mirror the typed-lane route: the `$__regexp_match_vec` exotic
 * (field 2 is `index`), `arguments`-rooted receivers, and non-`externref`
 * element carriers (numeric vecs keep their undefined-sentinel ABI; routing
 * them would need an unbox that loses `undefined`).
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { overlayRouteActive } from "./typed-lane-overlay-route.js";

function isArgumentsRooted(fctx: FunctionContext, node: ts.Expression): boolean {
  let cur = node;
  while (ts.isParenthesizedExpression(cur) || ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) && cur.text === "arguments" && fctx.localMap.has("arguments");
}

/**
 * The `__extern_get_idx` funcIdx when the loop over `iterable` must read
 * through the overlay, else `undefined` (nothing emitted). Call while the
 * caller still owns the outer `fctx.body` — the registration may flush.
 */
export function forOfArrayOverlayGetIdx(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecFields: readonly { name?: string }[],
  elemType: ValType,
  iterable: ts.Expression,
  preMaterialized: boolean,
): number | undefined {
  if (!overlayRouteActive(ctx) || preMaterialized || elemType.kind !== "externref") return undefined;
  if (vecFields.length >= 4 && vecFields[2]?.name === "index") return undefined;
  if (isArgumentsRooted(fctx, iterable)) return undefined;
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  return getIdx;
}

/** `Get(array, i)` — pushes the element as externref. */
export function forOfArrayOverlayReadInstrs(getIdx: number, vecLocal: number, iLocal: number): Instr[] {
  return [
    { op: "local.get", index: vecLocal },
    { op: "extern.convert_any" },
    { op: "local.get", index: iLocal },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: getIdx },
  ];
}
