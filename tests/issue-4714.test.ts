import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

// #4714 — an empty ArrayAssignmentPattern in a for-of head still performs
// GetIterator(value), even though it does not consume an element. Keep the
// two exact regressions beside all value-shape controls, plus the direct
// custom-iterator GetIterator abrupt-completion control. IteratorClose rows
// remain outside this issue's scope.
const TEST262 = join(process.cwd(), "test262");
const maybe = existsSync(TEST262) ? describe : describe.skip;

const rows = [
  "language/statements/for-of/dstr/array-empty-val-num.js",
  "language/statements/for-of/dstr/array-empty-val-undef.js",
  "language/statements/for-of/dstr/array-empty-val-array.js",
  "language/statements/for-of/dstr/array-empty-val-string.js",
  "language/statements/for-of/dstr/array-empty-val-null.js",
  "language/statements/for-of/dstr/array-empty-val-bool.js",
  "language/statements/for-of/dstr/array-empty-val-symbol.js",
  "language/statements/for-of/dstr/array-empty-iter-get-err.js",
] as const;

maybe("#4714 for-of empty array assignment pattern", () => {
  for (const lane of [
    { name: "host/GC", target: undefined },
    { name: "standalone", target: "standalone" as const },
  ]) {
    for (const rel of rows) {
      it(`${rel} passes in ${lane.name}`, async () => {
        const result = await runTest262File(join(TEST262, "test", rel), "issue-4714", 120_000, lane.target);
        expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
      }, 180_000);
    }
  }
});
