// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-3772.ts",
    target: lane === "standalone" ? "standalone" : undefined,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  if (lane === "standalone") {
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter((entry) => entry.module === "env"),
    ).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
    (exports.__module_init as (() => void) | undefined)?.();
    return (exports.test as () => number)();
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    new Uint8Array(result.binary),
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
  imports.setExports?.(exports);
  (exports.__module_init as (() => void) | undefined)?.();
  return (exports.test as () => number)();
}

const inheritedFilterSource = `
  foo.prototype = new Array(1, 2, 3);
  function foo() {}
  var f: any = new foo();
  f.length = false;
  function cb() {}
  var a: any = f.filter(cb);

  export function test(): number {
    return (Array.isArray(a) ? 10 : 0) + a.length;
  }
`;

describe("#3772 — generic filter results retain the Array brand", () => {
  it.each<Lane>(["host", "standalone"])("%s: inherited filter returns an empty Array", async (lane) => {
    await expect(run(inheritedFilterSource, lane)).resolves.toBe(10);
  });

  it("standalone: the same fnctor receiver works through an explicit borrowed filter", async () => {
    await expect(
      run(
        `
          foo.prototype = new Array(1, 2, 3);
          function foo() {}
          var f: any = new foo();
          f.length = false;
          var a: any = Array.prototype.filter.call(f, function cb() {});

          export function test(): number {
            return (Array.isArray(a) ? 10 : 0) + a.length;
          }
        `,
        "standalone",
      ),
    ).resolves.toBe(10);
  });

  it("standalone: direct inherited filter observes a prototype element when length is reduced", async () => {
    await expect(
      run(
        `
          foo.prototype = new Array(11, 22, 33);
          function foo() {}
          var f: any = new foo();
          f.length = 1;
          var a: any = f.filter(function cb() { return true; });

          export function test(): number {
            return (Array.isArray(a) ? 100 : 0) + a.length * 10 + a[0];
          }
        `,
        "standalone",
      ),
    ).resolves.toBe(121);
  });

  it("standalone: the explicit borrowed-filter result is also branded as an Array", async () => {
    await expect(
      run(
        `
          export function test(): number {
            const receiver: any = { 0: 1, 1: 2, length: 2 };
            const result: any = Array.prototype.filter.call(receiver, (value: number) => value > 0);
            return Array.isArray(result) ? 1 : 0;
          }
        `,
        "standalone",
      ),
    ).resolves.toBe(1);
  });
});
