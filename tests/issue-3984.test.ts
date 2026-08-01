import { existsSync } from "fs";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

/**
 * #3984 — standalone: `Object.defineProperties(arr, {length: {...}})` never
 * reached ES §10.4.2.4 ArraySetLength.
 *
 * `maybeEmitVecLengthDefine` had exactly ONE call site, inside
 * `compileObjectDefineProperty`. The static object-literal expansion inside
 * `compileObjectDefineProperties` re-parses each descriptor inline instead of
 * delegating, so the plural form fell through to the struct/externref path,
 * which has no notion of the WasmGC vec's length field.
 *
 * The failure mode is the dangerous one: a **silent wrong answer**, not a
 * refusal. `Object.defineProperties(a, {length: {value: 2}})` on `[0,1,2]` left
 * `a.length === 3` and threw nothing, so neither the root-cause classifier nor
 * the standalone floor could observe it. The singular form was already correct,
 * which is why this is a routing gap over working machinery rather than new
 * substrate (and hence disjoint from the #3251 per-index overlay epic).
 *
 * Measured by a paired single-process A/B (kill-switch attribution-by-removal)
 * over 103 reachable gated files: +34 pass, 0 lost, 0 compile_timeout, in-sweep
 * controls held; re-run unchanged after the god-file refactor and re-verified
 * 34/34 with the measurement scaffold deleted.
 */

const TEST262 = "/workspace/test262";
const maybe = existsSync(TEST262) ? describe : describe.skip;

// A representative slice of the 34 measured flips. All 34 live in the same
// family; these span the distinct descriptor shapes that route through
// ArraySetLength from the plural form.
const flipped = [
  "test/built-ins/Object/defineProperties/15.2.3.7-6-a-116.js",
  "test/built-ins/Object/defineProperties/15.2.3.7-6-a-117.js",
  "test/built-ins/Object/defineProperties/15.2.3.7-6-a-121.js",
  "test/built-ins/Object/defineProperties/15.2.3.7-6-a-124.js",
  "test/built-ins/Object/defineProperties/15.2.3.7-6-a-131.js",
  "test/built-ins/Object/defineProperties/15.2.3.7-6-a-148.js",
  "test/built-ins/Object/defineProperties/15.2.3.7-6-a-161.js",
  "test/built-ins/Object/defineProperties/15.2.3.7-6-a-174.js",
];

maybe("#3984 Object.defineProperties array-`length` routing (standalone)", () => {
  for (const rel of flipped) {
    it(`${rel} passes in the standalone lane`, async () => {
      const r = await runTest262File(`${TEST262}/${rel}`, "issue-3984", 120_000, "standalone");
      expect(r.status, `error: ${r.error ?? r.reason ?? ""}`).toBe("pass");
    }, 180_000);
  }

  // Guard against the obvious over-correction: the SINGULAR form was already
  // correct and must stay correct — the fix adds a second caller, it does not
  // change the shared machinery.
  // These two are the direct singular twins of the plural files above
  // (…6-4-N vs …7-6-a-N), so a regression in the shared ArraySetLength helper
  // shows up here first.
  for (const rel of [
    "test/built-ins/Object/defineProperty/15.2.3.6-4-133.js",
    "test/built-ins/Object/defineProperty/15.2.3.6-4-126.js",
  ]) {
    it(`${rel} (singular form) is unaffected`, async () => {
      const r = await runTest262File(`${TEST262}/${rel}`, "issue-3984", 120_000, "standalone");
      expect(r.status, `error: ${r.error ?? ""}`).toBe("pass");
    }, 180_000);
  }
});
