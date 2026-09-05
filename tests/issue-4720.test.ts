// #4720 — for-of array assignment must perform PutValue for unresolved names.
// Keep the exact host/standalone rows beside the #4939 lexical and member
// controls so this residual stays bounded to the repaired writer paths.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262");
const HAS_TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const abs = (rel: string) => join(TEST262_ROOT, "test", rel);

const unresolvedRows = [
  "language/statements/for-of/dstr/array-rest-put-unresolvable-no-strict.js",
  "language/statements/for-of/dstr/array-elem-put-unresolvable-no-strict.js",
  "language/statements/for-of/dstr/array-elem-put-unresolvable-strict.js",
  "language/statements/for-of/dstr/array-rest-put-unresolvable-strict.js",
];

const controls = [
  "language/statements/for-of/dstr/array-rest-put-let.js",
  "language/statements/for-of/dstr/array-rest-put-const.js",
  "language/statements/for-of/dstr/array-elem-put-let.js",
  "language/statements/for-of/dstr/array-elem-put-const.js",
  "language/statements/for-of/dstr/array-rest-put-prop-ref.js",
  "language/statements/for-of/dstr/array-elem-put-prop-ref.js",
  "language/statements/for-of/dstr/array-rest-after-element.js",
];

describe.skipIf(!HAS_TEST262)("#4720 for-of unresolved array writes", () => {
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "host";
    it(`exact rows and controls pass in ${lane}`, { timeout: 300_000 }, async () => {
      for (const rel of [...unresolvedRows, ...controls]) {
        const result = await runTest262File(abs(rel), "issue-4720", 120_000, target);
        expect(`${lane} ${rel}: ${result.status}: ${result.error ?? ""}`).toBe(`${lane} ${rel}: pass: `);
      }
    });
  }
});
