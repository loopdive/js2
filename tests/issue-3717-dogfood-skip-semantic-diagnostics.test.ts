/**
 * #3717 — every acorn dogfood script that compiles acorn must pass
 * `skipSemanticDiagnostics: true`.
 *
 * Acorn is plain pre-strict-mode JS. js2wasm's checker hard-codes `strict: true`,
 * so compiling acorn through full semantic checking surfaces a wall of
 * legitimate strict-null-check diagnostics — real `tsc --strict` emits the same
 * ones, so this is noise, not a compiler defect. (The original #3717 filing
 * claimed a checker regression; that repro was verified against `tsc` WITHOUT
 * `--strict` and was retracted.)
 *
 * `acorn-corpus.mjs`, `acorn-probe.mjs`, `acorn-test262.mjs` and
 * `acorn-standalone-compile.mjs` all routed around this. `acorn-harness.mjs` was
 * the single outlier still doing full semantic checking, so it alone hard-failed
 * with `compile.success: false` while every other lane was green — which read as
 * a compiler regression for as long as nobody compared the lanes.
 *
 * The defect was one script drifting out of step with its four siblings, so the
 * pin is on the INVARIANT rather than on the one file: any acorn dogfood script
 * that calls `compile()` passes the flag. `tests/dogfood/acorn.test.ts` also
 * drives the harness end-to-end, but its compile case is opt-in
 * (`DOGFOOD_ACORN=1`) and skipped in the default sweep, so it cannot catch this
 * drift on an ordinary PR. This one is static and always runs.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOGFOOD = join(dirname(fileURLToPath(import.meta.url)), "dogfood");

/** Every acorn dogfood script that feeds acorn's own source to `compile()`. */
const COMPILING_SCRIPTS = [
  "acorn-harness.mjs",
  "acorn-corpus.mjs",
  "acorn-probe.mjs",
  "acorn-test262.mjs",
  "acorn-standalone-compile.mjs",
];

describe("#3717 — acorn dogfood scripts skip semantic diagnostics", () => {
  it.each(COMPILING_SCRIPTS)("%s passes skipSemanticDiagnostics to compile()", (name) => {
    const src = readFileSync(join(DOGFOOD, name), "utf-8");
    expect(src).toMatch(/\bcompile\s*\(/);
    expect(src).toMatch(/skipSemanticDiagnostics:\s*true/);
  });

  it("no compiling acorn dogfood script is left as an outlier", () => {
    // The regression shape: N-1 scripts green, one silently red. Assert the set
    // is uniform rather than trusting the per-file cases above to be exhaustive.
    const missing = COMPILING_SCRIPTS.filter(
      (name) => !/skipSemanticDiagnostics:\s*true/.test(readFileSync(join(DOGFOOD, name), "utf-8")),
    );
    expect(missing).toEqual([]);
  });
});
