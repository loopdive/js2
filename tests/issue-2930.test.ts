import { describe, it, expect } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2930 — an import binding whose LOCAL name differs from the imported symbol's
// declaration name must resolve to the imported target (not the graceful-null
// default). Uses `.ts` fixtures so the alias resolution is isolated from #2932
// (`.js` module-dependency compilation) and #2931 (live function bindings).
async function runTest(files: Record<string, string>, entry = "./test.ts"): Promise<number> {
  const result = await compileMulti(files, entry, { skipSemanticDiagnostics: true });
  expect(result.success).toBe(true);
  expect(result.binary.length).toBeGreaterThan(0);
  const importObj = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
  if (typeof (importObj as any).setExports === "function") {
    (importObj as any).setExports(instance.exports);
  }
  const testFn = (instance.exports as any).test;
  expect(typeof testFn).toBe("function");
  return testFn();
}

describe("#2930 — import-alias name mismatch resolution", () => {
  it("default import with a differing local name resolves to the default export (call)", async () => {
    const ret = await runTest({
      "./test.ts": `import val from "./h.ts"; export function test(): number { return val(); }`,
      "./h.ts": `export default function fn(){ return 7; }`,
    });
    expect(ret).toBe(7);
  });

  it("default import whose local name matches the declaration still works (no regression)", async () => {
    const ret = await runTest({
      "./test.ts": `import fn from "./h.ts"; export function test(): number { return fn(); }`,
      "./h.ts": `export default function fn(){ return 7; }`,
    });
    expect(ret).toBe(7);
  });

  it("renamed named import ({ add as plus }) resolves to the exported function", async () => {
    const ret = await runTest({
      "./test.ts": `import { add as plus } from "./h.ts"; export function test(): number { return plus(1, 2); }`,
      "./h.ts": `export function add(a: number, b: number){ return a + b; }`,
    });
    expect(ret).toBe(3);
  });

  it("plain named import still works (no regression)", async () => {
    const ret = await runTest({
      "./test.ts": `import { add } from "./h.ts"; export function test(): number { return add(1, 2); }`,
      "./h.ts": `export function add(a: number, b: number){ return a + b; }`,
    });
    expect(ret).toBe(3);
  });

  it("export { g as default } resolves through the default import", async () => {
    const ret = await runTest({
      "./test.ts": `import v from "./h.ts"; export function test(): number { return v(); }`,
      "./h.ts": `function g(){ return 5; } export { g as default };`,
    });
    expect(ret).toBe(5);
  });

  it("anonymous default function resolves through the default import", async () => {
    const ret = await runTest({
      "./test.ts": `import val from "./h.ts"; export function test(): number { return val(); }`,
      "./h.ts": `export default function(){ return 9; }`,
    });
    expect(ret).toBe(9);
  });

  it("a differing-name default import read as a value is the callable target", async () => {
    const ret = await runTest({
      "./test.ts": `import val from "./h.ts"; export function test(): number { const x: any = val; return x(); }`,
      "./h.ts": `export default function fn(){ return 7; }`,
    });
    expect(ret).toBe(7);
  });

  it("default import aliases stay module-backed inside function-expression closures", async () => {
    const ret = await runTest({
      "./test.ts": `
        import api from "./h.ts";
        const cases: any[] = [];
        function register(name: string, body: Function): void { cases.push({ name, body }); }
        register("reads import", function (): number { return api.value; });
        export function test(): number { return cases[0].body(); }
      `,
      "./h.ts": `
        function api(): number { return 1; }
        (api as any).value = 42;
        export default api;
      `,
    });
    expect(ret).toBe(42);
  });
});
