// #3734 (Cause 2) — native-i32 ELEMENT storage for integer-only `number[]` on
// the IR path.
//
// Legacy has always lowered a `number[]` filled exclusively with int32-range
// integers to `(array (mut i32))` and widened with `f64.convert_i32_s` on read;
// the IR front-end kept `(array (mut f64))`, i.e. twice the memory traffic. On
// the landing-page `array.ts` benchmark that was the whole remaining IR-vs-
// legacy gap once #3741 landed.
//
// Three things are asserted here:
//
//  1. SHAPE — the benchmark body must actually get an i32 element vector, and
//     the read must widen back to f64.
//  2. GATING — every shape whose stored value is NOT provably an exact int32,
//     and every shape where the vector ESCAPES this function (so the full set
//     of stores is not visible), must keep the f64 layout. A conservative miss
//     costs nothing; a wrong narrowing is a silent wrong answer.
//  3. EQUIVALENCE — IR, legacy and real JavaScript must agree on every value,
//     across the edges that make an i32 element layout unsound when applied
//     too eagerly: fractional stores, values past 2^31, `-0`, out-of-bounds
//     reads (whose JS value is `undefined`, i.e. NaN in numeric context — a
//     number an i32 array cannot hold, which is why the widen happens INSIDE
//     the bounds-check arms).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(source: string, experimentalIR: boolean): Promise<WebAssembly.Exports> {
  const r = await compile(source, { nativeStrings: true, experimentalIR });
  if (!r.success) {
    throw new Error(
      `${experimentalIR ? "IR" : "legacy"} compile failed:\n${r.errors.map((e) => e.message).join("\n")}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(r.binary, buildImports(r.imports, undefined, r.stringPool));
  return instance.exports;
}

/** The `$<name>` function body out of a full-module WAT. */
function funcBody(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  expect(start, `function $${name} not found in WAT`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < wat.length; i++) {
    if (wat[i] === "(") depth++;
    else if (wat[i] === ")") {
      depth--;
      if (depth === 0) return wat.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced WAT for $${name}`);
}

/**
 * Did the IR lane give some vector in this module an i32 element layout?
 *
 * A narrowed vector either uses the grow helper (whose third parameter is the
 * element type) or, when capacity is proven, lowers to direct stores and keeps
 * an i32 vec-element scratch. Accept both optimized shapes without coupling to
 * module-relative type indices.
 */
