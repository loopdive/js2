// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4185 follow-up, for #4157) Reuse of the standalone RegExp engine's per-call
 * scratch: the `.test` capture-slot array and the `__regex_run` backtrack frames.
 *
 * Two independent things have to hold, and only one of them is about answers.
 *
 * 1. ANSWERS. Reuse is sound only because neither object is reachable from user
 *    code. The genuinely observable piece of state on the `.test` path is
 *    `lastIndex`, so it is read after every `g`/`y` call, and captures are read
 *    back through an `.exec` on a receiver that a pooled `.test` also used. The
 *    expected value is the one native Node produces for the identical program
 *    (`408058100` for 100 iterations) — an ON-vs-OFF comparison alone would
 *    happily agree on a wrong answer.
 *
 * 2. MECHANISM. Parity would also pass if the pool silently never engaged —
 *    which is exactly what the first draft of this fixture did: its `.test`
 *    calls took the static expression path rather than the carrier helper, and
 *    the capture-array count did not move at all. So the counts are asserted
 *    directly through the #3921/#4185 allocation census, whose per-function
 *    counters attribute each allocation to the helper that emitted it.
 *
 * The isolation half of assertion 2 is the load-bearing one: `__regex_run` also
 * allocates a per-push capture SNAPSHOT for patterns with `nSlots > 2`, which
 * this change deliberately leaves alone. `caps` (three groups) is in the
 * fixture precisely so that stream keeps allocating and proves the assertion is
 * measuring something.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/**
 * `carrierTest` erases the receiver's type, which is what routes `.test`
 * through `__regexp_test_carrier` rather than the static expression path.
 * `alt` backtracks (alternation under `+`) so the VM pushes SPLIT frames, and
 * `alt` (no groups, 2 slots) alternates with `caps` (three groups, 8 slots) so
 * both arms of the pool's "is the pooled array long enough" test are taken.
 */
const SOURCE = `
var alt = new RegExp("^(?:aa|ab|b)+$");
var caps = new RegExp("(a+)(b+)(c*)");
var glob = new RegExp("ab", "g");
var sticky = new RegExp("ab", "y");

function carrierTest(re: any, s: string): boolean { return re.test(s); }

export function run(n: number): number {
  var c = 0;
  for (var i = 0; i < n; i++) {
    if (carrierTest(alt, "aabab")) c += 1;
    if (carrierTest(alt, "aabaz")) c += 2;
    if (carrierTest(caps, "xaaabbc")) c += 4;
    if (carrierTest(caps, "xxx")) c += 8;
    glob.lastIndex = 0;
    if (carrierTest(glob, "zzabzzab")) c += 16;
    c += glob.lastIndex * 100;
    if (carrierTest(glob, "zzabzzab")) c += 32;
    c += glob.lastIndex * 10000;
    glob.lastIndex = 0;
    sticky.lastIndex = 2;
    if (carrierTest(sticky, "zzabzzab")) c += 64;
    c += sticky.lastIndex * 1000000;
    sticky.lastIndex = 0;
    var m = caps.exec("xaaabbc");
    if (m !== null) c += m[1].length * 7 + m[2].length * 13 + m[3].length * 17;
  }
  return c;
}
`;

/** What native Node returns for `run(100)` on the identical program. */
const NODE_ANSWER = 408058100;

const ITERATIONS = 100;

