import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { compileFiles, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// The playground's bench_* functions used to live in DEFAULT_SOURCE inside
// playground/main.ts; they now live in the multi-file benchmarks example.
const BENCHMARKS_ENTRY = fileURLToPath(new URL("../website/playground/examples/benchmarks.ts", import.meta.url));

function mockElement() {
  const el: Record<string, any> = {
    style: { cssText: "", background: "" },
    textContent: "",
    children: [],
    appendChild: (child: any) => {
      el.children.push(child);
      return child;
    },
    removeChild: (child: any) => {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
    setAttribute: () => {},
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    className: "",
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    innerHTML: "",
  };
  return el;
}

function mockDocument() {
  return {
    getElementById: () => mockElement(),
    createElement: () => mockElement(),
    body: mockElement(),
  };
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, { document: mockDocument() }, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: imports.env,
    "wasm:js-string": imports["wasm:js-string"],
    string_constants: imports.string_constants,
    string_constants16: imports.string_constants16,
  });
  imports.setInstance?.(instance);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("full playground benchmarks example", () => {
  it("compiles without errors", async () => {
    const result = await compileFiles(BENCHMARKS_ENTRY);
    if (!result.success) {
      console.log("Compilation errors:", result.errors);
    }
    expect(result.success).toBe(true);
  });

  it("validates as a wasm binary", async () => {
    const result = await compileFiles(BENCHMARKS_ENTRY);
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("bench_dom function is present in WAT", async () => {
    const result = await compileFiles(BENCHMARKS_ENTRY);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("bench_dom");
  });

  it("can instantiate and call bench_array", async () => {
    const result = await compileFiles(BENCHMARKS_ENTRY);
    expect(result.success).toBe(true);

    const exports = await instantiate(result);

    // bench_array should work
    const benchArray = exports.bench_array;
    expect(benchArray).toBeDefined();
    const result2 = benchArray();
    expect(result2).toBe(49995000);
  });

  it("can instantiate and call bench_dom without trapping", async () => {
    const result = await compileFiles(BENCHMARKS_ENTRY);
    expect(result.success).toBe(true);

    const exports = await instantiate(result);

    // Call bench_dom — should not throw/trap
    const benchDom = exports.bench_dom;
    expect(benchDom).toBeDefined();
    expect(() => benchDom()).not.toThrow();
    expect(benchDom()).toBe(100);
  });
});
