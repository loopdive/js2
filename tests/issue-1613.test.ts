// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1613 — for-in head with a non-identifier target.
//
// Before this fix compileForInStatement only accepted a single bare
// identifier (or single var/let declaration) and reported a compile error
// for any other ForBinding form:
//   - member-expression target:  for (x.y in obj)
//   - destructuring binding head: for (var [a] in obj) / for (let {a} in obj)
// It also did not reject lexical heads with duplicate bound names, which the
// spec requires to be a parse-phase SyntaxError.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<number | string> {
  const r = await compile(source, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    allowJs: true,
  });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number | string }).test();
}

async function compileErrors(source: string): Promise<string[]> {
  const r = await compile(source, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    allowJs: true,
  });
  return r.errors.map((e) => e.message);
}

describe("Issue #1613 — for-in non-identifier head", () => {
  it("member-expression target receives the enumerated key", async () => {
    const src = `
      export function test(): number {
        const x: any = {};
        let n: number = 0;
        for (x.y in { attr: null }) { n = n + 1; }
        return n;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  it("member-expression target ends holding the last key", async () => {
    const src = `
      export function test(): any {
        const x: any = {};
        for (x.y in { attr: null }) {}
        return x.y;
      }
    `;
    expect(await runTest(src)).toBe("attr");
  });

  it("array binding-pattern head destructures the string key", async () => {
    // Key "ab" array-destructured into [a, b] — duplicate name, last char wins.
    const src = `
      export function test(): any {
        let x: any;
        for (var [x, x] in { ab: null }) {}
        return x;
      }
    `;
    expect(await runTest(src)).toBe("b");
  });

  it("lexical binding-pattern head iterates once", async () => {
    const src = `
      export function test(): number {
        const obj: any = { key: 1 };
        let n: number = 0;
        for (let [a] in obj) { n = n + 1; }
        return n;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  it("rejects duplicate bound names in a lexical for-in head (SyntaxError)", async () => {
    const errs = await compileErrors(`export function test(): number { for (let [x, x] in ({} as any)) {} return 0; }`);
    expect(errs.some((m) => /Duplicate binding 'x' in for-in declaration/.test(m))).toBe(true);
  });

  it("rejects duplicate bound names for const for-in head", async () => {
    const errs = await compileErrors(
      `export function test(): number { for (const [x, x] in ({} as any)) {} return 0; }`,
    );
    expect(errs.some((m) => /Duplicate binding 'x' in for-in declaration/.test(m))).toBe(true);
  });

  it("plain identifier for-in head still works (no regression)", async () => {
    const src = `
      export function test(): number {
        const o: any = { x: 1, y: 2, z: 3 };
        let n: number = 0;
        for (const k in o) { n = n + 1; }
        return n;
      }
    `;
    expect(await runTest(src)).toBe(3);
  });
});
