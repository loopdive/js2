// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Constant number boxing hoisted to module-level globals.
 *
 * Two independent things have to hold, and the second is the one a naive test
 * skips.
 *
 * 1. ANSWERS. Hoisting collapses two boxes of the same constant into ONE
 *    reference, so every consumer that could observe reference identity has to
 *    still agree with JavaScript. The expected value is what native Node
 *    produces for the identical program — an ON-vs-OFF comparison alone would
 *    happily agree on a wrong answer. `NaN` (the one value where shared
 *    identity is the WRONG answer for `===`) is deliberately excluded by the
 *    pass, and both regimes are exercised here anyway.
 *
 * 2. MECHANISM. Parity would also pass if the pass silently never engaged —
 *    which is exactly what the first draft of this fixture did: with no
 *    top-level state the module has no `__module_init` to seed from, the pass
 *    bails, and ON and OFF produced byte-identical binaries. So the binaries
 *    are asserted to DIFFER, and the boxed-number allocation stream is asserted
 *    to go to zero through the #3921 allocation census.
 */
import { describe, expect, it } from "vitest";

import { hoistConstantBoxedNumbers } from "../src/codegen/const-box-hoist.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { compile } from "../src/index.js";
import type { Instr, WasmFunction, WasmModule } from "../src/ir/types.js";

/**
 * `state` is a top-level binding, which is what gives the module a
 * `__module_init` for the seed block to live in — without it the pass has
 * nowhere to seed and correctly no-ops.
 *
 * Every `any`-typed constant below reaches `__box_number` with a literal
 * operand, which is the population the pass rewrites. `Infinity` is the one
 * that also removes an allocation (it fails #3673's `i31` round trip); `42`
 * and `-0` cover the i31-able and the sign-carrying cases.
 */
const BODY = `
  var out = 0;
  var bit = 1;
  var a: any = Infinity;
  var b: any = Infinity;
  if (a === b) { out += bit; } bit *= 2;
  var n1: any = NaN;
  var n2: any = NaN;
  if (n1 === n2) { out += bit; } bit *= 2;
  if (n1 === n1) { out += bit; } bit *= 2;
  if (n1 !== n1) { out += bit; } bit *= 2;
  var z: any = 0;
  var mz: any = -0;
  if (z === mz) { out += bit; } bit *= 2;
  if (1 / (mz as number) === -Infinity) { out += bit; } bit *= 2;
  if (Object.is(z, mz)) { out += bit; } bit *= 2;
  if (Object.is(mz, mz)) { out += bit; } bit *= 2;
  if (Object.is(n1, n2)) { out += bit; } bit *= 2;
  var big: any = 3000000000;
  var big2: any = 3000000000;
  if (big === big2) { out += bit; } bit *= 2;
  var f: any = 1.5;
  var f2: any = 1.5;
  if (f === f2) { out += bit; } bit *= 2;
  var small: any = 42;
  var small2: any = 42;
  if (small === small2) { out += bit; } bit *= 2;
  var s = new Set();
  s.add(Infinity); s.add(Infinity); s.add(NaN); s.add(NaN); s.add(-0);
  out += s.size * bit; bit *= 8;
  if (s.has(Infinity)) { out += bit; } bit *= 2;
  if (s.has(NaN)) { out += bit; } bit *= 2;
  if (s.has(0)) { out += bit; } bit *= 2;
  var m = new Map();
  m.set(Infinity, 5); m.set(NaN, 9);
  out += (m.get(Infinity) as number) * bit; bit *= 16;
  out += (m.get(NaN) as number) * bit; bit *= 16;
  var arr: any[] = [Infinity, NaN, 42];
  out += (arr.indexOf(Infinity) + 2) * bit; bit *= 8;
  out += (arr.indexOf(NaN) + 2) * bit; bit *= 8;
  if (arr.includes(NaN)) { out += bit; } bit *= 2;
  if (a + 1 === Infinity) { out += bit; } bit *= 2;
  return out;
`;

/**
 * The mechanism fixture. `loop` boxes FOUR constants per iteration and nothing
 * else, so its own `__box_number` call count is a pure measure of constant
 * boxing. `sink` boxes only NON-constants (its `any` parameter), so it is the
 * isolation control: its call count must not move.
 *
 * Three of the four (`Infinity`, `-0`, `1.5`) also ALLOCATE today — they fail
 * #3673's `i31` round trip — while `42` is i31-able and never allocated. That
 * 4-vs-3 split is what lets the two censuses be asserted independently.
 */
const CONSTANTS_PER_ITERATION = 4;
const ALLOCATING_CONSTANTS_PER_ITERATION = 3;

const SOURCE = `
var state: any = Infinity;
function sink(x: any): number { return x === state ? 1 : 0; }
export function seeded(): number { return state === Infinity ? 1 : 0; }
export function run(): number {${BODY}}
export function loop(n: number): number {
  var hits = 0;
  for (var i = 0; i < n; i++) {
    hits += sink(Infinity);
    hits += sink(-0);
    hits += sink(42);
    hits += sink(1.5);
  }
  return hits;
}
`;

