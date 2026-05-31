// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1588 PR-B part 2 — UTF-8 dual-storage round-trip correctness.
//
// Compiles string programs twice on the WasmGC backend — once with
// --utf8-storage OFF (i16 NativeString, the baseline) and once ON (i8
// Utf8String for ascii/utf8-guaranteed literals) — and asserts identical
// observable results. The encoding distinction must be invisible to JS
// semantics (.length, charCodeAt, ===, concat all WTF-16-observable), so an
// i8-backed literal that flows into a string op must decode back to the same
// code units via __str_utf8_to_flat.

import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";

// Permissive host imports: a real env namespace with identity-ish stubs plus a
// Proxy fallback so any module-declared `env` import we didn't enumerate
// resolves to a harmless function. (nativeStrings keeps strings in-heap, so the
// programs don't need wasm:js-string, but `__box_number` etc. are still
// declared on the module.)
const envBase: Record<string, Function> = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
  __box_number: (v: number) => v,
  __unbox_number: (v: unknown) => Number(v),
};
const ENV = {
  env: new Proxy(envBase, {
    get(target, prop: string) {
      return prop in target ? target[prop] : () => 0;
    },
    has() {
      return true;
    },
  }),
};

async function run(source: string, exportName: string, utf8Storage: boolean): Promise<unknown> {
  const result = await compile(source, { experimentalIR: true, nativeStrings: true, utf8Storage });
  if (!result.success) {
    throw new Error(`compile failed (utf8Storage=${utf8Storage}): ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, ENV);
  const fn = (instance.exports as Record<string, (...a: unknown[]) => unknown>)[exportName];
  if (typeof fn !== "function") throw new Error(`export "${exportName}" not found`);
  return fn();
}

interface Case {
  readonly name: string;
  readonly source: string;
  readonly exportName: string;
}

// Each program returns a number so the i16 and i8 builds can be compared
// directly. Literals span ascii / multi-byte / astral / wtf16 so both storage
// widths and the UTF-8→UTF-16 decode path are exercised.
const CASES: ReadonlyArray<Case> = [
  {
    name: "ascii literal .length",
    source: `export function f(): number { const s = "hello"; return s.length; }`,
    exportName: "f",
  },
  {
    name: "ascii charCodeAt",
    source: `export function f(): number { const s = "ABC"; return s.charCodeAt(1); }`,
    exportName: "f",
  },
  {
    name: "multi-byte literal .length (code units, not bytes)",
    source: `export function f(): number { const s = "café"; return s.length; }`,
    exportName: "f",
  },
  {
    name: "multi-byte charCodeAt decodes back to the right code unit",
    // é = U+00E9 = 233; index 3.
    source: `export function f(): number { const s = "café"; return s.charCodeAt(3); }`,
    exportName: "f",
  },
  {
    name: "astral literal .length is 2 (surrogate pair)",
    source: `export function f(): number { const s = "a\u{1f600}b"; return s.length; }`,
    exportName: "f",
  },
  {
    name: "astral charCodeAt yields the high surrogate",
    // index 1 of "a😀b" is the high surrogate 0xD83D = 55357.
    source: `export function f(): number { const s = "a\u{1f600}b"; return s.charCodeAt(1); }`,
    exportName: "f",
  },
  {
    name: "concat of two ascii literals length",
    source: `export function f(): number { const a = "foo"; const b = "bar"; return (a + b).length; }`,
    exportName: "f",
  },
  {
    name: "concat ascii + multi-byte charCodeAt",
    source: `export function f(): number { const a = "x"; const b = "é"; return (a + b).charCodeAt(1); }`,
    exportName: "f",
  },
  {
    name: "equality of equal ascii literals",
    source: `export function f(): number { const a = "same"; const b = "same"; return a === b ? 1 : 0; }`,
    exportName: "f",
  },
  {
    name: "wtf16 lone-surrogate literal stays i16 and round-trips length",
    source: `export function f(): number { const s = "x\uD800y"; return s.length; }`,
    exportName: "f",
  },
];

describe("#1588 PR-B part 2 — utf8-storage round-trip equivalence", () => {
  for (const c of CASES) {
    it(`${c.name}: i8-on === i16-off`, async () => {
      const off = await run(c.source, c.exportName, false);
      const on = await run(c.source, c.exportName, true);
      expect(on).toBe(off);
    });
  }
});
