// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2131 — JS-host enumeration (Object.keys/values/entries, for-in,
// getOwnPropertyNames via _ownStructKeys) emitted raw struct-field
// declaration order. ES §10.1.11.1 OrdinaryOwnPropertyKeys requires
// canonical array-index keys first in ascending numeric order, then string
// keys in insertion order. The host runtime now applies a shared
// _orderOwnKeysSpec helper at every struct key-emission site (the JS-host
// counterpart of #1837's standalone fix).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, options: Record<string, unknown> = {}, fn = "test"): Promise<unknown> {
  const r = await compile(source, options);
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as any)[fn]();
}

describe("#2131 — JS-host integer-key enumeration order", () => {
  it("Object.keys puts array-index keys first, ascending", async () => {
    const out = await run(`
      export function test(): string {
        const o: any = { b: 1, "2": 2, a: 3, "1": 4 };
        return Object.keys(o).join(",");
      }
    `);
    expect(out).toBe("1,2,b,a");
  });

  it("for-in visits keys in the same order", async () => {
    const out = await run(`
      export function test(): string {
        const o: any = { b: 1, "2": 2, a: 3, "1": 4 };
        let s = "";
        for (const k in o) s += k + ",";
        return s;
      }
    `);
    expect(out).toBe("1,2,b,a,");
  });

  it("Object.values follows the spec key order", async () => {
    const out = await run(`
      export function test(): string {
        const o: any = { b: 1, "2": 2, a: 3, "1": 4 };
        return Object.values(o).join(",");
      }
    `);
    expect(out).toBe("4,2,1,3");
  });

  it("Object.entries follows the spec key order", async () => {
    const out = await run(`
      export function test(): string {
        const o: any = { b: 1, "2": 2, a: 3, "1": 4 };
        const e: any = Object.entries(o);
        return e[0][0] + e[1][0] + e[2][0] + e[3][0];
      }
    `);
    expect(out).toBe("12ba");
  });

  it("pure string-key objects keep insertion order", async () => {
    const out = await run(`
      export function test(): string {
        const o: any = { b: 1, a: 3, c: 2 };
        return Object.keys(o).join(",");
      }
    `);
    expect(out).toBe("b,a,c");
  });

  it("non-canonical numeric-looking keys are NOT reordered", async () => {
    const out = await run(`
      export function test(): string {
        const o: any = { b: 1, "01": 2, a: 3 };
        return Object.keys(o).join(",");
      }
    `);
    expect(out).toBe("b,01,a");
  });

  it("standalone mode (already fixed by #1837) keeps the same order", async () => {
    const out = await run(
      `
      export function test(): string {
        const o: any = { b: 1, "2": 2, a: 3, "1": 4 };
        return Object.keys(o).join(",");
      }
    `,
      { standalone: true },
    );
    expect(out).toBe("1,2,b,a");
  });
});
