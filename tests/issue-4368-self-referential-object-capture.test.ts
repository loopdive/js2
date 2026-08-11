// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

const SOURCE = `
  export function run() {
    let chain = {
      get: () => chain,
    };
    return chain.get() === chain ? 7 : 0;
  }
`;

describe("#4368 — self-referential object-literal capture initialization", () => {
  it("writes the initialized object through the live capture cell", async () => {
    const result = await compile(SOURCE, {
      fileName: "self-capture.js",
      skipSemanticDiagnostics: true,
      experimentalIR: false,
    });

    expect(result.success).toBe(true);
    await expect(WebAssembly.compile(result.binary)).resolves.toBeInstanceOf(WebAssembly.Module);

    const importObject = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, importObject);
    importObject.__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.run()).toBe(7);
  });
});
