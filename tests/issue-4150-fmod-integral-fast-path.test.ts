// #4150 — `%` on integral operands takes an `i32.rem_s` fast path in `__fmod`.
//
// The helper's slow path is a binary long-division loop whose iteration count
// scales with the binary-exponent difference of the operands, so an ordinary
// `x % 3` cost ~26 f64 iterations. The fast path answers it with one
// `i32.rem_s` when both operands are whole numbers in i32 range.
//
// This test exists because that fast path is a REPRESENTATION change on a core
// arithmetic operator: it must be indistinguishable from the exact path, not
// merely close. Two results i32 cannot represent are the reason the guard needs
// a trailing `copysign` — `-6 % 3` and `-0 % 3` are both `-0` in JS
// (§6.1.6.1.6), not `+0` — and `INT_MIN % -1` would trap `i32.rem_s` outright.
// Every case below is compared against the host's own `%` with `Object.is`, so
// signed zero is a real assertion and not collapsed by `===`.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

let mod: { m(a: number, b: number): number } | undefined;

async function remainder(): Promise<(a: number, b: number) => number> {
  if (!mod) {
    const r = await compile("export function m(a: number, b: number): number { return a % b; }", {
      fileName: "t.ts",
      target: "standalone",
    } as never);
    expect(r.success, r.success ? undefined : r.errors?.[0]?.message).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary!, {});
    mod = instance.exports as unknown as { m(a: number, b: number): number };
  }
  return (a, b) => mod!.m(a, b);
}

/** `Object.is` except that any NaN matches any NaN (payload is unobservable). */
function same(got: number, want: number): boolean {
  return Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want));
}

