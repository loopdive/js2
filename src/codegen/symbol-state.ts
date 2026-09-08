// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { GlobalDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addImport } from "./registry/physical-imports.js";

const STATE_NAMES = [
  "__symbol_counter",
  "__symbol_desc_table",
  "__symbol_intern_table",
  "__symbol_reg_keys",
  "__symbol_reg_ids",
  "__symbol_reg_count",
];

/** Reserve index space before native helper generation can cache global indices. */
export function reserveSymbolStateImports(ctx: CodegenContext): void {
  const state = ctx.standaloneSymbolState;
  if (!state || state === "export") return;
  if (ctx.mod.globals.length || ctx.mod.functions.length)
    throw new Error("Symbol state imports must be reserved before code generation.");
  for (const name of STATE_NAMES) {
    if (!addImport(ctx, state.module, name, { kind: "global", type: { kind: "externref" }, mutable: true })) {
      throw new Error("Cannot reserve Symbol state import " + name);
    }
  }
}

/** One realm owns every identity-bearing Symbol table, including boxed values. */
export function allocateSymbolState(ctx: CodegenContext, global: GlobalDef): number {
  const state = ctx.standaloneSymbolState;
  if (state && state !== "export") {
    let index = 0;
    for (const entry of ctx.mod.imports) {
      if (entry.desc.kind !== "global") continue;
      if (entry.module === state.module && entry.name === global.name) {
        entry.desc.type = global.type;
        if (state.reexport) ctx.mod.exports.push({ name: global.name, desc: { kind: "global", index } });
        return index;
      }
      index++;
    }
    throw new Error("Unreserved Symbol state import " + global.name);
  }
  const index = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push(global);
  if (state === "export") ctx.mod.exports.push({ name: global.name, desc: { kind: "global", index } });
  return index;
}
