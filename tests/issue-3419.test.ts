// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3419 — duplicate top-level / function-body function declarations are legal
// JS (var-scoped, last-wins per §16.1.1 / §10.2.11), while module top level,
// lexical collisions, and strict-mode block duplicates stay SyntaxErrors
// (§16.2.1.1 / §14.2.1; Annex B §B.3.2.1 tolerates sloppy block dups bound
// only by plain FunctionDeclarations).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const opts = {
  fileName: "test.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

async function compileErrors(src: string, extra: Record<string, unknown> = {}) {
  const r = await compile(src, { ...opts, ...extra });
  return r.errors.filter((e) => e.severity === "error").map((e) => e.message);
}

async function runAndGet(src: string): Promise<unknown> {
  const r = await compile(src, opts);
  expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  expect(r.success).toBe(true);
  const stub = new Proxy({}, { get: () => new Proxy({}, { get: () => () => 0 }) }) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(r.binary!, stub);
  const ex = instance.exports as Record<string, unknown>;
  if (typeof ex.__module_init === "function") (ex.__module_init as () => void)();
  return (ex.test as () => unknown)();
}

describe("#3419 duplicate function declarations — script/function-body last-wins", () => {
  it("allows duplicate top-level function declarations in a script (sloppy)", async () => {
    const errs = await compileErrors("function f() { return 1; }\nfunction f() { return 2; }\nf();\n");
    expect(errs).toEqual([]);
  });

  it("allows duplicate top-level function declarations in a strict script", async () => {
    const errs = await compileErrors('"use strict";\nfunction f() { return 1; }\nfunction f() { return 2; }\nf();\n');
    expect(errs).toEqual([]);
  });

  it("function-body duplicates are last-wins at runtime", async () => {
    const got = await runAndGet(`
function t() {
  function g() { return 10; }
  function g() { return 20; }
  return g();
}
export function test() { return t(); }
`);
    expect(got).toBe(20);
  });

  it("still rejects let + function collision at top level (both orders)", async () => {
    expect(await compileErrors("let f = 1;\nfunction f() {}\n")).not.toEqual([]);
    expect(await compileErrors("function f() {}\nlet f = 1;\n")).not.toEqual([]);
  });

  it("still rejects class + function collision at top level", async () => {
    expect(await compileErrors("class f {}\nfunction f() {}\n")).not.toEqual([]);
    expect(await compileErrors("function f() {}\nclass f {}\n")).not.toEqual([]);
  });

  it("module goal keeps duplicate top-level functions as SyntaxError (§16.2.1.1)", async () => {
    const errs = await compileErrors("function x() {}\nfunction x() {}\n", {
      inferModuleStrictArguments: true,
    });
    expect(errs.some((m) => m.includes("Duplicate identifier 'x'"))).toBe(true);
  });

  it("sloppy block duplicates bound only by plain functions are legal (Annex B §B.3.2.1)", async () => {
    const errs = await compileErrors("{ function h() {} function h() {} }\n");
    expect(errs).toEqual([]);
  });

  it("strict block duplicates stay SyntaxError", async () => {
    const errs = await compileErrors('"use strict";\n{ function h() {} function h() {} }\n');
    expect(errs.some((m) => m.includes("Duplicate identifier 'h'"))).toBe(true);
  });

  it("sloppy block async-function duplicate stays SyntaxError (B.3.2.1 covers only plain fns)", async () => {
    const errs = await compileErrors("{ async function h() {} async function h() {} }\n");
    expect(errs.some((m) => m.includes("Duplicate identifier 'h'"))).toBe(true);
  });

  it("var counter i32 promotion is disabled under conflicting var redeclaration (invalid-wasm guard)", async () => {
    // Real runtime imports: the demoted (f64) counter comparison routes through
    // host compare helpers, which a stub import object would zero out.
    const { compileAndInstantiate } = await import("../src/runtime.js");
    const ex = (await compileAndInstantiate(`
function t(arr: number[]) {
  var n = 0;
  for (var i = 0; i < arr.length; ++i) { n += 1; }
  for (var i = arr.length - 1; i >= 0; --i) { n += 10; }
  return n;
}
export function test() { return t([1, 2]); }
`)) as Record<string, unknown>;
    expect((ex.test as () => number)()).toBe(22);
  });
});
