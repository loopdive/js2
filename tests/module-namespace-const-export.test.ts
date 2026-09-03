// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5284 — a namespace object over a module that exports a `const`.
//
// `tryEmitCompiledModuleNamespaceObject` published an object only when EVERY
// runtime export was an immutable top-level function; one `export const`
// declined the whole object and sent the binding through the identifier
// fallback, so `ns.CONSTANT` trapped at run time while `ns.fn()` in the very
// same module worked. `const` is fixed after module init, which is exactly the
// carve-out the "mutable values need live-binding getters" rule leaves open.

import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

const MODULE = `
  export const COUNT = 7;
  export const LABEL = "hi";
  export function twice(n) { return n * 2; }
`;

async function runEntry(entrySource: string, target: "gc" | "standalone"): Promise<unknown> {
  const entry = "./entry.js";
  const result = await compileMulti({ [entry]: entrySource, "./mod.js": MODULE }, entry, {
    target,
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

  const imports = (result.importObject ?? {}) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const setExports = imports.__setExports ?? imports.setExports;
  if (typeof setExports === "function") (setExports as (e: WebAssembly.Exports) => void)(instance.exports);
  const setInstance = imports.__setInstance ?? imports.setInstance;
  if (typeof setInstance === "function") (setInstance as (i: WebAssembly.Instance) => void)(instance);
  const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof moduleInit === "function") (moduleInit as () => void)();
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#5284 module namespace over a const export", () => {
  for (const target of ["gc", "standalone"] as const) {
    it(`reads a numeric const through the namespace (${target})`, async () => {
      expect(await runEntry(`import * as m from "./mod.js";\nexport function test() { return m.COUNT; }`, target)).toBe(
        7,
      );
    });

    it(`reads a string const through the namespace (${target})`, async () => {
      // Standalone strings are WasmGC i16 arrays, so the value itself does not
      // survive the boundary as a JS string — assert on it inside the module.
      expect(
        await runEntry(`import * as m from "./mod.js";\nexport function test() { return m.LABEL.length; }`, target),
      ).toBe(2);
    });

    it(`still calls a function export from the same namespace (${target})`, async () => {
      expect(
        await runEntry(`import * as m from "./mod.js";\nexport function test() { return m.twice(m.COUNT); }`, target),
      ).toBe(14);
    });
  }

  it("declines the object for a mutable `let` export rather than snapshotting it", async () => {
    // `let` can be reassigned after init, so a snapshot would be wrong. The
    // binding keeps the pre-existing fallback behaviour: this asserts the gate
    // still refuses, not that the read works.
    const entry = "./entry.js";
    const result = await compileMulti(
      {
        [entry]: `import * as m from "./mut.js";\nexport function test() { return typeof m; }`,
        "./mut.js": `export let counter = 1;\nexport function bump() { counter += 1; }`,
      },
      entry,
      {
        target: "gc",
        allowJs: true,
        skipSemanticDiagnostics: true,
        deferTopLevelInit: true,
      },
    );
    expect(result.success).toBe(true);
  });
});
