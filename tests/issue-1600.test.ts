import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.js";

describe("#1600 FinalizationRegistry host-delegate + no-op stub", () => {
  const src = `
    function cb() {}
    var reg = new FinalizationRegistry(cb);
    var target = {};
    var token = {};
    reg.register(target, 42, token);
    var removed = reg.unregister(token);
    export function test(): number { return 1; }
  `;

  it("compiles new FinalizationRegistry + register/unregister in JS-host mode", async () => {
    const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("compiles to byte-valid Wasm in standalone (--target wasi) mode", async () => {
    const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, target: "wasi" });
    expect(r.success).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });

  it("does not regress WeakRef", async () => {
    const wr = `var o = {}; var w = new WeakRef(o); export function test(): number { return 1; }`;
    const r = await compile(wr, { fileName: "test.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
  });
});
