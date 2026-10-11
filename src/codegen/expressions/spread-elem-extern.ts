// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Project one element of a spread source (`f(...src)`) to the externref that
 * `__extras_argv` — and therefore the callee's `arguments` object — stores.
 *
 * Numbers are boxed, externrefs pass through, and GC refs are converted with
 * `extern.convert_any`. The exception is `$AnyValue` (#6736): in an untyped
 * standalone program `[0, 'a']` is a vec of tagged unions, and a union struct is
 * not a JS value. Converting it directly put the struct itself into `arguments`,
 * so `arguments[0] === 0` was false and `typeof arguments[0]` answered
 * "object". It is projected through the coercion engine instead, which unboxes
 * the union to the value it carries. Standalone-gated: the JS-host lane keeps
 * its existing lowering byte for byte.
 */
import type { Instr, ValType } from "../../ir/types.js";

/**
 * `anyToExtern` answers the `$AnyValue` projection (or `undefined` for any other
 * type). The caller supplies it because the coercion engine lives inside the
 * codegen import cycle, and this module stays outside it.
 */
export function spreadElemToExternInstrs(
  elemType: ValType,
  boxIdx: number | undefined,
  anyToExtern: (elemType: ValType) => Instr[] | undefined,
): Instr[] {
  const kind = elemType.kind;
  if (kind === "f64") {
    return boxIdx !== undefined ? [{ op: "call", funcIdx: boxIdx }] : [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  if (kind === "i32" || kind === "i8" || kind === "i16") {
    return boxIdx !== undefined
      ? [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx }]
      : [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  if (kind === "ref" || kind === "ref_null") {
    return anyToExtern(elemType) ?? [{ op: "extern.convert_any" }];
  }
  // externref element — already correct.
  return [];
}
