// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";

/**
 * #7018 — integer TypedArray CONSTRUCTION in standalone stores ToInt8/ToUint8/…
 * /ToInt32 (§7.1.6–§7.1.11, modulo 2ⁿ), not a saturated `i32.trunc_sat_f64_s`
 * (which stored 0xff for every value ≥ 2³¹ — uuid's SHA-1 bytes), and
 * `TA.of(…, ...packed)` reads a packed source with `array.get_s`/`_u` instead of
 * emitting invalid Wasm.
 *
 * Every row is checked against the same source run by the JS engine, so the
 * expected values are the spec's, not ours. On the parent commit the
 * `of`/`from`/`new TA(arr)`/`map` rows differed and the spread module did not
 * validate.
 */

const SOURCE = `
function big(): number { return (0x5a39a3ee + 0x80000000) >>> 0; }
function v(i: number): number {
  const vals = [2147483648, 4294967296, -1, 1e20, NaN, -0, 300, -129, 65537, 3661210606, 1.7, -1.7, 255.5, Infinity, -Infinity];
  return vals[i];
}
// Typed per-view hashes: reading a signed view through an any-typed receiver is
// a separate (pre-existing) representation question this test does not pin.
function hI8(a: Int8Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]) % 1000000007; return s; }
function hU8(a: Uint8Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]) % 1000000007; return s; }
function hC(a: Uint8ClampedArray): number { let s = 0; for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]) % 1000000007; return s; }
function hI16(a: Int16Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]) % 1000000007; return s; }
function hU16(a: Uint16Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]) % 1000000007; return s; }
function hI32(a: Int32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]) % 1000000007; return s; }
function hU32(a: Uint32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]) % 1000000007; return s; }
function arr(): number[] { const a: number[] = []; for (let i = 0; i < 15; i++) a.push(v(i)); return a; }
export function indexedStore(): number { const b = new Uint8Array(1); b[0] = big(); return b[0]; }
export function ofU8(): number { return Uint8Array.of(big())[0]; }
export function ofI8(): number { return hI8(Int8Array.of(v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9), v(10), v(11), v(12), v(13), v(14))); }
export function ofU8All(): number { return hU8(Uint8Array.of(v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9), v(10), v(11), v(12), v(13), v(14))); }
export function ofClamped(): number { return hC(Uint8ClampedArray.of(v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9), v(10), v(11), v(12), v(13), v(14))); }
export function ofI16(): number { return hI16(Int16Array.of(v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9), v(10), v(11), v(12), v(13), v(14))); }
export function ofU16(): number { return hU16(Uint16Array.of(v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9), v(10), v(11), v(12), v(13), v(14))); }
export function ofI32(): number { return hI32(Int32Array.of(v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9), v(10), v(11), v(12), v(13), v(14))); }
export function ofU32(): number { return hU32(Uint32Array.of(v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9), v(10), v(11), v(12), v(13), v(14))); }
export function newU8(): number { return hU8(new Uint8Array(arr())); }
export function newI8(): number { return hI8(new Int8Array(arr())); }
export function newClamped(): number { return hC(new Uint8ClampedArray(arr())); }
export function newI16(): number { return hI16(new Int16Array(arr())); }
export function newU32(): number { return hU32(new Uint32Array(arr())); }
export function newFromAny(): number { const a: any[] = arr(); return hU8(new Uint8Array(a)); }
export function fromU8(): number { return hU8(Uint8Array.from(arr())); }
export function fromI16(): number { return hI16(Int16Array.from(arr())); }
export function fromI32(): number { return hI32(Int32Array.from(arr())); }
export function mapU8(): number { return hU8(new Uint8Array(15).map((_x, i) => v(i))); }
export function mapI32(): number { return hI32(new Int32Array(15).map((_x, i) => v(i))); }
export function sha1Tail(): number { return hU8(Uint8Array.of(big(), big() >> 24, big() >>> 8)); }
export function newU16FromI8(): number { const i8 = Int8Array.of(-1, -128, 127, 5); return hU16(new Uint16Array(i8)); }
`;

const SPREAD_SOURCE = `
// Typed per-view hashes: reading a signed view through an any-typed receiver is
// a separate (pre-existing) representation question this test does not pin.
function hU8(a: Uint8Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]) % 1000000007; return s; }
function hI16(a: Int16Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]) % 1000000007; return s; }
function hU16(a: Uint16Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]) % 1000000007; return s; }
const i8 = Int8Array.of(-1, -128, 127, 5);
const u8 = Uint8Array.of(255, 128, 1);
const node = Uint8Array.of(0x9f, 0x68);
export function uuidNode(): number { return Uint8Array.of(1, ...node)[1]; }
export function mixed(): number { return hU8(Uint8Array.of(1, ...i8, 2, ...u8)); }
export function widenSigned(): number { return hI16(Int16Array.of(...i8, ...u8)); }
export function widenUnsigned(): number { return hU16(Uint16Array.of(...i8, 3661210606, ...u8)); }
export function fromNumbers(): number { const n: number[] = [3, 300]; return hU8(Uint8Array.of(7, ...n)); }
export function literalSpread(): number { const a = [...i8, ...u8]; let s = 0; for (const x of a) s = s * 31 + x; return s; }
`;

async function jsReference(source: string): Promise<Record<string, number>> {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  const out: Record<string, number> = {};
  for (const [name, fn] of Object.entries(mod)) if (typeof fn === "function") out[name] = (fn as () => number)();
  return out;
}

async function standalone(source: string, names: string[]): Promise<Record<string, number>> {
  const r = await compile(source, { target: "standalone", fileName: "issue-7018.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(r.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, () => number>;
  const out: Record<string, number> = {};
  for (const name of names) out[name] = exports[name]!();
  return out;
}

describe("#7018 — standalone TypedArray construction wraps (ToIntN), never saturates", () => {
  it("of / from / new TA(array) / map agree with the JS engine for boundary values", async () => {
    const expected = await jsReference(SOURCE);
    const actual = await standalone(SOURCE, Object.keys(expected));
    // Anti-vacuity: the indexed store already wrapped before the fix, and the
    // uuid SHA-1 byte is the specific saturated value (0xff) the fix removes.
    expect(expected.indexedStore).toBe(0xee);
    expect(actual.indexedStore).toBe(0xee);
    expect(expected.ofU8).toBe(0xee);
    for (const name of Object.keys(expected)) expect([name, actual[name]]).toEqual([name, expected[name]]);
  });

  it("TA.of with packed-TypedArray spreads validates and matches the JS engine", async () => {
    const expected = await jsReference(SPREAD_SOURCE);
    const actual = await standalone(SPREAD_SOURCE, Object.keys(expected));
    expect(expected.uuidNode).toBe(0x9f);
    for (const name of Object.keys(expected)) expect([name, actual[name]]).toEqual([name, expected[name]]);
  });
});
