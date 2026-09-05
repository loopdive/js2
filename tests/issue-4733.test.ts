// #4733 — native Map/Set forEach forwards callback parameters to named
// function-valued locals. The optional Map.forEach thisArg remains #4725.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, buildWasiPolyfill } from "../src/runtime.js";

type Target = "wasi" | undefined;

async function run(source: string, target: Target): Promise<{ value: number; mapImports: string[] }> {
  const result = await compile(source, {
    fileName: "test.ts",
    ...(target === undefined ? {} : { target }),
  });
  if (!result.success) throw new Error(result.errors?.[0]?.message ?? "compile failed");

  const module = await WebAssembly.compile(result.binary);
  const mapImports = WebAssembly.Module.imports(module)
    .map((entry) => entry.name)
    .filter((name) => /^Map_|^Set_/.test(name));

  let instance: WebAssembly.Instance;
  if (target === "wasi") {
    const wasi = buildWasiPolyfill();
    instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
    const memory = instance.exports.memory;
    if (memory) wasi.setMemory(memory as WebAssembly.Memory);
  } else {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    instance = await WebAssembly.instantiate(module, imports);
    imports.setInstance?.(instance);
    imports.setExports?.(instance.exports as Record<string, Function>);
  }

  return { value: (instance.exports.test as () => number)(), mapImports };
}

describe("#4733 Map/Set forEach callback parameters", () => {
  it("passes value, key, and the Map receiver to a named callback", async () => {
    const source = `
      export function test(): number {
        const map = new Map<number, number>();
        map.set(1, 10);
        map.set(2, 20);
        let code = 0;
        const callback = function (value: number, key: number, received: Map<number, number>) {
          if (received === map) code = code * 100 + value * 10 + key;
        };
        map.forEach(callback);
        return code;
      }
    `;

    for (const target of [undefined, "wasi"] as const) {
      const { value, mapImports } = await run(source, target);
      expect(value).toBe(10302);
      if (target === "wasi") expect(mapImports).toHaveLength(0);
    }
  });

  it("passes the Set value as both value and key to a named callback", async () => {
    const source = `
      export function test(): number {
        const set = new Set<number>();
        set.add(2);
        set.add(3);
        let code = 0;
        const callback = function (value: number, key: number, received: Set<number>) {
          if (received === set && value === key) code = code * 10 + value;
        };
        set.forEach(callback);
        return code;
      }
    `;

    for (const target of [undefined, "wasi"] as const) {
      const { value, mapImports } = await run(source, target);
      expect(value).toBe(23);
      if (target === "wasi") expect(mapImports).toHaveLength(0);
    }
  });
});
