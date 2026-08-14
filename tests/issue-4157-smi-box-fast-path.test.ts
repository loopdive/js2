// (#4157) The BOX side of the small-integer fast path — `src/codegen/smi-box-fast-path.ts`.
//
// The pass rewrites `call $__box_number` into `__box_number`'s own i31 arm,
// delegating to the untouched call when the predicate fails. Its whole value
// rests on that delegation being EXACT, so this file pins the boundary values
// where the two arms disagree if the predicate is copied wrong: the ±2^30 i31
// edges, `-0` (which round-trips through `i32.trunc_sat_f64_s` and must NOT
// become `ref.i31 0`), NaN, the infinities, and non-integers.
//
// Every case boxes a number into an `any` slot and reads it back inside Wasm,
// so nothing opaque crosses the JS boundary. The flag is **default `all`** since
// the #4157 tuned-set flip, so the positions below are `0` (the legacy
// emission), `1` (the restricted i32-only level), `all`, and unset — which must
// behave exactly like `all` and is the one position an ordinary build takes.
import { describe, it, expect, afterEach } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `
export function roundTrip(v: number): number { var o: any = {}; o.x = v; var r: number = o.x; return r; }
export function roundTripI32(n: number): number { var o: any = {}; o.x = n | 0; var r: number = o.x; return r; }
export function isNegZero(v: number): boolean { var o: any = {}; o.x = v; return 1 / o.x === -Infinity; }
export function typeofIsNumber(v: number): boolean { var o: any = {}; o.x = v; return typeof o.x === "number"; }
export function truthy(v: number): boolean { var o: any = {}; o.x = v; return o.x ? true : false; }
export function selfNe(v: number): boolean { var o: any = {}; o.x = v; return o.x !== o.x; }
export function objIs(v: number, w: number): boolean {
  var o: any = {}; o.x = v; var p: any = {}; p.y = w; return Object.is(o.x, p.y);
}
export function dynSub(a: number, b: number): number {
  var p: any = {}; p.a = a; p.b = b; var o: any = {}; o.x = p.a - p.b; var r: number = o.x; return r;
}
`;

const I31_MIN = -(2 ** 30);
const I31_MAX = 2 ** 30 - 1;

/** The values where a mis-copied predicate would diverge. */
const VALUES = [
  0,
  -0,
  1,
  -1,
  I31_MIN,
  I31_MIN - 1,
  I31_MAX,
  I31_MAX + 1,
  2147483647,
  -2147483648,
  2147483648,
  4294967296,
  1.5,
  -1.5,
  0.1,
  Infinity,
  -Infinity,
  1e21,
  2 ** 53, // the exact f64 above which integers are no longer contiguous
];

type Exports = Record<string, (...args: number[]) => number>;

async function instantiate(): Promise<Exports> {
  const result = await compile(SOURCE, {
    fileName: "t.ts",
    skipSemanticDiagnostics: true,
    target: "standalone" as const,
    optimize: 0,
  });
  if (!result.binary?.length) throw new Error(`compile failed: ${JSON.stringify(result.errors?.[0])}`);
  const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(result.binary), {});
  return exports as unknown as Exports;
}

const PREVIOUS = process.env.JS2WASM_SMI_FASTPATH;

/**
 * `delete`, not `= undefined` — assigning to `process.env` stringifies, so
 * `= undefined` would leave the literal string "undefined" behind and the flag
 * reader would see a SET variable. Absence is the state under test.
 */
function setFlag(value: string | undefined): void {
  // biome-ignore lint/performance/noDelete: absence, not the string "undefined"
  if (value === undefined) delete process.env.JS2WASM_SMI_FASTPATH;
  else process.env.JS2WASM_SMI_FASTPATH = value;
}

afterEach(() => setFlag(PREVIOUS));

describe.each([
  ["flag =0 (the legacy emission)", "0"],
  ["flag =1 (i32 sources)", "1"],
  ["flag =all (every boxing site)", "all"],
  ["unset (the shipped default, = all)", undefined],
])("#4157 smi box guard — %s", (_label, flag) => {
  it("agrees with JS on every boundary value", async () => {
    setFlag(flag);
    const e = await instantiate();

    for (const v of VALUES) {
      expect(Object.is(e.roundTrip(v), v), `roundTrip(${v})`).toBe(true);
      expect(e.roundTripI32(v), `roundTripI32(${v})`).toBe(v | 0);
      // `-0` is the value the i31 arm would silently lose; `1/x === -Infinity`
      // is the only way to see it from inside Wasm.
      expect(e.isNegZero(v), `isNegZero(${v})`).toBe(Number(Object.is(v, -0)));
      expect(e.typeofIsNumber(v), `typeof(${v})`).toBe(1);
      expect(e.truthy(v), `truthy(${v})`).toBe(Number(Boolean(v)));
      expect(e.selfNe(v), `NaN self-inequality(${v})`).toBe(Number(Number.isNaN(v)));
      for (const w of [0, -0, 1, I31_MAX, 1.5]) {
        expect(e.objIs(v, w), `Object.is(${v},${w})`).toBe(Number(Object.is(v, w)));
      }
    }
  });

  it("keeps dynamic subtraction exact across the i31 edges", async () => {
    setFlag(flag);
    const e = await instantiate();

    // `a, b ∈ [-2^30, 2^30-1]` ⇒ `a - b ∈ [-2^31+1, 2^31-1]`, i.e. results that
    // leave the i31 range and must fall to the `$BoxedNumber` arm.
    for (const [a, b] of [
      [I31_MAX, I31_MIN],
      [I31_MIN, I31_MAX],
      [I31_MAX, -1],
      [I31_MIN, 1],
      [0, 0],
      [0, -0],
      [1.5, 0.25],
      [10, 3],
    ]) {
      expect(Object.is(e.dynSub(a, b), a - b), `dynSub(${a},${b})`).toBe(true);
    }
  });
});
