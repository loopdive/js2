// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Focused coverage for assignment-form rest-object lowering. Each semantic
// repro runs through both the JavaScript-host and standalone Wasm lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

type Target = undefined | "standalone";

async function run(source: string, target: Target): Promise<Record<string, any>> {
  const result = await compile(source, { fileName: "for-of-rest-review.ts", target });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join("\n"));
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return instance.exports as Record<string, any>;
}

async function withPrototypeValue<T>(
  receiver: object,
  key: string,
  value: unknown,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(receiver, key);
  Object.defineProperty(receiver, key, { configurable: true, enumerable: false, writable: true, value });
  try {
    return await callback();
  } finally {
    if (previous) Object.defineProperty(receiver, key, previous);
    else delete (receiver as Record<string, unknown>)[key];
  }
}

describe("for-of assignment rest-object review repairs", () => {
  it.each<Target>([undefined, "standalone"])("keeps a shadowed local off the module global (%s)", async (target) => {
    const source = `
      var reviewShadow: any = 100;
      export function localValue(): number {
        let reviewShadow: any = 0;
        for ([...{ missing: reviewShadow = 7 }] of [[1]]) {}
        return reviewShadow;
      }
      export function moduleValue(): number { return reviewShadow; }`;
    const exports = await run(source, target);
    expect(exports.localValue()).toBe(7);
    expect(exports.moduleValue()).toBe(100);
  });

  it.each<Target>([undefined, "standalone"])(
    "re-resolves a genuine module global after a default import (%s)",
    async (target) => {
      const source = `
      var reviewGlobal: any = 0;
      export function test(): number {
        for ([...{ missing: reviewGlobal = "fallback" }] of [[1]]) {}
        return reviewGlobal === "fallback" ? 1 : 0;
      }`;
      const exports = await run(source, target);
      expect(exports.test()).toBe(1);
    },
  );

  it("checks inherited Array/Object properties before defaulting in the host lane", async () => {
    const arrayKey = "__forof_review_array_inherited";
    const objectKey = "__forof_review_object_inherited";
    const source = `
      export function test(): number {
        let arrayValue: any = 0;
        let objectValue: any = 0;
        for ([...{ ${arrayKey}: arrayValue = 7, ${objectKey}: objectValue = 9 }] of [[1]]) {}
        return arrayValue * 100 + objectValue;
      }`;
    // The host carrier is a real JS Array, so install the inherited properties
    // on the host prototypes around invocation and restore them afterward.
    const result = await withPrototypeValue(Array.prototype, arrayKey, 41, () =>
      withPrototypeValue(Object.prototype, objectKey, 43, async () => {
        const exports = await run(source, undefined);
        return exports.test();
      }),
    );
    expect(result).toBe(4143);
  });

  it("checks inherited Array/Object properties before defaulting in the standalone lane", async () => {
    const source = `
      Array.prototype.__forof_review_array_inherited = 41;
      Object.prototype.__forof_review_object_inherited = 43;
      export function test(): number {
        let arrayValue: any = 0;
        let objectValue: any = 0;
        for ([...{ __forof_review_array_inherited: arrayValue = 7, __forof_review_object_inherited: objectValue = 9 }] of [[1]]) {}
        return arrayValue * 100 + objectValue;
      }`;
    const exports = await run(source, "standalone");
    expect(exports.test()).toBe(4143);
  });

  it.each<Target>([undefined, "standalone"])("writes through a boxed closure capture (%s)", async (target) => {
    const source = `
      export function test(): number {
        let reviewBox: any = 0;
        const mutate = () => { reviewBox = 99; };
        const read = () => reviewBox;
        for ([...{ missing: reviewBox = 7 }] of [[1]]) {}
        return read();
      }`;
    const exports = await run(source, target);
    expect(exports.test()).toBe(7);
  });

  it.each<Target>([undefined, "standalone"])("assigns named and rest member targets (%s)", async (target) => {
    const source = `
      export function test(): number {
        const target: any = {};
        for ([...{ missing: target.value = 7 }] of [[1]]) {}
        for ([...target.rest] of [[1, 2, 3]]) {}
        return target.value * 10 + target.rest.length;
      }`;
    const exports = await run(source, target);
    expect(exports.test()).toBe(73);
  });
});
