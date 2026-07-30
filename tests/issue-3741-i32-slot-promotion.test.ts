// #3741 — native-i32 slot storage for provably-int32 mutable locals on the IR path.
//
// Two things are asserted here:
//
//  1. SHAPE — the landing-page `loop.ts` benchmark body
//     (`let s = 0; for (let i = 0; i < 1000000; i++) s = (s + i) | 0;`) must
//     compile through the IR front-end to the same native-i32 loop legacy
//     produces: `i32.add` / `i32.lt_s`, with NO ToInt32 bit-manipulation
//     (`i64.reinterpret_f64` & friends) and NO f64 arithmetic in the loop.
//     Before #3741 the IR path emitted an f64 add plus a ~25-instruction
//     JS-ToInt32 sequence per iteration and ran ~16x slower than legacy.
//
//  2. EQUIVALENCE — IR, legacy and real JavaScript must agree on every value,
//     including the wrap / overflow / negative-zero / uint32 edges that make
//     i32 promotion unsound when applied too eagerly (#1236, #2789, #1120's
//     `>>>` follow-up). A wrong arithmetic answer is the failure mode this
//     optimisation must never have.

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

const BENCH_SRC = `
export function run(): number {
  let s = 0;
  for (let i = 0; i < 1000000; i++) s = (s + i) | 0;
  return s;
}
`;

describe("#3741 — i32 slot promotion (shape)", () => {
  it("the loop.ts benchmark compiles to a native-i32 loop with no ToInt32 and no f64 arithmetic", async () => {
    const r = await compile(BENCH_SRC, { emitWat: true });
    expect(r.success).toBe(true);
    const body = funcBody(r.wat, "run");

    // Both locals are stored as i32 (the whole point — a loop-carried
    // f64<->i32 round trip costs as much as the ToInt32 it would replace).
    expect(body).toMatch(/\(local \$\$slot_s i32\)/);
    expect(body).toMatch(/\(local \$\$slot_i i32\)/);

    // Native i32 loop ops, exactly like legacy.
    expect(body).toContain("i32.add");
    expect(body).toContain("i32.lt_s");

    // No JS-ToInt32 bit manipulation (#3739's i64 fast path) anywhere.
    for (const op of ["i64.reinterpret_f64", "i64.shr_u", "i32.wrap_i64", "i32.trunc_sat_f64_s"]) {
      expect(body, `unexpected ${op} in the promoted loop`).not.toContain(op);
    }

    // No f64 arithmetic at all: the only f64 op left is the single
    // `f64.convert_i32_s` that widens the result for the `number` return.
    for (const op of ["f64.add", "f64.sub", "f64.mul", "f64.lt", "f64.const"]) {
      expect(body, `unexpected ${op} in the promoted loop`).not.toContain(op);
    }
    expect(body).toContain("f64.convert_i32_s");
  });

  it("an indexed read loop does not pay a convert/truncate round trip for the promoted counter", async () => {
    const r = await compile(
      `export function total(): number {
         const arr: number[] = [1, 2, 3];
         let t = 0;
         for (let i = 0; i < arr.length; i++) t = t + arr[i];
         return t;
       }`,
      { emitWat: true },
    );
    expect(r.success).toBe(true);
    const body = funcBody(r.wat, "total");
    // `arr[i]` must consume the i32 slot directly — the promotion widens on
    // read, and without the `trunc_sat(convert(x)) === x` cancellation in
    // `IrFunctionBuilder.emitUnary` this loop would be SLOWER than before.
    expect(body).not.toContain("i32.trunc_sat_f64_s");
    expect(body).toContain("array.get");
  });

  // Eligibility is keyed on the DECLARATION NODE, not on identifier text. Two
  // sibling `for (let i = …)` loops are two distinct bindings that happen to
  // share a name; a name-keyed set has to reject BOTH to stay safe, which
  // silently disabled the promotion on one of the most common shapes in real
  // code. Alpha-renaming the second counter must make no difference at all.
  it("two sibling loops that both declare `i` promote BOTH counters", async () => {
    const sameName = `export function run(): number {
      let t = 0;
      for (let i = 0; i < 100; i++) t = (t + i) | 0;
      for (let i = 0; i < 100; i++) t = (t + i) | 0;
      return t;
    }`;
    const renamed = `export function run(): number {
      let t = 0;
      for (let i = 0; i < 100; i++) t = (t + i) | 0;
      for (let j = 0; j < 100; j++) t = (t + j) | 0;
      return t;
    }`;
    const [a, b] = await Promise.all([compile(sameName, { emitWat: true }), compile(renamed, { emitWat: true })]);
    expect(a.success && b.success).toBe(true);
    const bodyA = funcBody(a.wat, "run");
    const bodyB = funcBody(b.wat, "run");

    // Three SOURCE-level i32 slots either way: the accumulator plus both
    // counters. (#3786) `__ru_*` slots are excluded — the reduction unroller
    // adds its own partial accumulators to these loops, and this assertion is
    // about which of the PROGRAM's bindings got promoted, not about the total
    // local count, which any later optimization is free to change.
    const sourceSlots = (w: string) =>
      [...w.matchAll(/\(local \$\$slot_(\w+) i32\)/g)].filter((m) => !m[1].startsWith("__ru_"));
    expect(sourceSlots(bodyA)).toHaveLength(3);
    expect(bodyA).not.toMatch(/\(local \$\$slot_\w+ f64\)/);
    // Same instruction mix as the alpha-renamed program — the ONLY difference
    // between the two sources is the second counter's name.
    const mix = (w: string): string =>
      [/i32\.add/g, /i32\.lt_s/g, /f64\.add/g, /f64\.lt/g].map((re) => (w.match(re) ?? []).length).join("/");
    expect(mix(bodyA)).toBe(mix(bodyB));
    expect(bodyA).not.toContain("f64.add");
  });

  it("keeps Fibonacci loop-carried state in i32 through an immutable next value", async () => {
    const r = await compile(
      `/** @param {number} n @returns {number} */
       export function run(n) {
         let a = 0;
         let b = 1;
         for (let i = 0; i < n; i++) {
           const next = (a + b) | 0;
           a = b;
           b = next;
         }
         return a | 0;
       }`,
      { emitWat: true, fileName: "fib.js", target: "wasi", nativeStrings: true },
    );
    expect(r.success).toBe(true);
    expect(r.irCompiledFuncs).toContain("run");
    const body = funcBody(r.wat, "run");

    expect(body).toMatch(/\(local \$\$slot_a i32\)/);
    expect(body).toMatch(/\(local \$\$slot_b i32\)/);
    expect(body).toContain("i32.add");
    expect(body).not.toContain("i32.trunc_sat_f64_s");
  });
});

