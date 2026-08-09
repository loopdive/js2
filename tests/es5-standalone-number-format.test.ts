// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4234 — the ES5 `Number` cluster on `--target standalone` (pure WasmGC, no JS
 * host). Two independent root causes, one describe block each.
 *
 * ## 1. String→double is the broken half, not double→string
 *
 * The bucket signature that opened this issue looked like a formatter bug:
 * `Expected SameValue(«1.2345677999999998e-87», «1.2345678e-87»)`. It is not.
 * The value on the RIGHT of that message is a compile-time literal that the
 * SAME `number_toString` rendered as `1.2345678e-87` — i.e. the dtoa is already
 * shortest-round-trip and was never at fault. The value on the LEFT is
 * `Number("+1234.5678e-90")`, and the PARSER produced a different double.
 *
 * So these tests compare `Number(s)` / `parseFloat(s)` against the host's own
 * parse of the same literal. Comparing against a hard-coded string would not
 * distinguish "parsed wrong" from "formatted wrong"; comparing the two paths
 * against each other is what localises it.
 *
 * ## 2. `Number` constructor own value properties
 *
 * `Number.hasOwnProperty("MAX_VALUE")` was false: the standalone ctor carrier
 * only ever carried `length`/`name`/`prototype`. The syntactic read
 * `Number.MAX_VALUE` is a compile-time `f64.const` fold and never touched the
 * carrier, so presence and value could disagree — which is exactly the pair
 * test262's `verifyNotWritable` checks. Every assertion below therefore pins
 * BOTH (`hasOwnProperty` true AND the reflective read equal to the direct read).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

async function runStandalone(source: string): Promise<Record<string, unknown>> {
  const r = await compile(source, { target: "standalone", fileName: "issue-4234.ts" });
  expect(r.success, r.success ? "" : r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  if (typeof exports._start === "function") exports._start();
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(exports)) {
    if (name !== "_start" && typeof fn === "function" && !name.startsWith("__")) out[name] = fn();
  }
  return out;
}

// ── 1. string → double ────────────────────────────────────────────────────

/**
 * Inputs chosen to cover each arm of the scaling switch in
 * `emitApplyDecimalExp`, because they are lowered differently:
 *   - `|totalExp| <= 22`   the pre-existing exactly-representable-power arm
 *   - `22 < |totalExp| <= 308`  the arm this issue rewrote (table + ONE op)
 *   - `|totalExp| > 308`   the staged tail that must still reach subnormals
 *                          and saturate to ±Infinity rather than 0/Infinity
 */
const PARSE_INPUTS = [
  // <= 22: must not regress.
  "0.1",
  "0.3",
  "0.01",
  "12.5",
  "1e21",
  "1e-21",
  // The four test262 files' actual payload, and its already-correct twin.
  "+1234.5678e-90",
  "+1234.5678e90",
  "-1234.5678e-90",
  "1.2345678e-87",
  // 22 < |e| <= 308.
  "2.2250738585072014e-308",
  "1.7976931348623157e308",
  "123456789012345678901234567890",
  "9.1073414692e-189",
  // > 308 — subnormal / saturation tail.
  "1e-320",
  "1e-323",
  "5e-324",
  "4.9e-324",
  "1e309",
  "1e400",
  "-1e400",
  "1e-400",
];