function hasI32ElementVector(wat: string): boolean {
  return (
    /\(func \$__vec_elem_set_\d+ \(param \(ref null \d+\) i32 i32\)/.test(wat) ||
    /\(local \$\$vec_element_i32: i32\)/.test(wat)
  );
}

const BENCH_SRC = `
export function bench_array(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total = total + arr[i];
  return total;
}
`;

describe("#3734 — i32 array elements (shape)", () => {
  it("the array.ts benchmark gets an i32 element vector and widens on read", async () => {
    const r = await compile(BENCH_SRC, { emitWat: true, trackIrOutcomes: true });
    expect(r.success).toBe(true);
    expect(hasI32ElementVector(r.wat)).toBe(true);

    // The sum loop's `arr[i]` reads the i32 element and widens IMMEDIATELY —
    // invariant R, which is what keeps the narrowing invisible to consumers.
    const body = funcBody(r.wat, "bench_array");
    // (`local.tee` in between is the SSA value's own spill — the widen is
    // still the next real operation on the loaded element.)
    expect(body).toMatch(/array\.get \d+\s*\n\s*(local\.tee \d+\s*\n\s*)?f64\.convert_i32_s/);
    expect(r.irOutcomes?.find((outcome) => outcome.displayName === "bench_array")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
  });

  it("a SAFE narrowed read uses i32 length directly and widens only the in-bounds element", async () => {
    const source = `export function read(index: number): number {
      const arr: number[] = [];
      for (let i = 0; i < 8; i++) arr.push(i);
      return arr[index];
    }`;
    const r = await compile(source, { emitWat: true, trackIrOutcomes: true });
    expect(r.success, r.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(hasI32ElementVector(r.wat)).toBe(true);
    const body = funcBody(r.wat, "read");
    expect(body).toContain("i32.lt_u");
    expect(body).toContain("array.get");
    // The two remaining truncations ground the incoming `number` parameter
    // and consume it as an index. The two widens are the loop carrier and
    // in-bounds element. The removed vec-length round-trip would make these
    // counts three and three.
    expect(body.match(/i32\.trunc_sat_f64_s/g) ?? []).toHaveLength(2);
    expect(body.match(/f64\.convert_i32_s/g) ?? []).toHaveLength(2);
    expect(r.irOutcomes?.find((outcome) => outcome.displayName === "read")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const read = instance.exports.read as (index: number) => number;
    expect(read(3)).toBe(3);
    expect(read(99)).toBeNaN();
  });

  it("a narrowed store costs one conversion FEWER per iteration than the f64 layout", async () => {
    // A fill-only loop isolates the store side: the narrowed build hands the
    // i32-promoted counter straight to `__vec_elem_set_*`, while the f64 build
    // has to widen it first. (In the full benchmark the two sides cancel out —
    // the narrowed READ gains the convert the narrowed STORE drops — so the
    // A/B has to be done on the store alone to say anything.)
    const fill = (element: string): string => `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 10000; i++) arr.push(${element});
      return arr.length;
    }`;
    const [narrow, wide] = await Promise.all([
      compile(fill("i"), { emitWat: true }),
      compile(fill("i + 0.5"), { emitWat: true }),
    ]);
    expect(narrow.success && wide.success).toBe(true);
    expect(hasI32ElementVector(narrow.wat)).toBe(true);
    expect(hasI32ElementVector(wide.wat)).toBe(false);

    const converts = (wat: string): number => (funcBody(wat, "f").match(/f64\.convert_i32_s/g) ?? []).length;
    expect(converts(narrow.wat)).toBe(converts(wide.wat) - 1);
  });

  it("legacy already used an i32 element layout for the same source (this closes an IR-only gap)", async () => {
    const r = await compile(BENCH_SRC, {
      emitWat: true,
      experimentalIR: false,
    });
    expect(r.success).toBe(true);
    const body = funcBody(r.wat, "bench_array");
    // Legacy inlines its own store sequence rather than minting a helper, so
    // look for the i32 array type it constructs directly.
    expect(body).toMatch(/array\.new_default \d+/);
    expect(body).toContain("f64.convert_i32_s");
  });
});

interface GateCase {
  readonly name: string;
  readonly source: string;
  /** Expected: does the IR lane narrow this vector's elements to i32? */
  readonly narrows: boolean;
}

const GATE_CASES: readonly GateCase[] = [
  {
    name: "int-only push loop narrows",
    source: BENCH_SRC,
    narrows: true,
  },
  {
    name: "`arr[i] = <exact int32>` element store narrows",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 20; i++) arr.push(0);
      for (let i = 0; i < 20; i++) arr[i] = (i * 3) | 0;
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    narrows: true,
  },
  {
    name: "a bitwise-coerced accumulator is an exact int32",
    source: `export function f(): number {
      const arr: number[] = [];
      let s = 0;
      for (let i = 0; i < 40; i++) { s = (s + i) | 0; arr.push(s); }
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    narrows: true,
  },
  {
    name: "an aliased local is still the same closed group",
    source: `export function f(): number {
      const arr: number[] = [];
      const b = arr;
      for (let i = 0; i < 15; i++) b.push((i * 2) | 0);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    narrows: true,
  },
  {
    name: "reading an element inside a larger expression is a READ, not a store",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 8; i++) arr.push(i);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i] * 2;
      return t;
    }`,
    narrows: true,
  },
  {
    name: "a fractional push keeps f64",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 50; i++) arr.push(i + 0.5);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    narrows: false,
  },
  {
    name: "ONE fractional element store among int pushes keeps f64",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 50; i++) arr.push(i);
      arr[3] = 0.25;
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    narrows: false,
  },
  {
    name: "a literal past 2^31 keeps f64",
    source: `export function f(): number {
      const arr: number[] = [];
      arr.push(2147483648);
      arr.push(1);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    narrows: false,
  },
  {
    name: "`-0` keeps f64 (an i32 element would collapse it to +0)",
    source: `export function f(): number {
      const arr: number[] = [];
      arr.push(-0);
      arr.push(1);
      return 1 / arr[0] + arr[1];
    }`,
    narrows: false,
  },
  {
    name: "a compound element store keeps f64 (the stored value is not modelled)",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 20; i++) arr.push(i);
      for (let i = 0; i < 20; i++) arr[i] += 1;
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    narrows: false,
  },
  {
    name: "an element increment keeps f64",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 20; i++) arr.push(i);
      for (let i = 0; i < 20; i++) arr[i]++;
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    narrows: false,
  },
  {
    name: "escaping into a call keeps f64 (the callee could store anything)",
    source: `function sum(xs: number[]): number {
      let t = 0;
      for (let i = 0; i < xs.length; i++) t = t + xs[i];
      return t;
    }
    export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 30; i++) arr.push(i);
      return sum(arr);
    }`,
    narrows: false,
  },
  {
    name: "escaping via return keeps f64",
    source: `export function g(): number[] {
      const arr: number[] = [];
      for (let i = 0; i < 10; i++) arr.push(i);
      return arr;
    }
    export function f(): number {
      const xs = g();
      let t = 0;
      for (let i = 0; i < xs.length; i++) t = t + xs[i];
      return t;
    }`,
    narrows: false,
  },
  {
    name: "escaping into a closure keeps f64",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 10; i++) arr.push(i);
      const grab = (): number => arr[2];
      return grab() + arr[3];
    }`,
    narrows: false,
  },
  {
    name: "for-of iteration keeps f64 (the loop variable's slot is element-typed)",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 20; i++) arr.push(i);
      let t = 0;
      for (const x of arr) t = t + x;
      return t;
    }`,
    narrows: false,
  },
];

