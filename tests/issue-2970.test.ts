// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#2970) `import.meta` is a distinct per-module object with stable reference
// identity: stable within a module, distinct across modules
// (sec-meta-properties). Mirrors test262
// language/expressions/import.meta/distinct-for-each-module.js.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime.js";

async function runMulti(files: Record<string, string>, entry: string): Promise<number> {
  const r: any = await compileMulti(files, entry);
  if (!r.success) throw new Error("compile failed: " + JSON.stringify(r.errors)?.slice(0, 300));
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test(): number }).test();
}

async function runBool(src: string): Promise<boolean> {
  // Wasm returns i32 (1/0) for a boolean export — coerce to a JS boolean.
  const ex = (await compileAndInstantiate(src)) as { test(): number };
  return Boolean(ex.test());
}
async function runStr(src: string): Promise<string> {
  const ex = (await compileAndInstantiate(src)) as { test(): string };
  return ex.test();
}

describe("#2970 import.meta per-module identity", () => {
  it("distinct across modules, stable within (distinct-for-each-module)", async () => {
    const files = {
      "fixture.ts": `
        export const meta = import.meta;
        export function getMeta(): object { return import.meta; }
      `,
      "entry.ts": `
        import { meta as fixtureMeta, getMeta } from './fixture.ts';
        export function test(): number {
          // 1: each module gets its own object
          const a = import.meta !== fixtureMeta ? 1 : 0;
          // 2: a function returns the import.meta of the module it is declared in
          const b = import.meta !== getMeta() ? 2 : 0;
          // 4: stable identity within one module
          const c = fixtureMeta === getMeta() ? 4 : 0;
          return a + b + c;
        }
      `,
    };
    expect(await runMulti(files, "entry.ts")).toBe(7);
  });

  it("import.meta === import.meta within one module (stable identity)", async () => {
    expect(await runBool(`export function test(): boolean { const a = import.meta; return a === import.meta; }`)).toBe(
      true,
    );
  });

  it("typeof import.meta is 'object'", async () => {
    expect(await runBool(`export function test(): boolean { return typeof import.meta === "object"; }`)).toBe(true);
  });

  it("import.meta is not null / undefined", async () => {
    expect(await runBool(`export function test(): boolean { return import.meta !== (null as any); }`)).toBe(true);
    expect(await runBool(`export function test(): boolean { return import.meta !== (undefined as any); }`)).toBe(true);
  });

  it("string coercion yields [object Object]", async () => {
    expect(await runStr(`export function test(): string { return import.meta + ""; }`)).toBe("[object Object]");
  });

  it("unknown import.meta property is undefined", async () => {
    expect(await runBool(`export function test(): boolean { return (import.meta as any).foo === undefined; }`)).toBe(
      true,
    );
  });

  it("two importers of the same fixture see the SAME fixture meta", async () => {
    const files = {
      "fixture.ts": `export const meta = import.meta;`,
      "mid.ts": `import { meta } from './fixture.ts'; export const midMeta = meta;`,
      "entry.ts": `
        import { meta as m1 } from './fixture.ts';
        import { midMeta as m2 } from './mid.ts';
        export function test(): number {
          // both re-exports resolve to the fixture module's single object
          const same = m1 === m2 ? 1 : 0;
          // and the entry module's own meta differs from the fixture's
          const diff = import.meta !== m1 ? 2 : 0;
          return same + diff;
        }
      `,
    };
    expect(await runMulti(files, "entry.ts")).toBe(3);
  });
});
