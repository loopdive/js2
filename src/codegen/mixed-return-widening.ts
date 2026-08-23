// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4641) The return-slot half of `T | undefined`.
 *
 * ## The wrong answer this removes
 *
 * ```js
 * function f(c) { if (c) return; return 5; }
 * f(true)   // → 0     spec: undefined
 * ```
 *
 * TS infers `f`'s return type as `5 | undefined`; `resolveWasmType`'s union arm
 * strips the nullish member and hands back the inner type, so the wasm result is
 * `f64` — and both places that materialize "no value" for a value-returning
 * function push that type's ZERO:
 *
 *   - `statements/control-flow.ts` for a syntactic bare `return;`
 *   - `function-body.ts` for a fall-off-the-end
 *
 * `f64.const 0` and `i32.const 0` are perfectly legal JS values, so nothing
 * downstream can tell the absent value from a returned `0` / `false`.
 *
 * ## Why widening, and not the sNaN sentinel
 *
 * The tree already owns an f64 `undefined` marker — `UNDEF_F64_BITS` in
 * `value-tags.ts`, a SIGNALING NaN that JS arithmetic can never produce — and
 * `binary-ops.ts` already answers `<f64> === undefined` by comparing its bits
 * (#3369). Emitting it here would be a one-constant change.
 *
 * It is still the wrong mechanism for THIS slot, and #2142's authoritative
 * reconcile (2026-06-15) says so in general terms:
 *
 * > Widen to externref + host `undefined` when the value must be observable to
 * > the general nullish/identity/stringify consumer set (`===`, `!==`,
 * > `typeof`, ToString, `??`). Use the sNaN sentinel ONLY inside the hot f64
 * > carriers whose sole consumer is `emitDefaultValueCheck`.
 *
 * A returned value is observable to all of them, and the sentinel reaches only
 * one: `typeof` still answers `"number"`, ToString still renders `"NaN"`, and
 * the generic f64→externref box deliberately REFUSES to resurrect the pattern
 * (`type-coercion.ts`, #3315 — `Math.abs` preserves the sNaN payload, so an
 * arbitrary f64 carrying those bits is a computed NaN, not `undefined`). The
 * sentinel also has no i32 twin, and `boolean | undefined` is the shape both
 * real-world hits in the #4641 census actually have.
 *
 * ## Why this is affordable at the hottest ABI in the compiler
 *
 * Because the shape is empty exactly where it would cost. Measured for #4641
 * (instruments in `.tmp/`, run on campaign HEAD `52cb0a6a6`):
 *
 * | corpus                                                 | fn bodies | `T\|undefined` → scalar |
 * | ------------------------------------------------------ | --------: | ----------------------: |
 * | `website/playground/examples` + `benchmarks/suites`     |       109 |                   **0** |
 * | moment + marked + redux + lodash                        |     1,254 |            **2** (both i32) |
 * | test262 `es5id:` corpus (syntactic mixed-return shape)  |     5,825 |                      67 |
 *
 * Zero in the perf-benchmark corpus means the benchmark lanes emit
 * byte-identical code: the predicate below fires only on a union that CONTAINS
 * `undefined`, and a function whose inferred type does not say `undefined`
 * never reaches it.
 *
 * ## Scope
 *
 * Return position of a top-level `function` DECLARATION only. Deliberately NOT
 * the general `resolveWasmType` union-collapse reversal — that is #3580 S3
 * (`number | undefined → externref`), which is atomic value-rep substrate with
 * a recorded floor-breach history (PR #2025, NET −1245 test262 rows,
 * auto-parked). Function expressions / arrows / methods keep their existing
 * carrier; see #4641's residual list.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";

/** TS flags that mean "this union member is the absent value". */
const NULLISH_FLAGS = ts.TypeFlags.Undefined | ts.TypeFlags.Void;

/**
 * True when `retType` is a union that CONTAINS `undefined` / `void`. `null` on
 * its own does not qualify — `isNullablePrimitiveType` (#1769/#3666) already
 * widens the explicit-null result family inside `resolveWasmType`, and this is
 * the `| undefined` twin, not a second claim on the same shape.
 */
function unionCarriesUndefined(retType: ts.Type): boolean {
  if (!retType.isUnion()) return false;
  return retType.types.some((member) => (member.flags & NULLISH_FLAGS) !== 0);
}

/**
 * Widen a function-declaration RESULT type when the declaration is
 * mixed-return: some path yields a value, some path yields `undefined`, and the
 * value's carrier is a wasm SCALAR that has no room for the absent value.
 *
 * `lowered` is what the existing pipeline already resolved (so this never
 * re-runs `resolveWasmType` and cannot register a type twice); the return value
 * replaces it. Every non-mixed / non-scalar case returns `lowered` UNCHANGED,
 * which is what keeps this byte-inert for the corpora measured above.
 *
 * Reference carriers are left alone on purpose: a `ref_null` / `externref`
 * result already represents `undefined` (both default-value emit sites push
 * `ref.null` / `emitUndefined` for them), so widening would be a no-op that
 * only cost a coercion.
 */
export function widenMixedUndefinedReturn(retType: ts.Type, lowered: ValType): ValType {
  if (lowered.kind !== "f64" && lowered.kind !== "i32" && lowered.kind !== "i64") return lowered;
  if (!unionCarriesUndefined(retType)) return lowered;
  return { kind: "externref" };
}
