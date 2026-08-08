// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4232) String-exotic object semantics on `--target standalone`:
// §10.4.3.5 indexed reads and §10.4.3.6 / §10.4.3.5 own properties.
//
// The failure this pins is a REPRESENTATION failure, not an off-by-one: the
// static element-read arm returned `ref $NativeString`, a type in which
// `undefined` cannot be expressed, so it answered `""` for every out-of-range
// index. Two consequences shape the assertions below:
//
//   * `=== undefined` is the load-bearing check — `!== ""` would also have been
//     satisfied by a null, so both directions are asserted.
//   * `s[NaN]` is not redundant with `s[-1]`: `i32.trunc_sat_f64_s(NaN)` is 0,
//     so a bounds-only fix reads `s[0]` and looks correct on the negative and
//     over-length cases while still being wrong (`15.5.5.5.2-3-3`).
//
// The in-range reads and their downstream uses are asserted too, because
// widening the result type to `externref` could regress them silently.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<Record<string, unknown>> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  if (typeof exports._start === "function") exports._start();
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(exports)) {
    if (name !== "_start" && typeof fn === "function" && !name.startsWith("__")) out[name] = fn();
  }
  return out;
}

describe("#4232 — String exotic indexed reads (standalone)", () => {
  it("out-of-range and non-canonical indices are undefined, not the empty string", async () => {
    const out = await runStandalone(`
var s = new String("hello world");
export function neg(): boolean { return s[-1] === undefined; }
export function past(): boolean { return s[11] === undefined; }
export function negNotEmpty(): boolean { return (s[-1] as any) !== ""; }
export function pastNotEmpty(): boolean { return (s[11] as any) !== ""; }
export function nan(): boolean { return s[NaN] === undefined; }
export function inf(): boolean { return s[Infinity] === undefined; }
export function huge(): boolean { return s[4294967295] === undefined; }
export function frac(): boolean { return s[1.5] === undefined; }
`);
    expect(out).toEqual({
      neg: 1,
      past: 1,
      negNotEmpty: 1,
      pastNotEmpty: 1,
      nan: 1,
      inf: 1,
      huge: 1,
      frac: 1,
    });
  });

  it("in-range reads still work, and still work as strings downstream", async () => {
    const out = await runStandalone(`
var s = new String("hello world");
var p = String("hello world");
export function first(): boolean { return s[0] === "h"; }
export function last(): boolean { return s[10] === "d"; }
export function negZero(): boolean { return s[-0] === "h"; }
export function chained(): number { return s[1].charCodeAt(0); }
export function lengthOf(): number { return s[4].length; }
export function literal(): boolean { return "XYZ"[2] === "Z"; }
export function computed(): boolean { return p[p.length - 1] === "d"; }
`);
    expect(out).toEqual({
      first: 1,
      last: 1,
      negZero: 1,
      chained: 101, // "e"
      lengthOf: 1,
      literal: 1,
      computed: 1,
    });
  });

  it("a PRIMITIVE string receiver gets the same bounds (§10.4.3.5 via the conjured wrapper)", async () => {
    const out = await runStandalone(`
var p = String("hello world");
export function neg(): boolean { return p[-1] === undefined; }
export function past(): boolean { return p[11] === undefined; }
export function nan(): boolean { return p[NaN] === undefined; }
export function inRange(): boolean { return p[0] === "h"; }
`);
    expect(out).toEqual({ neg: 1, past: 1, nan: 1, inRange: 1 });
  });
});

describe("#4232 — String exotic own properties (standalone)", () => {
  it("length and in-range indices are OWN; out-of-range are not", async () => {
    const out = await runStandalone(`
var s = new String("globglob");
export function len(): boolean { return (s as any).hasOwnProperty("length"); }
export function first(): boolean { return (s as any).hasOwnProperty("0"); }
export function last(): boolean { return (s as any).hasOwnProperty("7"); }
export function past(): boolean { return (s as any).hasOwnProperty("8"); }
export function numericFirst(): boolean { return (s as any).hasOwnProperty(0); }
export function numericLast(): boolean { return (s as any).hasOwnProperty(7); }
export function numericPast(): boolean { return (s as any).hasOwnProperty(8); }
export function numericNeg(): boolean { return (s as any).hasOwnProperty(-1); }
export function numericFrac(): boolean { return (s as any).hasOwnProperty(1.5); }
export function hasOwn(): boolean { return Object.hasOwn(s as any, "3"); }
`);
    expect(out).toEqual({
      len: 1,
      first: 1,
      last: 1,
      past: 0,
      numericFirst: 1,
      numericLast: 1,
      numericPast: 0,
      numericNeg: 0,
      numericFrac: 0,
      hasOwn: 1,
    });
  });

  it("NON-canonical numeric strings are not index properties", async () => {
    // The neighbouring for-in / __extern_get arms parse numeric keys with
    // `__str_to_number`, which accepts every one of these. Here that would be a
    // wrong `true`: none is a CanonicalNumericIndexString, so §10.4.3.5 says
    // the property is absent.
    const out = await runStandalone(`
var s = new String("globglob");
export function empty(): boolean { return (s as any).hasOwnProperty(""); }
export function leadingZero(): boolean { return (s as any).hasOwnProperty("01"); }
export function leadingSpace(): boolean { return (s as any).hasOwnProperty(" 1"); }
export function plusSign(): boolean { return (s as any).hasOwnProperty("+1"); }
export function exponent(): boolean { return (s as any).hasOwnProperty("1e0"); }
export function fractional(): boolean { return (s as any).hasOwnProperty("1.5"); }
export function nonDigit(): boolean { return (s as any).hasOwnProperty("x"); }
export function negString(): boolean { return (s as any).hasOwnProperty("-1"); }
`);
    expect(out).toEqual({
      empty: 0,
      leadingZero: 0,
      leadingSpace: 0,
      plusSign: 0,
      exponent: 0,
      fractional: 0,
      nonDigit: 0,
      negString: 0,
    });
  });

  it("ordinary objects and their own expandos are unaffected", async () => {
    // The prologue is consult-only: it answers 1 or falls through, never 0.
    const out = await runStandalone(`
var o: any = { q: 1 };
var s: any = new String("ab");
s.extra = 9;
export function plainHit(): boolean { return o.hasOwnProperty("q"); }
export function plainMiss(): boolean { return o.hasOwnProperty("z"); }
export function wrapperExpando(): boolean { return s.hasOwnProperty("extra"); }
export function wrapperExpandoMiss(): boolean { return s.hasOwnProperty("other"); }
export function inheritedNotOwn(): boolean { return o.hasOwnProperty("toString"); }
`);
    expect(out).toEqual({
      plainHit: 1,
      plainMiss: 0,
      wrapperExpando: 1,
      wrapperExpandoMiss: 0,
      inheritedNotOwn: 0,
    });
  });
});
