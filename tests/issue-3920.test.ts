// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3920, second half) Own-presence on a closed fnctor/class struct is a
 * PER-INSTANCE bit, not a property of the shape.
 *
 * A conditionally-assigned field (`if (c) this.p = v`) gets a physical slot on
 * the struct plus a `$presence_<w>` bit (#2847/#3780). Every VALUE read
 * consults the bit. The reflective predicates did not, and they were wrong in
 * BOTH directions depending on how the receiver was typed:
 *
 * | receiver | surface | wrong answer | mechanism |
 * | --- | --- | --- | --- |
 * | `any`/externref | `in`, `for…in`, `Object.keys` | `false` / 0 keys for a PRESENT field | the dynamic helpers had no closed-struct arm |
 * | statically the struct | `in`, `hasOwnProperty`, `propertyIsEnumerable` | `true` for an ABSENT field | `structFieldNames.includes(key)` folds to `i32.const 1` |
 *
 * **PR #4219 fixed the first row** — `__object_keys` / `__object_keys_forin` /
 * `__extern_has` now carry closed-struct arms behind an `isUserDeclaredStruct`
 * whitelist. Its commit message states that "a statically-typed receiver never
 * showed the bug because it never enters the dynamic runtime at all"; the
 * second row is why that is only half true. A statically-typed receiver has the
 * OPPOSITE defect, and measured on `main` after #4219 landed, three of the four
 * spellings still disagreed across lanes:
 *
 * | predicate, 2-iteration loop, one hit expected | standalone | JS host |
 * | --- | ---: | ---: |
 * | `"cond" in bag` | **2** | 1 |
 * | `bag.hasOwnProperty("cond")` | **2** | 1 |
 * | `bag.propertyIsEnumerable("cond")` | **2** | 1 |
 * | `Object.hasOwn(bag, "cond")` | 1 | 1 |
 *
 * `Object.hasOwn` is the control: it already routed to the runtime, so it was
 * right before and after, which localises the defect to the FOLD rather than to
 * the presence machinery.
 *
 * Both directions are silent wrong answers: the value read on the same line
 * stayed correct, so nothing ever contradicted them.
 *
 * ## Why every assertion here is paired with a control
 * An enumeration/presence differential over this receiver class passes
 * VACUOUSLY when both lanes answer "nothing" — comparing `undefined` to
 * `undefined` is a green test that measures no compiler behaviour. So:
 *
 * - `positive control` below asserts a NON-ZERO count of observed properties on
 *   a known instance BEFORE any lane-vs-lane comparison is trusted. If the
 *   probe stops seeing the instance at all, that test fails first and the
 *   comparisons below it are known to be meaningless.
 * - the presence assertions pin the FULL 4-way answer (present/absent ×
 *   conditional/unconditional), so a predicate that has degenerated into a
 *   constant — in either direction — cannot pass.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Same env save/restore shape as `tests/issue-3780-allocation-lowerings.test.ts`. */
async function runStandalone(source: string, env?: Record<string, string>): Promise<unknown> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  let result: Awaited<ReturnType<typeof compile>>;
  try {
    result = await compile(source, { fileName: "t.mjs", skipSemanticDiagnostics: true, target: "standalone" });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (!result.success) throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports as Record<string, () => void>).__module_init?.();
  return (instance.exports as Record<string, () => unknown>).main!();
}

async function runHost(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "t.mjs", skipSemanticDiagnostics: true });
  if (!result.success) throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as Record<string, () => unknown>).main!();
}

/**
 * Digits, most significant first:
 *   1000 `"cond" in bag` on the instance that GOT `cond`     → must be 1
 *    100 `"cond" in bag` on the instance that did NOT        → must be 0
 *     10 `"always" in bag` (unconditional ctor field)        → must be 1
 *      1 `"missing" in bag` (no such field anywhere)         → must be 0
 *
 * Pinning all four is what makes a degenerate predicate impossible to pass:
 * always-true scores 1111, always-false scores 0.
 */
const IN_MATRIX = `
function Bag(seed) { this.always = seed; }
export function main() {
  var withCond = new Bag(1);
  if (withCond.always > 0) withCond.cond = 7;
  var withoutCond = new Bag(0);
  if (withoutCond.always > 0) withoutCond.cond = 7;
  var score = 0;
  if ("cond" in withCond) score = score + 1000;
  if ("cond" in withoutCond) score = score + 100;
  if ("always" in withCond) score = score + 10;
  if ("missing" in withCond) score = score + 1;
  return score;
}
`;
const IN_MATRIX_EXPECTED = 1010;

/** The same matrix through `hasOwnProperty`, which shared the shape fold. */
const HASOWN_MATRIX = `
function Bag(seed) { this.always = seed; }
export function main() {
  var withCond = new Bag(1);
  if (withCond.always > 0) withCond.cond = 7;
  var withoutCond = new Bag(0);
  if (withoutCond.always > 0) withoutCond.cond = 7;
  var score = 0;
  if (withCond.hasOwnProperty("cond")) score = score + 1000;
  if (withoutCond.hasOwnProperty("cond")) score = score + 100;
  if (withCond.hasOwnProperty("always")) score = score + 10;
  if (withCond.hasOwnProperty("missing")) score = score + 1;
  return score;
}
`;

