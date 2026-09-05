// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4740 — standalone native collection instances must expose their intrinsic
// collection prototype through Object.getPrototypeOf.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const COLLECTION_PROTOTYPES = `
  const map = Object.getPrototypeOf(new Map([])) === Map.prototype;
  const set = Object.getPrototypeOf(new Set([])) === Set.prototype;
  const weakMap = Object.getPrototypeOf(new WeakMap([])) === WeakMap.prototype;
  const weakSet = Object.getPrototypeOf(new WeakSet([])) === WeakSet.prototype;
  return (map ? 1 : 0) + (set ? 2 : 0) + (weakMap ? 4 : 0) + (weakSet ? 8 : 0);
`;

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-4740.ts", target: "standalone" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.imports ?? []).toHaveLength(0);
  expect(WebAssembly.validate(result.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

async function runHost(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-4740.ts" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const importResult = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, importResult as WebAssembly.Imports);
  (importResult as typeof importResult & { setInstance?: (value: WebAssembly.Instance) => void }).setInstance?.(
    instance,
  );
  return (instance.exports as { test(): number }).test();
}

describe("#4740 native collection instance prototypes", () => {
  it("returns each collection prototype in standalone", async () => {
    expect(await runStandalone(`export function test(): number {${COLLECTION_PROTOTYPES}}`)).toBe(15);
  });

  it("preserves host collection prototype behavior", async () => {
    expect(await runHost(`export function test(): number {${COLLECTION_PROTOTYPES}}`)).toBe(15);
  });

  it("does not change ordinary object prototype identity", async () => {
    expect(
      await runStandalone(`export function test(): number {
        return Object.getPrototypeOf({}) === Object.prototype ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
