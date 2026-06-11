// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1470 residual sweep — string iteration + comparison must be pure Wasm and
 * spec-correct under `--target standalone`:
 *
 * 1. `[...str]` previously fell into the generic vec-spread branch, whose
 *    array-type lookup fails for the string struct and silently contributed
 *    NOTHING (`[..."abc"].length === 0`, elements null).
 * 2. `Array.from(str)` fell into the `__array_from` JS-host fallback — an
 *    env:: import leak AND (post late-import shift) an invalid module.
 * 3. `for (const c of str)` iterated code UNITS; §22.1.5.1 String iteration
 *    yields code POINTS (a well-formed surrogate pair is one element).
 * 4. `a.localeCompare(b)` fell through to "Unknown string method" and was
 *    demoted to an always-0 stub — violating §22.1.3.12's consistency
 *    requirement. Now lowers to UTF-16 code-unit order via __str_compare.
 * 5. `toLocaleLowerCase`/`toLocaleUpperCase` hit the same always-0 stub; they
 *    now alias the default case conversion (no ECMA-402 tables).
 *
 * Each case instantiates with an EMPTY import object — proving no JS host.
 */

async function instantiate(source: string, target: "standalone" | "wasi" = "standalone") {
  const r = await compile(source, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envLeaks = r.imports.filter((i) => i.module === "env" || i.module.startsWith("wasm:js-string"));
  expect(
    envLeaks.map((i) => `${i.module}::${i.name}`),
    "JS-host imports leaked",
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, (...args: number[]) => number>;
}

describe("#1470 string spread — standalone", () => {
  it("[...str] yields one element per code point", async () => {
    const ex = await instantiate(`
      export function len(): number { return [..."abc"].length; }
      export function elem1(): number { const a = [..."abc"]; return a[1].charCodeAt(0); }
      export function astralLen(): number { return [..."a\\u{1F600}b"].length; }
      export function astralMidLen(): number { const a = [..."a\\u{1F600}b"]; return a[1].length; }
      export function loneSurrogate(): number { return [..."a\\uD800b"].length; }
      export function empty(): number { return [...""].length; }
      export function consSpread(a: string, b: string): number { const s = a + b; return [...s].length; }
    `);
    expect(ex.len!()).toBe(3);
    expect(ex.elem1!()).toBe(98); // "b"
    expect(ex.astralLen!()).toBe(3); // §22.1.5.1: pair is ONE element
    expect(ex.astralMidLen!()).toBe(2); // ...of TWO code units
    expect(ex.loneSurrogate!()).toBe(3); // lone surrogate stays its own element
    expect(ex.empty!()).toBe(0);
  });

  it("mixed prefix element + string spread composes", async () => {
    const ex = await instantiate(`
      export function f(): number {
        const a = ["x", ..."yz"];
        return a.length * 1000 + a[2].charCodeAt(0);
      }
    `);
    expect(ex.f!()).toBe(3122); // len 3, "z" = 122
  });
});

describe("#1470 Array.from(string) — standalone", () => {
  it("materializes the code-point vec natively (no __array_from)", async () => {
    const ex = await instantiate(`
      export function len(): number { return Array.from("abc").length; }
      export function elem(): number { return Array.from("abc")[2].charCodeAt(0); }
      export function astral(): number { return Array.from("\\u{1F600}").length; }
    `);
    expect(ex.len!()).toBe(3);
    expect(ex.elem!()).toBe(99); // "c"
    expect(ex.astral!()).toBe(1);
  });
});

describe("#1470 for-of over strings — code points (standalone)", () => {
  it("yields surrogate pairs as one 2-unit element", async () => {
    const ex = await instantiate(`
      export function count(): number { let c = 0; for (const ch of "a\\u{1F600}b") c++; return c; }
      export function pairLen(): number { for (const ch of "\\u{1F600}") return ch.length; return -1; }
      export function sumAscii(): number { let c = 0; for (const ch of "abc") c += ch.charCodeAt(0); return c; }
      export function loneCount(): number { let c = 0; for (const ch of "\\uD800\\uD800") c++; return c; }
    `);
    expect(ex.count!()).toBe(3);
    expect(ex.pairLen!()).toBe(2);
    expect(ex.sumAscii!()).toBe(294);
    expect(ex.loneCount!()).toBe(2); // unpaired highs stay separate elements
  });
});

describe("#1470 localeCompare / toLocale case — standalone", () => {
  it("localeCompare is a consistent total order (code-unit)", async () => {
    const ex = await instantiate(`
      export function lt(): number { return "a".localeCompare("b"); }
      export function gt(): number { return "b".localeCompare("a"); }
      export function eq(): number { return "ab".localeCompare("a" + "b"); }
      export function prefix(): number { return "a".localeCompare("ab"); }
    `);
    expect(ex.lt!()).toBe(-1);
    expect(ex.gt!()).toBe(1);
    expect(ex.eq!()).toBe(0);
    expect(ex.prefix!()).toBe(-1);
  });

  it("toLocaleLowerCase/toLocaleUpperCase fall back to default case fold", async () => {
    const ex = await instantiate(`
      export function lower(): number { return "AbC".toLocaleLowerCase().charCodeAt(0); }
      export function upper(): number { return "aBc".toLocaleUpperCase().charCodeAt(0); }
      export function lowerLen(): number { return "AbC".toLocaleLowerCase("en-US").length; }
    `);
    expect(ex.lower!()).toBe(97); // "a"
    expect(ex.upper!()).toBe(65); // "A"
    expect(ex.lowerLen!()).toBe(3);
  });
});

describe("#1470 string iteration — WASI parity", () => {
  it("the same iteration semantics hold under --target wasi", async () => {
    const ex = await instantiate(
      `
      export function spreadLen(): number { return [..."a\\u{1F600}b"].length; }
      export function forofCount(): number { let c = 0; for (const ch of "a\\u{1F600}b") c++; return c; }
      export function lc(): number { return "a".localeCompare("b"); }
    `,
      "wasi",
    );
    expect(ex.spreadLen!()).toBe(3);
    expect(ex.forofCount!()).toBe(3);
    expect(ex.lc!()).toBe(-1);
  });
});

describe("#1470 default (gc / JS-host) mode regression guard", () => {
  it("keeps for-of/localeCompare behavior in JS-host mode", async () => {
    // NOTE: gc-mode `[..."abc"]` is a PRE-EXISTING host-mode gap (the
    // externref spread branch's __extern_length on a JS string yields 0) —
    // verified broken on main before this change; tracked separately. This
    // guard pins the paths this PR could plausibly affect.
    const r = await compile(
      `
      export function forofCount(): number { let c = 0; for (const ch of "abc") c++; return c; }
      export function lc(): number { return "a".localeCompare("b"); }
    `,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // #1667 — compile() returns a ready-to-pass importObject for JS-host mode.
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject!);
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.forofCount!()).toBe(3);
    expect(ex.lc!()).toBe(-1);
  });
});
