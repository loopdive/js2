import { expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

it.each([false, true])("does not infer process presence from Node ambient types (supplied=%s)", async (supplied) => {
  const result = await compile(
    `
    // node:fs is enough to seed the checker's synthetic Node declaration file.
    ${supplied ? "(globalThis as any).process = { marker: 7 };" : ""}
    export function run(): number {
      const kind = typeof process;
      if (kind !== ${supplied ? '"object"' : '"undefined"'}) return -1;
      if ((typeof process !== "undefined") !== ${supplied}) return -2;
      ${supplied ? "if (process.marker !== 7) return -3;" : ""}
      { const process = { marker: 42 }; if (process.marker !== 42) return -4; }
      return 1;
    }
  `,
    { target: "standalone", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(((await WebAssembly.instantiate(module, {})).exports.run as () => number)()).toBe(1);
});

it.each([false, true])("reads the native global environment with supplied capability=%s", async (supplied) => {
  const result = await compile(
    `
    interface Capability { value: number; }
    declare const capability: Capability | undefined;
    ${supplied ? "(globalThis as any).capability = { value: 42 };" : ""}
    function read(): number {
      if (false) { const capability = { value: 99 }; return capability.value; }
      return typeof capability === "object" ? capability.value : -1;
    }
    const initial = read();
    export function run(): number {
      if (initial !== ${supplied ? 42 : -1}) return -1;
      delete (globalThis as any).capability;
      if (typeof capability !== "undefined") return -2;
      const actualType = typeof capability;
      if (actualType !== "undefined") return -3;
      { const capability = { value: 7 }; return capability.value === 7 ? 1 : -4; }
    }
  `,
    { target: "standalone", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(((await WebAssembly.instantiate(module, {})).exports.run as () => number)()).toBe(1);
});

it.each(["node", "node-ambient", "performance", "linked"])(
  "checks standalone %s presence without a host",
  async (mode) => {
    const result = await compileMulti(
      {
        "./core.ts": `${mode === "node-ambient" ? "// node:fs" : ""}
      export function isNodeLikeSystem(): boolean {
      return typeof process !== "undefined" && !!process.nextTick && !process.browser && typeof require !== "undefined";
    }`,
        "./barrel.ts": `export * from './core.js';`,
        "./entry.ts": `
      import { isNodeLikeSystem } from './barrel.js';
      interface Performance { now(): number; }
      declare const performance: Performance | undefined;
      function tryGetPerformance(): boolean {
        if (isNodeLikeSystem()) return true;
        return typeof performance === "object";
      }
      export function run(): number { return ${mode.startsWith("node") ? "isNodeLikeSystem()" : mode === "performance" ? 'typeof performance === "object"' : "tryGetPerformance()"} ? -1 : 1; }
    `,
      },
      "./entry.ts",
      { target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(((await WebAssembly.instantiate(module, {})).exports.run as () => number)()).toBe(1);
  },
);
