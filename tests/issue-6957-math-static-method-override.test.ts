// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6957 — `Math.random = fn` must be honoured by `Math.random()` calls and
 * `Math.random` value reads in --target standalone.
 *
 * Octane's base.js installs a seeded generator through `Math.random = …` and
 * regexp.js calls `Math.random()`; the static Math lowering ignored the write,
 * so regexp failed with `Wrong checksum.`. Expected values are node's.
 *
 * The control rows pin the fast path: a program that never writes a Math
 * member keeps the direct `Math_random` kernel call.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string, emitWat = false) {
  const result = await compile(source, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    ...(emitWat ? { emitWat: true } : {}),
  });
  expect(result.success, (result.errors ?? []).map((e) => String(e.message ?? e)).join("\n")).toBe(true);
  return result;
}

async function runStandalone(source: string): Promise<unknown> {
  const result = await compileStandalone(source);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports.main as () => unknown)();
}

describe("#6957 standalone Math.<method> override", () => {
  it("top-level override is seen by a call in another function", async () => {
    const src = `
      Math.random = function () { return 0.25; };
      function f() { return Math.random() * 4; }
      export function main() { return f(); }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("value read, identity and call all see the override", async () => {
    const src = `
      var seed = 49734321;
      Math.random = function () { seed = (seed + 1) | 0; return seed; };
      export function main() {
        var r = Math.random;
        return (r === Math.random ? 1 : 0) + (Math.random() === 49734322 ? 10 : 0) + (r() === 49734323 ? 100 : 0);
      }`;
    expect(await runStandalone(src)).toBe(111);
  });

  it("override installed inside a function; a call before it reaches the builtin", async () => {
    const src = `
      function setup() { Math.random = function () { return 0.25; }; }
      function f() { return Math.random() * 4; }
      export function main() { var a = Math.random(); setup(); return (a >= 0 && a < 1 ? 10 : 0) + f(); }`;
    expect(await runStandalone(src)).toBe(11);
  });

  it("value reads before and after an in-function override", async () => {
    const src = `
      function setup() { Math.random = function () { return 0.5; }; }
      export function main() {
        var r0 = Math.random; var a = r0(); setup(); var r = Math.random;
        return r() + (r === Math.random ? 10 : 0) + (r0 !== r ? 100 : 0) + (a >= 0 && a < 1 ? 1000 : 0);
      }`;
    expect(await runStandalone(src)).toBe(1110.5);
  });

  it("Octane base.js shape: seeded generator from an IIFE", async () => {
    const src = `
      Math.random = (function () {
        var seed = 49734321;
        return function () {
          seed = ((seed + 0x7ed55d16) + (seed << 12)) & 0xffffffff;
          seed = ((seed ^ 0xc761c23c) ^ (seed >>> 19)) & 0xffffffff;
          seed = ((seed + 0x165667b1) + (seed << 5)) & 0xffffffff;
          seed = ((seed + 0xd3a2646c) ^ (seed << 9)) & 0xffffffff;
          seed = ((seed + 0xfd7046c5) + (seed << 3)) & 0xffffffff;
          seed = ((seed ^ 0xb55a4f09) ^ (seed >>> 16)) & 0xffffffff;
          return (seed & 0xfffffff) / 0x10000000;
        };
      })();
      function pick(n) { return Math.floor(Math.random() * n); }
      export function main() { var t = 0; for (var i = 0; i < 6; i++) t = t * 10 + pick(10); return t; }`;
    expect(await runStandalone(src)).toBe(935981);
  });

  it("control: without a Math write, Math.random() keeps the direct kernel call", async () => {
    const src = `export function main() { var x = Math.random(); return x >= 0 && x < 1 ? 1 : 0; }`;
    expect(await runStandalone(src)).toBe(1);
    const { wat } = await compileStandalone(src, true);
    // The kernel is present; the carrier [[Get]] + closure-apply driver is not.
    expect(wat).toContain("$Math_random");
    expect(wat).not.toContain("__apply_closure");
    expect(wat).not.toContain("__extern_get");
  });

  it("control: an unpatched member keeps its static lowering beside a patched one", async () => {
    const src = `
      Math.random = function () { return 0.25; };
      export function main() { return Math.floor(Math.random() * 8) + Math.abs(-3); }`;
    expect(await runStandalone(src)).toBe(5);
  });
});
