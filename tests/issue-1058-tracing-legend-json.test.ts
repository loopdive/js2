import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it("evaluates the record-array expression once and preserves scalar field values", async () => {
  const result = await compile(
    `
    interface Row { text: string; count: number; enabled: boolean; }
    let calls = 0;
    function rows(): Row[] { calls++; return [{ text: "x", count: 7, enabled: true }]; }
    export function run(): number {
      const text = JSON.stringify(rows());
      return calls === 1 && text === '[{"text":"x","count":7,"enabled":true}]' ? 1 : 0;
    }
  `,
    { target: "standalone" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(1);
});

it.each([
  ["[]", "[]"],
  ["null as unknown as Record[]", "null"],
  ['[null as unknown as Record, { value: "x" }]', '[null,{"value":"x"}]'],
])("preserves nullable record-array shape %s", async (input, expected) => {
  const result = await compile(
    `
    interface Record { value: string; }
    function render(records: Record[]): string { return JSON.stringify(records); }
    export function run(): number { return render(${input}) === ${JSON.stringify(expected)} ? 1 : 0; }
  `,
    { target: "standalone" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(1);
});

it.each(["legend", "legend as unknown as object"])(
  "serializes tracing records through %s in standalone",
  async (value) => {
    const result = await compile(
      `
    interface TraceRecord { configFilePath?: string; tracePath: string; typesPath?: string; }
    const legend: TraceRecord[] = [];
    export function run(): number {
      legend.push({ configFilePath: "tsconfig.json", tracePath: "trace.json", typesPath: "types.json" });
      legend[legend.length - 1].typesPath = undefined;
      return JSON.stringify(${value}) === '[{"configFilePath":"tsconfig.json","tracePath":"trace.json"}]' ? 1 : 0;
    }
  `,
      { target: "standalone" },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.run as Function)()).toBe(1);
  },
);

it("serializes a namespace-scoped legend whose record declaration follows its functions", async () => {
  const result = await compile(
    `
    namespace tracingEnabled {
      const legend: TraceRecord[] = [];
      export function render(): string {
        legend.push({ configFilePath: "tsconfig.json", tracePath: "trace.json", typesPath: "types.json" });
        legend[legend.length - 1].typesPath = undefined;
        return JSON.stringify(legend);
      }
      interface TraceRecord { configFilePath?: string; tracePath: string; typesPath?: string; }
    }
    export function run(): number {
      return tracingEnabled.render() === '[{"configFilePath":"tsconfig.json","tracePath":"trace.json"}]' ? 1 : 0;
    }
  `,
    { target: "standalone" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(1);
});
