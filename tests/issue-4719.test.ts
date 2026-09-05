import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const ROWS = [
  // Residual and its explicit-undefined sibling: both exercise the same
  // nested-array assignment target-resolution ordering.
  "array-elem-nested-array-undefined.js",
  "array-elem-nested-array-undefined-own.js",
  // Controls fixed by the dependency PR #4938.
  "array-rest-nested-array-null.js",
  "array-rest-nested-array-undefined.js",
  "obj-prop-nested-array-undefined.js",
  // Nearby nested-array assignment controls.
  "array-elem-nested-array-undefined-hole.js",
  "array-elem-nested-array-null.js",
  "array-elem-nested-array.js",
] as const;

describe("#4719 nested array assignment residual (depends on #4938)", () => {
  for (const lane of ["host", "standalone"] as const) {
    describe(lane, () => {
      for (const row of ROWS) {
        it(`passes ${row}`, async () => {
          const result = await runTest262File(
            join("test262/test/language/expressions/assignment/dstr", row),
            "issue-4719",
            30_000,
            lane === "standalone" ? "standalone" : undefined,
          );
          expect(result.status, `${row}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
        });
      }
    });
  }
});
