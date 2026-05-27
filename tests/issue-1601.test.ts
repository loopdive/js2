import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { runTest262File } from "./test262-runner.js";

/**
 * #1601 — Array iteration methods (map / reduceRight) on untyped arrays
 * emitted invalid Wasm and showed up as test262 `compile_error`:
 *  - the map bridge path stored the f64 callback result into an externref
 *    result array without boxing → `array.set[2] expected externref, found f64`.
 *  - reduceRight never registered the `__call_2_f64` host bridge (the import
 *    pre-scan only handled `reduce`) → "Missing __call_2_f64 import".
 *
 * These were the last 10 `compile_error` entries in the Array iteration
 * cluster. We assert they no longer classify as `compile_error` (they now
 * compile to valid Wasm; species/abrupt-ctor semantics are out of scope and
 * may still `fail` at runtime).
 */

const TEST262 = "/workspace/test262";
const ROOT = `${TEST262}/test/built-ins/Array/prototype`;

const cases = [
  "map/15.4.4.19-4-7.js",
  "map/create-ctor-non-object.js",
  "map/create-ctor-poisoned.js",
  "map/create-revoked-proxy.js",
  "map/create-species-abrupt.js",
  "map/create-species-non-ctor.js",
  "map/create-species-poisoned.js",
  "map/create-species-undef-invalid-len.js",
  "reduceRight/15.4.4.22-4-2.js",
  "reduceRight/15.4.4.22-4-7.js",
];

const maybe = existsSync(TEST262) ? describe : describe.skip;

maybe("#1601 array iteration callback codegen", () => {
  for (const rel of cases) {
    it(`${rel} compiles to valid Wasm (not compile_error)`, async () => {
      const r = await runTest262File(`${ROOT}/${rel}`, "built-ins/Array");
      expect(r.status, `reason: ${r.reason ?? ""}`).not.toBe("compile_error");
    });
  }
});
