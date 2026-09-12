// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Physical import and exception-tag registration without source collection. */
import type { Import, TagDef } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { buildStrictHostImportError, isHostImportAllowed } from "../host-import-allowlist.js";
import { addFuncType } from "./types.js";
import { appendPhysicalImport } from "../../wasm/physical/module-reservations.js";

/**
 * Register a physical import without loading source-collection code. This
 * narrow surface is used by PreparedIrProgram consumption and remains
 * independent of the high-level registry module.
 */
export function addImport(ctx: CodegenContext, module: string, name: string, desc: Import["desc"]): Import | undefined {
  if (ctx.indexSpaceFrozen) {
    throw new Error(
      `import space frozen (#1984): '${module}.${name}' added after finalize — ` +
        `this producer must register its import before the freeze point or refuse loudly`,
    );
  }
  if (ctx.strictNoHostImports) {
    const decision = isHostImportAllowed(module, name, ctx.linkedNamespaces);
    if (!decision.allowed) {
      const message = buildStrictHostImportError(module, name);
      ctx.errors.push({ message, line: 0, column: 0, severity: "degrade" });
      if (desc.kind === "func") {
        const recorded = (ctx.mod.strictDroppedHostImports ??= []);
        if (!recorded.some((d) => d.module === module && d.name === name)) {
          recorded.push({ module, name });
        }
      }
      return undefined;
    }
  }
  appendPhysicalImport(ctx.mod, module, name, desc);
  if (desc.kind === "func") {
    ctx.funcMap.set(name, ctx.numImportFuncs);
    ctx.numImportFuncs++;
  }
  if (desc.kind === "global") {
    ctx.numImportGlobals++;
  }
  return ctx.mod.imports[ctx.mod.imports.length - 1]!;
}

/** Lazily register the shared or module-local exception tag. */
export function ensureExnTag(ctx: CodegenContext): number {
  if (ctx.exnTagIdx >= 0) return ctx.exnTagIdx;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], []);
  if (ctx.sharedExnTag) {
    ctx.exnTagIdx = ctx.mod.imports.filter((imp) => imp.desc.kind === "tag").length;
    addImport(ctx, "env", "__exn", { kind: "tag", typeIdx });
    return ctx.exnTagIdx;
  }
  const tagDef: TagDef = { name: "__exn", typeIdx };
  ctx.exnTagIdx = ctx.mod.tags.length;
  ctx.mod.tags.push(tagDef);
  return ctx.exnTagIdx;
}