describe("#4234 — standalone StringToNumber is within one ulp", () => {
  it("Number(s) and parseFloat(s) match the host parse for every arm", async () => {
    // One module for all inputs: compiling 22 standalone modules serially is
    // minutes of wall time, and the arms do not interact.
    const decls = PARSE_INPUTS.map(
      (s, i) =>
        `export function n${i}(): number { return Number(${JSON.stringify(s)}); }\n` +
        `export function p${i}(): number { return parseFloat(${JSON.stringify(s)}); }`,
    ).join("\n");
    const out = await runStandalone(decls);

    const got: Record<string, unknown> = {};
    const want: Record<string, unknown> = {};
    PARSE_INPUTS.forEach((s, i) => {
      // Object.is, not ===, so -0 and NaN are compared by identity.
      got[`Number(${s})`] = Object.is(out[`n${i}`], Number(s)) ? "match" : out[`n${i}`];
      want[`Number(${s})`] = "match";
      got[`parseFloat(${s})`] = Object.is(out[`p${i}`], parseFloat(s)) ? "match" : out[`p${i}`];
      want[`parseFloat(${s})`] = "match";
    });
    expect(got).toEqual(want);
  });

  it("never drifts more than one ulp on a randomised sweep", async () => {
    // The pre-#4234 per-step loop was wrong on 75% of these and drifted by up
    // to ~10 ulp. A single rounding against the 10^k table bounds the error at
    // one ulp — i.e. the answer is always the nearest double or its immediate
    // neighbour. That BOUND is what this test pins; it deliberately does NOT
    // assert exactness, because this is not (yet) a correctly-rounded strtod.
    let seed = 987654321;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const inputs: string[] = [];
    for (let i = 0; i < 120; i++) {
      const nd = 1 + Math.floor(rnd() * 17);
      let d = "";
      for (let k = 0; k < nd; k++) d += Math.floor(rnd() * 10);
      d = d.replace(/^0+/, "") || "1";
      const pt = Math.max(1, Math.floor(rnd() * d.length));
      const mantissa = pt >= d.length ? d : `${d.slice(0, pt)}.${d.slice(pt)}`;
      inputs.push(`${mantissa}e${Math.floor(rnd() * 400) - 300}`);
    }
    const out = await runStandalone(
      inputs.map((s, i) => `export function v${i}(): number { return Number(${JSON.stringify(s)}); }`).join("\n"),
    );

    const offenders: string[] = [];
    inputs.forEach((s, i) => {
      const got = out[`v${i}`] as number;
      const wanted = Number(s);
      if (Object.is(got, wanted)) return;
      if (!Number.isFinite(wanted) || wanted === 0) {
        offenders.push(`${s}: got ${got} want ${wanted}`);
        return;
      }
      const ulps = Math.abs(got - wanted) / Math.abs(wanted) / Number.EPSILON;
      if (ulps > 1.0000001) offenders.push(`${s}: got ${got} want ${wanted} (${ulps.toFixed(2)} ulp)`);
    });
    expect(offenders).toEqual([]);
  });

  it("the gc (js-host) lane is untouched — it never used the native parser", async () => {
    const r = await compile(`export function v(): number { return Number("1234.5678e-90"); }`, {});
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {
      env: new Proxy({} as Record<string, unknown>, {
        get: () => () => 0,
        has: () => true,
      }),
    } as unknown as WebAssembly.Imports).catch(() => ({ instance: null }));
    // Instantiating the host lane needs the full import object; the point of
    // this case is only that the module still COMPILES with the host import
    // rather than picking up `__str_to_number`, so a null instance is fine.
    expect(Buffer.from(r.binary).includes(Buffer.from("__pow10_f64"))).toBe(false);
    void instance;
  });
});

// ── 2. Number ctor own value properties ───────────────────────────────────

const NUMBER_CONSTANTS = [
  "EPSILON",
  "MAX_SAFE_INTEGER",
  "MIN_SAFE_INTEGER",
  "MAX_VALUE",
  "MIN_VALUE",
  "POSITIVE_INFINITY",
  "NEGATIVE_INFINITY",
  "NaN",
] as const;

