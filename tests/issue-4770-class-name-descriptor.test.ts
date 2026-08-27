// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4770 — a class constructor's own `name` descriptor through dynamic MOPs.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(): Promise<number> {
  const result = await compile(
    `
      export function test(): number {
        class C {}
        const receiver: any = C;
        const key: string = "name";
        function gopd(obj: any, property: string): any {
          return Object.getOwnPropertyDescriptor(obj, property);
        }
        function read(obj: any, property: string): any {
          return obj[property];
        }
        function hasOwn(obj: any, property: string): boolean {
          return Object.prototype.hasOwnProperty.call(obj, property);
        }
        function isEnumerable(obj: any, property: string): boolean {
          return Object.prototype.propertyIsEnumerable.call(obj, property);
        }
        function write(obj: any, property: string, value: any): void {
          obj[property] = value;
        }
        function remove(obj: any, property: string): boolean {
          return delete obj[property];
        }
        const descriptor = gopd(receiver, key);
        const valueBefore: any = read(receiver, key);
        const ownBefore = hasOwn(receiver, key);
        const enumerableBefore = isEnumerable(receiver, key);
        write(receiver, key, "changed");
        const writeBlocked = read(receiver, key) === valueBefore;
        const deleted = remove(receiver, key);
        const ownAfterDelete = hasOwn(receiver, key);
        return descriptor !== undefined &&
          descriptor.value === "C" &&
          descriptor.writable === false &&
          descriptor.enumerable === false &&
          descriptor.configurable === true &&
          ownBefore &&
          !enumerableBefore &&
          writeBlocked &&
          deleted &&
          !ownAfterDelete ? 1 : 0;
      }
    `,
    {
      allowJs: true,
      fileName: "issue-4770-class-name-descriptor.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    },
  );
  expect(result.success, result.errors?.map((error) => error.message).join("\n") ?? "compile failed").toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4770 standalone class name descriptor", () => {
  it("keeps dynamic descriptor, read, write, enumeration, and delete semantics aligned", async () => {
    await expect(runStandalone()).resolves.toBe(1);
  });
});
