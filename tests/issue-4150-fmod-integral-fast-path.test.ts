// #4150 — `%` on integral operands takes a signed-integer fast path.
//
// At the call site, operands proven integral and in signed-i64 range use a
// direct `i64.rem_s`. Unknown operands use the same operation behind runtime
// integrality/range checks and fall back to exact `__fmod`. A negative proof
// (fractional, non-finite, out-of-range, or a zero divisor) emits only the exact
// path. The helper retains its narrower i32 path for callers that reach it.
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
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) Both failing cases assert that the SLOW path is still a `call` —
// "chose the helper", and "the kill switch keeps an exact-helper-only path".
// The IR inliner (default ON since the tuned-set flip) inlines `__fmod`, so
// `call` vanishes and the assertions read as "the fast path was taken", the
// exact opposite of what happened. Pin the inliner off.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

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

function functionWat(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? undefined : next);
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
      [2147483648, 3],
      // Signed-i64 boundaries. 2^63 is excluded because f64 cannot represent
      // i64::MAX separately; INT64_MIN % -1 must avoid the Wasm overflow trap.
      [-(2 ** 63), -1],
      [-(2 ** 63), 3],
      [2 ** 63, 3],
      [Number.MAX_SAFE_INTEGER, 97],
      [Number.MAX_SAFE_INTEGER + 1, 97],
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

  it("uses positive, unknown, and negative AOT proofs to choose the emitted path", async () => {
    const source = `
      export function proven(): number {
        let checksum = 0;
        for (let round = 0; round < 512; round = round + 1) {
          checksum = checksum + round % 17;
        }
        return checksum;
      }
      export function guarded(value: number): number { return value % 1000003; }
      export function fractional(value: number): number { return value % 2.5; }
      export function outside(divisor: number): number { return 1e20 % divisor; }
      export function zero(value: number): number { return value % 0; }
    `;
    for (const experimentalIR of [true, false]) {
      const result = await compile(`${source}\n// IR: ${experimentalIR}`, {
        fileName: "remainder-proof-shapes.ts",
        target: "standalone",
        fast: true,
        optimize: 0,
        experimentalIR,
        emitWat: true,
        emitWatOnlyFunctions: ["proven", "guarded", "fractional", "outside", "zero"],
      } as never);
      expect(result.success, result.success ? undefined : result.errors?.[0]?.message).toBe(true);

      const proven = functionWat(result.wat, "proven");
      expect(proven).toContain("i64.rem_s");
      expect(proven).not.toMatch(/\bcall\b/);
      expect(proven).not.toContain("f64.trunc");

      const guarded = functionWat(result.wat, "guarded");
      expect(guarded).toContain("f64.trunc");
      expect(guarded).toContain("i64.trunc_f64_s");
      expect(guarded).toContain("i64.rem_s");
      expect(guarded).toMatch(/\bcall\b/);

      for (const name of ["fractional", "outside", "zero"]) {
        const rejected = functionWat(result.wat, name);
        expect(rejected).toMatch(/\bcall\b/);
        expect(rejected).not.toContain("i64.trunc_f64_s");
        expect(rejected).not.toContain("i64.rem_s");
      }
    }
  });

  it("keeps an exact-helper-only kill switch", async () => {
    const previous = process.env.JS2WASM_INLINE_REMAINDER_FAST_PATH;
    try {
      process.env.JS2WASM_INLINE_REMAINDER_FAST_PATH = "0";
      const result = await compile("export function guarded(value: number): number { return value % 1000003; }", {
        fileName: "remainder-fast-path-disabled.ts",
        target: "standalone",
        fast: true,
        optimize: 0,
        emitWat: true,
        emitWatOnlyFunctions: ["guarded"],
      } as never);
      expect(result.success, result.success ? undefined : result.errors?.[0]?.message).toBe(true);
      const guarded = functionWat(result.wat, "guarded");
      expect(guarded).toMatch(/\bcall\b/);
      expect(guarded).not.toContain("i64.rem_s");
      expect(guarded).not.toContain("f64.trunc");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_INLINE_REMAINDER_FAST_PATH");
      else process.env.JS2WASM_INLINE_REMAINDER_FAST_PATH = previous;
    }
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

    const candidateHelper = functionWat(candidate.wat, "__fmod_early_magnitude");
    const controlHelper = functionWat(control.wat, "__fmod");
    const smallHelper = functionWat(smallDivisor.wat, "__fmod");
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
