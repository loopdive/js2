// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2191 — standalone `to{Upper,Lower}Case()` output must compare `===` correctly
// to a string literal for chars ≥0x80.
//
// Root cause (a #40 helper-routing bug, NOT an `__str_equals`/`__str_flatten`
// bug): the module emitted TWO functions — an ASCII-only `$__str_toUpperCase`
// (à=0xE0 ∉ [a-z] → unchanged) and the Unicode `$__str_toUpperCase_uni`
// (à→À=0xC0). The #40 ascii→uni re-point patched the ascii body by a
// funcIdx-shift-sensitive index (`mod.functions[asciiIdx - numImportFuncs]`) and
// missed the function the `===` call site actually resolved to. So
// `"à".toUpperCase()` via `===` was still "à" (0xE0) while `.charCodeAt(0)` (a
// different resolution path) saw the Unicode 0xC0 — an intransitive `===`.
//
// Fix: re-point the PUBLIC `__str_toUpperCase`/`__str_toLowerCase` NAMES (in both
// `nativeStrHelpers` and `funcMap`) directly at the `_uni` funcIdx, so every
// resolver dispatches to the Unicode body. Shift-immune.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2191 standalone case-conversion === literal for ≥0x80", () => {
  it('"à".toUpperCase() === "À"', async () => {
    expect(await runStandalone(`export function test(): number { return "à".toUpperCase() === "À" ? 1 : 0; }`)).toBe(1);
  });

  it('"à".toUpperCase() !== "à" (the lowercase input)', async () => {
    expect(await runStandalone(`export function test(): number { return "à".toUpperCase() === "à" ? 1 : 0; }`)).toBe(0);
  });

  it('"À".toLowerCase() === "à"', async () => {
    expect(await runStandalone(`export function test(): number { return "À".toLowerCase() === "à" ? 1 : 0; }`)).toBe(1);
  });

  it("ASCII case-conversion === still correct (z→Z)", async () => {
    expect(await runStandalone(`export function test(): number { return "z".toUpperCase() === "Z" ? 1 : 0; }`)).toBe(1);
  });

  it("mixed ASCII+≥0x80 word: café → CAFÉ", async () => {
    expect(
      await runStandalone(`export function test(): number { return "café".toUpperCase() === "CAFÉ" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("=== is transitive: helperA === helperB and both === literal", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = "à".toUpperCase();
        const b = "à".toUpperCase();
        return (a === b && a === "À" && b === "À") ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