/** What native Node returns for the identical program. */
const NODE_ANSWER: number = new Function(
  BODY.replace(/: any\[\]/g, "")
    .replace(/: any\b/g, "")
    .replace(/ as number/g, ""),
)() as number;

/**
 * The SMI box guard is pinned OFF for this fixture, and the reason is the whole
 * point of the file.
 *
 * `JS2WASM_SMI_FASTPATH` is **default `all`** since the #4157 tuned-set flip,
 * and at that level `smi-box-fast-path.ts` inlines `__box_number`'s i31 arm at
 * every boxing site. Three of `loop`'s four constants (`Infinity`, `-0`, `1.5`)
 * fail the i31 round trip and still call the helper; `42` is i31-able, so the
 * inlined guard HITS and the call never executes. The unhoisted baseline would
 * then measure 3 calls per iteration, not 4 — the fixture would still be green,
 * but `CONSTANTS_PER_ITERATION` would have quietly stopped meaning "the
 * constants this pass removes" and started meaning "the constants some OTHER
 * pass did not already remove".
 *
 * Pinning it off keeps the two censuses measuring the const-box hoist alone.
 * The 4-vs-3 split between the call census and the allocation census below is
 * this fixture's actual subject and depends on that isolation.
 */
const FLAGS_PINNED_OFF: Record<string, string> = { JS2WASM_SMI_FASTPATH: "0" };

