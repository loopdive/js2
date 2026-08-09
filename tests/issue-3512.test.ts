// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3512 — a class's INSTANCE field name must NOT appear as an own property of
// the constructor object via the host `_wrapForHost` proxy traps (#3479 Slice C,
// symmetric to the landed static-method reflection Slice A). `hasOwnProperty.call`
// on a class object routes through the proxy `[[GetOwnProperty]]` trap, which
// previously fell through to the instance struct-field shape and leaked.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, Function>).test();
}

describe("#3512 instance fields do not leak onto the class constructor", () => {
  it("hasOwnProperty.call(C, instanceField) is false", async () => {
    expect(
      await run(`class C { foo = "x"; static m(){ return 1; } }
        export function test(): number { return Object.prototype.hasOwnProperty.call(C, "foo") ? 1 : 0; }`),
    ).toBe(0);
  });

  it("still reports a static method as an own property (Slice A unchanged)", async () => {
    expect(
      await run(`class C { foo = "x"; static m(){ return 1; } }
        export function test(): number { return Object.prototype.hasOwnProperty.call(C, "m") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("still reports a sidecar dynamic property assigned to C", async () => {
    expect(
      await run(`class C { foo = "x"; static m(){ return 1; } }
        export function test(): number { (C as any).extra = 9; return Object.prototype.hasOwnProperty.call(C, "extra") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("instance field remains an own property of the INSTANCE", async () => {
    expect(
      await run(`class C { foo = "x"; }
        export function test(): number { const c = new C(); return Object.prototype.hasOwnProperty.call(c, "foo") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("does not leak the field even for a class with no static methods", async () => {
    expect(
      await run(`class C { foo = "x"; }
        export function test(): number { return Object.prototype.hasOwnProperty.call(C, "foo") ? 1 : 0; }`),
    ).toBe(0);
  });

  it("leaves plain-object hasOwnProperty unchanged", async () => {
    expect(
      await run(
        `export function test(): number { const o: any = { a: 1 }; return Object.prototype.hasOwnProperty.call(o, "a") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
