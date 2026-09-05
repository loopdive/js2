// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4693 — assignment-form object rest must exclude computed property keys.
// Each pin uses the same standalone runner seam as the artifact census.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262");
const DSTR_ROOT = "test/language/expressions/assignment/dstr";
const HAS_TEST262 = existsSync(join(TEST262_ROOT, "test", "language"));

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

const COMPUTED_OBJECT_REST_ROWS = [
  "obj-rest-computed-property.js",
  "obj-rest-computed-property-no-strict.js",
  "obj-rest-non-string-computed-property-1.js",
  "obj-rest-non-string-computed-property-array-1.js",
  "obj-rest-non-string-computed-property-1e0.js",
  "obj-rest-non-string-computed-property-string-1.js",
  "obj-rest-non-string-computed-property-1dot.js",
  "obj-rest-non-string-computed-property-1dot0.js",
  "obj-rest-non-string-computed-property-array-1e0.js",
] as const;

const PASS_CONTROLS = ["obj-rest-same-name.js", "obj-rest-val-null.js", "obj-rest-val-undefined.js"] as const;

async function expectStandalonePass(file: string): Promise<void> {
  const result = await runTest262File(join(TEST262_ROOT, DSTR_ROOT, file), "issue-4693", 60_000, "standalone");
  expect(result.status, `${file}: ${result.error ?? ""}`).toBe("pass");
  expect(result.error, `${file} unexpectedly reported an error`).toBeUndefined();
}

describe.skipIf(!HAS_TEST262)("#4693 — assignment object-rest computed keys", () => {
  for (const file of COMPUTED_OBJECT_REST_ROWS) {
    it(`passes ${file}`, { timeout: 120_000 }, async () => {
      await expectStandalonePass(file);
    });
  }

  for (const file of PASS_CONTROLS) {
    it(`keeps control green: ${file}`, { timeout: 120_000 }, async () => {
      await expectStandalonePass(file);
    });
  }
});
