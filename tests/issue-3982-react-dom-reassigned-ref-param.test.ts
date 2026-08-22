// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3982 — a mutable object parameter must not keep a nominal shape after the
// body assigns a different object shape. ReactDOM's createRequest replaces its
// render-state parameter with a pending-segment object; the old lowering cast
// that value back to the incoming shape, produced null, and trapped on the
// next property access. The same rule covers ReactDOM's createFiberRoot, which
// reuses a boolean `isStrictMode` parameter for the newly allocated Fiber.

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

const MIXED_SOURCE = `
  function FiberNode() {
    this.stateNode = null;
  }
  function createFiberImplClass() {
    return new FiberNode();
  }
  function createFiberRoot(isStrictMode) {
    var tag = 1;
    !0 === isStrictMode && (tag |= 24);
    isStrictMode = createFiberImplClass();
    isStrictMode.stateNode = { tag };
    return isStrictMode.stateNode.tag;
  }
  export function probe() {
    return createFiberRoot(true);
  }
`;

const FNCTOR_PROTOTYPE_SOURCE = `
  function Root() {
    this.value = 1;
  }
  Root.prototype.render = function () {
    return this.value + 6;
  };
  export function probe() {
    const root = new Root();
    return root.render();
  }
`;

const PROPERTY_RECEIVER_SOURCE = `
  function updateRoot(root) {
    root.cancelPendingCommit = null;
    return 1;
  }
  export function probe() {
    return updateRoot({ cancelPendingCommit: false });
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

    it(`widens a scalar parameter reused for an object (IR=${experimentalIR})`, async () => {
      const result = await compile(MIXED_SOURCE, {
        fileName: "issue-3982-mixed-reassigned-ref-param.ts",
        experimentalIR,
        skipSemanticDiagnostics: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures });
      expect(exports.probe()).toBe(25);
    });

    it(`keeps top-level fnctor prototype methods in the host lane (IR=${experimentalIR})`, async () => {
      const result = await compile(FNCTOR_PROTOTYPE_SOURCE, {
        fileName: "issue-3982-fnctor-prototype.ts",
        experimentalIR,
        skipSemanticDiagnostics: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures });
      expect(exports.probe()).toBe(7);
    });

    it(`keeps an implicit-any property receiver dynamic (IR=${experimentalIR})`, async () => {
      const result = await compile(PROPERTY_RECEIVER_SOURCE, {
        fileName: "issue-3982-property-receiver.ts",
        experimentalIR,
        skipSemanticDiagnostics: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures });
      expect(exports.probe()).toBe(1);
    });
  }
});
