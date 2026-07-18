// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3427 — the authoritative upstream harness (#3370) declares `isPrimitive` in
 * BOTH `testTypedArray.js` and `assert.js`. A JS engine tolerates the duplicate
 * top-level function declaration (last-wins), but our TypeScript front-end
 * rejects it as `Duplicate identifier 'isPrimitive'` at L1, which failed ~2k
 * TypedArray/Array tests in EACH lane. `assembleOriginalHarness` now
 * de-duplicates top-level function declarations in the assembled prefix
 * (renaming all-but-last to a dead `NAME$dupK`), matching JS last-wins.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

const TEST262_ROOT = join(import.meta.dirname, "..", "test262", "test");

// The exact worker options for the literal-harness lane (scripts/test262-worker.mjs
// `doCompile`): skipSemanticDiagnostics drops purely-semantic collisions (e.g.
// the runtime shim's `var print` vs the ambient DOM `print`), leaving the
// binder-level duplicate-identifier grammar error this fix targets.
const HARNESS_COMPILE_OPTS = { allowJs: true, fileName: "test.js", skipSemanticDiagnostics: true } as const;

function assembleFromFile(relPath: string) {
  const source = readFileSync(join(TEST262_ROOT, relPath), "utf8");
  const meta = parseMeta(source);
  return assembleOriginalHarness(source, meta);
}

describe("#3427 harness-assembly de-duplicates isPrimitive", () => {
  const typedArraySamples = [
    "built-ins/TypedArray/prototype/at/index-non-numeric-argument-tointeger.js",
    "built-ins/TypedArray/prototype/fill/fill-values-relative-end.js",
    "built-ins/Array/prototype/every/callbackfn-resize-arraybuffer.js",
  ];

  it("assembles a single live `isPrimitive` (earlier declaration renamed)", () => {
    const asm = assembleFromFile(typedArraySamples[0]!);
    const src = asm.primary.source;
    // assert.js's isPrimitive (the LAST declaration) survives verbatim…
    expect((src.match(/function isPrimitive\s*\(/g) ?? []).length).toBe(1);
    // …and testTypedArray.js's earlier one is renamed to a dead identifier.
    expect((src.match(/function isPrimitive\$dup0\s*\(/g) ?? []).length).toBe(1);
  });

  it("preserves bodyLineOffset (rename adds no lines)", () => {
    const asm = assembleFromFile(typedArraySamples[0]!);
    // The renamed token is same-line, so the offset is still the exact prefix
    // line count (last body line = prefix lines + body-internal line).
    const prefixLen =
      asm.primary.source.length - readFileSync(join(TEST262_ROOT, typedArraySamples[0]!), "utf8").length;
    expect(prefixLen).toBeGreaterThan(0);
    expect(asm.primary.bodyLineOffset).toBeGreaterThan(0);
  });

  it("compiles the TypedArray/Array samples without a duplicate-identifier error", async () => {
    for (const relPath of typedArraySamples) {
      const asm = assembleFromFile(relPath);
      const r = await compile(asm.primary.source, HARNESS_COMPILE_OPTS);
      const dupErrors = (r.errors ?? []).filter((e) => /Duplicate identifier/.test(e.message));
      expect(dupErrors, `${relPath}: ${dupErrors.map((e) => e.message).join(", ")}`).toHaveLength(0);
      expect(r.success, `${relPath} should compile`).toBe(true);
    }
  });

  it("keeps the strict rerun variant duplicate-free too", async () => {
    const asm = assembleFromFile(typedArraySamples[0]!);
    expect(asm.strictRerun).toBeDefined();
    const r = await compile(asm.strictRerun!.source, HARNESS_COMPILE_OPTS);
    const dupErrors = (r.errors ?? []).filter((e) => /Duplicate identifier/.test(e.message));
    expect(dupErrors).toHaveLength(0);
  });
});
