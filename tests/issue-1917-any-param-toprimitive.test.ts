// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1917 / #2358 PR-2 — standalone ToPrimitive over an object that crosses the
// externref boundary as `any` (e.g. an any-typed parameter), where the nominal
// struct's concrete typeIdx is erased inside the callee.
//
// PR-1 fixed the `+`-with-typed-object-LOCAL case by recovering the typeIdx
// before erasure. That trick is impossible for an any-typed PARAMETER — inside
// the callee the value is a plain externref with no typeIdx. PR-2 materializes
// such an object-literal struct into a dynamic `$Object` AT the
// ref-struct→externref coercion (where the typeIdx is still known), so the
// native `__to_primitive` helper can dispatch its valueOf/toString. Reuses the
// `__new_plain_object` path the `as any`-literal form already uses; no
// struct-layout / brand change.

async function runStandaloneNum(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(r.imports.length).toBe(0); // host-free
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#1917 ToPrimitive over object literal across an `any` parameter", () => {
  it("reduces a valueOf object passed to an any param under `*`", async () => {
    expect(
      await runStandaloneNum(`
        function g(x: any): number { return x * 2; }
        export function f(): number {
          const o = { valueOf: () => 21 };
          return g(o);
        }
      `),
    ).toBe(42);
  });

  it("reduces under `-` across an any param", async () => {
    expect(
      await runStandaloneNum(`
        function g(x: any): number { return x - 1; }
        export function f(): number {
          const o = { valueOf: () => 21 };
          return g(o);
        }
      `),
    ).toBe(20);
  });

  it("reduces under `+` across an any param", async () => {
    expect(
      await runStandaloneNum(`
        function g(x: any): number { return x + 1; }
        export function f(): number {
          const o = { valueOf: () => 4 };
          return g(o);
        }
      `),
    ).toBe(5);
  });

  it("reduces under unary `+` across an any param", async () => {
    expect(
      await runStandaloneNum(`
        function g(x: any): number { return +x; }
        export function f(): number {
          const o = { valueOf: () => 9 };
          return g(o);
        }
      `),
    ).toBe(9);
  });

  // Regression guards — these must keep their status-quo behaviour (the change
  // only fires for object literals carrying a ToPrimitive method field; plain
  // data structs keep the byte-identical `extern.convert_any`).
  it("still reduces Number(obj) with valueOf (pre-existing pass)", async () => {
    expect(
      await runStandaloneNum(`
        export function f(): number {
          const o = { valueOf: () => 7 };
          return Number(o as any);
        }
      `),
    ).toBe(7);
  });
});
