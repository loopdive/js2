// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The ES5 standalone rows that regressed 2026-09-23 → 09-28, run through the
 * real test262 harness. Mechanism pins live in
 * es5-standalone-regressions-2026-09.test.ts; this file is separate because
 * harness compiles are heavy for one worker. S15.4.4.2_A1_T3 alone exceeds
 * the 512 MB fork heap, so it — like the two eval-provider rows — is guarded by
 * ES5's `completed` status in the CI ratchet rather than here.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";
describe("ES5 · the regressed test262 rows themselves, through the real harness", () => {
  // The snippets above pin each mechanism; these pin the exact rows, in the
  // runner's own module shape (the $262 shim makes every row a runtime-eval
  // module, which is what exposed the i32 brand collision). The two rows that
  // need the QuickJS eval provider (S11.1.1_A3.2, 15.3.5.4_2-95gs), and
  // S15.4.4.2_A1_T3 (too large for one fork), are guarded
  // by ES5's `completed` status in the CI ratchet instead.
  it.each([
    "built-ins/Boolean/prototype/toString/S15.6.4.2_A1_T1.js",
    "built-ins/Boolean/prototype/toString/S15.6.4.2_A1_T2.js",
    "language/expressions/property-accessors/S11.2.1_A3_T1.js",
    "harness/deepEqual-primitives.js",
  ])("%s passes standalone", async (file) => {
    const result = await runTest262File(join("test262/test", file), "es5-2026-09", 120_000, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
