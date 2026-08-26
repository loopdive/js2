// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #4732 — §23.4.1.1 step 1: WeakSet has no [[Call]] method. Calling the
 * ambient constructor without `new` must throw a TypeError on both the JS-host
 * and standalone lanes, while the native constructor path and adjacent
 * WeakMap/Set constructors remain usable.
 */

import { describe, expect, it } from "vitest";

import { buildImports, compile, instantiateWasm } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4732.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown"}`);
  }

  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

function lanes(): Lane[] {
  return ["host", "standalone"];
}

describe("#4732 — WeakSet requires new", () => {
  for (const lane of lanes()) {
    describe(lane, () => {
      it("throws TypeError for both no-argument and iterable calls", async () => {
        await expect(
          run(
            `export function test(): number {
              let sideEffect = 0;
              let noArg = 0;
              let iterableArg = 0;
              try { WeakSet(); } catch (e) { noArg = e instanceof TypeError ? 1 : -1; }
              try { WeakSet([sideEffect = 1]); } catch (e) {
                iterableArg = e instanceof TypeError ? 1 : -1;
              }
              return noArg + iterableArg * 2 + sideEffect * 4;
            }`,
            lane,
          ),
        ).resolves.toBe(7);
      });

      it("keeps native constructor controls working", async () => {
        await expect(
          run(
            `export function test(): number {
              const ws = new WeakSet([]);
              const wm = new WeakMap([]);
              const set = new Set([]);
              return ws !== undefined && wm !== undefined && set !== undefined ? 1 : 0;
            }`,
            lane,
          ),
        ).resolves.toBe(1);
      });
    });
  }
});

describe("#4732 — constructor import shape", () => {
  it("keeps standalone WeakSet/WeakMap/Set construction host-free", async () => {
    const result = await compile(
      `export function test(): number {
        const key: object = {};
        return new WeakSet([key]).has(key) && new WeakMap([[key, 1]]).get(key) === 1 && new Set([1]).has(1) ? 1 : 0;
      }`,
      { fileName: "issue-4732-structure.ts", target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    if (!result.success) return;
    const imports = result.imports.map((entry) => entry.name);
    expect(imports.filter((name) => /^(WeakSet|WeakMap|Set)_/.test(name))).toEqual([]);
  });

  it("retains host constructor imports for the host lane", async () => {
    const result = await compile(
      `export function test(): number {
        const key: object = {};
        return new WeakSet([key]).has(key) && new WeakMap([[key, 1]]).get(key) === 1 && new Set([1]).has(1) ? 1 : 0;
      }`,
      { fileName: "issue-4732-host-structure.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    if (!result.success) return;
    const imports = result.imports.map((entry) => entry.name);
    expect(imports).toEqual(expect.arrayContaining(["WeakSet_new", "WeakMap_new", "Set_new"]));
  });
});
