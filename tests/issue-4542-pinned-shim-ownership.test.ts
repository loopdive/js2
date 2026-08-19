// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4542 — the committed ownership table must keep describing the real shim.
//
// The annotation is unavoidably a hand-written summary (the callee is foreign
// code), but its SHAPE is mechanically derivable from
// `scripts/quickjs-artifact/qjs_shim.c`, and a shape mismatch is exactly how a
// wrong annotation gets in. This reads the C source — no artifact build
// needed — and fails if the table and the source have drifted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { declareExternCImports } from "../src/codegen-linear/c-abi.js";
import type { ExternCImportSpec } from "../src/codegen-linear/c-abi.js";
import type { WasmModule } from "../src/ir/types.js";
import {
  SHIM_REFCOUNT_PRIMITIVES,
  checkShimOwnershipDrift,
  parseShimExports,
  pinnedShimImports,
  requireOwnershipAnnotations,
  resolveImportOwnership,
} from "../src/codegen-linear/refcount/index.js";

const SHIM = readFileSync(fileURLToPath(new URL("../scripts/quickjs-artifact/qjs_shim.c", import.meta.url)), "utf8");

describe("#4542 — pinned-shim ownership table", () => {
  it("every wrapper that carries a handle is in the table, with the right shape", () => {
    expect(checkShimOwnershipDrift(SHIM)).toEqual([]);
  });

  it("the parser actually found the shim's exports (a guard against a silent zero)", () => {
    const parsed = parseShimExports(SHIM);
    expect(parsed.length).toBeGreaterThan(20);
    expect(parsed.map((p) => p.name)).toContain("qjs_get_prop_str");
    expect(parsed.find((p) => p.name === "qjs_get_prop_str")?.returnsHandle).toBe(true);
    // The one wrapper that reaches handles through memory rather than through
    // a parameter — the pass cannot see them, which is safe only because the
    // shim borrows. Asserted so a future `consumes` wrapper of this shape
    // cannot slip in unnoticed.
    expect(parsed.find((p) => p.name === "qjs_call")?.handleArrayParams).toBe(1);
  });

  it("the whole table resolves — no row is missing an annotation it needs", () => {
    const table = requireOwnershipAnnotations(pinnedShimImports());
    expect(table.get("qjs_get_prop_str")?.result).toBe("owned");
    expect(table.get("qjs_set_prop_str")?.args).toEqual(["borrows", "borrows", "borrows", "borrows"]);
    // The raw C API consumes this argument; the shim does not. Getting it
    // backwards double-frees every stored value.
    expect(table.get("qjs_set_prop_str")?.args).not.toContain("consumes");
  });

  it("nothing in this ABI unwinds — the exception is a sentinel handle, not a trap", () => {
    const table = requireOwnershipAnnotations(pinnedShimImports());
    for (const spec of pinnedShimImports()) {
      const resolved = resolveImportOwnership(spec);
      expect(`${spec.name}:${resolved.throws}`).toBe(`${spec.name}:false`);
    }
    expect(table.get("qjs_eval")?.throws).toBe(false);
  });

  it("conversions that can run user JS are marked as able to drop container slots", () => {
    const table = requireOwnershipAnnotations(pinnedShimImports());
    // `valueOf` / `toString` / a getter all run arbitrary JS. Reading these as
    // pure is the mistake the elision rule exists to prevent.
    for (const name of ["qjs_to_f64", "qjs_to_cstring", "qjs_get_prop_str", "qjs_call", "qjs_eval"]) {
      expect(`${name}:${table.get(name)?.releasesContainerSlots}`).toBe(`${name}:true`);
    }
    expect(table.get("qjs_tag")?.releasesContainerSlots).toBe(false);
  });

  it("the refcount primitives are NOT ordinary rows", () => {
    // Routing `free` through the table that decides where frees go would be
    // circular; the pass emits these directly.
    const names = pinnedShimImports().map((s) => s.name);
    for (const prim of SHIM_REFCOUNT_PRIMITIVES) expect(names).not.toContain(prim);
  });

  it("the drift check FAILS when the table and the source disagree", () => {
    // Negative control: without this the check above could be vacuous.
    const mutated = SHIM.replace(
      "qjs_handle QJS_EXPORT(qjs_new_object)(JSContext *ctx)",
      "qjs_handle QJS_EXPORT(qjs_new_object)(JSContext *ctx, qjs_handle proto)",
    );
    expect(mutated).not.toBe(SHIM);
    const drift = checkShimOwnershipDrift(mutated);
    expect(drift.map((d) => d.export)).toContain("qjs_new_object");
  });

  it("a wrapper added to the shim but not to the table is reported", () => {
    const mutated = `${SHIM}\nqjs_handle QJS_EXPORT(qjs_brand_new)(JSContext *ctx, qjs_handle h) { return h; }\n`;
    const drift = checkShimOwnershipDrift(mutated);
    expect(drift.find((d) => d.export === "qjs_brand_new")?.problem).toMatch(/missing from the ownership table/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe("#4542 — the annotation gate fires at DECLARATION time", () => {
  function emptyModule(): WasmModule {
    return {
      types: [],
      imports: [],
      functions: [],
      exports: [],
      tables: [],
      elements: [],
      globals: [],
      tags: [],
      stringPool: [],
      externClasses: [],
      nodeBuiltinModules: new Set(),
      stringLiteralValues: new Map(),
      asyncFunctions: new Set(),
      declaredFuncRefs: [],
      funcOrdinalToPosition: [],
      memories: [],
      dataSegments: [],
    } as unknown as WasmModule;
  }

  it("an engine import with handles and no ownership is refused where it is declared", () => {
    const spec: ExternCImportSpec = {
      module: "qjs",
      name: "qjs_mystery",
      params: [{ address: "ptr" }, { address: "handle" }],
      results: [{ address: "handle" }],
      engine: true,
    };
    expect(() => declareExternCImports(emptyModule(), [spec])).toThrow(/no ownership annotation/);
  });

  it("but an address-role handle is STILL usable as a plain width role (#4554)", () => {
    // The type role carries two meanings that coincide on wasm32 and are not
    // the same idea. Requiring an annotation for the WIDTH meaning would break
    // the #4539 declaration of a plain doubling function, which uses the role
    // precisely to prove role and width emit the same bytes.
    const spec: ExternCImportSpec = {
      module: "cpeer",
      name: "c_double",
      params: [{ address: "handle" }],
      results: [{ address: "handle" }],
    };
    const mod = emptyModule();
    expect(() => declareExternCImports(mod, [spec])).not.toThrow();
    expect(mod.imports).toHaveLength(1);
  });

  it("an incoherent annotation is refused even on a non-engine import", () => {
    // Declaring something wrong is a mistake worth naming whether or not the
    // import is flagged as engine surface.
    const spec: ExternCImportSpec = {
      module: "cpeer",
      name: "c_bad",
      params: [{ kind: "i32" }],
      results: [{ kind: "i32" }],
      ownership: "consumes",
    };
    expect(() => declareExternCImports(emptyModule(), [spec])).toThrow(/no parameter is a handle/);
  });

  it("the whole pinned-shim table declares without complaint", () => {
    const mod = emptyModule();
    const indices = declareExternCImports(mod, pinnedShimImports());
    expect(indices.get("qjs_get_prop_str")).toBeTypeOf("number");
    expect(mod.imports.length).toBe(pinnedShimImports().length);
  });
});
