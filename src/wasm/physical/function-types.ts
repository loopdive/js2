// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../model/instructions.js";
import type { TypeDef } from "../model/module-records.js";

/** Build a cache key for a function type signature (params + results). */
export function funcTypeKey(params: ValType[], results: ValType[]): string {
  const part = (v: ValType): string => {
    let s = v.kind;
    if (v.kind === "ref" || v.kind === "ref_null") s += ":" + (v as { typeIdx: number }).typeIdx;
    // (#2795) An `i32` Wasm slot backs `number`, `boolean` (1/0) and symbol
    // HANDLES, which box to the host DIFFERENTLY (`__box_number` vs
    // `__box_boolean` vs `__box_symbol`). The brand rides on the ValType but the
    // bare `kind` is identical, so a brand-blind dedup collapses e.g. a
    // `(f64)->boolean` signature onto a previously-registered `(f64)->number`
    // one — and `getWasmFuncReturnType` then hands callers a PLAIN i32, so a
    // boolean-returning recursive kernel's result boxed as the number 1 instead
    // of `true` (#2795 closures/10-mutual). Keep branded i32 signatures distinct.
    else if (v.kind === "i32") {
      if ((v as { boolean?: true }).boolean) s += ":bool";
      else if ((v as { symbol?: true }).symbol) s += ":sym";
    }
    // (#2846) Same brand-propagation hazard as i32 (#2795), one slot down: a
    // bigint-branded `i64` (`{ kind:"i64"; bigint:true }`) backs a BigInt and
    // boxes to the host via `__box_bigint`, whereas a plain native `i64`
    // (`type i64 = number`) boxes via `__box_number` (`f64.convert_i64_s`,
    // lossy past 2^53). A brand-blind dedup collapses a `(...)->bigint`
    // signature onto a previously-registered plain-`i64` one, so
    // `getWasmFuncReturnType` hands callers a PLAIN i64 and acorn's
    // `stringToBigInt` return got boxed as a rounded number (#2846). Keep the
    // branded i64 signature distinct.
    else if (v.kind === "i64") {
      if ((v as { bigint?: true }).bigint) s += ":big";
    }
    // An f64 undefined sentinel has the same Wasm carrier as an ordinary
    // number, but callers must preserve the brand so boxing can recover
    // `undefined`. Keep it out of the plain-number cache entry just like the
    // i32/i64 semantic carriers above.
    else if (v.kind === "f64") {
      if ((v as { undefSentinel?: true }).undefSentinel) s += ":undef";
    }
    return s;
  };
  return params.map(part).join(",") + "|" + results.map(part).join(",");
}

export function internFunctionType(
  types: TypeDef[],
  cache: Map<string, number>,
  params: ValType[],
  results: ValType[],
  name?: string,
  cacheOnly = false,
): number {
  const key = funcTypeKey(params, results);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (cacheOnly) throw new Error(`function type was not reserved: ${key}`);
  const idx = types.length;
  types.push({
    kind: "func",
    name: name ?? `type${idx}`,
    params,
    results,
  });
  cache.set(key, idx);
  return idx;
}

/** Compare all physical indices and independent semantic carrier brands. */
export function sameValTypes(left: readonly ValType[], right: readonly ValType[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index]!;
      if (value.kind !== other.kind) return false;
      switch (value.kind) {
        case "ref":
        case "ref_null":
          return (other.kind === "ref" || other.kind === "ref_null") && value.typeIdx === other.typeIdx;
        case "i32":
          return other.kind === "i32" && value.boolean === other.boolean && value.symbol === other.symbol;
        case "i64":
          return other.kind === "i64" && value.bigint === other.bigint;
        case "f64":
          return other.kind === "f64" && value.undefSentinel === other.undefSentinel;
        default:
          return true;
      }
    })
  );
}
