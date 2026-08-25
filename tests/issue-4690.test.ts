// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4690 pins the four standalone for-of assignment-rest cases whose rest target
// is a property reference. The exact upstream files exercise PutValue, setter
// invocation, and the no-get/abrupt-completion ordering that reduced probes
// tend to miss. The identifier-rest control protects the existing #2602 path.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const T262 = join(__dirname, "..", "test262");
const HAVE_T262 = existsSync(join(T262, "harness", "assert.js"));
const abs = (rel: string) => join(T262, "test", rel);

describe.skipIf(!HAVE_T262)("#4690 standalone for-of assignment-rest property targets", () => {
  const files = [
    "language/statements/for-of/dstr/array-rest-put-prop-ref.js",
    "language/statements/for-of/dstr/array-rest-put-prop-ref-no-get.js",
    "language/statements/for-of/dstr/array-rest-put-prop-ref-user-err.js",
    "language/statements/for-of/dstr/array-rest-put-prop-ref-user-err-iter-close-skip.js",
    // Baseline-pass control: identifier rest must remain byte/semantically stable.
    "language/statements/for-of/dstr/array-rest-after-element.js",
  ];

  for (const rel of files) {
    it(`${rel} passes in standalone`, { timeout: 120_000 }, async () => {
      const result = await runTest262File(abs(rel), "issue-4690", 120_000, "standalone");
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});