interface Case {
  readonly name: string;
  readonly source: string;
  readonly fn: string;
  readonly args: readonly number[];
  /** Reference implementation, evaluated in real JS. */
  readonly js: (...a: number[]) => number;
}

const CASES: readonly Case[] = [
  {
    name: "loop.ts benchmark accumulator (wraps past 2^31)",
    source: BENCH_SRC,
    fn: "run",
    args: [],
    js: () => {
      let s = 0;
      for (let i = 0; i < 1000000; i++) s = (s + i) | 0;
      return s;
    },
  },
  {
    name: "accumulator that wraps NEGATIVE",
    source: `export function f(): number {
      let s = 0;
      for (let i = 0; i < 200; i++) s = (s - 30000000) | 0;
      return s;
    }`,
    fn: "f",
    args: [],
    js: () => {
      let s = 0;
      for (let i = 0; i < 200; i++) s = (s - 30000000) | 0;
      return s;
    },
  },
  {
    name: "iterative fibonacci — the #1120 motivating shape",
    source: `export function fib(n: number): number {
      let a = 0;
      let b = 1;
      for (let i = 0; i < n; i++) {
        const next = (a + b) | 0;
        a = b;
        b = next;
      }
      return a;
    }`,
    fn: "fib",
    args: [90],
    js: (n) => {
      let a = 0;
      let b = 1;
      for (let i = 0; i < n; i++) {
        const next = (a + b) | 0;
        a = b;
        b = next;
      }
      return a;
    },
  },
  {
    name: "FNV-style mixer — xor + shift compounds",
    source: `export function h(n: number): number {
      let x = 2166136261 | 0;
      for (let i = 0; i < n; i++) {
        x = x ^ i;
        x = (x << 5) | 0;
        x = x ^ (x >> 7);
      }
      return x;
    }`,
    fn: "h",
    args: [50],
    js: (n) => {
      let x = 2166136261 | 0;
      for (let i = 0; i < n; i++) {
        x = x ^ i;
        x = (x << 5) | 0;
        x = x ^ (x >> 7);
      }
      return x;
    },
  },
  {
    name: "bitwise compound assignments",
    source: `export function g(n: number): number {
      let x = 0;
      for (let i = 0; i < n; i++) {
        x |= i;
        x ^= 0x5a5a;
        x &= 0xffff;
        x <<= 1;
        x >>= 1;
      }
      return x;
    }`,
    fn: "g",
    args: [17],
    js: (n) => {
      let x = 0;
      for (let i = 0; i < n; i++) {
        x |= i;
        x ^= 0x5a5a;
        x &= 0xffff;
        x <<= 1;
        x >>= 1;
      }
      return x;
    },
  },
  {
    name: "`>>>` is NOT promotable — its uint32 value exceeds int32",
    source: `export function u(): number {
      let x = 0;
      x = (-1 >>> 0) | 0;
      let y = 0;
      y = -1 >>> 0;
      return y - x;
    }`,
    fn: "u",
    args: [],
    js: () => {
      let x = 0;
      x = (-1 >>> 0) | 0;
      let y = 0;
      y = -1 >>> 0;
      return y - x;
    },
  },
  {
    name: "accumulator that must STAY f64 (`+=` — the #1236 saturation trap)",
    source: `export function s(n: number): number {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += i;
      return acc;
    }`,
    fn: "s",
    args: [1000000],
    js: (n) => {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += i;
      return acc;
    },
  },
  {
    name: "promoted counter read into f64 arithmetic and back",
    source: `export function m(n: number): number {
      let total = 0;
      for (let i = 0; i < n; i++) total = total + i * 0.5;
      return total;
    }`,
    fn: "m",
    args: [11],
    js: (n) => {
      let total = 0;
      for (let i = 0; i < n; i++) total = total + i * 0.5;
      return total;
    },
  },
  {
    name: "counter stepping by a literal (`i += 3`)",
    source: `export function st(n: number): number {
      let hits = 0;
      for (let i = 0; i < n; i += 3) hits = (hits + i) | 0;
      return hits;
    }`,
    fn: "st",
    args: [40],
    js: (n) => {
      let hits = 0;
      for (let i = 0; i < n; i += 3) hits = (hits + i) | 0;
      return hits;
    },
  },
  {
    name: "descending counter (`i--`)",
    source: `export function d(n: number): number {
      let acc = 0;
      for (let i = n; i > 0; i--) acc = (acc + i) | 0;
      return acc;
    }`,
    fn: "d",
    args: [25],
    js: (n) => {
      let acc = 0;
      for (let i = n; i > 0; i--) acc = (acc + i) | 0;
      return acc;
    },
  },
  {
    name: "promoted counter as an array index",
    source: `export function idx(): number {
      const arr: number[] = [10, 20, 30, 40];
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = (t + arr[i]) | 0;
      return t;
    }`,
    fn: "idx",
    args: [],
    js: () => {
      const arr = [10, 20, 30, 40];
      let t = 0;
      for (let i = 0; i < arr.length; i++) t = (t + arr[i]) | 0;
      return t;
    },
  },
  {
    name: "promoted counter as an element STORE index",
    source: `export function store(): number {
      const arr: number[] = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) arr[i] = (i * 7) | 0;
      let t = 0;
      for (let j = 0; j < 4; j++) t = (t + arr[j]) | 0;
      return t;
    }`,
    fn: "store",
    args: [],
    js: () => {
      const arr = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) arr[i] = (i * 7) | 0;
      let t = 0;
      for (let j = 0; j < 4; j++) t = (t + arr[j]) | 0;
      return t;
    },
  },
  {
    name: "early return from inside the loop reads the promoted local",
    source: `export function er(n: number): number {
      let s = 0;
      for (let i = 0; i < 1000; i++) {
        s = (s + i) | 0;
        if (i === n) return s;
      }
      return -1;
    }`,
    fn: "er",
    args: [12],
    js: (n) => {
      let s = 0;
      for (let i = 0; i < 1000; i++) {
        s = (s + i) | 0;
        if (i === n) return s;
      }
      return -1;
    },
  },
  {
    name: "negative-zero is not observable through a promoted local",
    source: `export function nz(): number {
      let z = 0;
      z = (z - 0) | 0;
      return 1 / (z === 0 ? z : 1);
    }`,
    fn: "nz",
    args: [],
    js: () => {
      let z = 0;
      z = (z - 0) | 0;
      return 1 / (z === 0 ? z : 1);
    },
  },
  {
    // The #3741 x #3758 seam. `s` is slot-promoted (every write is `| 0`
    // wrapped); `k` is NOT (a `const`, so it never gets a slot) but IS
    // i32-pure, so only #3758 can fuse it. `isFusedI32Lowerable` takes the
    // union of both proofs — without that, this mixed subtree would satisfy
    // neither and fall back to the full ToInt32 dance, i.e. #3741 would have
    // REGRESSED an expression #3758 already handled.
    name: "mixed promoted-slot + i32-pure-but-not-promoted operands",
    source: `export function mix(n: number): number {
      const k = 12345 | 0;
      let s = 0;
      for (let i = 0; i < n; i++) s = (s + i + k) | 0;
      return s;
    }`,
    fn: "mix",
    args: [500],
    js: (n) => {
      const k = 12345 | 0;
      let s = 0;
      for (let i = 0; i < n; i++) s = (s + i + k) | 0;
      return s;
    },
  },
  {
    // #3758 owns `*` (guarded by legacy's |operand| < 2^21 proof); #3741 does
    // not add `i32.mul`. A promoted local flowing into a guarded multiply must
    // still agree with JS.
    name: "guarded i32 multiply over a promoted local (#3758's arm)",
    source: `export function mul(n: number): number {
      let h = 0;
      for (let i = 0; i < n; i++) h = (h * 31 + i) | 0;
      return h;
    }`,
    fn: "mul",
    args: [200],
    js: (n) => {
      let h = 0;
      for (let i = 0; i < n; i++) h = (h * 31 + i) | 0;
      return h;
    },
  },
  {
    // Large-operand multiply: NEITHER path may use native i32.mul here (JS
    // computes the product in f64 first and rounds above 2^53). Guards the
    // #1179-followup / #3758 `isI32MulSafe` bound from either side.
    name: "unguarded large multiply stays f64-faithful",
    source: `export function bigmul(): number {
      let a = 0;
      let b = 0;
      let r = 0;
      a = 2147483647 | 0;
      b = 2147483647 | 0;
      r = (a * b) | 0;
      return r;
    }`,
    fn: "bigmul",
    args: [],
    js: () => {
      let a = 0;
      let b = 0;
      let r = 0;
      a = 2147483647 | 0;
      b = 2147483647 | 0;
      r = (a * b) | 0;
      return r;
    },
  },
  {
    // The name-keying regression, end to end: two sibling loops declaring the
    // same counter name, both promoted, plus an indexed read of a vec built by
    // the first loop. This is the `array.ts` benchmark shape.
    name: "two sibling loops that both declare `i` (array.ts shape)",
    source: `export function run(): number {
      const arr: number[] = [];
      for (let i = 0; i < 500; i++) arr.push(i);
      let total = 0;
      for (let i = 0; i < arr.length; i++) total = (total + arr[i]) | 0;
      return total;
    }`,
    fn: "run",
    args: [],
    js: () => {
      const arr: number[] = [];
      for (let i = 0; i < 500; i++) arr.push(i);
      let total = 0;
      for (let i = 0; i < arr.length; i++) total = (total + arr[i]!) | 0;
      return total;
    },
  },
  {
    // Genuine shadowing: the inner `i` is a DIFFERENT binding whose scope is
    // nested inside the outer one. The planner drops both (distinguishing them
    // needs use-site scope resolution the planner deliberately does not do),
    // but the ANSWER must still be right — that is what this asserts.
    name: "nested loops shadowing the counter name",
    source: `export function sh(): number {
      let t = 0;
      for (let i = 0; i < 7; i++) {
        for (let i = 0; i < 5; i++) t = (t + i) | 0;
        t = (t + 100) | 0;
      }
      return t;
    }`,
    fn: "sh",
    args: [],
    js: () => {
      let t = 0;
      for (let i = 0; i < 7; i++) {
        for (let i = 0; i < 5; i++) t = (t + i) | 0;
        t = (t + 100) | 0;
      }
      return t;
    },
  },
  {
    // A loop counter shadowing an OUTER `let i` that is itself i32-coerced.
    // The two bindings' scopes nest, so neither is promoted — and the outer
    // `i` must still read back its own value after the loop.
    name: "loop counter shadows an outer i32-coerced `let i`",
    source: `export function outer(): number {
      let i = 5 | 0;
      let t = 0;
      for (let i = 0; i < 10; i++) t = (t + i) | 0;
      i = (i + 1) | 0;
      return (t * 1000 + i) | 0;
    }`,
    fn: "outer",
    args: [],
    js: () => {
      let i = 5 | 0;
      let t = 0;
      for (let i = 0; i < 10; i++) t = (t + i) | 0;
      i = (i + 1) | 0;
      return (t * 1000 + i) | 0;
    },
  },
  {
    // Sibling loops where only ONE counter is promotable (the second is
    // written with a non-i32-safe value). Keying on the declaration means the
    // first must still promote; a name-keyed set would drop both.
    name: "sibling loops, only the first counter promotable",
    source: `export function part(n: number): number {
      let t = 0;
      for (let i = 0; i < 10; i++) t = (t + i) | 0;
      for (let i = n; i < 10; i++) t = (t + 1) | 0;
      return t;
    }`,
    fn: "part",
    args: [3],
    js: (n) => {
      let t = 0;
      for (let i = 0; i < 10; i++) t = (t + i) | 0;
      for (let i = n; i < 10; i++) t = (t + 1) | 0;
      return t;
    },
  },
  {
    name: "comparison of two promoted locals",
    source: `export function cmp(n: number): number {
      let a = 0;
      let hits = 0;
      for (let i = 0; i < n; i++) {
        a = (a + 3) | 0;
        if (a > i) hits = (hits + 1) | 0;
      }
      return hits;
    }`,
    fn: "cmp",
    args: [30],
    js: (n) => {
      let a = 0;
      let hits = 0;
      for (let i = 0; i < n; i++) {
        a = (a + 3) | 0;
        if (a > i) hits = (hits + 1) | 0;
      }
      return hits;
    },
  },
];

