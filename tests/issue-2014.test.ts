import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #2014 — numeric-key element access on a struct/any receiver.
// `o[2]` / `o[i]` on `{ 2: "two" }` returned undefined while `o["2"]` worked:
// a small integer key (1-15) collided with the well-known-symbol ID range in
// `_safeGet`, so the numeric key was mis-resolved as Symbol(n) before the real
// `__sget_<n>` property getter was tried.
//
// #2010 residual — a shorthand property mixed with a spread (`{ x, ...null }`)
// dropped the shorthand binding: `resolvePropertyNameText` returned undefined
// for shorthands, so the open-$Object construction path skipped them entirely.

async function evalNum(body: string): Promise<unknown> {
  const exports = await compileToWasm(body);
  return (exports as { test: () => unknown }).test();
}
async function evalStr(body: string): Promise<unknown> {
  const exports = await compileToWasm(body);
  return (exports as { test: () => unknown }).test();
}

describe("#2014 numeric-key element access", () => {
  it("reads a numeric-literal key", async () => {
    expect(await evalStr(`export function test(): string { const o: any = { 2: "two" }; return o[2]; }`)).toBe("two");
  });

  it("reads a string-literal key (was already working)", async () => {
    expect(await evalStr(`export function test(): string { const o: any = { 2: "two" }; return o["2"]; }`)).toBe("two");
  });

  it("reads a dynamic numeric-variable key", async () => {
    expect(
      await evalStr(`export function test(): string { const o: any = { 2: "two" }; const i = 2; return o[i]; }`),
    ).toBe("two");
  });

  it("does not regress array indexing", async () => {
    expect(await evalNum(`export function test(): number { const a = [10, 20, 30]; return a[1]; }`)).toBe(20);
    expect(await evalNum(`export function test(): number { const a = [10, 20, 30]; const i = 2; return a[i]; }`)).toBe(
      30,
    );
  });
});

describe("#2010 residual: shorthand + spread", () => {
  it("keeps a leading shorthand alongside an error-typed spread", async () => {
    expect(
      await evalNum(
        `export function test(): number { const x = 5; const o = { x, ...null, y: 6 }; return (o as any).x; }`,
      ),
    ).toBe(5);
    expect(
      await evalNum(
        `export function test(): number { const x = 5; const o = { x, ...null, y: 6 }; return (o as any).y; }`,
      ),
    ).toBe(6);
  });

  it("keeps a shorthand after a spread", async () => {
    expect(
      await evalNum(`export function test(): number { const x = 5; const o = { ...null, x }; return (o as any).x; }`),
    ).toBe(5);
  });

  it("does not regress a shorthand without a spread", async () => {
    expect(
      await evalNum(`export function test(): number { const x = 5; const o = { x, y: 6 }; return (o as any).x; }`),
    ).toBe(5);
  });

  it("does not regress a non-leading named property with a spread", async () => {
    expect(
      await evalNum(`export function test(): number { const o = { a: 5, ...null, b: 6 }; return (o as any).a; }`),
    ).toBe(5);
  });
});
