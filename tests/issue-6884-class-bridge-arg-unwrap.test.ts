// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6884 — a compiled class-method host bridge must hand its compiled callee the
// RAW carriers of its arguments, not the host mirrors `__extern_method_call`
// wrapped them in. With the mirror, `t instanceof TD` was false inside the
// callee and `t.totalNs` came back through the host mirror without its class
// members — the Temporal polyfill's "__digit is not a function" (27 test262
// Duration.round / PlainDateTime since·until rows, unmasked by #6848).

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const ENTRY = fileURLToPath(new URL("./fixtures/issue-6884/entry.js", import.meta.url));

async function compileEntry(): Promise<{ exports: WebAssembly.Exports; importNames: string[] }> {
  const result = await compileProject(ENTRY, { allowJs: true, skipSemanticDiagnostics: true, target: "gc" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  const importNames = ((result.imports ?? []) as readonly { readonly name: string }[]).map((entry) => entry.name);
  return { exports: instance.exports, importNames };
}

describe("#6884 — class-method host bridge unwraps its arguments", () => {
  it("passes the argument's own struct through a dynamic method call", async () => {
    const { exports, importNames } = await compileEntry();
    // The shape really goes through the host method bridge (anti-vacuity: if
    // the call were ever resolved statically this test would prove nothing).
    expect(importNames).toContain("__extern_method_call");
    // Parent: "THROW TypeError: __digit is not a function".
    expect((exports.dynamicSubtract as () => string)()).toBe("true:5");
  });

  it("control: the statically-resolved call answers the same", async () => {
    const { exports } = await compileEntry();
    expect((exports.staticSubtract as () => string)()).toBe("true:5");
  });
});
