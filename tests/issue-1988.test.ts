// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1988 — `any + ref` ToPrimitive regression guard.
//
// `__any_add` once skipped ToPrimitive on object/array operands, so `1 + {}`
// returned NaN and `[] + []` returned 0 instead of string-concatenating the
// ToPrimitive(default) results (§13.15.3 ApplyStringOrNumericBinaryOperator).
// The recent #1938/#1900/#2073 type-coercion wave fixed it; this locks the
// host/gc-mode behavior in so it cannot silently regress.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStr(source: string): Promise<string> {
  const r = await compile(source, { fileName: "issue-1988.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imp = r.importObject;
  const { instance } = await WebAssembly.instantiate(r.binary, imp);
  (imp as unknown as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  return (instance.exports as Record<string, () => string>).test();
}

describe("#1988 any + ref ToPrimitive", () => {
  it('1 + {} → "1[object Object]"', async () => {
    expect(await runStr(`export function test(): string { const o: any = {}; return String(1 + o); }`)).toBe(
      "1[object Object]",
    );
  });

  it('[] + [] → ""', async () => {
    expect(await runStr(`export function test(): string { const a: any = []; return String(a + a); }`)).toBe("");
  });

  it('[1,2] + 1 → "1,21"', async () => {
    expect(await runStr(`export function test(): string { const a: any = [1, 2]; return String(a + 1); }`)).toBe(
      "1,21",
    );
  });

  it('{} + "x" → "[object Object]x"', async () => {
    expect(await runStr(`export function test(): string { const o: any = {}; return o + "x"; }`)).toBe(
      "[object Object]x",
    );
  });

  it('[3,4] + ",5" → "3,4,5"', async () => {
    expect(await runStr(`export function test(): string { const a: any = [3, 4]; return a + ",5"; }`)).toBe("3,4,5");
  });

  it('{} + {} → "[object Object][object Object]"', async () => {
    expect(await runStr(`export function test(): string { const o: any = {}; return o + o; }`)).toBe(
      "[object Object][object Object]",
    );
  });
});
