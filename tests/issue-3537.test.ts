// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3537 — standalone: expando own-properties on array ($Vec) receivers were
// silently dropped (writes no-op'd in `__extern_set`'s vec arm / the non-object
// miss arm; reads terminally answered undefined in `__extern_get`'s vec arm).
// The fix routes non-numeric-key vec property ops into an array-identity-keyed
// side table (`src/codegen/vec-props.ts` — the ARRAY arm of the #3468
// own-property family). These tests run compiled standalone binaries and assert
// on RUNTIME results (not just compile success).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const standaloneOpts = {
  fileName: "test.ts",
  emitWat: false,
  skipSemanticDiagnostics: true,
  target: "standalone" as const,
};

async function run(src: string): Promise<number> {
  const r = await compile(src, standaloneOpts);
  expect(r.success).toBe(true);
  expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#3537 — array expando own-properties (standalone)", () => {
  it("round-trips a named expando through the dynamic path", async () => {
    expect(
      await run(`var a = [1, 2];
export function test(): number { (a as any).x = 5; return ((a as any).x === 5) ? 1 : 2; }`),
    ).toBe(1);
  });

  it("top-level expando writes on an array var persist (the test262 __expected harness shape)", async () => {
    expect(
      await run(`var a = ["abc", "a"];
(a as any).index = 0;
(a as any).input = "abc";
export function test(): number { return ((a as any).index === 0 && (a as any).input === "abc") ? 1 : 2; }`),
    ).toBe(1);
  });

  it("expandos are identity-keyed: visible through every alias of the SAME array", async () => {
    expect(
      await run(`var a = [1, 2];
export function test(): number { var g: any = a; g.x = 9; return ((a as any).x === 9) ? 1 : 2; }`),
    ).toBe(1);
  });

  it("distinct arrays do not cross-talk", async () => {
    expect(
      await run(`var a = [1]; var b = [2];
export function test(): number { (a as any).x = 11; (b as any).x = 22; return ((a as any).x === 11 && (b as any).x === 22) ? 1 : 2; }`),
    ).toBe(1);
  });

  it("elements and length are untouched by expando writes", async () => {
    expect(
      await run(`var a = [1, 2];
export function test(): number { (a as any).x = 5; return (a[0] === 1 && a[1] === 2 && a.length === 2) ? 1 : 2; }`),
    ).toBe(1);
  });

  it("numeric keys stay vec ELEMENTS (never bagged): in-bounds writes hit the element", async () => {
    expect(
      await run(`var a = [1, 2];
export function test(): number { var g: any = a; g[0] = 7; g["1"] = 9; return (a[0] === 7 && a[1] === 9) ? 1 : 2; }`),
    ).toBe(1);
  });

  it("a computed 'length' key write cannot shadow the real length via the bag", async () => {
    expect(
      await run(`var a = [1, 2];
export function test(): number { var g: any = a; var k: any = "length"; g[k] = 55; return (a.length === 2 && (g as any).length === 2) ? 1 : 2; }`),
    ).toBe(1);
  });

  it("for-in over the array is not polluted by expandos (reflection out of scope)", async () => {
    expect(
      await run(`var a = [1, 2];
export function test(): number { (a as any).x = 5; var ks = ""; for (var k in a) { ks += k; } return (ks === "01") ? 1 : 2; }`),
    ).toBe(1);
  });

  it("a function-valued expando dispatches as a method", async () => {
    expect(
      await run(`var a = [1, 2]; var fn = function (): number { return 777; };
export function test(): number { (a as any).m = fn; return ((a as any).m() === 777) ? 1 : 2; }`),
    ).toBe(1);
  });

  it("#3468 closure own-properties still work (composed arm, closure fallthrough intact)", async () => {
    expect(
      await run(`var n = 1; var memo = function (x: number): number { return x + n; };
export function test(): number { var g: any = memo; g.cache = 5; return (g.cache === 5) ? 1 : 2; }`),
    ).toBe(1);
  });

  it("host (gc) lane output is byte-identical for an expando-free program", async () => {
    // The side table is standalone/wasi-gated; the host lane must not change.
    const src = `var a = [1, 2];
export function test(): number { return a.length; }`;
    const host = await compile(src, { ...standaloneOpts, target: undefined });
    expect(host.success).toBe(true);
    // No $VecPropEntry machinery in host mode: the wat/type space must not
    // mention the side table. (Byte-identity vs pre-#3537 is covered by CI's
    // host lane; here we assert the gate held — nothing vec-prop was emitted.)
    const hostWat = await compile(src, { ...standaloneOpts, target: undefined, emitWat: true });
    expect(hostWat.wat ?? "").not.toContain("vec_prop");
  });
});
