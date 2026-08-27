// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4768 — native generator state across a statically known ordinary call.
 *
 * A host-lane native generator used as an arbitrary call argument used to be
 * rejected by the use-site safety walk and lowered to the lazy buffer object.
 * The first host-side `next()` on that object executes the whole body, so an
 * array-binding elision observed too many iterator steps. The repaired lane
 * carries the state through the closure ABI and drains only the binding
 * pattern's required prefix.
 */
import { describe, expect, it } from "vitest";
import { buildImports } from "../src/runtime.js";
import { compile } from "../src/index.js";

async function runHost(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4768.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.success ? "" : result.errors?.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool) as WebAssembly.Imports & {
    setInstance?: (instance: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const init = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof init === "function") (init as () => void)();
  return (instance.exports as { test: () => number }).test();
}

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4768-standalone.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.success ? "" : result.errors?.map((e) => e.message).join("; ")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module), "standalone regression control must not need host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

const generator = `
  let steps = 0;
  function* g() { steps += 1; yield 1; steps += 1; yield 2; }
`;

describe("#4768 native generator ordinary-call boundary", () => {
  it("does not resume an unused plain parameter on an infinite generator", async () => {
    expect(
      await runHost(`
        let steps = 0;
        function* infinite() { while (true) { steps += 1; yield steps; } }
        function plain(value: any): void {}
        export function test(): number { plain(infinite()); return steps; }`),
    ).toBe(0);
  });

  it("does not resume an unused plain parameter", async () => {
    expect(
      await runHost(`${generator}
        function plain(value: any): void {}
        export function test(): number { plain(g()); return steps; }`),
    ).toBe(0);
  });

  it.each([
    ["[]", "function consume([]: any): void {}", 0],
    ["[,]", "function consume([,]: any): void {}", 1],
    ["[, ,]", "function consume([, ,]: any): void {}", 2],
    ["[a]", "function consume([a]: any): void { if (a === -1) steps += 100; }", 1],
    ["[a,b]", "function consume([a, b]: any): void { if (a === -1 || b === -1) steps += 100; }", 2],
    ["[[]]", "function consume([[]]: any): void {}", 1],
  ] as const)("consumes the exact IteratorStep budget for %s", async (_pattern, consumer, expected) => {
    expect(
      await runHost(`${generator} ${consumer} export function test(): number { consume(g()); return steps; }`),
    ).toBe(expected);
  });

  it("keeps an unknown callee on the conservative eager path", async () => {
    expect(
      await runHost(`${generator}
        function invoke(fn: any, value: any): void { fn(value); }
        const consumer: any = ([,]: any) => {};
        export function test(): number { invoke(consumer, g()); return steps; }`),
    ).toBe(2);
  });

  it("keeps a reassignable callee on the conservative eager path", async () => {
    expect(
      await runHost(`${generator}
        function consume([,]: any): void {}
        let target: any = consume;
        target = consume;
        export function test(): number { target(g()); return steps; }`),
    ).toBe(2);
  });

  it("keeps an unbounded rest pattern on the fallback path in standalone", async () => {
    expect(
      await runStandalone(`
        let steps = 0;
        function* g() { steps += 1; yield 1; steps += 1; yield 2; }
        function consume([...[,]]: any): void {}
        export function test(): number { consume(g()); return steps; }`),
    ).toBe(2);
  });

  it("completes a native generator after an abrupt iterator step", async () => {
    expect(
      await runStandalone(`
        let following = 0;
        function* g() { throw new Error("boom"); following += 1; }
        function consume([,]: any): void {}
        const iter: any = g();
        export function test(): number {
          let first = 0;
          try { consume(iter); } catch (_) { first = 1; }
          let second = 0;
          try {
            const result = iter.next();
            second = result.done ? 1 : 2;
          } catch (_) { second = 3; }
          return first * 10 + second * 100 + following;
        }`),
    ).toBe(110);
  });
});
