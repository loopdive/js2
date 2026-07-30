// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const CASES = [
  "built-ins/Array/prototype/filter/target-array-with-non-writable-property.js",
  "built-ins/Array/prototype/map/target-array-with-non-writable-property.js",
] as const;

async function runBoundReflectionProbe(): Promise<number> {
  const result: any = await compile(
    `
var hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
var isEnumerable = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable);
function verifyTransitions(obj: any, name: any): number {
  var desc = Object.getOwnPropertyDescriptor(obj, name);
  if (!desc) return 10;
  if (!hasOwn(obj, name) || isEnumerable(obj, name)) return 11;
  if (desc.value !== 1 || obj[name] !== 1) return 12;

  obj[name] = "unlikelyValue";
  if (obj[name] !== "unlikelyValue") return 13;
  obj[name] = desc.value;
  if (obj[name] !== 1) return 14;

  Object.defineProperty(obj, name, { enumerable: true });
  var changed = Object.getOwnPropertyDescriptor(obj, name);
  if (!changed || !isEnumerable(obj, name) || changed.value !== 1) return 15;

  if (!delete obj[name] || hasOwn(obj, name)) return 16;
  obj[name] = 3;
  var recreated = Object.getOwnPropertyDescriptor(obj, name);
  if (!recreated || recreated.value !== 3 || !recreated.writable ||
      !recreated.enumerable || !recreated.configurable) return 17;

  if (!delete obj[name]) return 18;
  Object.defineProperty(obj, name, {
    value: 1,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  var restored = Object.getOwnPropertyDescriptor(obj, name);
  if (!restored) return 19;
  if (!hasOwn(obj, name)) return 20;
  if (isEnumerable(obj, name)) return 21;
  if (restored.value !== 1) return 22;
  if (!restored.writable) return 23;
  return restored.configurable ? 1 : 24;
}
export function test(): number {
  var values = [1];
  Object.defineProperty(values, 0, {
    value: 1,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return verifyTransitions(values, 0);
}
`,
    {
      fileName: "issue-3420-standalone-array-own-property.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    },
  );
  expect(result.success, result.errors?.map((error: any) => error.message).join("\n")).toBe(true);
  expect(result.importObject).toEqual({});
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  return (instance.exports as { test(): number }).test();
}

describe("#3420 standalone Array own-property reflection", () => {
  it("supports numeric reflection, cross-kind writes, deletion, and recreation", async () => {
    expect(await runBoundReflectionProbe()).toBe(1);
  });

  for (const relativePath of CASES) {
    it(`passes the authoritative standalone case: ${relativePath}`, async () => {
      const result = await runTest262File(
        resolve("test262/test", relativePath),
        "issue-3420-standalone",
        30_000,
        "standalone",
      );
      expect(result.status, result.error).toBe("pass");
    });
  }
});
