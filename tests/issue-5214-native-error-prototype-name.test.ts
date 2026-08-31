// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5214 — NativeError prototype `name` must remain configurable through the
// standalone NativeProto companion's own-property presence path.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-5214-native-error-prototype-name.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return -1;
  expect(result.imports.filter((entry) => entry.module === "env")).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#5214 — standalone NativeError prototype name configurability", () => {
  it("keeps all six names visible, deletable, absent, and revivable", async () => {
    await expect(
      runStandalone(`
        function check(proto: any, key: string, expected: string): boolean {
          const initial: any = Object.getOwnPropertyDescriptor(proto, key);
          if (initial === undefined || initial.value !== expected ||
              initial.writable !== true || initial.enumerable !== false ||
              initial.configurable !== true) return false;
          if (!Object.prototype.hasOwnProperty.call(proto, key) ||
              !Object.hasOwn(proto, key) ||
              proto.propertyIsEnumerable(key)) return false;
          const inheritedBefore = key in proto;

          if (!delete proto[key]) return false;
          if (Object.prototype.hasOwnProperty.call(proto, key)) return false;
          if (Object.hasOwn(proto, key)) return false;
          if (Object.getOwnPropertyDescriptor(proto, key) !== undefined) return false;
          if ((key in proto) !== inheritedBefore) return false;
          if (proto.propertyIsEnumerable(key)) return false;

          proto[key] = expected;
          const revived: any = Object.getOwnPropertyDescriptor(proto, key);
          return revived !== undefined && revived.value === expected &&
            revived.writable === true && revived.enumerable === true &&
            revived.configurable === true && Object.hasOwn(proto, key) &&
            proto.propertyIsEnumerable(key);
        }

        function methodControl(proto: any, key: string): boolean {
          const descriptor: any = Object.getOwnPropertyDescriptor(proto, key);
          return descriptor !== undefined && descriptor.writable === true &&
            descriptor.enumerable === false && descriptor.configurable === true &&
            Object.hasOwn(proto, key) && !proto.propertyIsEnumerable(key);
        }

        function expandoControl(proto: any): boolean {
          const key = "issue5214Expando";
          proto[key] = 7;
          const present = Object.hasOwn(proto, key) &&
            Object.prototype.hasOwnProperty.call(proto, key);
          const removed = delete proto[key] && !Object.hasOwn(proto, key) &&
            Object.getOwnPropertyDescriptor(proto, key) === undefined;
          return present && removed;
        }

        if (!check(EvalError.prototype, "name", "EvalError")) return 1;
        if (!check(RangeError.prototype, "name", "RangeError")) return 1;
        if (!check(ReferenceError.prototype, "name", "ReferenceError")) return 1;
        if (!check(SyntaxError.prototype, "name", "SyntaxError")) return 1;
        if (!check(TypeError.prototype, "name", "TypeError")) return 1;
        if (!check(URIError.prototype, "name", "URIError")) return 1;
        if (!methodControl(Date.prototype, "toString")) return 2;
        if (!expandoControl(Date.prototype)) return 3;
        return 0;
      `),
    ).resolves.toBe(0);
  });
});
