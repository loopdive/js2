// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(["gc", "standalone"] as const)("reads optional binder Map.size as a number in %s", async (target) => {
  const result = await compile(
    `interface Symbol { flags: number; }
    type SymbolTable = Map<string, Symbol>;
    interface Source { locals?: SymbolTable; }
    export function run(): number {
      const source: Source = {};
      if ((source.locals?.size ?? 0) !== 0) return -1;
      source.locals = new Map<string, Symbol>();
      source.locals.set("x", { flags: 2 });
      const count = source.locals?.size ?? 0;
      if (count !== 1 || count >= 256) return -2;
      const map: ReadonlyMap<string, Symbol> = source.locals;
      if (map?.size !== 1) return -3;
      const set: ReadonlySet<number> = new Set([1, 2]);
      if (set?.size !== 2) return -4;
      let reads = 0;
      const holder = { get value(): ReadonlyMap<string, Symbol> { reads++; return map; } };
      if (holder.value?.size !== 1 || reads !== 1) return -5;
      return count * 256;
    }`,
    { target },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
  const imports = result.importObject ?? {};
  const instance = await WebAssembly.instantiate(module, imports);
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  expect((instance.exports.run as () => number)()).toBe(256);
});

it.each(["Map", "Set"])("does not claim a user-defined %s size getter", async (name) => {
  const result = await compile(
    `class ${name} {
      get size(): number { return 7; }
    }
    export function run(): number {
      const value = new ${name}();
      return value?.size;
    }`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as () => number)()).toBe(7);
});