async function build(hoist: boolean, census: boolean): Promise<Uint8Array> {
  const saved = {
    hoist: process.env.JS2WASM_HOIST_CONST_BOXES,
    census: process.env.JS2WASM_ALLOC_CENSUS,
    calls: process.env.JS2WASM_ALLOC_CENSUS_CALLS,
    pinned: Object.fromEntries(Object.keys(FLAGS_PINNED_OFF).map((k) => [k, process.env[k]])),
  };
  const set = (key: string, value: string | undefined): void => {
    // `= undefined` coerces to the STRING "undefined", which reads as "set".
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set("JS2WASM_HOIST_CONST_BOXES", hoist ? undefined : "0");
  set("JS2WASM_ALLOC_CENSUS", census ? "1" : undefined);
  set("JS2WASM_ALLOC_CENSUS_CALLS", census ? "__box_number" : undefined);
  for (const [k, v] of Object.entries(FLAGS_PINNED_OFF)) set(k, v);
  try {
    const result = await compile(SOURCE, { fileName: "issue-4157-const-box-hoist.ts", target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    return result.binary;
  } finally {
    set("JS2WASM_HOIST_CONST_BOXES", saved.hoist);
    set("JS2WASM_ALLOC_CENSUS", saved.census);
    set("JS2WASM_ALLOC_CENSUS_CALLS", saved.calls);
    for (const [k, v] of Object.entries(saved.pinned)) set(k, v);
  }
}

async function instantiate(binary: Uint8Array): Promise<Record<string, unknown>> {
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  const exports = instance.exports as unknown as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return exports;
}

/**
 * Per-counter SLOPE — allocations (#3921 census) and `__box_number` calls
 * (#4185 call census) **per `loop` iteration**. Measuring a slope rather than a
 * total cancels every fixed cost (module init, the first-call warm-up) and
 * keeps the assertions independent of the census's `type_<n>` naming, which
 * moves with unrelated compiler changes.
 */
async function slopePerIteration(
  hoist: boolean,
): Promise<{ slope: Map<string, number>; runAnswer: number; loopAnswer: number }> {
  const exports = await instantiate(await build(hoist, true));
  const counters = Object.entries(exports).filter(
    ([name, g]) =>
      (name.startsWith("__alloc_count_") || name.startsWith("__call_census_")) && g instanceof WebAssembly.Global,
  ) as [string, WebAssembly.Global][];
  const read = (): Map<string, number> => new Map(counters.map(([n, g]) => [n, Number(g.value)]));
  const runAnswer = (exports.run as () => number)();
  const loop = exports.loop as (n: number) => number;

  const warm = read();
  const loopAnswer = loop(10);
  const after10 = read();
  loop(110);
  const after110 = read();

  const slope = new Map<string, number>();
  for (const [name, value] of after110) {
    const first = (after10.get(name) ?? 0) - (warm.get(name) ?? 0);
    const second = value - (after10.get(name) ?? 0);
    // 110 iterations' worth minus 10 iterations' worth, over the 100-iteration
    // difference — the per-iteration cost, with every fixed cost cancelled.
    const perIteration = (second - first) / 100;
    if (perIteration !== 0) slope.set(name, perIteration);
  }
  return { slope, runAnswer, loopAnswer };
}

/** The `__box_number` call census counter for one caller, per iteration. */
const boxCallsIn = (slope: Map<string, number>, caller: string): number => {
  const pattern = new RegExp(`^__call_census_${caller}_\\d+__TO____box_number$`);
  let total = 0;
  for (const [name, count] of slope) if (pattern.test(name)) total += count;
  return total;
};

/** Allocation counters only, keyed by the census's short type name. */
const allocationsIn = (slope: Map<string, number>): Map<string, number> => {
  const out = new Map<string, number>();
  for (const [name, count] of slope) {
    if (name.startsWith("__alloc_count_")) out.set(name.replace("__alloc_count_", ""), count);
  }
  return out;
};

describe("#4157 — constant number boxing hoisted to module globals", () => {
  it("visits a shared instruction-array DAG once instead of expanding every path", () => {
    const leaf: Instr[] = [
      { op: "f64.const", value: 42 },
      { op: "call", funcIdx: 7 },
    ];
    let shared = leaf;
    for (let depth = 0; depth < 28; depth++) {
      shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
    }
    const init: WasmFunction = { name: "__module_init", typeIdx: 0, locals: [], body: [] };
    const target: WasmFunction = { name: "target", typeIdx: 0, locals: [], body: shared };
    const mod = {
      types: [],
      imports: [],
      functions: [init, target],
      exports: [],
      tables: [],
      elements: [],
      globals: [],
      tags: [],
      stringPool: [],
      externClasses: [],
      nodeBuiltinModules: new Set(),
      stringLiteralValues: new Map(),
      asyncFunctions: new Set(),
      declaredFuncRefs: [],
      funcOrdinalToPosition: [],
      memories: [],
      dataSegments: [],
    } satisfies WasmModule;
    const ctx = {
      mod,
      funcMap: new Map([["__box_number", 7]]),
      numImportGlobals: 0,
      programAbiModuleInitCallables: { firstFunction: () => init },
    } as unknown as CodegenContext;

    hoistConstantBoxedNumbers(ctx);

    expect(leaf).toEqual([{ op: "global.get", index: 0 }]);
    expect(mod.globals).toHaveLength(2);
  });

  it("agrees with native Node, with hoisting on and off", async () => {
    const off = await instantiate(await build(false, false));
    const on = await instantiate(await build(true, false));
    expect((off.run as () => number)()).toBe(NODE_ANSWER);
    expect((on.run as () => number)()).toBe(NODE_ANSWER);
    // A hoisted global read before any user code still holds its box.
    expect((on.seeded as () => number)()).toBe(1);
    expect((off.seeded as () => number)()).toBe(1);
  }, 180_000);

  it("actually engages — the two binaries differ, and deterministically so", async () => {
    const offA = await build(false, false);
    const offB = await build(false, false);
    const on = await build(true, false);
    expect(Buffer.from(offA).equals(Buffer.from(offB))).toBe(true);
    expect(Buffer.from(on).equals(Buffer.from(offA))).toBe(false);
  }, 180_000);

  it("removes every constant boxing CALL, and no other call", async () => {
    const off = await slopePerIteration(false);
    const on = await slopePerIteration(true);
    expect(off.runAnswer).toBe(NODE_ANSWER);
    expect(on.runAnswer).toBe(NODE_ANSWER);
    expect(off.loopAnswer).toBe(on.loopAnswer);

    // `loop` boxes only constants → after hoisting it calls `__box_number`
    // zero times per iteration. Not fewer times: zero.
    expect(boxCallsIn(off.slope, "loop")).toBe(CONSTANTS_PER_ITERATION);
    expect(boxCallsIn(on.slope, "loop")).toBe(0);

    // `sink` boxes only its non-constant `any` parameter — the isolation
    // control. Unchanged, or the pass is rewriting more than it may.
    expect(boxCallsIn(on.slope, "sink")).toBe(boxCallsIn(off.slope, "sink"));
    expect(boxCallsIn(off.slope, "sink")).toBeGreaterThan(0);
  }, 180_000);

  it("removes exactly the constant boxes that were allocating, and no other stream", async () => {
    const off = allocationsIn((await slopePerIteration(false)).slope);
    const on = allocationsIn((await slopePerIteration(true)).slope);

    // Exactly one allocation stream may move: the boxed-number carrier.
    const changed = [...new Set([...off.keys(), ...on.keys()])].filter(
      (name) => (off.get(name) ?? 0) !== (on.get(name) ?? 0),
    );
    expect(changed).toHaveLength(1);

    // …and it must fall by exactly the three constants that are not i31-able.
    // `42` is i31-able and never allocated, so the CALL count above falls by
    // four while this falls by three — the two censuses are not measuring the
    // same thing, and the gap is the point.
    const boxedNumber = changed[0]!;
    expect((off.get(boxedNumber) ?? 0) - (on.get(boxedNumber) ?? 0)).toBe(ALLOCATING_CONSTANTS_PER_ITERATION);
  }, 180_000);
});
