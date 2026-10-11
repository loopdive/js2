// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6686 (#5385 S2) — the JS value boundary survives the native regime in a JS
// environment: strings cross as primitives, `any` receivers reach admitted JS
// objects, JS callables are called through the boundary adapter, and compiled
// objects handed back into a closure export are unwrapped from their facade.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
beforeAll(() => {
  process.env.JS2WASM_NATIVE_REGIME_JS = "1";
});
afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
  else process.env.JS2WASM_NATIVE_REGIME_JS = previous;
});

async function instantiateRegime(source: string) {
  const result = await compile(source, { fileName: "issue-6686.ts", semanticProviders: "native-first" });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  expect(result.targetProfile?.nativeRegime).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return { result, exports: wrapCompiledExports(result, instance) as Record<string, any> };
}

describe("#6686 JS value boundary under the native regime", () => {
  it("marshals string params and results as JS primitives", async () => {
    const { exports } = await instantiateRegime(`
      export function value(): string { return "  alpha-beta  ".trim().toUpperCase().slice(0, 5); }
      export function echo(value: string): string { return value.trim().toUpperCase(); }
    `);
    expect(exports.value()).toBe("ALPHA");
    expect(exports.echo("  beta  ")).toBe("BETA");
  });

  it("calls methods on admitted JS objects through an any receiver", async () => {
    const { exports } = await instantiateRegime(`
      export function readByte(view: any): any { return view.getUint8(0); }
      export function callNoArg(target: any): any { return target.f(); }
    `);
    expect(exports.readByte(new DataView(new Uint8Array([9, 8]).buffer))).toBe(9);
    expect(exports.callNoArg({ f: () => 5 })).toBe(5);
  });

  it("invokes and binds JS callables at the boundary without breaking native closures", async () => {
    const { exports, result } = await instantiateRegime(`
      function add(left: number, right: number): number { return left + right; }
      export function callIt(fn: any): any { return fn(4); }
      export function bindIt(fn: any): any { const bound = fn.bind({ base: 7 }, 3); return bound(2); }
      export function local(): number { const bound = add.bind(undefined, 4); return bound(5); }
    `);
    expect(exports.callIt((value: number) => value * 2)).toBe(8);
    expect(
      exports.bindIt(function (this: { base: number }, left: number, right: number) {
        return this.base + left + right;
      }),
    ).toBe(12);
    expect(exports.local()).toBe(9);
    expect(result.hostImportInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "__boundary_callback_call_1", classification: "value-adapter" }),
      ]),
    );
  });

  it("unwraps a compiled object's host facade before a closure export casts it", async () => {
    const { exports } = await instantiateRegime(`
      interface P { a: number }
      export function make(): P { return { a: 3 }; }
      export function makeGet(): (o: P) => number { return (o: P) => o.a; }
    `);
    const made = exports.make();
    expect(made.a).toBe(3);
    expect(exports.makeGet()(made)).toBe(3);
  });

  it("does not report the boundary adapters as standalone host-import leaks", async () => {
    const { result, exports } = await instantiateRegime(`export function read(target: any): any { return target.x; }`);
    expect(exports.read({ x: 4 })).toBe(4);
    expect(result.errors.filter((error) => /Host import leak/.test(error.message))).toEqual([]);
  });
});
