// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7430 — `o?.f?.()` where the class field `f` holds `undefined`: the struct-field arm of the optional call called the
// field without testing it, and the call trapped. Past the receiver test the call is now `o.f?.()` on the held
// receiver, which short-circuits on the field value. That call passes a spread argument as its elements, not as one
// array. A field that holds a non-callable value is not skipped: the call throws a TypeError. Each program's expected
// answer is node's.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const TARGETS = ["gc", "standalone", "wasi"] as const;

async function run(source: string, target: (typeof TARGETS)[number]): Promise<unknown> {
  const result = await compile(source, { target, fileName: "t.ts" });
  expect(result.errors.filter((error) => error.severity === "error").map((error) => error.message)).toEqual([]);
  const imports =
    target === "gc"
      ? buildImports(result.imports, undefined, result.stringPool)
      : target === "wasi"
        ? { wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }) }
        : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.main as () => unknown)();
}

const node = (source: string): unknown =>
  new Function(
    `${ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace(/export /g, "")}; return main();`,
  )();

describe("#7430 `o?.f?.(args)` on a class-field callee", () => {
  it.each([
    [
      "an undefined field",
      "class O { f: (() => number) | undefined = undefined; } " +
        "export function main(): number { const o: O | undefined = new O(); return o?.f?.() === undefined ? 1 : 0; }",
      1,
    ],
    [
      "an undefined field does not evaluate the arguments",
      "let n = 0; function bump(): number { n++; return 1; } " +
        "class O { f: ((x: number) => number) | undefined = undefined; } " +
        "export function main(): number { const o: O | undefined = new O(); const r = o?.f?.(bump()); " +
        "return (r === undefined ? 1 : 0) + n * 10; }",
      1,
    ],
    [
      "a defined field runs once, with the arguments evaluated once",
      "let n = 0; let calls = 0; function bump(): number { n++; return 4; } " +
        "class O { f: ((x: number) => number) | undefined = (x: number) => { calls++; return x * 2; }; } " +
        "export function main(): number { const o: O | undefined = new O(); const r = o?.f?.(bump()); " +
        "return (r === 8 ? 1 : 0) + n * 10 + calls * 100; }",
      111,
    ],
    [
      "a defined field is called with the receiver as `this`",
      "class O { n = 5; f: ((this: O) => number) | undefined = function (this: O) { return this.n; }; } " +
        "export function main(): number { const o: O | undefined = new O(); return o?.f?.() ?? -1; }",
      5,
    ],
    [
      "an undefined receiver short-circuits before the arguments",
      "let n = 0; function bump(): number { n++; return 1; } " +
        "class O { f: ((x: number) => number) | undefined = (x: number) => x; } " +
        "export function main(): number { const o: O | undefined = undefined as O | undefined; " +
        "const r = o?.f?.(bump()); return (r === undefined ? 1 : 0) + n * 10; }",
      1,
    ],
    [
      "a parameter receiver, defined and undefined fields",
      "class O { f: ((x: number) => number) | undefined; constructor(f?: (x: number) => number) { this.f = f; } } " +
        "function g(o?: O): number { const r = o?.f?.(3); return r === undefined ? -1 : r; } " +
        "export function main(): number { return g(new O((x) => x + 1)) * 100 + g(new O()) * 10 + g(); }",
      389,
    ],
    [
      "a getter receiver is read once",
      "let gets = 0; class O { f: (() => number) | undefined = () => 2; } " +
        "class H { o = new O(); get g(): O | undefined { gets++; return this.o; } } " +
        "export function main(): number { const h = new H(); const r = h.g?.f?.(); return (r === 2 ? 1 : 0) + gets * 10; }",
      11,
    ],
    [
      "an object-literal field",
      "export function main(): number { const o: { f?: () => number } | undefined = {}; " +
        "const p: { f?: () => number } | undefined = { f: () => 3 }; " +
        "return (o?.f?.() === undefined ? 1 : 0) + (p?.f?.() ?? 0) * 10; }",
      31,
    ],
    [
      "a spread argument passes its elements",
      "class C { f = (a: number, b: number) => a + b; } " +
        "export function main(): number { const o: C | undefined = new C(); const xs = [1, 2]; return o?.f?.(...xs) ?? -1; }",
      3,
    ],
    [
      "a spread after a plain argument",
      "class C { f = (a: number, b: number, c: number) => a + b * 10 + c * 100; } " +
        "export function main(): number { const o: C | undefined = new C(); const xs = [2, 3]; " +
        "return o?.f?.(1, ...xs) ?? -1; }",
      321,
    ],
    [
      "`o.f?.(...xs)` on a receiver that is not optional",
      "class C { f = (a: number, b: number) => a + b; } " +
        "export function main(): number { const o = new C(); const xs = [1, 2]; return o.f?.(...xs) ?? -1; }",
      3,
    ],
  ])("%s", async (_, source, expected) => {
    expect(node(source)).toBe(expected);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(expected);
  });
});

// Each program answers 1 when `o?.f?.()` throws a TypeError, 2 when it yields `undefined`, 3 for any other value.
const outcome = (decl: string, call = "o?.f?.()"): string =>
  `${decl} export function main(): number { ` +
  `try { const r = ${call}; return r === undefined ? 2 : 3; } catch (e) { return e instanceof TypeError ? 1 : 4; } }`;

describe("#7469 `o?.f?.()` on a class field that holds a non-callable value", () => {
  it.each([
    ["a number field", outcome("class O { f: any = 5; } const o: O | undefined = new O();")],
    ["a string field", outcome('class O { f: any = "s"; } const o: O | undefined = new O();')],
    ["an object field", outcome("class O { f: any = {}; } const o: O | undefined = new O();")],
    ["`o.f?.()` on a number field", outcome("class O { f: any = 5; } const o = new O();", "o.f?.()")],
  ])("%s throws a TypeError", async (_, source) => {
    expect(node(source)).toBe(1);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(1);
  });
});
