// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6650) The two reasons an object literal is built on the open host
 * `$Object` route (`__new_plain_object` + `__extern_set`, yielding an
 * externref) rather than as a closed WasmGC struct:
 *
 *  - its SHAPE forbids a struct — `objectLiteralForcesHostPath` (accessors,
 *    runtime-computed keys, colon-`__proto__`, an empty-string key, …);
 *  - it SPREADS into a non-specific contextual position —
 *    `objectLiteralSpreadTakesHostPath` (#2804).
 *
 * Every boundary that has to pin a carrier for such a literal must consult
 * BOTH, or the two halves disagree: the value is an externref while the
 * boundary's ABI is the checker-inferred concrete struct, and the guarded
 * downcast (`ref.test` → `ref.cast` / `ref.null none`) takes the null arm on
 * every evaluation. `typeof` still answers `"object"`; every property read
 * answers null or traps.
 *
 * The local-binding boundary (`statements/variables.ts`) and the captured-init
 * boundary (`statements/nested-declarations.ts`) already do. The FUNCTION
 * RETURN boundary (`functionReturnsHostObjectLiteralCarrier`) consulted only
 * the shape-driven predicate until #6650, which is why
 * `function f() { const o = {…}; return { ...o, days: 9 }; }` answered null for
 * every caller — the defect behind `Temporal.PlainDate.prototype.add` failing
 * for every input in standalone (the polyfill's `Wr()` is exactly that shape).
 */
import { objectLiteralForcesHostPath, objectLiteralSpreadTakesHostPath } from "../literals.js";
import type { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/** True when this literal's VALUE is an open host `$Object` externref, for either reason. */
export function objectLiteralTakesHostCarrier(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): boolean {
  return objectLiteralForcesHostPath(ctx, expr) || objectLiteralSpreadTakesHostPath(ctx, expr);
}
