import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2583 — standalone any-typed array method dispatch (indexOf/lastIndexOf/
// includes). An array literal typed `any` compiles to a `$__vec_*` struct
// subtyping the shared `$__vec_base` supertype; `a.indexOf("y")` was lowered
// through the guarded native-string method path whose non-string else-arm
// returned a benign default (0). The fix routes that else-arm through the
// closed-method dispatcher `__call_m_<m>_<arity>`, whose new `$__vec_base`
// brand arm linear-scans the array via native `__extern_length` /
// `__extern_get_idx` + `__extern_strict_eq` (indexOf/lastIndexOf) /
// `__extern_same_value_zero` (includes). Surfaced a latent substrate bug too:
// `__any_strict_eq`/`__any_eq`'s tag-5 string-content arm used the host
// `wasm:js-string equals` import, absent in standalone (→ const 0), so two equal
// boxed strings compared unequal; now falls back to native flatten + __str_equals.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2583 standalone any-array method brand dispatch (indexOf/lastIndexOf/includes)", () => {
  it("indexOf finds a string element", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=["x","y"]; return a.indexOf("y"); }`),
    ).toBe(1);
  });

  it("indexOf returns -1 when absent", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=["x","y"]; return a.indexOf("z"); }`),
    ).toBe(-1);
  });

  it("indexOf finds a number element", async () => {
    expect(await runStandalone(`export function test(): number { const a:any=[1,2,3]; return a.indexOf(2); }`)).toBe(1);
  });

  it("lastIndexOf scans backward to the last match", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=["x","y","x"]; return a.lastIndexOf("x"); }`),
    ).toBe(2);
  });

  it("lastIndexOf returns -1 when absent", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=["x","y"]; return a.lastIndexOf("z"); }`),
    ).toBe(-1);
  });

  it("includes returns true for a present number (SameValueZero)", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[1,2,3]; return a.includes(2)?1:0; }`),
    ).toBe(1);
  });

  it("includes returns false for an absent value", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[1,2,3]; return a.includes(9)?1:0; }`),
    ).toBe(0);
  });

  it("includes finds a string element", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=["x","y"]; return a.includes("y")?1:0; }`),
    ).toBe(1);
  });

  // NaN: StrictEquality (indexOf) is NaN≠NaN; SameValueZero (includes) is NaN=NaN.
  it("indexOf(NaN) returns -1 (StrictEquality)", async () => {
    expect(await runStandalone(`export function test(): number { const a:any=[NaN]; return a.indexOf(NaN); }`)).toBe(
      -1,
    );
  });

  it("includes(NaN) returns true (SameValueZero)", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[NaN]; return a.includes(NaN)?1:0; }`),
    ).toBe(1);
  });

  it("empty array → indexOf -1", async () => {
    expect(await runStandalone(`export function test(): number { const a:any=[]; return a.indexOf("x"); }`)).toBe(-1);
  });

  it("empty array → includes false", async () => {
    expect(await runStandalone(`export function test(): number { const a:any=[]; return a.includes("x")?1:0; }`)).toBe(
      0,
    );
  });

  it("mixed-type elements: indexOf locates the matching kind only", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[1,"x",true]; return a.indexOf("x"); }`),
    ).toBe(1);
  });

  // ── regressions: the fast paths and string-receiver path stay unchanged ──
  it("typed string[] indexOf still uses the fast path", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:string[]=["x","y"]; return a.indexOf("y"); }`),
    ).toBe(1);
  });

  it("typed number[] includes still works", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:number[]=[1,2,3]; return a.includes(2)?1:0; }`),
    ).toBe(1);
  });

  it("string receiver indexOf still dispatches to String.prototype.indexOf", async () => {
    expect(await runStandalone(`export function test(): number { const a:any="xy"; return a.indexOf("y"); }`)).toBe(1);
  });

  it("open-$Object method dispatch unaffected", async () => {
    expect(await runStandalone(`export function test(): number { const o:any={m(){return 5;}}; return o.m(); }`)).toBe(
      5,
    );
  });
});