describe("#4234 — Number's §15.7.3 constants are own properties of the carrier", () => {
  it("hasOwnProperty is true for each, and the reflective read matches the direct read", async () => {
    const decls = NUMBER_CONSTANTS.map(
      (k, i) =>
        `export function has${i}(): boolean { return N.hasOwnProperty(${JSON.stringify(k)}); }\n` +
        // NaN can't be compared with ===, so compare its string form; for the
        // rest compare the reflective read against the syntactic fold, which is
        // the pair `verifyNotWritable` relies on.
        `export function same${i}(): boolean { return String(N[${JSON.stringify(k)}]) === String(Number.${k}); }`,
    ).join("\n");
    const out = await runStandalone(`const N: any = Number;\n${decls}`);

    const got: Record<string, unknown> = {};
    const want: Record<string, unknown> = {};
    NUMBER_CONSTANTS.forEach((k, i) => {
      got[`has ${k}`] = out[`has${i}`];
      got[`value ${k}`] = out[`same${i}`];
      want[`has ${k}`] = 1;
      want[`value ${k}`] = 1;
    });
    expect(got).toEqual(want);
  });

  it("they are non-enumerable, non-writable and non-configurable (§15.7.3)", async () => {
    const out = await runStandalone(`
const N: any = Number;
export function notEnumerable(): boolean {
  const keys: string[] = Object.keys(N);
  let seen: boolean = false;
  for (let i = 0; i < keys.length; i++) { if (keys[i] === "MAX_VALUE") seen = true; }
  return !seen;
}
// [[Writable]] false. A module body is strict code, so the rejected write
// THROWS rather than silently no-opping — either outcome satisfies the spec,
// what must hold in both is that the value did not move.
export function notWritable(): boolean {
  const before: number = N.MAX_VALUE;
  try { N.MAX_VALUE = 1; } catch (e) { /* strict-mode rejection */ }
  return N.MAX_VALUE === before;
}
export function notConfigurable(): boolean {
  const d: any = Object.getOwnPropertyDescriptor(N, "MAX_VALUE");
  return d !== null && d !== undefined && d.writable === false && d.enumerable === false && d.configurable === false;
}
`);
    expect(out).toEqual({ notEnumerable: 1, notWritable: 1, notConfigurable: 1 });
  });

  it("only Number is seeded — a sibling ctor carrier stays as it was", async () => {
    // Guards against the table being keyed too broadly. `String` has no numeric
    // §15.7.3-style constants, so seeding it would be a scope leak.
    const out = await runStandalone(`
const S: any = String;
export function stringHasNoMaxValue(): boolean { return !S.hasOwnProperty("MAX_VALUE"); }
export function stringStillHasName(): boolean { return S.hasOwnProperty("name"); }
`);
    expect(out).toEqual({ stringHasNoMaxValue: 1, stringStillHasName: 1 });
  });

  it("the gc (js-host) lane does not mint the standalone carrier", async () => {
    const r = await compile(
      `const N: any = Number;\nexport function h(): boolean { return N.hasOwnProperty("MAX_VALUE"); }`,
      {},
    );
    expect(r.success).toBe(true);
    expect(Buffer.from(r.binary).includes(Buffer.from("__builtin_ctor_Number"))).toBe(false);
  });
});

// ── test262 files that flip ───────────────────────────────────────────────

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

describe.skipIf(!TEST262)("#4234 — test262 files that flip on the standalone lane", () => {
  const files = [
    // StringToNumber accuracy.
    "built-ins/Number/S9.3.1_A4_T1.js",
    "built-ins/Number/S9.3.1_A4_T2.js",
    "built-ins/Number/S9.3.1_A5_T1.js",
    "built-ins/Number/S9.3.1_A5_T3.js",
    // Number ctor own value constants — presence…
    "built-ins/Number/S15.7.3_A2.js",
    "built-ins/Number/S15.7.3_A3.js",
    "built-ins/Number/S15.7.3_A4.js",
    "built-ins/Number/S15.7.3_A5.js",
    "built-ins/Number/S15.7.3_A6.js",
    // …and attributes, via propertyHelper's runtime descriptor queries.
    "built-ins/Number/MAX_VALUE/S15.7.3.2_A2.js",
    "built-ins/Number/MAX_VALUE/S15.7.3.2_A3.js",
    "built-ins/Number/MIN_VALUE/S15.7.3.3_A2.js",
    "built-ins/Number/MIN_VALUE/S15.7.3.3_A3.js",
    "built-ins/Number/NEGATIVE_INFINITY/S15.7.3.5_A2.js",
    "built-ins/Number/POSITIVE_INFINITY/S15.7.3.6_A2.js",
  ];
  for (const rel of files) {
    it(`${rel} passes`, { timeout: 120_000 }, async () => {
      const abs = join(__dirname, "..", "test262", "test", rel);
      const r = await runTest262File(abs, "es5-number-format", 60_000, "standalone");
      expect(`${r.status}: ${r.reason ?? r.error ?? ""}`).toBe("pass: ");
    });
  }
});
