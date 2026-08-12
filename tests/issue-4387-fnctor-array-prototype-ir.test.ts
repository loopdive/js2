// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "issue-4387.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    experimentalIR: true,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(
    WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter((entry) => entry.module === "env"),
  ).toEqual([]);
  return result;
}

describe("#4387 — Array-valued live fnctor prototype", () => {
  it("keeps inherited filter callable on the standalone module-init path", async () => {
    const result = await compileStandalone(`
      F.prototype = new Array(11, 22, 33);
      function F() {}
      var value: any = new F();
      value.length = false;
      var filtered: any = value.filter(function () { return true; });

      export function test(): number {
        return (Array.isArray(filtered) ? 10 : 0) + filtered.length;
      }
    `);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
    (exports.__module_init as () => void)();
    expect((exports.test as () => number)()).toBe(10);
  });

  it("routes the inherited filter call inside an IR-owned function", async () => {
    const result = await compileStandalone(`
      F.prototype = new Array(11, 22, 33);
      function F() {}
      var value: any = new F();
      value.length = 1;

      export function filterInherited(callback: any): any {
        return value.filter(callback);
      }

      export function run(): number {
        var filtered: any = filterInherited(function (value: number): boolean { return true; });
        return filtered[0];
      }
    `);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toContain("filterInherited");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
    (exports.__module_init as () => void)();
    expect((exports.run as () => number)()).toBe(11);
  });

  it("does not treat a shadowed Array constructor as the intrinsic", async () => {
    const result = await compileStandalone(`
      function Array() {}
      function F() {}
      F.prototype = new Array();
      var value: any = new F();

      export function read(): number {
        return value.missing === undefined ? 1 : 0;
      }
    `);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
    (exports.__module_init as () => void)();
    expect((exports.read as () => number)()).toBe(1);
  });
});
