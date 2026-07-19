// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";

/**
 * (#2963 Tier 2a) The f64 predicate body shared by BOTH the direct
 * `Number.is<X>(n)` call lowering (`call-builtin-static.ts`) and the reified
 * first-class value closure (`builtin-value-read.ts`
 * `ensureStandaloneBuiltinStaticMethodClosure`). Factoring it here guarantees
 * the reified `const f = Number.isInteger; f(x)` closure is byte-for-byte the
 * SAME numeric test as the direct call — observational identity is the #2963
 * acceptance bar — and keeps the two paths from drifting.
 *
 * `v` is a wasm local index holding the already-unboxed f64 candidate; the
 * emitted sequence consumes nothing off the stack and leaves a single i32
 * (0/1) boolean. It does NOT do ToNumber — the no-coercion §21.1.2.x rule is
 * enforced by the CALLER (a `__typeof_number` / static-number-type guard):
 * these ops only run once the argument is known to be a Number.
 *
 * The op sequences are IDENTICAL to the historical inline lambdas in
 * `tryCompileBuiltinStaticCall` (verified byte-inert via prove-emit-identity):
 *   - isNaN:         n !== n
 *   - isInteger:     n === trunc(n) && (n - n === 0)   [finite]
 *   - isFinite:      n - n === 0
 *   - isSafeInteger: isInteger(n) && abs(n) <= MAX_SAFE_INTEGER
 */
export function numberIsPredicateOps(method: string, v: number): Instr[] {
  switch (method) {
    case "isNaN":
      // NaN !== NaN is true; any other number → false.
      return [{ op: "local.get", index: v }, { op: "local.get", index: v }, { op: "f64.ne" }];
    case "isInteger":
      // n === trunc(n) && isFinite(n)
      return [
        { op: "local.get", index: v },
        { op: "local.get", index: v },
        { op: "f64.trunc" },
        { op: "f64.eq" },
        // finite: n - n === 0 (Infinity - Infinity = NaN, NaN !== 0)
        { op: "local.get", index: v },
        { op: "local.get", index: v },
        { op: "f64.sub" },
        { op: "f64.const", value: 0 },
        { op: "f64.eq" },
        { op: "i32.and" },
      ];
    case "isFinite":
      // isFinite(n) → n - n === 0.0
      return [
        { op: "local.get", index: v },
        { op: "local.get", index: v },
        { op: "f64.sub" },
        { op: "f64.const", value: 0 },
        { op: "f64.eq" },
      ];
    case "isSafeInteger":
      // isSafeInteger(n) = isInteger(n) && abs(n) <= MAX_SAFE_INTEGER
      return [
        // isInteger: n === trunc(n) && isFinite(n)
        { op: "local.get", index: v },
        { op: "local.get", index: v },
        { op: "f64.trunc" },
        { op: "f64.eq" },
        { op: "local.get", index: v },
        { op: "local.get", index: v },
        { op: "f64.sub" },
        { op: "f64.const", value: 0 },
        { op: "f64.eq" },
        { op: "i32.and" },
        // abs(n) <= MAX_SAFE_INTEGER
        { op: "local.get", index: v },
        { op: "f64.abs" },
        { op: "f64.const", value: Number.MAX_SAFE_INTEGER },
        { op: "f64.le" },
        { op: "i32.and" },
      ];
    default:
      throw new Error(`numberIsPredicateOps: unknown Number.is* method '${method}'`);
  }
}
