// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../wasm/model/instructions.js";
import type { CodegenContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/** Resolve before queue helper indices are minted. Never treat a same-named
 * local function or a mismatched import as the requested host scheduler.
 */
export function registerMicrotaskNotification(ctx: CodegenContext): Instr[] {
  const binding = ctx.standaloneMicrotaskNotifyImport;
  if (!binding) return [];
  const index = ensureLateImport(ctx, binding.name, [], [], binding.module);
  // Complete this import batch before emitting a call to its newly inserted
  // index; that call must not be shifted as an older defined-function ref.
  flushLateImportShifts(ctx, ctx.currentFunc ?? null);
  const functions = ctx.mod.imports.filter((entry) => entry.desc.kind === "func");
  const imported = index === undefined ? undefined : functions[index];
  if (
    !imported ||
    imported.module !== binding.module ||
    imported.name !== binding.name ||
    imported.desc.kind !== "func"
  ) {
    throw new Error("native microtask notification does not resolve to its requested import");
  }
  const type = ctx.mod.types[imported.desc.typeIdx];
  if (type?.kind !== "func" || type.params.length !== 0 || type.results.length !== 0) {
    throw new Error("native microtask notification must have signature () -> void");
  }
  return [{ op: "call", funcIdx: index! }];
}
