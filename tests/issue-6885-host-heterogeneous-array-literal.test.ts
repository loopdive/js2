// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6885 — on the JS-host lane `[obj, "s"]` (object BINDING first) stored the
// string as null and `[obj, 5]` trapped: the #6613 carrier widening was
// standalone-only. Unmasked by #6511 in test262
// `Temporal/PlainDate/from/limits.js`.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const ENTRY = fileURLToPath(new URL("./fixtures/issue-6885/entry.js", import.meta.url));

async function compileEntry(): Promise<WebAssembly.Exports> {
  const result = await compileProject(ENTRY, { allowJs: true, skipSemanticDiagnostics: true, target: "gc" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

const call = (exports: WebAssembly.Exports, name: string) => (exports[name] as () => unknown)();

describe("#6885 — heterogeneous array literal on the JS-host lane", () => {
  it("keeps a primitive sibling of an object binding", async () => {
    const exports = await compileEntry();
    // Parent: `[{"a":1},null] object`.
    expect(call(exports, "bindingThenString")).toBe('[{"a":1},"s"] string');
    // Parent: RuntimeError: dereferencing a null pointer.
    expect(call(exports, "bindingThenNumber")).toBe('[{"a":1},5] number');
    // Parent: `object,object,object,object` (the strings read back as null).
    expect(call(exports, "temporalTable")).toBe("object,object,string,string");
  });

  it("controls: shapes that already worked are unchanged", async () => {
    const exports = await compileEntry();
    expect(call(exports, "inlineThenString")).toBe('[{"a":1},"s"]');
    expect(call(exports, "stringThenBinding")).toBe('["s",{"a":1}]');
    expect(call(exports, "homogeneous")).toBe("1,2");
  });
});
