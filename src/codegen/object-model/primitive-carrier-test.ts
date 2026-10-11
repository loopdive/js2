// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 V10a) "Is this externref a bare PRIMITIVE carrier?" — the standalone
 * representations a primitive takes before any ToObject: an i31 / boxed number,
 * a boxed boolean, a native string, a `$Symbol`. Leaves an i32 on the stack.
 *
 * Used where the spec's GetV / Invoke (§7.3.2, §7.3.20) must ToObject a
 * primitive `this` while an object-only predicate would answer "no such
 * property": `Promise.prototype.catch.call(true)` must find
 * `Boolean.prototype.then`. Absent carrier types are skipped, so a module that
 * never mints one emits no test for it.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

const I31_HEAP_TYPE = -20;

export function primitiveCarrierTestInstrs(ctx: CodegenContext, valueLocal: number): Instr[] {
  const typeIdxs = [
    I31_HEAP_TYPE,
    ctx.nativeBoxNumberTypeIdx,
    ctx.nativeBoxBooleanTypeIdx,
    ctx.anyStrTypeIdx,
    ctx.symbolTypeIdx,
  ].filter((idx) => idx === I31_HEAP_TYPE || idx >= 0);
  const out: Instr[] = [];
  typeIdxs.forEach((typeIdx, i) => {
    out.push({ op: "local.get", index: valueLocal }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx });
    if (i > 0) out.push({ op: "i32.or" });
  });
  return out;
}