describe("#3734 — i32 array elements (narrowing gate)", () => {
  for (const c of GATE_CASES) {
    it(c.name, async () => {
      const r = await compile(c.source, { emitWat: true });
      expect(r.success).toBe(true);
      expect(hasI32ElementVector(r.wat)).toBe(c.narrows);
    });
  }
});

interface EquivCase {
  readonly name: string;
  readonly source: string;
  readonly fn: string;
  readonly args: readonly number[];
  readonly js: (...a: number[]) => number;
  /**
   * Both wasm lanes already read an out-of-bounds / hole element as 0 where JS
   * yields `undefined`. That divergence predates this change and is asserted
   * lane-to-lane only.
   */
  readonly lanesOnly?: boolean;
}

const EQUIV_CASES: readonly EquivCase[] = [
  {
    name: "array.ts benchmark",
    source: BENCH_SRC,
    fn: "bench_array",
    args: [],
    js: () => {
      const arr: number[] = [];
      for (let i = 0; i < 10000; i++) arr.push(i);
      let total = 0;
      for (let i = 0; i < arr.length; i++) total = total + arr[i]!;
      return total;
    },
  },
  {
    name: "negative integers",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 40; i++) arr.push((0 - i) | 0);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    fn: "f",
    args: [],
    js: () => {
      const arr: number[] = [];
      for (let i = 0; i < 40; i++) arr.push((0 - i) | 0);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i]!;
      return t;
    },
  },
  {
    name: "values that wrap past 2^31 via ToInt32",
    source: `export function f(): number {
      const arr: number[] = [];
      arr.push(2147483648 | 0);
      arr.push(3000000000 | 0);
      arr.push(4294967295 | 0);
      arr.push(7);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    fn: "f",
    args: [],
    js: () => {
      const arr: number[] = [];
      arr.push(2147483648 | 0);
      arr.push(3000000000 | 0);
      arr.push(4294967295 | 0);
      arr.push(7);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i]!;
      return t;
    },
  },
  {
    name: "un-narrowed fractional array still agrees",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 50; i++) arr.push(i + 0.5);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    fn: "f",
    args: [],
    js: () => {
      const arr: number[] = [];
      for (let i = 0; i < 50; i++) arr.push(i + 0.5);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i]!;
      return t;
    },
  },
  {
    name: "`-0` survives (the array is deliberately NOT narrowed)",
    source: `export function f(): number {
      const arr: number[] = [];
      arr.push(-0);
      arr.push(1);
      return 1 / arr[0] + arr[1];
    }`,
    fn: "f",
    args: [],
    js: () => {
      const arr: number[] = [];
      arr.push(-0);
      arr.push(1);
      return 1 / arr[0]! + arr[1]!;
    },
  },
  {
    name: "element store overwrites",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 20; i++) arr.push(0);
      for (let i = 0; i < 20; i++) arr[i] = (i * 3) | 0;
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    fn: "f",
    args: [],
    js: () => {
      const arr: number[] = [];
      for (let i = 0; i < 20; i++) arr.push(0);
      for (let i = 0; i < 20; i++) arr[i] = (i * 3) | 0;
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i]!;
      return t;
    },
  },
  {
    name: "growth past the initial capacity",
    source: `export function f(): number {
      const arr: number[] = [];
      for (let i = 0; i < 1000; i++) arr.push(i);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t + arr.length;
    }`,
    fn: "f",
    args: [],
    js: () => {
      const arr: number[] = [];
      for (let i = 0; i < 1000; i++) arr.push(i);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i]!;
      return t + arr.length;
    },
  },
  {
    name: "push in expression position returns the new length",
    source: `export function f(): number {
      const arr: number[] = [];
      let last = 0;
      for (let i = 0; i < 12; i++) last = arr.push(i);
      return last + arr.length + arr[11];
    }`,
    fn: "f",
    args: [],
    js: () => {
      const arr: number[] = [];
      let last = 0;
      for (let i = 0; i < 12; i++) last = arr.push(i);
      return last + arr.length + arr[11]!;
    },
  },
  {
    name: "aliased writes are visible through the original binding",
    source: `export function f(): number {
      const arr: number[] = [];
      const b = arr;
      for (let i = 0; i < 15; i++) b.push((i * 2) | 0);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t;
    }`,
    fn: "f",
    args: [],
    js: () => {
      const arr: number[] = [];
      const b = arr;
      for (let i = 0; i < 15; i++) b.push((i * 2) | 0);
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i]!;
      return t;
    },
  },
  {
    name: "a store far past the length grows and zero-fills identically in both lanes",
    source: `export function f(): number {
      const arr: number[] = [];
      arr.push(1);
      arr[10] = 5;
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = t + arr[i];
      return t + arr.length;
    }`,
    fn: "f",
    args: [],
    lanesOnly: true,
    js: () => 0,
  },
];

describe("#3734 — i32 array elements (IR == legacy == JS)", () => {
  for (const c of EQUIV_CASES) {
    it(c.name, async () => {
      const [legacy, ir] = await Promise.all([instantiate(c.source, false), instantiate(c.source, true)]);
      const legacyValue = (legacy[c.fn] as (...a: number[]) => number)(...c.args);
      const irValue = (ir[c.fn] as (...a: number[]) => number)(...c.args);
      expect(Object.is(irValue, legacyValue), `IR ${irValue} vs legacy ${legacyValue}`).toBe(true);
      if (c.lanesOnly) return;
      const expected = c.js(...c.args);
      expect(Object.is(legacyValue, expected), `legacy ${legacyValue} vs JS ${expected}`).toBe(true);
      expect(Object.is(irValue, expected), `IR ${irValue} vs JS ${expected}`).toBe(true);
    });
  }

  // An UNPROVEN index can read out of bounds, where JS yields `undefined` —
  // NaN in the numeric context the IR keeps a `number[]` read in. An i32
  // element vector has no NaN, which is exactly why the widen happens INSIDE
  // the bounds-check arms rather than around the whole `if`. Compare the
  // narrowed lane against the SAME source compiled with a fractional store
  // (which suppresses the narrowing), so the assertion is "narrowing did not
  // change the out-of-bounds answer" rather than a restatement of it.
  it("an out-of-bounds read of a NARROWED array still yields NaN, exactly as the f64 layout does", async () => {
    const narrowed = `export function f(n: number): number {
      const arr: number[] = [];
      for (let i = 0; i < 5; i++) arr.push(i);
      const v = arr[n];
      return v === v ? 1 : 0;
    }`;
    const notNarrowed = `export function f(n: number): number {
      const arr: number[] = [];
      for (let i = 0; i < 5; i++) arr.push(i);
      arr[0] = 0.5;
      const v = arr[n];
      return v === v ? 1 : 0;
    }`;
    const [a, b] = await Promise.all([compile(narrowed, { emitWat: true }), compile(notNarrowed, { emitWat: true })]);
    expect(a.success && b.success).toBe(true);
    expect(hasI32ElementVector(a.wat)).toBe(true);
    expect(hasI32ElementVector(b.wat)).toBe(false);

    const [irNarrow, irWide] = await Promise.all([instantiate(narrowed, true), instantiate(notNarrowed, true)]);
    for (const n of [-1, 0, 4, 5, 100]) {
      const got = (irNarrow.f as (n: number) => number)(n);
      const want = (irWide.f as (n: number) => number)(n);
      expect(got, `n=${n}: narrowed ${got} vs f64 ${want}`).toBe(want);
    }
  });
});
