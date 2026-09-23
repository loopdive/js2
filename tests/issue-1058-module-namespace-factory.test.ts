// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

it.each([false, true])("reads an exported factory beside mutable exports (barrel=%s)", async (barrel) => {
  const result = await compileMulti(
    {
      "./provider.ts": `
      export let revision = 1;
      export const factory = createFactory();
      function createFactory() {
        return { get mode() { return 7; }, make: () => ({ kind: 42 }) };
      }
      export function bump() { revision++; }
    `,
      "./barrel.ts": 'export * from "./provider.js";',
      "./entry.ts": `
      import * as ts from "./${barrel ? "barrel" : "provider"}.js";
      export function run(): number {
        const kind = ts.factory.make().kind;
        ts.bump();
        return kind * 10 + ts.revision;
      }
    `,
    },
    "./entry.ts",
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(422);
});

it("keeps same-named exported live bindings owned by their exact modules", async () => {
  const result = await compileMulti(
    {
      "./left.ts": "export let value = 7; export function bump() { value++; }",
      "./right.ts": "export let value = 40; export function bump() { value += 2; }",
      "./entry.ts": `
      import * as left from "./left.js";
      import * as right from "./right.js";
      export function run(): number { left.bump(); right.bump(); return left.value * 100 + right.value; }
    `,
    },
    "./entry.ts",
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(842);
});
