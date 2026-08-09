// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4298 — dynamic writes to a WasmGC struct are ordinary enumerable own data
// properties. React aliases Object.assign, copies props into `{}`, then mutates
// them through dynamic keys; direct reads worked while Object.keys returned [].

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { expect, it } from "vitest";

async function runTest(src: string, standalone: boolean): Promise<unknown> {
  const result = await compile(src, {
    fileName: "issue-4298.js",
    skipSemanticDiagnostics: true,
    ...(standalone ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...args: unknown[]) => unknown>;
  if ((imports as { setExports?: (exports: unknown) => void }).setExports) {
    (imports as { setExports: (exports: unknown) => void }).setExports(exports);
  }
  return exports.test();
}

for (const standalone of [false, true]) {
  it(`#4298 enumerates ordinary dynamic writes on a WasmGC struct (${standalone ? "standalone" : "host"})`, async () => {
    const source = `
      function listKeys(value) {
        return Object.keys(value).join(",");
      }

      export function test() {
        var object = { base: 1 };
        delete object.base;
        var first = "ref";
        var second = "foo";
        object[first] = null;
        object[second] = "ef";
        if (listKeys(object) !== "ref,foo") return 10;
        if (!object.hasOwnProperty(first) || !object.hasOwnProperty(second)) return 20;
        if (!object.propertyIsEnumerable(first) || !object.propertyIsEnumerable(second)) return 25;
        if (object[first] !== null || object[second] !== "ef") return 30;
        return 1;
      }
    `;

    expect(await runTest(source, standalone)).toBe(1);
  });
}
