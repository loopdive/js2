// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3780 round 4) Two allocation-volume lowerings for the standalone lane.
 *
 * The standalone acorn self-parse allocates ~58 MB per 226 KB source, of which
 * only ~10 MB is the AST it returns. Two representation changes take ~24.8% off
 * that, and both are pure size/identity questions with no semantic content:
 *
 *  1. **Packed presence flags.** #2847's hidden `$has_<name>` own-presence slot
 *     is correct but was one whole `i32` per conditionally-assigned property.
 *     Acorn's `Node` has 63 of them — 252 bytes of a 536-byte AST node. They
 *     are now bits in `$presence_<w>` words (130 fields → 69).
 *  2. **Interned boolean carriers.** A JS boolean has no observable identity
 *     and its carrier field is immutable, so two module-level carriers suffice.
 *     `__box_boolean` is inlined into every boolean-producing site, so this is
 *     the difference between a GC object and a `global.get` on a path that runs
 *     millions of times per parse.
 *
 * Each ships with a paired control (`JS2WASM_PACKED_PRESENCE_BITS=0`,
 * `JS2WASM_INTERNED_BOOL_BOXES=0`) so the measurement is attributable. The
 * tests below assert the two things that could actually break: that the packed
 * layout still answers own-presence correctly ACROSS A WORD BOUNDARY (the case
 * a single-word implementation would silently pass), and that interning is
 * invisible to boolean semantics.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string, env?: Record<string, string>): Promise<unknown> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  let result;
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
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).main!();
}

/**
 * 40 conditionally-assigned properties on one constructor — deliberately more
 * than 32, so `p00`..`p31` and `p32`..`p39` land in DIFFERENT presence words.
 * A packing bug that ignores the word index, or masks with the wrong bit, shows
 * up here and nowhere in a small fixture.
 */
const CROSS_WORD_PRESENCE = `
function Bag(seed) { this.seed = seed; }
export function main() {
  var total = 0;
  for (var seed = 0; seed < 41; seed++) {
    var bag = new Bag(seed);
${Array.from({ length: 40 }, (_, i) => `    if (seed > ${i}) bag.p${String(i).padStart(2, "0")} = ${i};`).join("\n")}
    var present = 0;
${Array.from({ length: 40 }, (_, i) => `    if ("p${String(i).padStart(2, "0")}" in bag) present = present + 1;`).join("\n")}
    // Every earlier property must still read back its own value, so a shared
    // word cannot be silently clobbering a sibling's storage either.
    var sum = 0;
${Array.from({ length: 40 }, (_, i) => `    if (bag.p${String(i).padStart(2, "0")} !== undefined) sum = sum + bag.p${String(i).padStart(2, "0")};`).join("\n")}
    total = total + present * 1000 + sum;
  }
  return total;
}
`;

// seed s assigns p_i for every i < s, so `present` = min(s, 40) and
// `sum` = sum of 0..min(s,40)-1.
const EXPECTED_CROSS_WORD = (() => {
  let total = 0;
  for (let seed = 0; seed < 41; seed++) {
    const present = Math.min(seed, 40);
    let sum = 0;
    for (let i = 0; i < present; i++) sum += i;
    total += present * 1000 + sum;
  }
  return total;
})();

const BOOLEAN_IDENTITY = `
export function main() {
  var o = { a: true, b: false, c: true };
  var score = 0;
  if (o.a === true) score = score + 1;
  if (o.b === false) score = score + 2;
  if (o.a === o.c) score = score + 4;         // two boxes, same value
  if (o.a === o.b) score = score + 8;         // must stay false
  if (!o.b) score = score + 16;
  if (o.a) score = score + 32;
  if (typeof o.a === "boolean") score = score + 64;
  if (o.a == 1) score = score + 128;          // loose: boolean -> number
  if (o.b == 0) score = score + 256;
  score = score + (o.a + 1) * 512;            // ToNumber(true) === 1
  var flipped = !o.a;
  if (flipped === false) score = score + 4096;
  return score;
}
`;

// 1 + 2 + 4 + 16 + 32 + 64 + 128 + 256 + 1024 + 4096
const EXPECTED_BOOLEAN = 1 + 2 + 4 + 16 + 32 + 64 + 128 + 256 + 2 * 512 + 4096;

describe("#3780 — packed own-presence flags", () => {
  it("answers `in` and reads back values across a presence-word boundary", async () => {
    expect(await runHost(CROSS_WORD_PRESENCE)).toBe(EXPECTED_CROSS_WORD);
  });

  /**
   * (#3920) The standalone lane now agrees with the host lane, so this asserts
   * `EXPECTED_CROSS_WORD` outright — the flip #3920's acceptance criteria asked
   * for. Until then it was pinned to `EXPECTED_CROSS_WORD - 820 * 1000` on the
   * strength of `"pNN" in bag` answering `false` for a fnctor instance.
   *
   * That pinned constant went stale twice, in OPPOSITE directions, and the test
   * has been red on `main` throughout. Measured, per base:
   *
   * | base | answer | why |
   * | --- | ---: | --- |
   * | `9ff693ddf` (before PR #4219) | 1,650,660 | the receiver types as the closed struct, so `in` took the compile-time `structFieldNames.includes(key)` fold and every one of the 40 keys answered `true` — 40 hits × 41 seeds instead of 820 |
   * | `23ba5903b` (after PR #4219) | **830,660** | correct, and exactly `EXPECTED_CROSS_WORD` |
   * | the pin | 10,660 | the ORIGINAL bug: presence dropped out entirely |
   *
   * So this is not an allocation-count change — the pin encoded a wrong answer,
   * the wrong answer moved, and a pin against the lane's own bug cannot survive
   * that. Hence asserting the real value. The credit for the behaviour reaching
   * `EXPECTED_CROSS_WORD` is #4219's; this only repairs the assertion.
   *
   * Both layouts must still agree — that is the packing-is-layout-only claim,
   * and the 32-bit word boundary is where a single-word implementation would
   * silently pass.
   */
  it("is layout-only: packed and unpacked standalone builds agree", async () => {
    const packed = await runStandalone(CROSS_WORD_PRESENCE);
    const unpacked = await runStandalone(CROSS_WORD_PRESENCE, { JS2WASM_PACKED_PRESENCE_BITS: "0" });
    expect(packed).toBe(unpacked);
    expect(packed).toBe(EXPECTED_CROSS_WORD);
  });
});

describe("#3780 — interned boolean carriers", () => {
  it("keeps boolean equality, coercion and truthiness intact", async () => {
    expect(await runStandalone(BOOLEAN_IDENTITY)).toBe(EXPECTED_BOOLEAN);
  });

  it("is identity-only: the allocating control produces the identical result", async () => {
    expect(await runStandalone(BOOLEAN_IDENTITY, { JS2WASM_INTERNED_BOOL_BOXES: "0" })).toBe(EXPECTED_BOOLEAN);
  });
});
