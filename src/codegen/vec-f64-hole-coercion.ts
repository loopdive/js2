// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Preserve the sparse f64 absence marker across a vec representation change. */
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import { holeSentinelInstrs } from "./array-holes.js";
import { f64HoleTestInstrs } from "./vec-f64-hole-presence.js";

/**
 * Wrap the ordinary f64→externref coercion so an internal sparse marker stays
 * a marker. The caller has already built `normalCoercion`, keeping this helper
 * independent from the general coercion engine and its import graph.
 */
export function f64HoleToExternrefInstrs(ctx: CodegenContext, fctx: FunctionContext, normalCoercion: Instr[]): Instr[] {
  if (!ctx.usesArrayHoles) return normalCoercion;
  const elemLocal = allocTempLocal(fctx, { kind: "f64" });
  const instrs: Instr[] = [
    { op: "local.tee", index: elemLocal },
    ...f64HoleTestInstrs(),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: holeSentinelInstrs(ctx),
      else: [{ op: "local.get", index: elemLocal }, ...normalCoercion],
    },
  ];
  releaseTempLocal(fctx, elemLocal);
  return instrs;
}
