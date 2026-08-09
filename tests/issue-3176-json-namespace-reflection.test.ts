// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3176 residual — runtime reflection over the standalone JSON namespace.
 *
 * Direct `<Builtin>.<method>` reads have compile-time metadata paths. These
 * tests deliberately erase the receiver/key types through helper parameters,
 * matching test262's `propertyHelper.js`, so the native `$Object` MOP must
 * observe the namespace carrier's genuine own properties.
 */

async function compileStandalone(src: string) {
  const result = await compile(src, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#3176 standalone JSON namespace reflection", () => {
  it("exposes JSON methods as non-enumerable writable configurable own properties", async () => {
    const exports = await compileStandalone(`
      function descriptorIsBuiltinMethod(obj: any, key: any): number {
        const d: any = Object.getOwnPropertyDescriptor(obj, key);
        return d !== undefined &&
          d.writable === true &&
          d.enumerable === false &&
          d.configurable === true ? 1 : 0;
      }

      export function parse(): number { return descriptorIsBuiltinMethod(JSON, "parse"); }
      export function stringify(): number { return descriptorIsBuiltinMethod(JSON, "stringify"); }
      export function rawJSON(): number { return descriptorIsBuiltinMethod(JSON, "rawJSON"); }
      export function isRawJSON(): number { return descriptorIsBuiltinMethod(JSON, "isRawJSON"); }
    `);

    expect(exports.parse!()).toBe(1);
    expect(exports.stringify!()).toBe(1);
    expect(exports.rawJSON!()).toBe(1);
    expect(exports.isRawJSON!()).toBe(1);
  });

  it("installs JSON's symbol-keyed toStringTag with its spec descriptor", async () => {
    const exports = await compileStandalone(`
      function check(obj: any, key: any): number {
        const d: any = Object.getOwnPropertyDescriptor(obj, key);
        return obj[key] === "JSON" &&
          d !== undefined &&
          d.writable === false &&
          d.enumerable === false &&
          d.configurable === true ? 1 : 0;
      }

      export function test(): number { return check(JSON, Symbol.toStringTag); }
    `);

    expect(exports.test!()).toBe(1);
  });

  it("treats reified JSON methods as extensible function objects", async () => {
    const exports = await compileStandalone(`
      function check(fn: any): number {
        return Object.isExtensible(fn) &&
          !Object.isFrozen(fn) &&
          !Object.isSealed(fn) &&
          Object.getPrototypeOf(fn) === Function.prototype &&
          fn.hasOwnProperty("prototype") === false ? 1 : 0;
      }

      export function parse(): number { return check(JSON.parse); }
      export function stringify(): number { return check(JSON.stringify); }
      export function rawJSON(): number { return check(JSON.rawJSON); }
      export function isRawJSON(): number { return check(JSON.isRawJSON); }
    `);

    expect(exports.parse!()).toBe(1);
    expect(exports.stringify!()).toBe(1);
    expect(exports.rawJSON!()).toBe(1);
    expect(exports.isRawJSON!()).toBe(1);
  });
});
