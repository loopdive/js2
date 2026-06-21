// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2042 S3 — standalone `Object.is` (SameValue §7.2.10) was a #1472-Phase-B
// refusal ("Codegen error: '__object_is' ... not supported in --target
// standalone"). Implemented as a native tag-dispatched helper in
// object-runtime.ts over two boxed externrefs:
//   - both number  → compare f64 BIT PATTERNS (i64.reinterpret_f64 + i64.eq):
//                     NaN is SameValue NaN, and +0 is NOT SameValue -0.
//   - both boolean  → unbox i32 + i32.eq
//   - both bigint   → __to_bigint + i64.eq
//   - both string   → value equality (__str_flatten + __str_equals)
//   - both null      → equal
//   - else           → WasmGC `eq`-heap reference identity
// Added to OBJECT_RUNTIME_HELPER_NAMES so ensureLateImport routes it natively
// under standalone. Host (GC) mode keeps the `__object_is` host import.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const env = (r.imports ?? []).filter((i) => i.module === "env").map((i) => i.name);
  expect(
    env.filter((n) => n === "__object_is"),
    `must not leak __object_is host import: ${env.join(", ")}`,
  ).toEqual([]);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as Record<string, () => number>).run();
}

const fn = (body: string) => `export function run(): number { ${body} }`;

describe("#2042 S3 — standalone Object.is (SameValue, no host-import leak)", () => {
  it("Object.is(NaN, NaN) is true (SameValue, unlike ===)", async () => {
    expect(await runStandalone(fn(`return Object.is(NaN, NaN) ? 1 : 0;`))).toBe(1);
  });

  it("Object.is(+0, -0) is false (SameValue distinguishes signed zero)", async () => {
    expect(await runStandalone(fn(`return Object.is(0, -0) ? 1 : 0;`))).toBe(0);
  });

  it("Object.is(0, 0) is true", async () => {
    expect(await runStandalone(fn(`return Object.is(0, 0) ? 1 : 0;`))).toBe(1);
  });

  it("Object.is on equal / unequal numbers", async () => {
    expect(await runStandalone(fn(`return Object.is(1, 1) ? 1 : 0;`))).toBe(1);
    expect(await runStandalone(fn(`return Object.is(1, 2) ? 1 : 0;`))).toBe(0);
  });

  it("Object.is on booleans", async () => {
    expect(await runStandalone(fn(`const a: any = true; const b: any = true; return Object.is(a, b) ? 1 : 0;`))).toBe(
      1,
    );
  });

  it("Object.is on equal strings (value equality)", async () => {
    expect(await runStandalone(fn(`const a: any = "abc"; const b: any = "abc"; return Object.is(a, b) ? 1 : 0;`))).toBe(
      1,
    );
    expect(await runStandalone(fn(`const a: any = "abc"; const b: any = "abd"; return Object.is(a, b) ? 1 : 0;`))).toBe(
      0,
    );
  });

  it("Object.is on object reference identity", async () => {
    expect(await runStandalone(fn(`const o: any = {}; return Object.is(o, o) ? 1 : 0;`))).toBe(1);
    expect(await runStandalone(fn(`return Object.is({} as any, {} as any) ? 1 : 0;`))).toBe(0);
  });
});
