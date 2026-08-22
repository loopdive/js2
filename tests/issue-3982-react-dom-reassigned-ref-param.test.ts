// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3982 — a mutable object parameter must not keep a nominal shape after the
// body assigns a different object shape. ReactDOM's createRequest replaces its
// render-state parameter with a pending-segment object; the old lowering cast
// that value back to the incoming shape, produced null, and trapped on the
// next property access.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

const SOURCE = `
  function makeRenderState() {
    return { parentFlushed: false };
  }
  function makePendingSegment() {
    return { status: 0, children: [] };
  }
  function createRequest(renderState: { parentFlushed: boolean }) {
    renderState = makePendingSegment();
    renderState.status = 1;
    return renderState.status;
  }
  export function probe() {
    return createRequest(makeRenderState());
  }
`;

describe("#3982 — mutable object parameter representation", () => {
  for (const experimentalIR of [false, true]) {
    it(`preserves a reassigned object value (IR=${experimentalIR})`, async () => {
      const result = await compile(SOURCE, {
        fileName: "issue-3982-reassigned-ref-param.ts",
        experimentalIR,
        skipSemanticDiagnostics: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures });
      expect(exports.probe()).toBe(1);
    });
  }
});
