import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { emitToBoolean } from "../src/codegen/coercion-engine.js";
import { createEmptyModule } from "../src/ir/types.js";

it.each(["anyref", "eqref"] as const)("routes %s truthiness through the canonical value classifier", (kind) => {
  const ctx = createCodegenContext(createEmptyModule(), {} as CodegenContext["checker"]);
  const instructions = emitToBoolean(ctx, { kind }, []);
  const helper = ctx.funcMap.get("__is_truthy");
  expect(helper).toBeDefined();
  expect(instructions).toEqual([{ op: "extern.convert_any" }, { op: "call", funcIdx: helper }]);
});

it("validates and runs TypeScript's optional-mark measurement path", async () => {
  const result = await compile(
    `
    interface PerformanceTime { now(): number; timeOrigin: number; }
    interface Performance extends PerformanceTime {
      mark(name: string): void;
      measure(name: string, startMark?: string, endMark?: string): void;
      clearMeasures(name?: string): void;
      clearMarks(name?: string): void;
    }
    let performanceImpl: Performance | undefined;
    let enabled = false;
    let timeorigin = 10;
    const marks = new Map<string, number>();
    const durations = new Map<string, number>();
    function timestamp(): number { return 40; }
    export function measure(measureName: string, startMarkName?: string, endMarkName?: string): void {
      if (enabled) {
        const end = (endMarkName !== undefined ? marks.get(endMarkName) : undefined) ?? timestamp();
        const start = (startMarkName !== undefined ? marks.get(startMarkName) : undefined) ?? timeorigin;
        const previousDuration = durations.get(measureName) || 0;
        durations.set(measureName, previousDuration + (end - start));
        performanceImpl?.measure(measureName, startMarkName, endMarkName);
      }
    }
    export function run(): number {
      enabled = true;
      marks.set("start", 15); marks.set("end", 25);
      measure("elapsed", "start", "end");
      measure("elapsed");
      return durations.get("elapsed") === 40 ? 1 : -1;
    }
  `,
    { target: "standalone", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});

it.each([
  ["0", false],
  ["-0", false],
  ["NaN", false],
  ["false", false],
  ['""', false],
  ["undefined", false],
  ["null", false],
  ["7", true],
  ["-2", true],
  ["true", true],
  ['"x"', true],
  ["({ tag: 1 })", true],
  ["[1]", true],
])("preserves Map-result truthiness, identity and short-circuiting for %s", async (value, truthy) => {
  const result = await compile(
    `
    let calls = 0, reads = 0;
    const map = new Map<string, any>();
    function key(): string { reads++; return "value"; }
    function fallback(): number { calls++; return 23; }
    export function run(): number {
      const value: any = ${value}; map.set("value", value);
      const or = map.get(key()) || fallback();
      if (reads !== 1 || calls !== ${truthy ? 0 : 1}) return -1;
      if (or !== ${truthy ? "value" : "23"}) return -2;
      calls = 0;
      const and = map.get(key()) && fallback();
      if (reads !== 2 || calls !== ${truthy ? 1 : 0}) return -3;
      ${value === "NaN" ? "if (and === and) return -4;" : `if (and !== ${truthy ? "23" : "value"}) return -4;`}
      return 1;
    }
  `,
    { target: "standalone", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});
