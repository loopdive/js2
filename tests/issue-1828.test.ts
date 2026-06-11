// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1828 — Array.prototype.{find,findIndex,map}.call on sparse array-like
// receivers. ECMA-262 §23.1.3.12.1 FindViaPredicate visits every index via
// Get, while §23.1.3.21 Array.prototype.map skips missing indices but preserves
// the original length and holes.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run<T>(src: string, fnName = "test"): Promise<T> {
  const r = await compile(src, { fileName: "issue-1828.ts" });
  const errors = r.errors.filter((e) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((e) => `L${e.line}:${e.column} ${e.message}`).join("\n"));
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => T>)[fnName]!();
}

describe("#1828 sparse array-like Array.prototype .call hole handling", () => {
  it("findIndex.call visits holes as undefined", async () => {
    const result = await run<number>(`
      export function test(): number {
        const obj: any = { 0: 1, 2: 3, length: 3 };
        return Array.prototype.findIndex.call(obj, (x: any) => x === undefined);
      }
    `);

    expect(result).toBe(1);
  });

  it("find.call stops on a hole visited as undefined", async () => {
    const result = await run<number>(`
      export function test(): number {
        const obj: any = { 0: 1, 2: 3, length: 3 };
        let visited = 0;
        const found: any = Array.prototype.find.call(obj, (x: any) => {
          visited = visited + 1;
          return x === undefined;
        });
        return found === undefined && visited === 2 ? 1 : 0;
      }
    `);

    expect(result).toBe(1);
  });

  it("map.call preserves sparse receiver length and holes", async () => {
    const result = await run<number>(`
      export function test(): number {
        const obj: any = { 0: 1, 2: 3, length: 3 };
        const out: any = Array.prototype.map.call(obj, (x: any) => x * 2);
        if (out.length !== 3) return 10 + out.length;
        if (out[0] !== 2) return 20;
        if ("1" in out) return 30;
        if (out[2] !== 6) return 40;
        return 1;
      }
    `);

    expect(result).toBe(1);
  });

  it("map.call keeps trailing holes by preserving the original length", async () => {
    const result = await run<number>(`
      export function test(): number {
        const obj: any = { 0: 5, length: 3 };
        const out: any = Array.prototype.map.call(obj, (x: any) => x + 1);
        if (out.length !== 3) return 10 + out.length;
        if (out[0] !== 6) return 20;
        if ("1" in out) return 30;
        if ("2" in out) return 40;
        return 1;
      }
    `);

    expect(result).toBe(1);
  });
});
