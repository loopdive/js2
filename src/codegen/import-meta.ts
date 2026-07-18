// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2970) `import.meta` per-module object identity.
 *
 * `sec-meta-properties-runtime-semantics-evaluation`: `module.[[ImportMeta]]`
 * is created once per module record and cached; distinct module records have
 * distinct objects. Multi-file compiles land in a single Wasm module, so the
 * per-module object is modelled as ONE shared zero-field `$ImportMeta` struct
 * type with a DISTINCT immutable global instance per source file.
 *
 * A bare `import.meta` value read returns the global for the source file the
 * expression syntactically occurs in — so a function declared in module `A`
 * that returns `import.meta` yields `A`'s object regardless of caller, giving:
 *   - stable identity within a module (`fixture_meta === getMeta()`),
 *   - distinct identity across modules (`import.meta !== fixture_meta`).
 *
 * `import.meta.<prop>` reads (e.g. `.url`) are intercepted upstream in
 * `trySuperAndImportMetaRead` (property-access-dispatch), so this object never
 * needs concrete fields — only reference identity.
 */
import type { StructTypeDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Register the shared zero-field `$ImportMeta` struct type once. */
function ensureImportMetaType(ctx: CodegenContext): number {
  if (ctx.importMetaTypeIdx !== undefined) return ctx.importMetaTypeIdx;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: "ImportMeta", fields: [] } as StructTypeDef);
  ctx.importMetaTypeIdx = typeIdx;
  ctx.structMap.set("ImportMeta", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "ImportMeta");
  ctx.structFields.set("ImportMeta", []);
  return typeIdx;
}

/**
 * Get-or-create the immutable `$ImportMeta` singleton global for `fileName`.
 * Each source file gets its own `struct.new $ImportMeta` instance, so distinct
 * files compare unequal by reference identity while a single file is stable.
 * Returns the global index (`global.get`-able as `(ref $ImportMeta)`).
 */
export function ensureImportMetaObject(ctx: CodegenContext, fileName: string): number {
  const existing = ctx.importMetaGlobals.get(fileName);
  if (existing !== undefined) return existing;

  const typeIdx = ensureImportMetaType(ctx);
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: `__import_meta_${ctx.importMetaGlobals.size}`,
    type: { kind: "ref", typeIdx },
    mutable: false,
    init: [{ op: "struct.new", typeIdx }],
  });
  ctx.importMetaGlobals.set(fileName, globalIdx);
  return globalIdx;
}
