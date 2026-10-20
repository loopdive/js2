// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr } from "../core/nodes.js";
import type { BackendEmitter } from "./emitter.js";
import type { IrLowerResolver } from "./lower-contracts.js";
export function emitNativeGlobalRead<S>(
  instr: Extract<IrInstr, { kind: "global.get" }>,
  emitter: BackendEmitter<S>,
  resolver: IrLowerResolver,
  out: S,
): void {
  emitter.emitGlobalGet(resolver.resolveGlobal(instr.target), out);
  if (
    instr.resultType?.kind === "vec" &&
    !instr.resultType.nullable &&
    resolver.nativeVectorGlobalReadNonNull?.(instr.target, instr.resultType)
  )
    emitter.pushRaw(out, { op: "ref.as_non_null" }); // pushraw-ok(#6920): issued native global storage refinement
}
