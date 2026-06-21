import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #2358 (#10 fold) — standalone Array → primitive (Array.prototype.toString =
// join(",")) inside the runtime `__to_primitive` engine.
//
// A real array literal compiles to a `__vec_<elemKind>` struct (subtyping
// `$__vec_base`), NOT the dynamic `$Object`. So `__to_primitive`'s
// `ref.test objectTypeIdx` arm missed it and returned the array unchanged →
// `__unbox_number(array)` → NaN. This broke `Number([1])`, `1 + [2]`,
// `"1,2" == [1,2]` standalone. The fix detects a vec via the shared `$__vec_base`
// supertype and reduces it through a native join helper
// (`__array_to_primitive_string`, reserved at __to_primitive-emit time and
// filled after `__extern_length`/`__extern_get_idx` register).

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2358 standalone Array ToPrimitive (join)", () => {
  it("Number([1]) reduces a single-element array to its number", async () => {
    expect(await runStandalone(`export function test(): number { return Number([1] as any); }`)).toBe(1);
  });

  it("Number([42]) reduces to 42", async () => {
    expect(await runStandalone(`export function test(): number { return Number([42] as any); }`)).toBe(42);
  });

  it('Number([]) reduces empty array to 0 (ToNumber("") = 0)', async () => {
    expect(await runStandalone(`export function test(): number { return Number([] as any); }`)).toBe(0);
  });

  it("Number([1,2]) is NaN (','-joined string is not numeric)", async () => {
    // n !== n iff NaN
    expect(
      await runStandalone(
        `export function test(): number { const n = Number([1,2] as any); return (n !== n) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it('1 + [2] concatenates as "12" then to-number → 12', async () => {
    expect(
      await runStandalone(`export function test(): number { return ((1 as any) + ([2] as any)) as number; }`),
    ).toBe(12);
  });

  it('"1,2" == [1,2] reduces the array to "1,2" and string-compares true', async () => {
    expect(await runStandalone(`export function test(): number { return ("1,2" == ([1,2] as any)) ? 1 : 0; }`)).toBe(1);
  });

  it('[1,2,3] == "1,2,3" (array on the left)', async () => {
    expect(
      await runStandalone(`export function test(): number { return (([1,2,3] as any) == "1,2,3") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("string-element array joins with commas", async () => {
    // ["a","b"] + "" === "a,b" (length 3)
    expect(await runStandalone(`export function test(): number { return ((["a","b"] as any) + "").length; }`)).toBe(3);
  });

  // Regression guards — the already-merged nominal-object half must still work.
  it("Number({valueOf}) still reduces a nominal object (no regression)", async () => {
    expect(await runStandalone(`export function test(): number { return Number({valueOf: () => 5} as any); }`)).toBe(5);
  });

  it("any-param nominal object * 2 still reduces (no regression)", async () => {
    expect(
      await runStandalone(
        `function g(x: any) { return x * 2; } export function test(): number { return g({valueOf: () => 21}); }`,
      ),
    ).toBe(42);
  });
});
