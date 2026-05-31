// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #820m Phase A (Slice 1) — class-as-value field-type widening.
// `{ id: class {} }` inside a function body used to drop the class value to
// null because resolveWasmType picked a ref-to-instance type for the field,
// and the externref produced by compileClassExpression silently coerced to
// ref.null. Slice 1 widens construct-signature-only property types to
// externref in ensureStructForType so the closure-struct externref is
// retained verbatim.
//
// The .name propagation half (Phase B) is a separate carve-out — the
// closure-struct externref does not yet carry an ES `.name` property.

async function runWithCheck<T>(src: string, check: (o: unknown) => T): Promise<T> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown> & {
    env?: Record<string, unknown>;
  };
  imports.env = imports.env ?? {};
  imports.env.check = check as (o: unknown) => unknown;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const exp = instance.exports as Record<string, unknown>;
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(exp);
  }
  const fn = exp.test as () => unknown;
  if (typeof fn !== "function") throw new Error("no test() export");
  return fn() as T;
}

describe("#820m Phase A — class-as-value retained in object-literal property", () => {
  it("`{ id: class {} }` inside function body — property is non-null", async () => {
    const src = `
      declare function check(o: any): number;
      export function test(): number {
        const obj: any = { id: class {} };
        return check(obj.id);
      }
    `;
    const result = await runWithCheck<number>(src, (o) => (o == null ? 0 : 1));
    expect(result).toBe(1);
  });

  it("`{ id: class C {} }` inside function body — property is non-null (named class)", async () => {
    const src = `
      declare function check(o: any): number;
      export function test(): number {
        const obj: any = { id: class C {} };
        return check(obj.id);
      }
    `;
    const result = await runWithCheck<number>(src, (o) => (o == null ? 0 : 1));
    expect(result).toBe(1);
  });

  it("multiple class-valued properties — both retained", async () => {
    const src = `
      declare function check(a: any, b: any): number;
      export function test(): number {
        const obj: any = { foo: class {}, bar: class {} };
        return check(obj.foo, obj.bar);
      }
    `;
    const result = await runWithCheck<number>(src, (a, b) => (a != null && b != null ? 1 : 0));
    expect(result).toBe(1);
  });

  it("top-level `const C = class {}` unaffected — still retained", async () => {
    const src = `
      declare function check(o: any): number;
      const C: any = class {};
      export function test(): number {
        return check(C);
      }
    `;
    const result = await runWithCheck<number>(src, (o) => (o == null ? 0 : 1));
    expect(result).toBe(1);
  });

  it("nested function returning anonymous class — retained", async () => {
    const src = `
      declare function check(o: any): number;
      function make(): any { return class {}; }
      export function test(): number {
        return check(make());
      }
    `;
    const result = await runWithCheck<number>(src, (o) => (o == null ? 0 : 1));
    expect(result).toBe(1);
  });

  it("plain data property next to class property — both retained", async () => {
    const src = `
      declare function check(t: string, c: any): number;
      export function test(): number {
        const obj: any = { tag: "x", cls: class {} };
        return check(obj.tag, obj.cls);
      }
    `;
    const result = await runWithCheck<number>(src, (t, c) => (t === "x" && c != null ? 1 : 0));
    expect(result).toBe(1);
  });
});
