// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";

// Mutation prerequisites for live Promise iteration. Native JavaScript is the
// oracle; stale compiler answers must never become preservation expectations.
const cases = [
  [
    "numeric shrink/regrow",
    `const a = [1, 2, 3]; a.length = 1; a.length = 3;
    return a[1] === undefined && a[2] === undefined ? 1 : -1;`,
  ],
  [
    "reference shrink/regrow",
    `const a: any[] = [1, undefined, 3]; a.length = 1; a.length = 3;
    return a[1] === undefined && a[2] === undefined ? 1 : -1;`,
  ],
  [
    "reference descriptor shrink/regrow",
    `const a: any[] = [1, undefined, 3];
    Object.defineProperty(a, "length", {value: 1});
    Object.defineProperty(a, "length", {value: 3});
    return a[1] === undefined && a[2] === undefined ? 1 : -1;`,
  ],
  [
    "reference append preserved",
    `const a: any[] = [1, undefined];
    a[a.length] = 3; a.length = 3;
    return a[2] === 3 ? 1 : -1;`,
  ],
  [
    "dynamic length shrink/regrow",
    `const a: any = [1, undefined, 3];
    function setLength(x: any, key: string, value: number) { x[key] = value; }
    setLength(a, "length", 1); setLength(a, "length", 3);
    return a[1] === undefined && a[2] === undefined ? 1 : -1;`,
  ],
  [
    "refused shrink preserves elements",
    `const a: any[] = [1, undefined, 3];
    Object.defineProperty(a, "length", {writable: false});
    try { a.length = 1; } catch (_) {}
    return a.length === 3 && a[2] === 3 ? 1 : -1;`,
  ],
] as const;

for (const [name, body] of cases) {
  it(name, async () => {
    const source = `export function test(): number { ${body} }`;
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    expect(runInNewContext(`${js}\nexports.test()`, { exports: {} }, { timeout: 5000 })).toBe(1);
    const result = await compile(source, { target: "standalone", nativeStrings: true });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    const actual = (instance.exports.test as () => number)();
    console.log(JSON.stringify({ name, source, actual, expected: 1 }));
    expect(actual).toBe(1);
  });
}
