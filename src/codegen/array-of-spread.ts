// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The standalone `Array.of(...items)` backing array (#6421).
 *
 * §23.1.2.3 makes every argument an element, so the result length is the
 * argument list's RUNTIME length — which a spread makes unknowable at compile
 * time. The #1633 standalone arm sized the vec from `arguments.length` and
 * therefore excluded spread lists outright (`noJsHost && !hasSpreadArg`); they
 * fell through to the host path, whose `__js_array_new` / `__array_of` imports
 * do not exist in a standalone build. Measured on `699df289e1`: the module no
 * longer instantiates at all ("Native-first adapter cannot bind
 * env::__js_array_new").
 *
 * Extracted from `call-builtin-static.ts`, which is at its god-file LOC ceiling
 * (#3102): the arm is the `Array.prototype.push` spread sink (`array.set` at a
 * running write index) over the shared argument-list builder, and nothing about
 * it is specific to the barrel it used to live in.
 */
import type { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildSpreadArgList, canBuildSpreadArgList } from "./spread-arg-list.js";

/**
 * Build the vec for a SPREAD-containing standalone `Array.of` call.
 *
 * Returns the vec's type on success and `undefined` when the call must keep the
 * caller's existing path — no expansion substrate on this target, or a
 * non-nullable element type, which has no `array.new_default` zero value.
 * Nothing is emitted in either case.
 */
export function tryEmitArrayOfSpreadVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  shape: { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType },
): ValType | undefined {
  const { vecTypeIdx, arrTypeIdx, elemType } = shape;
  if (elemType.kind === "ref") return undefined;
  if (!canBuildSpreadArgList(ctx, fctx, elemType)) return undefined;
  const built = buildSpreadArgList(ctx, fctx, args, 0, elemType, "arrof_sp");
  if (!built) return undefined;

  const dataLocal = allocLocal(fctx, `__arrof_sp_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const writeLocal = allocLocal(fctx, `__arrof_sp_w_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: built.countLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: writeLocal });
  built.emitStores({
    pre: [
      { op: "local.get", index: dataLocal },
      { op: "local.get", index: writeLocal },
    ],
    post: [
      { op: "array.set", typeIdx: arrTypeIdx },
      { op: "local.get", index: writeLocal },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: writeLocal },
    ],
  });
  fctx.body.push({ op: "local.get", index: built.countLocal });
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}
