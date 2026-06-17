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
 * This test pins the two known invalid-unoptimized corpus programs (#1941's
 * corpus work) so the detection can't silently regress. If a future fix makes
 * one of these validate cleanly, this test will flag it — move the now-valid
 * program out of `KNOWN_MALFORMED` (ratchet direction).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "../src/index.js";

const CORPUS_DIR = resolve(import.meta.dirname, "differential", "corpus");

// Programs that compile (`success: true`) but whose DEFAULT-pipeline binary
// fails WebAssembly.validate — the malformed-wasm class #2143 makes visible.
const KNOWN_MALFORMED = ["array/02-push-pop.js", "control/12-for-in-object.js"];

// A representative valid program: must compile AND validate (guards against the
// detection over-firing / a regression breaking a clean program).
const KNOWN_VALID = "numeric/01-basic-arithmetic.js";

describe("#2143 — default-pipeline Wasm validation", () => {
  for (const rel of KNOWN_MALFORMED) {
    it(`${rel}: compiles success:true but the default binary fails WebAssembly.validate`, async () => {
      const src = readFileSync(resolve(CORPUS_DIR, rel), "utf-8");
      const r = await compile(src, { fileName: rel });
      // The whole point of #2143: `success` is NOT a sufficient signal of a
      // valid binary. (If `success` ever becomes false here the program now
      // hard-errors — also acceptable, but then update this list.)
      expect(r.success).toBe(true);
      expect(WebAssembly.validate(r.binary)).toBe(false);
    });
  }

  it(`${KNOWN_VALID}: a clean program still compiles AND validates (detection isn't over-eager)`, async () => {
    const src = readFileSync(resolve(CORPUS_DIR, KNOWN_VALID), "utf-8");
    const r = await compile(src, { fileName: KNOWN_VALID });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
