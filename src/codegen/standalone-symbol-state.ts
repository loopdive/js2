// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";
import { addImport } from "./registry/physical-imports.js";
import { ensureSymbolCarrier, ensureSymbolDescTable, ensureSymbolRegistry } from "./symbol-native.js";
import { ensureSymbolCounter } from "./literals.js";

const NAMES = [
  "__symbol_counter",
  "__symbol_desc_table",
  "__symbol_intern_table",
  "__symbol_reg_keys",
  "__symbol_reg_ids",
  "__symbol_reg_count",
] as const;
const reservations = new WeakMap<CodegenContext, { indices: Map<string, number>; filled: Set<string> }>();

/** Reserve imported indices before any defined global/body is created. Typed
 * table descriptors are filled by their native producers below, before emit. */
export function prepareStandaloneSymbolState(ctx: CodegenContext): void {
  const state = ctx.standaloneSymbolState;
  if (!state) return;
  if (typeof state === "object") {
    if (ctx.mod.globals.length) throw new Error("shared Symbol imports must precede defined globals");
    const indices = new Map<string, number>();
    for (const name of NAMES) {
      indices.set(name, ctx.numImportGlobals);
      const type: ValType =
        name === "__symbol_counter" || name === "__symbol_reg_count" ? { kind: "i32" } : { kind: "externref" };
      if (!addImport(ctx, state.module, name, { kind: "global", type, mutable: true }))
        throw new Error("shared Symbol state import refused");
    }
    reservations.set(ctx, { indices, filled: new Set() });
  }
  ensureSymbolCounter(ctx);
  ensureSymbolCarrier(ctx);
  ensureSymbolDescTable(ctx);
  ensureSymbolRegistry(ctx);
}

/** One native allocation authority for defined and Context-imported state. */
export function symbolStateGlobal(ctx: CodegenContext, name: string, type: ValType, init: Instr[]): number {
  const state = reservations.get(ctx);
  if (state) {
    const index = state.indices.get(name);
    const item = ctx.mod.imports.find(
      (item) => item.name === name && item.module === (ctx.standaloneSymbolState as { module: string }).module,
    );
    if (index === undefined || item?.desc.kind !== "global") throw new Error("unreserved shared Symbol state global");
    item.desc.type = type;
    state.filled.add(name);
    return index;
  }
  const index = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({ name, type, mutable: true, init });
  return index;
}

export function publishStandaloneSymbolState(ctx: CodegenContext): void {
  const option = ctx.standaloneSymbolState;
  if (!option) return;
  const state = reservations.get(ctx);
  if (state && state.filled.size !== NAMES.length) throw new Error("shared Symbol state has unfilled typed imports");
  if (option !== "export" && !option.reexport) return;
  for (const name of NAMES) {
    if (ctx.mod.exports.some((entry) => entry.name === name)) throw new Error("shared Symbol state export is occupied");
    const defined = ctx.mod.globals.findIndex((global) => global.name === name);
    const index = state?.indices.get(name) ?? (defined < 0 ? -1 : ctx.numImportGlobals + defined);
    if (index < 0) throw new Error("shared Symbol state global missing");
    ctx.mod.exports.push({ name, desc: { kind: "global", index } });
  }
}
