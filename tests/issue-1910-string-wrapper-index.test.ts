import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1910 R4 — standalone String-wrapper `.length` and integer-indexed read.
//
// `new String("ab")` builds a `$Object` wrapper carrying its [[StringData]]
// native string in the reserved FLAG_INTERNAL slot (#1910 S2). String-exotic
// own properties `.length` (§22.1.4.1) and integer-index reads `w[i]`
// (§10.4.3 CanonicalNumericIndexString → §22.1.3.1-style char) are NOT routed
// to the underlying string by the generic `$Object` property/index path, so
// they null-deref. The standalone property/element-access lowering now recovers
// the slot string via `__to_primitive(recv, "string")` and reads `len` /
// `__str_charAt`. Scope: `.length` + integer-index read (String-exotic
// own-property enumeration is a separate, larger tail).
async function runNum(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#1910 R4 standalone String-wrapper indexed access + length", () => {
  it("new String('abc').length === 3", async () => {
    expect(await runNum(`export function f(): number { return new String("abc").length; }`)).toBe(3);
  });

  it("new String('xy').length === 2", async () => {
    expect(await runNum(`export function f(): number { return new String("xy").length; }`)).toBe(2);
  });

  it("new String('').length === 0", async () => {
    expect(await runNum(`export function f(): number { return new String("").length; }`)).toBe(0);
  });

  it("new String('abc')[0] === 'a'", async () => {
    expect(
      await runNum(`export function f(): number { const s = new String("abc"); return s[0] === "a" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("new String('abc')[2] === 'c'", async () => {
    expect(
      await runNum(`export function f(): number { const s = new String("abc"); return s[2] === "c" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("indexed char feeds a typed string method (charCodeAt)", async () => {
    expect(
      await runNum(
        `export function f(): number { const s = new String("abc"); const c: string = s[0]; return c.charCodeAt(0); }`,
      ),
    ).toBe(97);
  });
});
