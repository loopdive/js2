import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

describe("#1623 extern.convert_any double-wrap on already-externref receiver", () => {
  it("emits valid Wasm for `this.#priv` in static method when #priv is set-only", async () => {
    const src = `
      class C {
        static set #f(v) { throw new Error(); }
        static getAccess() { return this.#f; }
      }
      C.getAccess;
      export function test(): number { return 1; }
    `;
    const r = compile(src, { fileName: "t.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    // Validate the module compiles — instantiation may need host imports
    // but byte-level Wasm validation must succeed.
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });

  it("emits valid Wasm for `this.unknownProp` in a static method (extern_get fallback)", async () => {
    const src = `
      class C {
        static probe() { return (this as any).unknown; }
      }
      C.probe;
      export function test(): number { return 1; }
    `;
    const r = compile(src, { fileName: "t.ts", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });
});
