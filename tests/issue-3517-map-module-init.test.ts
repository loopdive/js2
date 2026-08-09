// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { compile, compileMulti, type CompileOptions, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ALGORITHMS_URL = new URL("../website/playground/examples/js/algorithms.ts", import.meta.url);
const ALGORITHMS_SOURCE = readFileSync(ALGORITHMS_URL, "utf8");
const MAP_SOURCE = `
  const cache = new Map<number, number>();
  export function memo(n: number): number {
    if (n < 2) return n;
    const hit = cache.get(n);
    if (hit !== undefined) return hit;
    const value = memo(n - 1) + memo(n - 2);
    cache.set(n, value);
    return value;
  }
`;

const previousIrFirst = process.env.JS2WASM_IR_FIRST;
afterEach(() => {
  if (previousIrFirst === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
  else process.env.JS2WASM_IR_FIRST = previousIrFirst;
});

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

function mapImportNames(result: CompileResult): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .filter((entry) => entry.kind === "function" && entry.module === "env" && entry.name.startsWith("Map_"))
    .map((entry) => entry.name)
    .sort();
}

async function tracked(source: string, options: CompileOptions = {}): Promise<CompileResult> {
  return compile(source, {
    fileName: "issue-3517-map-module-init.ts",
    experimentalIR: true,
    trackFallbacks: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
}

describe("#3517 exact generic Map module initializer", () => {
  for (const irFirst of ["0", "1"] as const) {
    it(`IR-emits and runs the exact algorithms source with JS2WASM_IR_FIRST=${irFirst}`, async () => {
      process.env.JS2WASM_IR_FIRST = irFirst;
      const result = await tracked(ALGORITHMS_SOURCE, { fileName: ALGORITHMS_URL.pathname });

      expectSuccess(result);
      expect(result.irCompiledFuncs ?? []).toContain("<module-init>");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(mapImportNames(result)).toEqual(["Map_get", "Map_new", "Map_set"]);

      const built = buildImports(result.imports, undefined, result.stringPool);
      const env = built.env as Record<string, (...args: unknown[]) => unknown>;
      const originalNew = env.Map_new!;
      const originalGet = env.Map_get!;
      const originalSet = env.Map_set!;
      const maps: unknown[] = [];
      let getCalls = 0;
      let setCalls = 0;
      const logs: string[] = [];
      env.console_log_string = (value: unknown) => logs.push(String(value));
      env.Map_new = (...args: unknown[]) => {
        const map = originalNew(...args);
        maps.push(map);
        return map;
      };
      env.Map_get = (receiver: unknown, ...args: unknown[]) => {
        getCalls++;
        expect(receiver).toBe(maps[0]);
        return originalGet(receiver, ...args);
      };
      env.Map_set = (receiver: unknown, ...args: unknown[]) => {
        setCalls++;
        expect(receiver).toBe(maps[0]);
        return originalSet(receiver, ...args);
      };

      const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
      imports["wasm:js-string"] = built["wasm:js-string"] as unknown as WebAssembly.ModuleImports;
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      built.setExports?.(instance.exports as Record<string, Function>);
      expect(maps).toHaveLength(1);

      const main = instance.exports.main as () => void;
      main();
      const firstLogs = [...logs];
      const firstGets = getCalls;
      const firstSets = setCalls;
      expect(firstGets).toBeGreaterThan(0);
      expect(firstSets).toBeGreaterThan(0);
      expect(firstLogs.at(-1)).toBe("after  = [0,1,2,3,4,5,6,7,8,9]");

      main();
      expect(logs.slice(firstLogs.length)).toEqual(firstLogs);
      expect(getCalls).toBeGreaterThan(firstGets);
      expect(setCalls, "the second run reuses the populated module Map").toBe(firstSets);
      expect(maps).toHaveLength(1);
    });
  }

  it.each([
    ["let binding", `let cache = new Map<number, number>(); export function read(): number { return 1; }`],
    ["one type argument", `const cache = new Map<number>(); export function read(): number { return 1; }`],
    [
      "runtime argument",
      `const cache = new Map<number, number>([[1, 2]]); export function read(): number { return 1; }`,
    ],
    [
      "conditional wrapper",
      `const cache = true ? new Map<number, number>() : new Map<number, number>(); export function read(): number { return 1; }`,
    ],
    [
      "shadowed Map",
      `class Map<K, V> {} const cache = new Map<number, number>(); export function read(): number { return 1; }`,
    ],
  ])("keeps the unsupported %s module shape on the direct initializer", async (_label, source) => {
    const result = await tracked(source);
    expectSuccess(result);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps typed local constructors outside the exception", async () => {
    const result = await tracked(`
      class Box<T, U> {}
      export function make(): number {
        const value = new Box<number, number>();
        return value === null ? 0 : 1;
      }
    `);
    expectSuccess(result);
    expect(result.irCompiledFuncs ?? []).not.toContain("make");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each([
    ["native strings", { nativeStrings: true }],
    ["fast", { fast: true }],
    ["standalone", { target: "standalone" as const }],
    ["WASI", { target: "wasi" as const }],
    ["strict no-host", { strictNoHostImports: true }],
  ])("keeps the Map module initializer legacy-owned in %s", async (_label, options) => {
    const result = await tracked(MAP_SOURCE, options);
    expectSuccess(result);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps module init legacy-owned in the M0 multi-source overlay", async () => {
    const result = await compileMulti(
      {
        "./dep.ts": `export function identity(value: number): number { return value; }`,
        "./entry.ts": `
          import { identity } from "./dep";
          ${MAP_SOURCE}
          export function run(n: number): number { return identity(memo(n)); }
        `,
      },
      "./entry.ts",
      {
        experimentalIR: true,
        trackFallbacks: true,
        skipSemanticDiagnostics: true,
      },
    );
    expectSuccess(result);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
