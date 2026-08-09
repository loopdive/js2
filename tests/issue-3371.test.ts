// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const REPRESENTATIVES = [
  "annexB/built-ins/Date/prototype/getYear/not-a-constructor.js",
  "built-ins/TypedArrayConstructors/ctors/buffer-arg/proto-from-ctor-realm.js",
  "built-ins/DataView/custom-proto-if-object-is-used.js",
] as const;

const HOST_ABI_PASS = "annexB/language/function-code/block-decl-func-block-scoping.js";
const HOST_ABI_NONTRAP = "language/expressions/await/await-awaits-thenable-not-callable.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.run as () => number)();
}

describe("#3371 standalone Reflect.construct", () => {
  it.each(REPRESENTATIVES)("passes original-harness representative %s", { timeout: 60_000 }, async (path) => {
    const result = await runTest262File(resolve("test262/test", path), "issue-3371", 45_000, "standalone");
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });

  it("supports two-argument construction", async () => {
    await expect(
      runStandalone(`
        class Box {
          value: number;
          constructor(value: number) { this.value = value; }
        }
        export function run(): number {
          const box: any = Reflect.construct(Box, [42]);
          return box.value;
        }
      `),
    ).resolves.toBe(42);
  });

  it("keeps constructible function-expression wrappers callable in compileMulti", async () => {
    const result = await compileMulti(
      {
        "./dependency.js": `export const value = 1;`,
        "./entry.js": `
          import { value } from "./dependency.js";
          function assert() {}
          assert.sameValue = function (actual, expected) {
            if (actual !== expected) throw new Error("values differ");
          };
          assert.sameValue(value, 1);
          export function run() { return value; }
        `,
      },
      "./entry.js",
      { allowJs: true, skipSemanticDiagnostics: true, target: "standalone" },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });

  it("keeps unsupported argsList shapes fail-loud under #3371", async () => {
    const result = await compile(
      `export function f(target: any, argsList: any): any { return Reflect.construct(target, argsList); }`,
      { target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(false);
    const errors = result.errors.map((error) => error.message).join("\n");
    expect(errors).toMatch(/array-literal argsList \(#3371\)/);
    expect(errors).not.toMatch(/#1472/);
    expect(result.imports).toEqual([]);
  });

  it("performs an honest three-argument IsConstructor probe", async () => {
    await expect(
      runStandalone(`
        function isConstructor(f: any): boolean {
          try {
            Reflect.construct(function () {}, [], f);
          } catch (_) {
            return false;
          }
          return true;
        }
        export function run(): number {
          function ordinary() {}
          const expression = function () {};
          const arrow = () => 1;
          return (isConstructor(ordinary) ? 1 : 0)
            + (isConstructor(arrow) ? 10 : 0)
            + (isConstructor(Date.prototype.getYear) ? 100 : 0)
            + (isConstructor(expression) ? 1000 : 0);
        }
      `),
    ).resolves.toBe(1001);
  });

  it("uses a distinct NewTarget prototype for DataView", async () => {
    await expect(
      runStandalone(`
        export function run(): number {
          const buffer = new ArrayBuffer(8);
          function NewTarget() {}
          const proto = {};
          NewTarget.prototype = proto;
          const view: any = Reflect.construct(DataView, [buffer, 0], NewTarget);
          return Object.getPrototypeOf(view) === proto ? 1 : 0;
        }
      `),
    ).resolves.toBe(1);
  });

  it("uses the TypedArray target intrinsic when NewTarget.prototype is null", async () => {
    await expect(
      runStandalone(`
        function check(TA: any): number {
          function NewTarget() {}
          NewTarget.prototype = null;
          const view: any = Reflect.construct(TA, [new ArrayBuffer(8)], NewTarget);
          return Object.getPrototypeOf(view) === Int8Array.prototype ? 1 : 0;
        }
        export function run(): number { return check(Int8Array); }
      `),
    ).resolves.toBe(1);
  });

  it("resolves the original-harness realm alias by TypedArray name", async () => {
    await expect(
      runStandalone(`
        const $262: any = { global: globalThis };
        $262.createRealm = function (): any { return $262; };
        const other: any = $262.createRealm().global;
        function check(TA: any): number {
          return other[TA.name].prototype === Int8Array.prototype ? 1 : 0;
        }
        export function run(): number { return check(Int8Array); }
      `),
    ).resolves.toBe(1);
  });

  it("accepts a realm Function instance as the TypedArray NewTarget", async () => {
    await expect(
      runStandalone(`
        const $262: any = { global: globalThis };
        $262.createRealm = function (): any { return $262; };
        const other: any = $262.createRealm().global;
        const C: any = new other.Function();
        C.prototype = null;
        function check(TA: any): number {
          const view: any = Reflect.construct(TA, [new ArrayBuffer(8)], C);
          return Object.getPrototypeOf(view) === other[TA.name].prototype ? 1 : 0;
        }
        export function run(): number { return check(Int8Array); }
      `),
    ).resolves.toBe(1);
  });

  it("selects the intrinsic prototype for every dynamic TypedArray constructor", async () => {
    await expect(
      runStandalone(`
        const $262: any = { global: globalThis };
        $262.createRealm = function (): any { return $262; };
        const other: any = $262.createRealm().global;
        function check(TA: any): number {
          function NewTarget() {}
          NewTarget.prototype = null;
          const view: any = Reflect.construct(TA, [new ArrayBuffer(8)], NewTarget);
          return Object.getPrototypeOf(view) === other[TA.name].prototype ? 1 : 0;
        }
        export function run(): number {
          return check(Int8Array) + check(Uint8Array) + check(Uint8ClampedArray)
            + check(Int16Array) + check(Uint16Array) + check(Int32Array)
            + check(Uint32Array) + check(Float32Array) + check(Float64Array);
        }
      `),
    ).resolves.toBe(9);
  });

  it("preserves the TypedArray carrier through a harness-style callback", async () => {
    await expect(
      runStandalone(`
        const $262: any = { global: globalThis };
        $262.createRealm = function (): any { return $262; };
        const other: any = $262.createRealm().global;
        const C: any = new other.Function();
        C.prototype = null;
        const floatConstructors: any[] = [Float64Array, Float32Array];
        const intConstructors: any[] = [
          Int32Array, Int16Array, Int8Array, Uint32Array, Uint16Array,
          Uint8Array, Uint8ClampedArray,
        ];
        const constructors: any[] = floatConstructors.concat(intConstructors);
        function makePassthrough(TA: any, value: any): any { return value; }
        function each(f: (TA: any, bound: Function) => void): void {
          for (let i = 0; i < constructors.length; i++) {
            const constructor = constructors[i];
            const bound = makePassthrough.bind(undefined, constructor);
            try { f(constructor, bound); } catch (error) { throw error; }
          }
        }
        export function run(): number {
          let result = 0;
          each(function (TA: any): void {
            const view: any = Reflect.construct(TA, [new ArrayBuffer(8)], C);
            if (Object.getPrototypeOf(view) === other[TA.name].prototype) result += 1;
          });
          return result;
        }
      `),
    ).resolves.toBe(9);
  });
});

describe("#3371 host closure ABI", () => {
  it("keeps ordinary function declarations callable through the original harness", { timeout: 60_000 }, async () => {
    const result = await runTest262File(resolve("test262/test", HOST_ABI_PASS), "issue-3371", 45_000);
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });

  it("does not turn an existing dynamic-import failure into an uncatchable cast", { timeout: 60_000 }, async () => {
    const result = await runTest262File(resolve("test262/test", HOST_ABI_NONTRAP), "issue-3371", 45_000);
    expect(result.error ?? "").not.toMatch(/illegal cast/i);
  });
});
