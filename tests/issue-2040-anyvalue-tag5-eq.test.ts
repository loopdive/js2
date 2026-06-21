import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #2040 — standalone AnyValue tag-5 equality. In standalone the tag-5 (string)
// arm of __any_eq/__any_strict_eq was a dead `i32.const 0` (the JS-host `equals`
// import is -1), so EVERY tag-5 ===/== returned false — including a NUMBER `any`
// boxed as tag-5 by the #1888 box-the-externref policy. That broke the test262
// harness `assert._isSameValue` (gates a huge fraction of sameValue/notSameValue
// asserts). Fix: a 3-way field-4 cascade (number / native-string / ref-identity).

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

// `const m = a;` forces the AnyValue type to be ensured before the comparison,
// so the eq routes through __any_strict_eq / __any_eq (the failing path).
const EQ = `function eq(a: any, b: any): boolean { const m = a; return a === b; }`;
const LE = `function le(a: any, b: any): boolean { const m = a; return a == b; }`;

describe("#2040 standalone AnyValue tag-5 equality", () => {
  it("number === number: 5 === 5 true, 5 === 6 false", async () => {
    expect(await runStandalone(`${EQ} export function test(): number { return eq(5, 5) ? 1 : 0; }`)).toBe(1);
    expect(await runStandalone(`${EQ} export function test(): number { return eq(5, 6) ? 1 : 0; }`)).toBe(0);
  });

  it("string === string: content compare", async () => {
    expect(await runStandalone(`${EQ} export function test(): number { return eq("ab", "ab") ? 1 : 0; }`)).toBe(1);
    expect(await runStandalone(`${EQ} export function test(): number { return eq("ab", "cd") ? 1 : 0; }`)).toBe(0);
  });

  it("number === string (different JS type) is false", async () => {
    expect(await runStandalone(`${EQ} export function test(): number { return eq(5, "5") ? 1 : 0; }`)).toBe(0);
  });

  it("loose number == string ToNumber-compares (§7.2.15)", async () => {
    expect(await runStandalone(`${LE} export function test(): number { return le(5, "5") ? 1 : 0; }`)).toBe(1);
    expect(await runStandalone(`${LE} export function test(): number { return le(5, "6") ? 1 : 0; }`)).toBe(0);
  });

  it("object === object by reference identity (a === a over an array any)", async () => {
    expect(
      await runStandalone(
        `function eq(a: any, b: any): boolean { const m = a; return a === b; } export function test(): number { const v = [1,2,3]; return eq(v, v) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("distinct arrays are not equal", async () => {
    expect(await runStandalone(`${EQ} export function test(): number { return eq([1,2,3], [4,5,6]) ? 1 : 0; }`)).toBe(
      0,
    );
  });

  it("_isSameValue(1,2) is false, _isSameValue(1,1) is true (the harness shape)", async () => {
    const isSame = `function isSame(a: any, b: any): boolean { if (a === b) { return a !== 0 || 1/a === 1/b; } return a !== a && b !== b; }`;
    expect(await runStandalone(`${isSame} export function test(): number { return isSame(1, 2) ? 1 : 0; }`)).toBe(0);
    expect(await runStandalone(`${isSame} export function test(): number { return isSame(1, 1) ? 1 : 0; }`)).toBe(1);
  });

  it("a !== a is false after a preceding any-op (the regression trigger)", async () => {
    expect(
      await runStandalone(
        `function f(a: any): number { const m = a * 2; const n = (a !== a); return n ? 1 : 0; } export function test(): number { return f(5); }`,
      ),
    ).toBe(0);
  });

  it("array-string indexOf still finds by content (no regression)", async () => {
    expect(await runStandalone(`export function test(): number { return ["","ab","bca","abc"].indexOf("abc"); }`)).toBe(
      3,
    );
  });
});
