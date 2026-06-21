// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2042 S3 residual — standalone `Object.fromEntries([["a", 1], ...])` over a
// LITERAL array-of-pairs. It previously refused ("Codegen error:
// '__object_fromEntries' ... not supported in --target standalone"): the native
// helper iterates entries via `__extern_get_idx`, which reliably indexes only a
// `$ObjVec` — a native array literal mis-casts through the externref boundary.
//
// Fix: mirror `compileObjectAssignArg` — when the entries arg is an array literal
// of two-element pairs with STRING keys, the call site NORMALISES it into a
// `$ObjVec` of pair `$ObjVec`s (`__objvec_new`/`__objvec_push`) and hands the
// native `__object_fromEntries` helper that indexable shape, which builds the
// `$Object` via `__extern_set` (ToPropertyKeys the key). The raw-arg / Map /
// non-string-key shapes keep their pre-existing REFUSAL (compile error) — they
// are NOT routed to the helper, so no new trap is introduced.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const env = (r.imports ?? []).filter((i) => i.module === "env").map((i) => i.name);
  expect(
    env.filter((n) => n === "__object_fromEntries"),
    `must not leak host import: ${env.join(", ")}`,
  ).toEqual([]);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as Record<string, () => number>).run();
}

const fn = (body: string) => `export function run(): number { ${body} }`;

describe("#2042 S3 — standalone Object.fromEntries over a string-key array literal", () => {
  it("single pair: o.a === 1", async () => {
    expect(await runStandalone(fn(`const o: any = Object.fromEntries([["a", 1]]); return o.a as number;`))).toBe(1);
  });

  it("multiple pairs: o.b === 2", async () => {
    expect(
      await runStandalone(fn(`const o: any = Object.fromEntries([["a", 1], ["b", 2]]); return o.b as number;`)),
    ).toBe(2);
  });

  it("key count is correct", async () => {
    expect(
      await runStandalone(
        fn(`const o: any = Object.fromEntries([["a", 1], ["b", 2], ["c", 3]]); return Object.keys(o).length;`),
      ),
    ).toBe(3);
  });

  it("duplicate key — last wins", async () => {
    expect(
      await runStandalone(fn(`const o: any = Object.fromEntries([["a", 1], ["a", 9]]); return o.a as number;`)),
    ).toBe(9);
  });

  it("string value preserved", async () => {
    expect(
      await runStandalone(fn(`const o: any = Object.fromEntries([["k", "v"]]); return (o.k as string).length;`)),
    ).toBe(1);
  });

  it("boolean value preserved", async () => {
    expect(
      await runStandalone(fn(`const o: any = Object.fromEntries([["b", true]]); return (o.b as boolean) ? 1 : 0;`)),
    ).toBe(1);
  });

  it("mixed value types", async () => {
    expect(
      await runStandalone(
        fn(
          `const o: any = Object.fromEntries([["n", 5], ["s", "x"]]); return (o.n as number) + (o.s as string).length;`,
        ),
      ),
    ).toBe(6);
  });

  // ── regression: $ObjVec entries (Object.entries result) unchanged ──
  it("Object.fromEntries(Object.entries(o)) still works", async () => {
    expect(
      await runStandalone(
        fn(
          `const src: any = { x: 7, y: 8 }; const o: any = Object.fromEntries(Object.entries(src)); return o.x as number;`,
        ),
      ),
    ).toBe(7);
  });
});
