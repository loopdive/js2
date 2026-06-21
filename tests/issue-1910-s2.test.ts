// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1910 / #1472 S2 — boxed primitive-wrapper ToPrimitive in `--target standalone`.
 *
 * `new Number(x)` / `new String(x)` / `new Boolean(x)` produce wrapper OBJECTS
 * (typeof === "object"). In standalone mode there is no JS host to satisfy the
 * `env::__new_Number` / `__new_String` / `__new_Boolean` imports the gc path uses,
 * so the binary failed at instantiation ("module is not an object or function").
 *
 * S2 builds the wrapper natively as a `$Object` carrying its internal
 * `[[PrimitiveValue]]` slot (non-enumerable), and teaches `__to_primitive` to read
 * that slot first (§7.1.1.1 — the wrapper's intrinsic valueOf returns the internal
 * value). Operator contexts that ToNumber a wrapper (`%`, `*`, `-`, `<<`, …) and
 * ToString (`String(w)`) now work host-free.
 *
 * NOTE: the both-operands-`any` `+` string-concat path (`__any_add`) has a
 * SEPARATE pre-existing standalone bug (concat result reads empty for every
 * any+any concat, reproduced on clean main, e.g. `"a"+"b"` both-any). S2 does NOT
 * fix that path; it only ensures a wrapper reaching `__any_to_string` no longer
 * TRAPS ("illegal cast") — it degrades to that pre-existing concat behaviour
 * instead. Wrapper ToNumber + `String(wrapper)` are the S2 acceptance surface.
 */

async function instantiate(src: string): Promise<{
  ret: unknown;
  imports: string[];
}> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  const err = r.errors?.find((e) => e.severity !== "warning");
  if (!r.success || err) throw new Error("compile failed: " + (err?.message ?? "unknown"));
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ret = (instance.exports as Record<string, () => unknown>).test?.();
  return { ret, imports };
}

describe("#1910/#1472 S2 — boxed primitive-wrapper ToPrimitive (standalone)", () => {
  it("new Number(x) wrapper leaks no host import and instantiates", async () => {
    const { imports } = await instantiate(`export function test(): number { let w: any = new Number(1); return 0; }`);
    expect(imports.filter((i) => /__new_Number/.test(i))).toEqual([]);
    expect(imports).toEqual([]);
  });

  it("new String(x) / new Boolean(x) leak no host import", async () => {
    const a = await instantiate(`export function test(): number { let w: any = new String("x"); return 0; }`);
    const b = await instantiate(`export function test(): number { let w: any = new Boolean(1); return 0; }`);
    expect(a.imports).toEqual([]);
    expect(b.imports).toEqual([]);
  });

  it('new Number(1) % "1" === 0 (the architect\'s primary acceptance signature)', async () => {
    const { ret, imports } = await instantiate(
      `export function test(): number { return (new Number(1) as any) % "1"; }`,
    );
    expect(imports).toEqual([]);
    expect(ret).toBe(0);
  });

  it("ToNumber over Number/String wrappers via arithmetic operators", async () => {
    expect((await instantiate(`export function test(): number { return (new Number(5) as any) - 0; }`)).ret).toBe(5);
    expect(
      (await instantiate(`export function test(): number { return (new Number(3) as any) * (new Number(4) as any); }`))
        .ret,
    ).toBe(12);
    expect((await instantiate(`export function test(): number { return (new String("5") as any) - 0; }`)).ret).toBe(5);
    expect((await instantiate(`export function test(): number { return (new String("5") as any) % 4; }`)).ret).toBe(1);
  });

  it("full §11.13.2_A4.3 modulo-assignment matrix over Number/String wrappers", async () => {
    // Mirrors test262 compound-assignment/S11.13.2_A4.3_T2.2.js (Number/String,
    // primitive and object). Returns the failing step index, 0 = all pass.
    const { ret, imports } = await instantiate(`export function test(): number {
      let x: any;
      x = "1"; x %= 1; if (x !== 0) return 1;
      x = 1; x %= "1"; if (x !== 0) return 2;
      x = new String("1"); x %= 1; if (x !== 0) return 3;
      x = 1; x %= new String("1"); if (x !== 0) return 4;
      x = "1"; x %= new Number(1); if (x !== 0) return 5;
      x = new Number(1); x %= "1"; if (x !== 0) return 6;
      x = new String("1"); x %= new Number(1); if (x !== 0) return 7;
      x = new Number(1); x %= new String("1"); if (x !== 0) return 8;
      return 0;
    }`);
    expect(imports).toEqual([]);
    expect(ret).toBe(0);
  });

  it("String(new Number(n)) returns the decimal string (length / char codes)", async () => {
    expect(
      (await instantiate(`export function test(): number { let s = String(new Number(1)); return s.length; }`)).ret,
    ).toBe(1);
    expect(
      (await instantiate(`export function test(): number { let s = String(new Number(1)); return s.charCodeAt(0); }`))
        .ret,
    ).toBe(49);
    expect(
      (await instantiate(`export function test(): number { let s = String(new Number(42)); return s.length; }`)).ret,
    ).toBe(2);
  });

  it("String(new String(s)) returns the inner string", async () => {
    expect(
      (
        await instantiate(
          `export function test(): number { let w: any = new String("ab"); let s = String(w); return s.length; }`,
        )
      ).ret,
    ).toBe(2);
  });

  it("the [[PrimitiveValue]] internal slot is non-enumerable (Object.keys ignores it)", async () => {
    // The wrapper's only own property is the internal slot, which must NOT be
    // enumerable, so Object.keys over it is empty.
    const { ret } = await instantiate(
      `export function test(): number { let w: any = new Number(7); return Object.keys(w).length; }`,
    );
    expect(ret).toBe(0);
  });

  it('typeof a boxed wrapper is "object"', async () => {
    expect(
      (
        await instantiate(
          `export function test(): boolean { let w: any = new Number(1); return typeof w === "object"; }`,
        )
      ).ret,
    ).toBe(1);
    expect(
      (
        await instantiate(
          `export function test(): boolean { let w: any = new String("x"); return typeof w === "object"; }`,
        )
      ).ret,
    ).toBe(1);
  });

  it("a wrapper reaching __any_to_string no longer traps (degrades, does not crash)", async () => {
    // Pre-S2 this trapped with "illegal cast"; post-S2 it must instantiate and
    // run without a Wasm trap. (The any+any concat RESULT is still governed by a
    // separate pre-existing __any_add bug — not asserted here.)
    const run = async () =>
      (
        await instantiate(
          `export function test(): number { let a: any = new String("1"); let b: any = "x"; let s = a + b; return s.length; }`,
        )
      ).ret;
    await expect(run()).resolves.toBeTypeOf("number");
  });
});
