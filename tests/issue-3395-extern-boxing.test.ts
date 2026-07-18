// #3395 — object/closure GC ref ↔ externref boxing at boundaries (child of
// #2039's standalone invalid-Wasm bucket).
//
// SHAPE 2 (this slice): a WeakSet/WeakMap key/value that is a null/undefined
// literal (incl. `null as any` — the §CanBeHeldWeakly "value cannot be held
// weakly" rows) was compiled raw and its TYPED `ref.null $Struct` flowed into
// `any.convert_extern`, which wants an externref → invalid Wasm
// ("any.convert_extern expected externref, found ref.null of type (ref null
// N)"). Fix: route the weak-collection args through the canonical
// null-literal guard (`compileCollectionElementArg` → `ref.null NONE_HEAP`),
// with an as/paren/!/satisfies unwrap so wrapped null literals are recognized.
//
// Shapes 1 (missing box in class/private-method init) and 3 (== double-convert
// with a wrapper Object) are tracked as follow-ups in the issue file.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function validStandalone(source: string): Promise<boolean> {
  const result = await compile(source, { fileName: "t.ts", target: "standalone" as const });
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  return WebAssembly.validate(result.binary);
}

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "t.ts", target: "standalone" as const });
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3395 shape 2 — Weak-collection null key → valid Wasm", () => {
  it("WeakSet.has / .add / .delete with a null/undefined key compile to valid Wasm", async () => {
    expect(
      await validStandalone(`export function test(): boolean { const s = new WeakSet(); return s.has(null as any); }`),
    ).toBe(true);
    expect(
      await validStandalone(
        `export function test(): boolean { const s = new WeakSet(); return s.has(undefined as any); }`,
      ),
    ).toBe(true);
    expect(await validStandalone(`export function test(): void { const s = new WeakSet(); s.add(null as any); }`)).toBe(
      true,
    );
  });

  it("WeakMap.has / .get / .set with a null key compile to valid Wasm", async () => {
    expect(
      await validStandalone(`export function test(): boolean { const m = new WeakMap(); return m.has(null as any); }`),
    ).toBe(true);
    expect(
      await validStandalone(
        `export function test(): boolean { const m = new WeakMap<any,any>(); m.set(null as any, 1); return m.has(null as any); }`,
      ),
    ).toBe(true);
  });

  it("WeakSet.has(null) returns false (CanBeHeldWeakly is false)", async () => {
    // `has` lowers to an i32 boolean; encode as a number so the falsy result is
    // representation-stable across the wasm boundary (0 === false).
    const got = await runStandalone(
      `export function test(): number { const s = new WeakSet(); return s.has(null as any) ? 1 : 0; }`,
    );
    expect(got).toBe(0);
  });

  it("object identity is preserved across add/has (no regression)", async () => {
    const got = await runStandalone(`
      export function test(): number {
        const s = new WeakSet();
        const a = {};
        const b = {};
        s.add(a);
        return (s.has(a) ? 1 : 0) * 10 + (s.has(b) ? 1 : 0);   // 10: a in, b out
      }
    `);
    expect(got).toBe(10);
  });

  it("WeakMap identity round-trip preserved (no regression)", async () => {
    const got = await runStandalone(`
      export function test(): number {
        const m = new WeakMap<any, any>();
        const k = {};
        m.set(k, 42);
        const v: any = m.get(k);
        return typeof v === "number" ? v : -1;
      }
    `);
    expect(got).toBe(42);
  });
});
