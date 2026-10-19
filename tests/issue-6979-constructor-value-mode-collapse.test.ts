// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runNative(source: string, target: "standalone" | "wasi"): Promise<number> {
  const result = await compile(source, {
    target,
    fileName: `issue-6979-constructor-${target}.ts`,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as unknown as { __module_init?: () => void; readResult: () => number };
  exports.__module_init?.();
  return exports.readResult();
}

for (const target of ["standalone", "wasi"] as const) {
  describe(`#6979 constructor/value-reader mode collapse — ${target}`, () => {
    it("reads native builtin method metadata without materializing a host function", async () => {
      expect(
        await runNative(
          `
        export function readResult(): number {
          return Boolean.prototype.valueOf.name === "valueOf" && Boolean.prototype.valueOf.length === 0
            && Number.isNaN.name === "isNaN" && Number.isNaN.length === 1 ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("keeps the symbol iterator alias identical to its native method value", async () => {
      expect(
        await runNative(
          `
        export function readResult(): number {
          return Map.prototype[Symbol.iterator] === Map.prototype.entries
            && Set.prototype[Symbol.iterator] === Set.prototype.values ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("distinguishes native array values from byte-backed buffers and views", async () => {
      expect(
        await runNative(
          `
        var check = Array.isArray;
        export function readResult(): number {
          var array: boolean[] = [true];
          return check(array) && !check(new ArrayBuffer(4)) && !check(new Uint8Array(4)) ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("stores the exact fnctor identity rather than a different callable", async () => {
      expect(
        await runNative(
          `
        function Ctor(value: number) { this.value = value; }
        function Other() {}
        export function readResult(): number {
          var object: any = new Ctor(42);
          return object.value === 42 && object.constructor === Ctor && object.constructor !== Other ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("materializes a function-expression constructor's transitive sibling captures", async () => {
      expect(
        await runNative(
          `
        export function readResult(): number {
          var seed = 42;
          function read() { return seed; }
          var Ctor = function () { this.value = read(); };
          var object: any = new Ctor();
          return object.value;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("snapshots the fnctor prototype for instances created before replacement", async () => {
      expect(
        await runNative(
          `
        function Ctor() { this.own = 1; }
        Ctor.prototype = { inherited: 19 };
        var before: any = new Ctor();
        Ctor.prototype = { inherited: 23 };
        var after: any = new Ctor();
        export function readResult(): number { return before.inherited + after.inherited; }
      `,
          target,
        ),
      ).toBe(42);
    });
  });
}