// The planner's eligibility check is strictly MORE conservative than legacy's
// for-counter path, and here that matters for correctness, not just coverage.
// Legacy's `detectI32LoopVar` promotes a counter on the loop HEAD's shape alone
// and never inspects the body, so a body that assigns a non-integer to the
// counter (`i = i + 0.5`) silently truncates and changes the iteration count.
// #3741's planner rejects the binding instead, because `i = i + n` is not a
// write shape `lowerAsI32` can emit exactly.
//
// Asserted IR-vs-JS only: legacy is KNOWN-WRONG here (returns 55; the spec
// value is 52) — a pre-existing `detectI32LoopVar` bug, independent of #3741.
// Reproduce with `experimentalIR: false`. Worth its own issue; not fixed here.
describe("#3741 — planner is stricter than legacy's counter promotion", () => {
  it("a counter mutated to a non-integer in the loop body is NOT promoted", async () => {
    const source = `export function part(n: number): number {
      let t = 0;
      for (let i = 0; i < 10; i++) { i = i + n; t = (t + 1) | 0; }
      return t;
    }`;
    const expected = ((n: number): number => {
      let t = 0;
      for (let i = 0; i < 10; i++) {
        i = i + n;
        t = (t + 1) | 0;
      }
      return t;
    })(0.5);
    const ir = await instantiate(source, true);
    expect((ir.part as (n: number) => number)(0.5), "IR vs JS").toBe(expected);
  });
});

describe("#3741 — i32 slot promotion (IR == legacy == JS)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const expected = c.js(...c.args);
      const [legacy, ir] = await Promise.all([instantiate(c.source, false), instantiate(c.source, true)]);
      const legacyValue = (legacy[c.fn] as (...a: number[]) => number)(...c.args);
      const irValue = (ir[c.fn] as (...a: number[]) => number)(...c.args);
      expect(legacyValue, "legacy vs JS").toBe(expected);
      expect(irValue, "IR vs JS").toBe(expected);
    });
  }
});
