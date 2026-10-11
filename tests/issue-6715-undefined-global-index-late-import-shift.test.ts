// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6715 — a late host string import shifts the module-global range. The
// canonical undefined singleton is cached as an absolute global index, so the
// cache must move with that range before a later emitter reads it.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { canonicalUndefinedExternInstrs, ensureAnyValueType } from "../src/codegen/any-helpers.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { addHostStringConstantGlobal } from "../src/codegen/registry/imports.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { createEmptyModule } from "../src/ir/types.js";

function fixture() {
  const ast = analyzeSource("export const value = 0;", "/repo/issue-6715-undefined-global-index.ts");
  const module = createEmptyModule();
  const ctx = createCodegenContext(module, ast.checker, {
    standalone: false,
    nativeStrings: true,
    strictNoHostImports: false,
  });
  return { ctx, module };
}

describe("#6715 cached undefined global index", () => {
  it("moves the cached singleton before a later canonical undefined read is emitted", () => {
    const { ctx, module } = fixture();

    // The preceding i32 slot makes a stale cache resolve to an incompatible
    // global after the import is inserted at index zero, matching the failure
    // shape rather than merely proving that a number changed.
    module.globals.push({
      name: "__symbol_counter",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    ensureAnyValueType(ctx);
    const undefinedBefore = ctx.undefinedGlobalIdx;
    if (undefinedBefore === undefined) throw new Error("missing undefined singleton");
    const undefinedGlobal = module.globals[undefinedBefore - ctx.numImportGlobals];
    if (undefinedGlobal === undefined) throw new Error("missing cached undefined global");

    expect(undefinedBefore).toBe(1);
    expect(addHostStringConstantGlobal(ctx, "late host global")).toBe(0);
    expect(ctx.numImportGlobals).toBe(1);
    expect(ctx.undefinedGlobalIdx).toBe(undefinedBefore + 1);
    expect(module.globals[ctx.undefinedGlobalIdx! - ctx.numImportGlobals]).toBe(undefinedGlobal);

    const typeIdx = addFuncType(ctx, [], [{ kind: "i32" }], "read_undefined_tag");
    module.functions.push({
      name: "read_undefined_tag",
      typeIdx,
      locals: [],
      body: [
        ...canonicalUndefinedExternInstrs(ctx),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyValueTypeIdx },
        { op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 0 },
      ],
      exported: true,
    });
    module.exports.push({ name: "readUndefinedTag", desc: { kind: "func", index: 0 } });

    const binary = emitBinary(module);
    expect(WebAssembly.validate(binary), "post-shift module must be valid Wasm").toBe(true);
    const wasmModule = new WebAssembly.Module(binary);
    expect(WebAssembly.Module.imports(wasmModule)).toEqual([
      { module: "string_constants", name: "late host global", kind: "global" },
    ]);

    const importedString = new WebAssembly.Global({ value: "externref", mutable: false }, "late host global");
    const instance = new WebAssembly.Instance(wasmModule, {
      string_constants: { "late host global": importedString },
    });
    expect((instance.exports.readUndefinedTag as () => number)()).toBe(1);
  });
});
