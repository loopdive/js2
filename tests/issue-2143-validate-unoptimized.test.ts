// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2143 — the differential harness validates DEFAULT-pipeline output, not just
 * optimizer output. Previously a binary the compiler reported as `success:
 * true` but the engine rejects (`WebAssembly.validate` → false) was invisible:
 * it surfaced only as an instantiate-time `runtime_error`, and only when a test
 * happened to execute it.
 *
 * `scripts/diff-test.ts` now runs `WebAssembly.validate(r.binary)` after a
 * successful compile and classifies a failure as the distinct `malformed_wasm`
 * outcome (feeding #1853's hard-error-stability bucket); the per-file delta gate
 * (`scripts/diff-test-gate.ts`) then fails CI loudly if any corpus program
 * regresses from `match` to `malformed_wasm`.
 *
 * This test pins the #2143 corpus programs so the detection can't silently
 * regress. The ratchet direction is one-way: once a fix makes a formerly-
 * malformed program validate cleanly, it moves OUT of `KNOWN_MALFORMED` into
 * `NOW_VALID` (a positive compile-and-validate guard) — it must NEVER go back
 * to asserting the old bad behavior.
 *
 * (#3340) `array/02-push-pop.js` and `control/12-for-in-object.js` — formerly
 * `KNOWN_MALFORMED` — now compile AND validate on current main (a real compiler
 * improvement). Left asserting `validate === false`, they were stale INVERTED
 * sentinels: the improvement made them FAIL, and the root issue-tests baseline
 * silently absorbed those failures as accepted rot, so main stayed green while
 * the tests demanded obsolete malformed output. They are now positive guards.
 * `KNOWN_MALFORMED` is intentionally empty — the #2143 detection mechanism
 * (`scripts/diff-test.ts` malformed_wasm classification + the per-file delta
 * gate) stays; there is simply no unintentionally-malformed corpus program
 * left to pin. A genuine future regression to `malformed_wasm` is caught by the
 * delta gate, and a NEW malformed corpus program would be added back here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "../src/index.js";

const CORPUS_DIR = resolve(import.meta.dirname, "differential", "corpus");

// (#3340) Formerly-malformed programs that now compile AND validate — a
// one-way ratchet out of the malformed set. Asserting validity here means a
// regression that re-breaks them fails loudly instead of being re-absorbed.
const NOW_VALID = ["array/02-push-pop.js", "control/12-for-in-object.js"];

// Unintentionally-malformed default-pipeline corpus programs (compile
// `success: true` but fail WebAssembly.validate). Currently empty: the #2143
// detection still runs, but no corpus program triggers it. Add a program here
// ONLY for a genuinely-malformed default binary — never to re-pin a fixed one.
const KNOWN_MALFORMED: string[] = [];

// A representative valid program: must compile AND validate (guards against the
// detection over-firing / a regression breaking a clean program).
const KNOWN_VALID = "numeric/01-basic-arithmetic.js";

describe("#2143 — default-pipeline Wasm validation", () => {
  for (const rel of [KNOWN_VALID, ...NOW_VALID]) {
    it(`${rel}: compiles success:true AND its default binary validates`, async () => {
      const src = readFileSync(resolve(CORPUS_DIR, rel), "utf-8");
      const r = await compile(src, { fileName: rel });
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(r.binary)).toBe(true);
    });
  }

  for (const rel of KNOWN_MALFORMED) {
    it(`${rel}: compiles success:true but the default binary fails WebAssembly.validate`, async () => {
      const src = readFileSync(resolve(CORPUS_DIR, rel), "utf-8");
      const r = await compile(src, { fileName: rel });
      expect(r.success).toBe(true);
      expect(WebAssembly.validate(r.binary)).toBe(false);
    });
  }
});
