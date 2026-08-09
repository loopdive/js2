// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2875 slice B — reflective `String.prototype.<m>.call(undefined)` must throw a
// TypeError (RequireObjectCoercible, §22.1.3.1 step 1) in `--target standalone`.
//
// Before this slice, the four reflective String proto member-body families
// (index-accessor charAt/at/charCodeAt/codePointAt, search-numeric indexOf/
// lastIndexOf, search-boolean includes/startsWith/endsWith, trim/trimStart/
// trimEnd) guarded RequireObjectCoercible with a bare `ref.is_null`. Under the
// #2106 undefinedSingleton regime `undefined` is a DISTINCT non-null sentinel
// externref, so `ref.is_null` caught `null` but MISSED `undefined`:
// `charAt.call(undefined)` silently ToString'd it to "undefined" and returned a
// value instead of throwing. This slice OR-s in the native `__extern_is_undefined`
// predicate (host-free) via a shared `emitStringRequireObjectCoercible` helper.
//
// Results are host-opaque WasmGC refs, so tests assert via a number computed
// INSIDE the module (1 = threw TypeError, 0/2 = did not / wrong error kind).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // No host import may leak: the undefined test is the native __extern_is_undefined.
  expect(r.imports ?? []).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

// `.call(recv, ...args)` wrapped in try/catch → 1 iff it threw a TypeError.
const throwsTypeError = (member: string, recv: string, args = ""): string =>
  `export function test(): number { try { (String.prototype.${member} as any).call(${recv}${args}); return 0; } ` +
  `catch (e) { return (e instanceof TypeError) ? 1 : 2; } }`;

// Every member that has a native reflective proto body, one per family arm.
const UNDEF_CASES: ReadonlyArray<[string, string]> = [
  // index-accessor family (emitStringProtoMemberBody)
  ["charAt", ", 0"],
  ["at", ", 0"],
  ["charCodeAt", ", 0"],
  ["codePointAt", ", 0"],
  // search-numeric family (emitStringSearchNumericMemberBody)
  ["indexOf", ', "x"'],
  ["lastIndexOf", ', "x"'],
  // search-boolean family (emitStringSearchBooleanMemberBody)
  ["includes", ', "x"'],
  ["startsWith", ', "x"'],
  ["endsWith", ', "x"'],
  // trim family (emitStringTrimMemberBody)
  ["trim", ""],
  ["trimStart", ""],
  ["trimEnd", ""],
];

describe("#2875 slice B — String.prototype.<m>.call(undefined) throws (RequireObjectCoercible)", () => {
  for (const [member, args] of UNDEF_CASES) {
    it(`${member}.call(undefined) throws TypeError`, async () => {
      expect(await runStandalone(throwsTypeError(member, "undefined", args))).toBe(1);
    });
  }

  // Regression guard: `null` receivers must STILL throw (ref.is_null half).
  for (const [member, args] of [
    ["charAt", ", 0"],
    ["indexOf", ', "x"'],
    ["includes", ', "x"'],
    ["trim", ""],
  ] as ReadonlyArray<[string, string]>) {
    it(`${member}.call(null) still throws TypeError`, async () => {
      expect(await runStandalone(throwsTypeError(member, "null", args))).toBe(1);
    });
  }

  // Regression guard: valid string receivers still produce the correct result.
  it("charAt.call('abc', 1) === 'b'", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const c: any = (String.prototype.charAt as any).call("abc", 1); return c === "b" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("indexOf.call('abcb', 'b') === 1", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const c: any = (String.prototype.indexOf as any).call("abcb", "b"); return c === 1 ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("includes.call('abc', 'b') === true", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const c: any = (String.prototype.includes as any).call("abc", "b"); return c === true ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("trim.call('  hi ') === 'hi'", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const c: any = (String.prototype.trim as any).call("  hi "); return c === "hi" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