describe("#4150 — __fmod integral fast path", () => {
  it("matches the host on the cases the fast path must get exactly right", async () => {
    const m = await remainder();
    const cases: [number, number][] = [
      // Ordinary integral — the shape the fast path exists for.
      [7, 3],
      [-7, 3],
      [7, -3],
      [-7, -3],
      [255, 16],
      [-255, 16],
      // Zero remainder with a negative dividend → -0, which i32 cannot carry.
      [-6, 3],
      [6, 3],
      // Signed zero in either position.
      [-0, 3],
      [0, 3],
      [6, -0],
      [6, 0],
      // Non-finite: must fall THROUGH to the exact path, not be captured by the
      // saturating conversion.
      [NaN, 3],
      [3, NaN],
      [Infinity, 3],
      [3, Infinity],
      [-Infinity, 3],
      [3, -Infinity],
      // i32 boundaries. INT_MIN % -1 would trap i32.rem_s.
      [-2147483648, -1],
      [2147483647, 3],
      [-2147483648, 3],
      [2147483648, 3], // just outside i32 → exact path
      // Fractional and huge/tiny — exact path, including the #2056 ULP-drift
      // repros the long-division algorithm was written for.
      [2.5, 1],
      [7.5, 2.5],
      [1e16, 0.0001],
      [123456789.123, 0.001],
      [1e308, 1e-308],
      [1e10, 7],
      [5e-324, 1e-300],
      [0.1, 0.03],
      [-0.1, 0.03],
      [1e300, 3],
    ];
    const bad = cases.filter(([a, b]) => !same(m(a, b), a % b));
    expect(bad.map(([a, b]) => `${a} % ${b} -> ${m(a, b)}, want ${a % b}`)).toEqual([]);
  });

  it("matches the host over a seeded random sweep spanning both paths", async () => {
    const m = await remainder();
    // Deterministic LCG — a fixed corpus, so a failure is reproducible.
    let seed = 0x2f6e2b1;
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = (): number => {
      const r = next();
      if (r < 0.35) return Math.floor(next() * 2 ** 32); // integral, spans i32 and beyond
      if (r < 0.6) return next() * 1e6; // fractional
      if (r < 0.8) return next() * 1e300; // huge
      return next() * 1e-300; // tiny / subnormal-adjacent
    };
    const mismatches: string[] = [];
    for (let i = 0; i < 20000; i++) {
      const a = (next() < 0.5 ? -1 : 1) * pick();
      const b = (next() < 0.5 ? -1 : 1) * pick();
      if (!same(m(a, b), a % b) && mismatches.length < 5) mismatches.push(`${a} % ${b} -> ${m(a, b)}, want ${a % b}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("checks magnitude before integral guards and preserves the legacy order behind its kill switch", async () => {
    const source = `
      export function run(n: number): number {
        const modulus = 1000000007;
        let sum = 0;
        for (let i = 0; i < n; i = i + 1) {
          sum = (sum + 832040) % modulus;
        }
        return sum;
      }
    `;

    const compileArm = async (control: boolean, input = source) => {
      const previous = process.env.JS2WASM_FMOD_EARLY_MAGNITUDE;
      try {
        if (control) process.env.JS2WASM_FMOD_EARLY_MAGNITUDE = "0";
        else Reflect.deleteProperty(process.env, "JS2WASM_FMOD_EARLY_MAGNITUDE");
        return await compile(`${input}\n// ${control ? "control" : "candidate"}`, {
          fileName: "fmod-early-magnitude.ts",
          target: "standalone",
          fast: true,
          optimize: 0,
          emitWat: true,
          emitWatOnlyFunctions: ["__fmod", "__fmod_early_magnitude"],
        } as never);
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_FMOD_EARLY_MAGNITUDE");
        else process.env.JS2WASM_FMOD_EARLY_MAGNITUDE = previous;
      }
    };

    const candidate = await compileArm(false);
    const control = await compileArm(true);
    const smallDivisor = await compileArm(false, "export function run(a: number): number { return a % 3; }");
    const previousLinearIr = process.env.JS2WASM_LINEAR_IR;
    let linear: Awaited<ReturnType<typeof compile>>;
    try {
      process.env.JS2WASM_LINEAR_IR = "1";
      linear = await compile(source, {
        fileName: "fmod-early-magnitude-linear.ts",
        target: "linear",
        fast: true,
        optimize: 0,
        emitWat: true,
      });
    } finally {
      if (previousLinearIr === undefined) Reflect.deleteProperty(process.env, "JS2WASM_LINEAR_IR");
      else process.env.JS2WASM_LINEAR_IR = previousLinearIr;
    }
    expect(candidate.success, candidate.success ? undefined : candidate.errors?.[0]?.message).toBe(true);
    expect(control.success, control.success ? undefined : control.errors?.[0]?.message).toBe(true);
    expect(smallDivisor.success, smallDivisor.success ? undefined : smallDivisor.errors?.[0]?.message).toBe(true);
    expect(linear.success, linear.success ? undefined : linear.errors?.[0]?.message).toBe(true);
    expect(linear.wat).toContain("$__fmod");

    const helperWat = (wat: string, name: string): string => {
      const start = wat.indexOf(`(func $${name}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const next = wat.indexOf("\n  (func $", start + 1);
      return wat.slice(start, next < 0 ? undefined : next);
    };
    const candidateHelper = helperWat(candidate.wat, "__fmod_early_magnitude");
    const controlHelper = helperWat(control.wat, "__fmod");
    const smallHelper = helperWat(smallDivisor.wat, "__fmod");
    const candidateTrunc = candidateHelper.indexOf("i32.trunc_sat_f64_s");
    const candidateMagnitude = candidateHelper.indexOf("f64.lt");
    const controlTrunc = controlHelper.indexOf("i32.trunc_sat_f64_s");
    const controlMagnitude = controlHelper.indexOf("f64.lt");
    const smallTrunc = smallHelper.indexOf("i32.trunc_sat_f64_s");
    const smallMagnitude = smallHelper.indexOf("f64.lt");
    expect(candidateMagnitude).toBeGreaterThanOrEqual(0);
    expect(candidateMagnitude).toBeLessThan(candidateTrunc);
    expect(controlTrunc).toBeGreaterThanOrEqual(0);
    expect(controlTrunc).toBeLessThan(controlMagnitude);
    expect(smallTrunc).toBeGreaterThanOrEqual(0);
    expect(smallTrunc).toBeLessThan(smallMagnitude);

    const candidateInstance = await WebAssembly.instantiate(candidate.binary!, {});
    const controlInstance = await WebAssembly.instantiate(control.binary!, {});
    const linearInstance = await WebAssembly.instantiate(linear.binary!, {});
    const candidateRun = candidateInstance.instance.exports.run as (n: number) => number;
    const controlRun = controlInstance.instance.exports.run as (n: number) => number;
    const linearRun = linearInstance.instance.exports.run as (n: number) => number;
    const expected = (n: number): number => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum = (sum + 832040) % 1000000007;
      return sum;
    };
    for (const n of [10_000, 100_000, 200_000]) {
      expect(candidateRun(n)).toBe(expected(n));
      expect(controlRun(n)).toBe(expected(n));
      expect(linearRun(n)).toBe(expected(n));
    }
  });
});
