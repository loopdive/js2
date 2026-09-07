// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { addImport, ensureExnTag } from "../src/codegen/registry/physical-imports.js";
import { createEmptyModule, type Import } from "../src/ir/types.js";

type PhysicalContext = Pick<
  CodegenContext,
  | "mod"
  | "funcMap"
  | "numImportFuncs"
  | "numImportGlobals"
  | "errors"
  | "indexSpaceFrozen"
  | "strictNoHostImports"
  | "linkedNamespaces"
  | "funcTypeCache"
  | "exnTagIdx"
  | "sharedExnTag"
>;

function context(overrides: Partial<PhysicalContext> = {}): CodegenContext {
  const physical: PhysicalContext = {
    mod: createEmptyModule(),
    funcMap: new Map(),
    numImportFuncs: 0,
    numImportGlobals: 0,
    errors: [],
    indexSpaceFrozen: false,
    strictNoHostImports: false,
    linkedNamespaces: new Set(),
    funcTypeCache: new Map(),
    exnTagIdx: -1,
    sharedExnTag: false,
    ...overrides,
  };
  return physical as CodegenContext;
}

describe("physical import registration", () => {
  it("registers the exact import descriptor and updates only its index space", () => {
    const ctx = context();
    const descriptor: Import["desc"] = { kind: "func", typeIdx: 0 };
    const imported = addImport(ctx, "provider", "call", descriptor);
    expect(imported).toBe(ctx.mod.imports[0]);
    expect(imported!.desc).toBe(descriptor);
    expect(ctx.funcMap.get("call")).toBe(0);
    expect(ctx.numImportFuncs).toBe(1);
    expect(ctx.numImportGlobals).toBe(0);
    addImport(ctx, "provider", "value", { kind: "global", type: { kind: "f64" }, mutable: true });
    expect(ctx.numImportFuncs).toBe(1);
    expect(ctx.numImportGlobals).toBe(1);
    expect(ctx.mod.imports).toHaveLength(2);
  });

  it("rejects new imports after the existing freeze point before changing any space", () => {
    const ctx = context({ indexSpaceFrozen: true });
    expect(() => addImport(ctx, "env", "too_late", { kind: "func", typeIdx: 0 })).toThrow("import space frozen");
    expect(ctx.mod.imports).toHaveLength(0);
    expect(ctx.funcMap.size).toBe(0);
    expect(ctx.numImportFuncs).toBe(0);
    expect(ctx.numImportGlobals).toBe(0);
  });

  it("preserves strict-host allowed namespaces and exact dropped-import evidence", () => {
    const ctx = context({ strictNoHostImports: true, linkedNamespaces: new Set(["provider"]) });
    expect(addImport(ctx, "wasi_snapshot_preview1", "fd_write", { kind: "func", typeIdx: 0 })).toBeDefined();
    expect(addImport(ctx, "provider", "call", { kind: "func", typeIdx: 0 })).toBeDefined();
    for (let attempt = 0; attempt < 2; attempt++)
      expect(addImport(ctx, "env", "not_a_supported_host_import", { kind: "func", typeIdx: 0 })).toBeUndefined();
    expect(ctx.mod.imports).toHaveLength(2);
    expect(ctx.numImportFuncs).toBe(2);
    expect(ctx.funcMap.has("not_a_supported_host_import")).toBe(false);
    expect(ctx.mod.strictDroppedHostImports).toEqual([{ module: "env", name: "not_a_supported_host_import" }]);
    expect(ctx.errors.map((error) => error.severity)).toEqual(["degrade", "degrade"]);
  });

  it("reuses the same local tag and type after reservation and index-space freezing", () => {
    const ctx = context();
    expect(ensureExnTag(ctx)).toBe(0);
    const tag = ctx.mod.tags[0];
    ctx.indexSpaceFrozen = true;
    expect(ensureExnTag(ctx)).toBe(0);
    expect(ctx.mod.tags).toEqual([tag]);
    expect(ctx.mod.tags[0]).toBe(tag);
    expect(ctx.mod.imports).toHaveLength(0);
    expect(ctx.mod.types).toHaveLength(1);
    expect(ctx.mod.types[0]).toMatchObject({ kind: "func", params: [{ kind: "externref" }], results: [] });
  });

  it("preserves the shared tag's absolute identity and reserves it only once", () => {
    const ctx = context({ sharedExnTag: true });
    addImport(ctx, "provider", "prior_tag", { kind: "tag", typeIdx: 0 });
    expect(ensureExnTag(ctx)).toBe(1);
    const tag = ctx.mod.imports[1];
    ctx.indexSpaceFrozen = true;
    expect(ensureExnTag(ctx)).toBe(1);
    expect(ctx.mod.imports).toHaveLength(2);
    expect(ctx.mod.imports[1]).toBe(tag);
    expect(tag).toMatchObject({ module: "env", name: "__exn", desc: { kind: "tag", typeIdx: 0 } });
    expect(ctx.mod.tags).toHaveLength(0);
    expect(ctx.mod.types).toHaveLength(1);
    expect(ctx.numImportFuncs).toBe(0);
    expect(ctx.numImportGlobals).toBe(0);
  });

  it("keeps the old registry exports bound to the same implementations", async () => {
    const compatibility = await import("../src/codegen/registry/imports.js");
    expect(compatibility.addImport).toBe(addImport);
    expect(compatibility.ensureExnTag).toBe(ensureExnTag);
  });
});
