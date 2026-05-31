// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts" });
  if (!r.success) throw new Error("compile failed: " + r.errors?.[0]?.message);
  const imp = buildImports(r.imports, undefined, r.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(r.binary, imp);
  if (imp.setExports) imp.setExports(instance.exports);
  return (instance.exports as any).test();
}

describe("#779e arguments-object mapped/unmapped strict split", () => {
  it("sloppy: writing arguments[i] reflects into the named param (mapped)", async () => {
    expect(
      await runTest(`export function test(): number {
        function f(a) { arguments[0] = 99; return a; }
        return f(1);
      }`),
    ).toBe(99);
  });

  it("strict: writing arguments[i] does NOT reflect into the named param (unmapped)", async () => {
    expect(
      await runTest(`"use strict";
      export function test(): number {
        function f(a) { arguments[0] = 99; return a; }
        return f(1);
      }`),
    ).toBe(1);
  });

  it("sloppy: writing the param reflects into arguments[i] (mapped, read direction)", async () => {
    expect(
      await runTest(`export function test(): number {
        function f(a) { a = 7; return arguments[0]; }
        return f(1);
      }`),
    ).toBe(7);
  });

  it("strict: writing the param does NOT reflect into arguments[i]", async () => {
    expect(
      await runTest(`"use strict";
      export function test(): number {
        function f(a) { a = 7; return arguments[0]; }
        return f(1);
      }`),
    ).toBe(1);
  });

  it("trailing comma in the argument list does not inflate arguments.length", async () => {
    expect(
      await runTest(`export function test(): number {
        function f() { return arguments.length; }
        return f(42, undefined,);
      }`),
    ).toBe(2);
  });

  it("class methods are always strict → unmapped arguments", async () => {
    expect(
      await runTest(`export function test(): number {
        class C { m(a) { arguments[0] = 99; return a; } }
        return new C().m(1);
      }`),
    ).toBe(1);
  });
});
