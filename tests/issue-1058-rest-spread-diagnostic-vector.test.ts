// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each([false, true])("converts a diagnostic vector at a rest spread call (filled=%s)", async (filled) => {
  const result = await compile(
    `interface Diagnostic { code: number; relatedInformation?: Diagnostic[]; }
    interface LocatedDiagnostic extends Diagnostic { start: number; }
    function addRelatedInfo<T extends Diagnostic>(diagnostic: T, ...related: Diagnostic[]): T {
      if (!related.length) return diagnostic;
      diagnostic.relatedInformation = related;
      return diagnostic;
    }
    export function run(): number {
      const related: LocatedDiagnostic[] = ${filled ? "[{code: 7, start: 4}]" : "[]"};
      const diagnostic: LocatedDiagnostic = {code: 9, start: 8};
      const result = addRelatedInfo(diagnostic, ...related);
      if (result !== diagnostic || result.code !== 9 || result.start !== 8) return -1;
      ${filled ? "if (result.relatedInformation?.length !== 1 || result.relatedInformation[0] !== related[0]) return -2;" : "if (result.relatedInformation !== undefined) return -3;"}
      return 1;
    }`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});

it.each([false, true])("packs numeric rest arguments for a resolved generic function (spread=%s)", async (spread) => {
  const result = await compile(
    `function sum<T>(prefix: T, ...values: number[]): number {
      let total = 0;
      for (const value of values) total += value;
      return total;
    }
    export function run(): number {
      const values: number[] = [2, 3];
      return ${spread ? 'sum("x", ...values)' : 'sum("x", 2, 3)'};
    }`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(5);
});

it("reads an absent optional diagnostic vector as undefined without a rest call", async () => {
  const result = await compile(
    `interface Diagnostic { code: number; relatedInformation?: Diagnostic[]; }
    export function run(): number {
      const diagnostic: Diagnostic = {code: 9};
      return diagnostic.relatedInformation === undefined ? 1 : 0;
    }`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});