/** `Object.hasOwn`, the third spelling — it already routed to the runtime. */
const OBJECT_HASOWN_MATRIX = HASOWN_MATRIX.replace(/(\w+)\.hasOwnProperty\((".*?")\)/g, "Object.hasOwn($1, $2)");

/**
 * The FILED repro: the receiver flows through a shape that keeps it
 * `any`/externref, so `in` routes to the runtime `__extern_has` rather than the
 * compile-time fold. That arm answered 0 for a property the instance carries —
 * the opposite error from the fold, on the same source-level question.
 *
 * `1007` = presence term 1000 + the value read-back 7, so a regression in
 * EITHER half is visible in the single number.
 */
const RUNTIME_ARM = `
function Bag(seed) { this.seed = seed; }
function probe(o) { return (("p" in o) ? 1000 : 0) + o.p; }
export function main() {
  var bag = new Bag(1);
  if (bag.seed > 0) bag.p = 7;
  return probe(bag);
}
`;

/**
 * The FALSE-POSITIVE arm — the half PR #4219 left open. It needs a receiver
 * whose STATIC type is the closed struct; a loop-local is one, because the
 * typed-binding pass resolves it to `(ref null $__fnctor_Bag)`. That routes all
 * three folding predicates into `structFieldNames.includes(key)`, and each
 * answered `true` on the iteration where `cond` was never assigned.
 *
 * seed 0 → `cond` absent, seed 1 → present, so the honest answer is exactly one
 * hit per predicate: `1 + 10 + 100 = 111`. A shape fold scores `222`.
 * `Object.hasOwn` is deliberately NOT in this fixture — it never folded, so it
 * would score the same either way and would dilute the signal.
 */
const IN_FOLD_LOOP = `
function Bag(seed) { this.always = seed; }
export function main() {
  var score = 0;
  for (var seed = 0; seed < 2; seed++) {
    var bag = new Bag(seed);
    if (seed > 0) bag.cond = 7;
    if ("cond" in bag) score = score + 1;
    if (bag.hasOwnProperty("cond")) score = score + 10;
    if (bag.propertyIsEnumerable("cond")) score = score + 100;
  }
  return score;
}
`;

/**
 * POSITIVE CONTROL — the instance really is observable to the probe.
 *
 * Everything above compares two lanes or pins a bitmask; both go green if the
 * receiver silently stops being an object the compiler can see at all (a
 * compile that degrades `new Bag()` to `undefined` would answer 0 for every
 * predicate and, with an all-absent expectation, look correct). This asserts a
 * NON-ZERO count of directly-read fields on the very instance the matrices use,
 * so a vacuous run fails HERE, first, and loudly.
 */
const POSITIVE_CONTROL = `
function Bag(seed) { this.always = seed; }
export function main() {
  var bag = new Bag(5);
  if (bag.always > 0) bag.cond = 9;
  var seen = 0;
  if (bag.always === 5) seen = seen + 1;
  if (bag.cond === 9) seen = seen + 1;
  return seen;
}
`;

describe("#3920 — closed-struct own-presence is a per-instance bit", () => {
  it("positive control: the probe can actually see the instance's fields", async () => {
    // Non-vacuity gate. If this is 0, every other assertion in this file is
    // comparing "nothing" to "nothing" and proves nothing.
    expect(await runStandalone(POSITIVE_CONTROL)).toBe(2);
    expect(await runHost(POSITIVE_CONTROL)).toBe(2);
  });

  it("`in` answers the presence bit, not the shape — standalone", async () => {
    expect(await runStandalone(IN_MATRIX)).toBe(IN_MATRIX_EXPECTED);
  });

  it("`in` answers the presence bit, not the shape — JS host", async () => {
    expect(await runHost(IN_MATRIX)).toBe(IN_MATRIX_EXPECTED);
  });

  it("`hasOwnProperty` agrees with `in` on the same four cases", async () => {
    expect(await runStandalone(HASOWN_MATRIX)).toBe(IN_MATRIX_EXPECTED);
  });

  it("`Object.hasOwn` agrees with both", async () => {
    expect(await runStandalone(OBJECT_HASOWN_MATRIX)).toBe(IN_MATRIX_EXPECTED);
  });

  it("a struct-typed receiver does not fold an absent conditional field to `true`", async () => {
    // The false-POSITIVE arm — still live on `main` after #4219, where the
    // standalone lane answered 222 (all three predicates constant-true) against
    // the host lane's correct 111.
    expect(await runStandalone(IN_FOLD_LOOP)).toBe(111);
    expect(await runHost(IN_FOLD_LOOP)).toBe(111);
  });

  it("the runtime `__extern_has` arm finds a present conditional field", async () => {
    // The filed repro. Standalone answered 7 (presence term dropped) while the
    // host answered 1007 on byte-identical source.
    expect(await runStandalone(RUNTIME_ARM)).toBe(1007);
    expect(await runHost(RUNTIME_ARM)).toBe(1007);
  });

  it("is layout-independent: the unpacked-presence control agrees", async () => {
    // `JS2WASM_PACKED_PRESENCE_BITS=0` gives every tracked field its own word.
    // The answer must come from the BIT, so both layouts must agree — this is
    // the property that keeps the fix correct under #3927's per-type layouts.
    expect(await runStandalone(IN_MATRIX, { JS2WASM_PACKED_PRESENCE_BITS: "0" })).toBe(IN_MATRIX_EXPECTED);
  });
});
