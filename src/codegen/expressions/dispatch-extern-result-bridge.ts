// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6684) Keep a LIVE dispatch arm's externref result when the call site
 * expects a nullable WasmGC reference, under `--target standalone` / `wasi`.
 *
 * The closure-call dispatch ladders (`call-identifier.ts` for `f(x)`,
 * `calls-closures.ts` for `obj.f(x)`) test the callee's runtime funcref
 * against every candidate signature. When the matching candidate returns
 * `externref` but the call site's static result is a typed reference — a
 * JSDoc `@returns {string}` makes it the native-string carrier — no bridge
 * applied and the arm fell into the dead-arm placeholder: `drop` the result,
 * answer `ref.null`. That placeholder is right for arms that never run, but
 * for the LIVE arm it silently discarded the value. lodash-es's `toString`
 * (`@returns {string}`) is exported through a runtime-eval carrier whose
 * trampoline returns externref, so `toString("abc")` answered `undefined` in
 * the importer and `words(text).length` trapped on a null.
 *
 * The bridge is a GUARDED downcast, not `ref.cast`: the value survives when it
 * really is a `T`, and anything else still answers `null` — exactly the
 * previous answer — so it can never trap where the old code did not. It is a
 * pure reference test (no call, no import), which the ladders require of
 * every arm (#2174: a late import from a dead arm shifts baked indices).
 *
 * Returns null — caller keeps its placeholder — off the no-host lanes and for
 * a non-struct/array target.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";

export function guardedExternRefResultBridge(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
): Instr[] | null {
  if (!(ctx.standalone || ctx.wasi)) return null;
  if (from.kind !== "externref" && from.kind !== "ref_extern") return null;
  if (to.kind !== "ref_null" && to.kind !== "ref") return null;
  // `ref.test` from `anyref` is valid only against struct/array heap types.
  const toDef = ctx.mod.types[to.typeIdx];
  if (toDef?.kind !== "struct" && toDef?.kind !== "array") return null;
  const scratch = allocLocal(fctx, `__dispatch_ret_any_${fctx.locals.length}`, { kind: "anyref" });
  return [
    { op: "any.convert_extern" },
    { op: "local.tee", index: scratch },
    { op: "ref.test", typeIdx: to.typeIdx },
    {
      op: "if",
      // Same block type the ladder declares; its dead-arm placeholder
      // (`defaultValueInstrs`) answers `ref.null` for both kinds too.
      blockType: { kind: "val", type: to },
      then: [
        { op: "local.get", index: scratch },
        { op: "ref.cast", typeIdx: to.typeIdx },
      ],
      else: [{ op: "ref.null", typeIdx: to.typeIdx }],
    },
  ];
}
