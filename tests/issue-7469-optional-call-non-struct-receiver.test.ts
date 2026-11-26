// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7469 — `o?.f?.()` on a receiver that is not a struct (`any`, a `Record`, an index signature, an object built
// dynamically): an `any` receiver called `f` through the method ladder without testing it, so an undefined `f` threw,
// and a nullish receiver yielded `null`; a `Record` or index-signature receiver never called `f` at all. Past the
// receiver test the call is now `o.f?.()` on the held receiver, as for a struct (#7430). A non-callable `f` that is not
// nullish throws a TypeError, and a global built-in namespace (`JSON`, `Math`) keeps its static method's native call.
// Each expected answer is node's.
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

// Each program scores `o?.f?.()` three ways: a defined `f` that checks `this === o` (×100), an undefined `f` (×10)
// and a nullish receiver (×1).
const METHOD = "function (this: any) { return this === o ? this.n : -50; }";
const score = (decl: string, recv = "o"): string =>
  `export function main(): number { ${decl} ` +
  `return (${recv}?.f?.() ?? -9) * 100 + (u?.f?.() === undefined ? 10 : 0) + (z?.f?.() === undefined ? 1 : 0); }`;

describe("#7469 `o?.f?.(args)` on a non-struct receiver", () => {
  it.each([
    [
      "an `any` local",
      score(`const o: any = { n: 5, f: ${METHOD} }; const u: any = { n: 5 }; const z: any = undefined;`),
    ],
    [
      "an `unknown` parameter narrowed to an object with a callable `f`",
      'function h(o: unknown): any { if (typeof o === "object" && o !== null && "f" in o && ' +
        'typeof o.f === "function") return o?.f?.(3); return -1; } ' +
        "export function main(): number { return h({ f: (x: number) => x * 2 }) * 100 + (h({}) === -1 ? 10 : 0) + " +
        "(h(null) === -1 ? 1 : 0); }",
    ],
    [
      "an `unknown` value cast to `any`",
      score(
        `const v: unknown = { n: 5, f: ${METHOD} }; const o: any = v; const u: any = {} as unknown; const z: any = null;`,
        "(v as any)",
      ),
    ],
    [
      "a `Record` receiver",
      score(
        `const o: Record<string, any> | undefined = { n: 5, f: ${METHOD} }; ` +
          "const u: Record<string, any> | undefined = { n: 5 }; const z: Record<string, any> | undefined = undefined;",
      ),
    ],
    [
      "an index-signature receiver",
      score(
        `const o: { [k: string]: any } | undefined = { n: 5, f: ${METHOD} }; ` +
          "const u: { [k: string]: any } | undefined = {}; const z: { [k: string]: any } | undefined = undefined;",
      ),
    ],
    [
      "an object from JSON.parse",
      score(
        `const o: any = JSON.parse('{"n":5}'); o.f = ${METHOD}; ` +
          `const u: any = JSON.parse('{"n":5}'); const z: any = JSON.parse("null");`,
      ),
    ],
    [
      "an object built by element assignment",
      score(`const o: any = {}; o["n"] = 5; o["f"] = ${METHOD}; const u: any = {}; let z: any = {}; z = null;`),
    ],
    [
      "an `any` parameter",
      "function g(p: any): any { return p?.f?.(3); } " +
        "export function main(): number { const o: any = { n: 5, f: function (this: any, x: number) " +
        "{ return this === o ? this.n + x : -50; } }; " +
        "return (g(o) ?? -9) * 100 + (g({}) === undefined ? 10 : 0) + (g(undefined) === undefined ? 1 : 0); }",
    ],
    [
      "the arguments run once for a defined `f` and not at all otherwise",
      "let n = 0; function bump(): number { n++; return 4; } " +
        "export function main(): number { const o: any = { f: (x: number) => x * 2 }; const u: any = {}; " +
        "const z: any = null; const a = o?.f?.(bump()); const b = u?.f?.(bump()); const c = z?.f?.(bump()); " +
        "return (a === 8 ? 1 : 0) + (b === undefined ? 10 : 0) + (c === undefined ? 100 : 0) + n * 1000; }",
    ],
  ])("%s", async (_, source) => {
    const expected = node(source);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(expected);
  });
});

// Each program answers 1 when the call throws a TypeError, 2 when it yields `undefined`, 3 for any other value.
const outcome = (decl: string, call = "o?.f?.()"): string =>
  `export function main(): number { ${decl} ` +
  `try { const r = ${call}; return r === undefined ? 2 : 3; } catch (e) { return e instanceof TypeError ? 1 : 4; } }`;

describe("#7469 `o?.f?.()` where `f` is neither nullish nor callable", () => {
  it.each([
    ["a number on an `any` receiver", outcome("const o: any = { f: 5 };")],
    ["a string on an `any` receiver", outcome('const o: any = { f: "s" };')],
    ["an object on an `any` receiver", outcome("const o: any = { f: {} };")],
    ["a number on a `Record` receiver", outcome("const o: Record<string, any> | undefined = { f: 5 };")],
    ["an object on a `Record` receiver", outcome("const o: Record<string, any> | undefined = { f: {} };")],
    ["`o.f?.()` on an `any` receiver", outcome("const o: any = { f: 5 };", "o.f?.()")],
    ["`Math?.PI?.()`", outcome("", "(Math as any)?.PI?.()")],
  ])("%s throws a TypeError", async (_, source) => {
    expect(node(source)).toBe(1);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(1);
  });
});

describe("#7469 `?.` calls on a global built-in namespace keep the native static call", () => {
  it.each([
    ['`JSON?.parse?.("5")`', 'export function main(): number { return JSON?.parse?.("5"); }'],
    ['`JSON.parse?.("5")`', 'export function main(): number { return JSON.parse?.("5"); }'],
    ["`Math?.max?.(1, 2)`", "export function main(): number { return Math?.max?.(1, 2); }"],
    ["`Math.abs?.(-3)`", "export function main(): number { return Math.abs?.(-3); }"],
    ["`JSON?.stringify?.(5)`", 'export function main(): number { return JSON?.stringify?.(5) === "5" ? 1 : 0; }'],
  ])("%s", async (_, source) => {
    const expected = node(source);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(expected);
  });
});
