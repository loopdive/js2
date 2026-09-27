// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6698) The standalone `__extern_get` field-name dispatch nested one Wasm
 * `block` per occupied hash bucket. A program with ~2,000+ distinct closed-struct
 * field names (axios) produced a 2,292-deep block ladder, and the recursive
 * post-codegen walkers overflowed the JS stack:
 * "Codegen error: Maximum call stack size exceeded".
 *
 * The reduced shape is hundreds of field names over plain object literals, read
 * through a dynamic key. The nesting assertion is the regression guard (the
 * overflow itself needs ~1,500 buckets, more compile heap than a unit-test
 * fork has); the read-backs keep a mis-routing dispatch from passing.
 * Every read is checked against the value the literal stores, plus a miss, so a
 * dispatch that compiles but routes a key to the wrong bucket cannot pass.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/**
 * `fieldCount` distinct field names spread over closed-struct object literals of
 * `GROUP` fields each (one very wide literal costs far more compile memory for
 * the same dispatch width), read back through a dynamic key.
 */
const GROUP = 40;
function wideSource(fieldCount: number): string {
  const decls: string[] = [];
  for (let g = 0; g * GROUP < fieldCount; g++) {
    const fields: string[] = [];
    for (let i = g * GROUP; i < Math.min(fieldCount, (g + 1) * GROUP); i++) fields.push(`f${i}: ${i * 3 + 1}`);
    decls.push(`const o${g} = { ${fields.join(", ")} };`);
  }
  return `
function launder(x) { return x ? x : null; }
${decls.join("\n")}
const groups = [${decls.map((_, g) => `o${g}`).join(", ")}];
export function read(i) { const o = launder(groups[(i / ${GROUP}) | 0]); return o["f" + i]; }
export function miss() { const o = launder(o0); const v = o["nope" + 1]; return v === undefined ? 1 : 0; }
`;
}

type Exports = { read(i: number): number; miss(): number };

/**
 * Compile once; return the instance exports and the deepest folded-WAT nesting
 * of `__extern_get` (the only function body printed).
 */
async function build(fieldCount: number): Promise<{ exports: Exports; nesting: number }> {
  const result = await compile(wideSource(fieldCount), {
    fileName: "wide.mjs",
    skipSemanticDiagnostics: true,
    target: "standalone",
    optimize: 0,
    emitWatOnlyFunctions: ["__extern_get"],
  });
  if (!result.success) throw new Error(result.errors.map((e) => String(e.message ?? e)).join("; "));
  let depth = 0;
  let nesting = 0;
  for (const line of result.wat.split("\n")) {
    for (const ch of line) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
    nesting = Math.max(nesting, depth);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports as Record<string, () => void>).__module_init?.();
  return { exports: instance.exports as unknown as Exports, nesting };
}

function expectEveryField(exports: Exports, fieldCount: number): void {
  const wrong: number[] = [];
  for (let i = 0; i < fieldCount; i++) if (exports.read(i) !== i * 3 + 1) wrong.push(i);
  expect(wrong).toEqual([]);
  expect(exports.miss()).toBe(1);
}

describe("#6698 standalone __extern_get dispatch over many field names", () => {
  it("bounds the bucket-ladder nesting and still routes every key", async () => {
    // ~330 occupied buckets: one block level each before the fix (nesting
    // ~340); two ~sqrt-sized ladders after it.
    const { exports, nesting } = await build(350);
    expect(nesting).toBeLessThan(120);
    expectEveryField(exports, 350);
  }, 120_000);

  it("keeps the flat ladder (and its routing) under the limit", async () => {
    const { exports, nesting } = await build(40);
    expect(nesting).toBeGreaterThan(40); // one level per bucket: shape unchanged
    expectEveryField(exports, 40);
  }, 60_000);
});