async function build(pooled: boolean, census: boolean): Promise<Uint8Array> {
  const saved = {
    caps: process.env.JS2WASM_REGEXP_TEST_CAPS_POOL,
    frame: process.env.JS2WASM_REGEXP_FRAME_REUSE,
    census: process.env.JS2WASM_ALLOC_CENSUS,
    byFunc: process.env.JS2WASM_ALLOC_CENSUS_BY_FUNC,
  };
  const set = (key: string, value: string | undefined): void => {
    // `= undefined` coerces to the STRING "undefined", which reads as "set".
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set("JS2WASM_REGEXP_TEST_CAPS_POOL", pooled ? undefined : "0");
  set("JS2WASM_REGEXP_FRAME_REUSE", pooled ? undefined : "0");
  set("JS2WASM_ALLOC_CENSUS", census ? "1" : undefined);
  set("JS2WASM_ALLOC_CENSUS_BY_FUNC", census ? "1" : undefined);
  try {
    const result = await compile(SOURCE, { fileName: "issue-4185-regex-scratch-reuse.ts", target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    return result.binary;
  } finally {
    set("JS2WASM_REGEXP_TEST_CAPS_POOL", saved.caps);
    set("JS2WASM_REGEXP_FRAME_REUSE", saved.frame);
    set("JS2WASM_ALLOC_CENSUS", saved.census);
    set("JS2WASM_ALLOC_CENSUS_BY_FUNC", saved.byFunc);
  }
}

/**
 * Run the fixture twice and report the answer plus the allocation delta of the
 * SECOND run — the first warms every pool, so a steady-state delta of zero is
 * the property worth pinning.
 */
async function steadyState(pooled: boolean): Promise<{ answer: number; allocs: Map<string, number> }> {
  const { instance } = await WebAssembly.instantiate(await build(pooled, true), {});
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  const counters = Object.entries(exports).filter(([name]) => name.startsWith("__alloc_count_"));
  const read = (): Map<string, number> =>
    new Map(counters.map(([name, g]) => [name, (g as WebAssembly.Global).value as number]));
  const run = exports.run as (n: number) => number;
  const answer = run(ITERATIONS);
  const before = read();
  // A second identical batch must produce the same total again — a pool that
  // leaked state between calls would drift here.
  expect(run(ITERATIONS)).toBe(answer);
  const allocs = new Map<string, number>();
  for (const [name, value] of read()) {
    const delta = value - (before.get(name) ?? 0);
    if (delta > 0) allocs.set(name.replace("__alloc_count_", ""), delta);
  }
  return { answer, allocs };
}

const sumMatching = (allocs: Map<string, number>, ...needles: string[]): number => {
  let total = 0;
  for (const [name, count] of allocs) if (needles.every((n) => name.includes(n))) total += count;
  return total;
};

describe("#4185 follow-up — RegExp `.test` scratch and backtrack-frame reuse", () => {
  it("agrees with native Node, with the reuse flags on and off", async () => {
    const on = await steadyState(true);
    const off = await steadyState(false);
    expect(on.answer).toBe(NODE_ANSWER);
    expect(off.answer).toBe(NODE_ANSWER);
  }, 180_000);

  it("stops allocating in the `.test` helper and the backtrack VM, and only there", async () => {
    const on = await steadyState(true);
    const off = await steadyState(false);

    // The two streams this change targets: gone, not merely reduced.
    expect(sumMatching(off.allocs, "__in____regexp_test_carrier")).toBeGreaterThan(0);
    expect(sumMatching(on.allocs, "__in____regexp_test_carrier")).toBe(0);
    expect(sumMatching(off.allocs, "ReFrame", "__in____regex_run")).toBeGreaterThan(0);
    expect(sumMatching(on.allocs, "ReFrame", "__in____regex_run")).toBe(0);

    // Isolation: everything else — including `__regex_run`'s per-push capture
    // snapshot, which is deliberately NOT pooled — allocates exactly as before.
    for (const [name, count] of off.allocs) {
      if (name.includes("__in____regexp_test_carrier")) continue;
      if (name.includes("ReFrame") && name.includes("__in____regex_run")) continue;
      expect(on.allocs.get(name), `${name} changed`).toBe(count);
    }
    expect(sumMatching(on.allocs, "__in____regex_run")).toBeGreaterThan(0);
  }, 180_000);

  it("emits the pre-change instruction sequence when both flags are off", async () => {
    const a = await build(false, false);
    const b = await build(false, false);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(await build(true, false)).equals(Buffer.from(a))).toBe(false);
  }, 180_000);
});
