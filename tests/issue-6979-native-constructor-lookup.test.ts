// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, target: "standalone" | "wasi"): Promise<number> {
  const result = await compile(source, {
    target,
    fileName: "issue-6979-native-lookup.ts",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as unknown as { __module_init?: () => void; readResult: () => number };
  exports.__module_init?.();
  return exports.readResult();
}

for (const target of ["standalone", "wasi"] as const) {
  describe(`#6979 native constructor lookup — ${target}`, () => {
    for (const [name, expression] of [
      ["literal", "[1, 2, 3]"],
      ["split", '"a,b".split(",")'],
      ["map", "[1, 2, 3].map(x => x * 2)"],
    ]) {
      it(`reads the Array constructor from a dynamically typed ${name} result`, async () => {
        expect(
          await run(
            `
          function ctorOf(value: any): any { return value.constructor; }
          export function readResult(): number {
            var ctor = ctorOf(${expression});
            return ctor === Array && ctor !== Object ? 42 : -1;
          }
        `,
            target,
          ),
        ).toBe(42);
      });
    }

    it("resolves an unknown computed key without an Array identifier or constructor property spelling", async () => {
      expect(
        await run(
          `
        function get(value: any, key: string): any { return value[key]; }
        export function readResult(): number {
          var key = "constr" + "uctor";
          var ctor = get([1, 2], key);
          return ctor && ctor.name === "Array" && ctor.length === 1 ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("honors an own constructor shadow and restores inheritance after deletion", async () => {
      expect(
        await run(
          `
        function ctorOf(value: any): any { return value.constructor; }
        export function readResult(): number {
          var array: any = [1];
          array.constructor = 17;
          if (ctorOf(array) !== 17) return -1;
          delete array.constructor;
          return ctorOf(array) === Array ? 42 : -2;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("reads the live constructor property from Array.prototype", async () => {
      expect(
        await run(
          `
        function Other() {}
        function ctorOf(value: any): any { return value.constructor; }
        var proto: any = Array.prototype;
        proto.constructor = Other;
        export function readResult(): number {
          return ctorOf([1]) === Other && ctorOf([1]) !== Array ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("reads wrapper metadata through a computed key in every native environment", async () => {
      expect(
        await run(
          `
        function get(value: any, key: string): any { return value[key]; }
        export function readResult(): number {
          var ctor = get(new Number(3), "constr" + "uctor");
          return ctor && ctor.name === "Number" && ctor === Number ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("resolves an ordinary object's constructor without an Object identifier", async () => {
      expect(
        await run(
          `
        function get(value: any, key: string): any { return value[key]; }
        export function readResult(): number {
          var object: any = {};
          object.extra = 7;
          var ctor = get(object, "constr" + "uctor");
          return ctor && ctor.name === "Object" ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("reads a wrapper's live prototype constructor rather than its primitive tag", async () => {
      expect(
        await run(
          `
        function Other() {}
        function get(value: any, key: string): any { return value[key]; }
        var proto: any = Number.prototype;
        proto.constructor = Other;
        export function readResult(): number {
          return get(new Number(3), "constr" + "uctor") === Other ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("reads the live Object prototype constructor for an ordinary object", async () => {
      expect(
        await run(
          `
        function Other() {}
        function get(value: any, key: string): any { return value[key]; }
        var proto: any = Object.prototype;
        proto.constructor = Other;
        export function readResult(): number {
          var object: any = {};
          object.extra = 7;
          return get(object, "constr" + "uctor") === Other ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("does not invent an inherited constructor on an explicit null prototype", async () => {
      expect(
        await run(
          `
        function get(value: any, key: string): any { return value[key]; }
        export function readResult(): number {
          var object = Object.create(null);
          return get(object, "constr" + "uctor") === undefined ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });

    it("resolves constructor lookup through a stored Reflect.get value", async () => {
      expect(
        await run(
          `
        var get = Reflect.get;
        export function readResult(): number {
          var ctor = get([1], "constr" + "uctor");
          return ctor && ctor.name === "Array" ? 42 : -1;
        }
      `,
          target,
        ),
      ).toBe(42);
    });
  });
}
