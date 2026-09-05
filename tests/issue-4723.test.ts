// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4723 pins the host-only property-setter residual left after #4690. The
// setter value is an array rest value, so it must cross the accessor callback
// boundary as an externref rather than as the scalar carrier inferred for an
// unannotated setter parameter. The #4715/#4720 property-reference controls
// remain in this matrix to guard the shared PutValue path.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const T262 = join(__dirname, "..", "test262");
const HAVE_T262 = existsSync(join(T262, "harness", "assert.js"));
const abs = (rel: string) => join(T262, "test", rel);

describe.skipIf(!HAVE_T262)("#4723 for-of assignment-rest property setter", () => {
  const files = [
    "language/statements/for-of/dstr/array-rest-put-prop-ref-no-get.js",
    // #4690 setter/PutValue controls.
    "language/statements/for-of/dstr/array-rest-put-prop-ref.js",
    "language/statements/for-of/dstr/array-rest-put-prop-ref-user-err.js",
    "language/statements/for-of/dstr/array-rest-put-prop-ref-user-err-iter-close-skip.js",
    // #4715/#4720 property-reference control and identifier-rest baseline.
    "language/statements/for-of/dstr/array-elem-put-prop-ref.js",
    "language/statements/for-of/dstr/array-rest-after-element.js",
  ];

  for (const target of ["host", "standalone"] as const) {
    const lane = target === "standalone" ? "standalone" : undefined;
    for (const rel of files) {
      it(`${target}: ${rel}`, { timeout: 120_000 }, async () => {
        const result = await runTest262File(abs(rel), "issue-4723", 120_000, lane);
        expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
      });
    }
  }
});
