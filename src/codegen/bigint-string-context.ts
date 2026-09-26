// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6656 slice 2) Exact ToString for a STATICALLY bigint-typed operand in a
 * string context.
 *
 * ## The gap
 *
 * A bigint whose static type is `bigint` is carried as a branded i64
 * (`{ kind: "i64", bigint: true }`). Every string context in `string-ops.ts`
 * — the native-strings operand arm, a template span, a `String.raw`
 * substitution and the two `+` concat operands — stringified it the same way
 * it stringifies a native `type i64 = number`: `f64.convert_i64_s` followed by
 * `number_toString`. That is exact only up to 2^53.
 *
 * Measured on base `bccd46c552`, `--target standalone`:
 *
 * | expression                        | before             | Node   |
 * | --------------------------------- | ------------------ | ------ |
 * | `(9007199254740993n).toString()`  | `…993`             | `…993` |
 * | `String(9007199254740993n)`       | `…992`             | `…993` |
 * | `"" + 9007199254740993n`          | `…992`             | `…993` |
 * | `String(9223372036854775807n)`    | `9223372036854776000` | `…807` |
 *
 * The first row is the tell: the exact answer machinery has existed since
 * #1644 (`bigint_toString` in `bigint-format-native.ts`, an i64-exact
 * sign-aware decimal formatter), and #6642 S62 routed the DYNAMIC receiver and
 * `__any_to_string` to it. Only the static-operand string contexts were left
 * on the f64 path — which is why an `any`-typed bigint printed correctly while
 * a `bigint`-typed one did not.
 *
 * ## Why this matters beyond printing
 *
 * `@js-temporal/polyfill` moves values between its JSBI carrier and real
 * BigInt through decimal STRINGS (`globalThis.BigInt(t.toString(10))`), so a
 * rounded `String(bigint)` corrupts values that never left i64 range at all.
 * That is the `SameValue(«NaN», «9007199254740992»)` signature on the
 * `Duration` max/precision rows.
 *
 * ## Absent-not-wrong
 *
 * `bigIntToStringIdx` answers `undefined` unless the operand actually carries
 * the `bigint` brand, the lane emits the NATIVE number formatters
 * (`usesNativeNumberFormat` — standalone / WASI / native-strings, where
 * `bigint_toString` is a defined function rather than a host `env` import) and
 * the module demanded the helper. Every caller keeps its existing f64 arm as
 * the fallthrough, so a module that does not meet all three conditions
 * compiles byte-identically.
 *
 * The native-format gate is what keeps the JS-host lane inert: there
 * `bigint_toString` would be registered as an `env` IMPORT by
 * `finalizeUnifiedCollector`, adding an import (and shifting every function
 * index) to modules that never asked for one.
 *
 * ## ABI
 *
 * `bigint_toString: (i64) -> externref`, identical to `number_toString`'s
 * `(f64) -> externref`, so the helper is a drop-in at each call site: the
 * caller's own `emitNativeStringRefFromExternref` / plain-externref handling
 * after the call is unchanged.
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { usesNativeNumberFormat } from "./number-format-native.js";

/**
 * Index of the exact `bigint_toString` formatter to use for `opType`, or
 * `undefined` when the caller must keep its existing numeric path.
 */
export function bigIntToStringIdx(ctx: CodegenContext, opType: ValType | undefined): number | undefined {
  if (!opType || opType.kind !== "i64" || opType.bigint !== true) return undefined;
  if (!usesNativeNumberFormat(ctx)) return undefined;
  return ctx.funcMap.get("bigint_toString");
}

/**
 * Import-collector side of the same decision: register the exact formatter for
 * a string context whose operand is statically `bigint`.
 *
 * The `usesNativeNumberFormat` gate is the load-bearing half. In the JS-host
 * lane `finalizeUnifiedCollector` turns this demand into an `env` IMPORT, and a
 * new import shifts every function index — so a module that merely PRINTS a
 * bigint would move bytes in a lane whose bigints do not even use the i64
 * carrier. `bigIntToStringIdx` declines symmetrically, so the two halves can
 * never disagree.
 */
export function registerBigIntToStringDemand(ctx: CodegenContext, needed: Set<string>, isBigIntOperand: boolean): void {
  if (!isBigIntOperand) return;
  if (!usesNativeNumberFormat(ctx)) return;
  needed.add("bigint_toString");
}
