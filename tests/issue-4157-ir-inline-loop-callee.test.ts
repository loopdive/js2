// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157, rule 5) The loop-leaf rule must NOT inline a callee that carries a loop of
 * its own — rule 5 in `src/codegen/ir-inline.ts`.
 *
 * The shape below is the landing-page WASI `fib` benchmark reduced to its
 * essentials: an exported kernel that is a leaf, small, and one `for` loop,
 * called from inside a driver's own loop. Every other loop-leaf precondition
 * holds, so before rule 5 the kernel was inlined into the driver at each site.
 * Cranelift then had to keep the driver's live f64 state in stack slots
 * (caller-saved across the driver's calls) and reloaded them inside the
 * kernel's 20M-iteration inner loop: the lane went 1.50x V8 -> 0.76x.
 *
 * Pinned structurally, by the `call` surviving in the driver, rather than by a
 * timing: a wall-clock assertion for a register-allocation effect is not
 * reproducible across the machines CI runs on (the same two binaries rank in
 * opposite orders on some hosts), whereas "the kernel is still a call" is
 * exactly the property rule 5 is there to keep.
 */
import { describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { parseInlineOptions } from "../src/codegen/ir-inline.js";

const FLAG = "JS2WASM_IR_INLINE";

/** The landing `fib` kernel plus a driver that calls it from its own loop. */
const SOURCE = `
export function run(n: number): number {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const next = (a + b) | 0;
    a = b;
    b = next;
  }
  return a | 0;
}

export function drive(n: number): number {
  let sink = 0;
  for (let m = 0; m < 3; m++) {
    sink = (sink + run(n)) | 0;
  }
  return sink | 0;
}
`;

/**
 * The control: the same driver, but the kernel is loop-FREE. Two call sites so
 * the single-caller rule cannot claim it — the loop-leaf rule is then the only
 * one that can reach the site, which is what makes the pair a clean isolation.
 */
const LEAF_SOURCE = `
function kernel(a: number, b: number): number { return a * 3 + b - 1; }

export function drive(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) acc = kernel(acc, i) + kernel(i, acc);
  return acc;
}
`;

async function build(source: string): Promise<Uint8Array> {
  const r = await compile(source, {
    fileName: "loop-callee-probe.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    optimize: 0,
  });
  if (!r.binary?.length) throw new Error(`compile failed: ${JSON.stringify((r.errors ?? []).slice(0, 2))}`);
  return r.binary;
}

async function instantiate(source: string): Promise<WebAssembly.Exports> {
  const binary = await build(source);
  const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  return exports;
}

describe("#4157 rule 5 — a loop-carrying callee is not a loop-leaf", () => {
  // Isolating the loop-leaf rule: the same rule set MINUS `loop`. Whatever the
  // other three rules do lands in both builds, so a difference between them is
  // the loop-leaf rule and nothing else. (Byte-identity against `=0` would not
  // work here — this probe compiles at `optimize: 0`, where the module's helper
  // inlines survive instead of being normalised away by `wasm-opt`.)
  const WITHOUT_LOOP_RULE = "adapters,single,specialise";

  test("the shipped default leaves `run` a call inside the driver's loop", async () => {
    delete process.env[FLAG];
    const shipped = await build(SOURCE);
    process.env[FLAG] = WITHOUT_LOOP_RULE;
    const withoutLoopRule = await build(SOURCE);
    delete process.env[FLAG];
    expect(
      Buffer.from(shipped).equals(Buffer.from(withoutLoopRule)),
      "the loop-leaf rule must find nothing to do in a driver whose only leaf carries a loop",
    ).toBe(true);
  });

  test("a loop-FREE leaf at a hot site is still inlined", async () => {
    delete process.env[FLAG];
    const shipped = await build(LEAF_SOURCE);
    process.env[FLAG] = WITHOUT_LOOP_RULE;
    const withoutLoopRule = await build(LEAF_SOURCE);
    delete process.env[FLAG];
    expect(
      Buffer.from(shipped).equals(Buffer.from(withoutLoopRule)),
      "rule 5 must narrow the loop-leaf rule, not retire it",
    ).toBe(false);
  });

  test("`loop` is still one of the rules the `on` preset selects", () => {
    expect(parseInlineOptions(undefined).loop).toBe(true);
    expect(parseInlineOptions("on").loop).toBe(true);
    expect(parseInlineOptions("0").loop).toBe(false);
  });

  test("both shapes still compute the right answer at the default", async () => {
    delete process.env[FLAG];
    const exports = await instantiate(SOURCE);
    // fib(30) = 832040, summed over three driver iterations.
    expect((exports.run as (n: number) => number)(30)).toBe(832_040);
    expect((exports.drive as (n: number) => number)(30)).toBe(2_496_120);

    const leaf = await instantiate(LEAF_SOURCE);
    process.env[FLAG] = "0";
    const leafOff = await instantiate(LEAF_SOURCE);
    delete process.env[FLAG];
    expect((leaf.drive as (n: number) => number)(64)).toBe((leafOff.drive as (n: number) => number)(64));
  });
});
