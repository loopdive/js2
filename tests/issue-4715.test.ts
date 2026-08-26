// #4715 — for-of assignment destructuring must preserve lexical PutValue errors.
// The exact Test262 rows exercise both TDZ and const writes, while the member
// controls keep the existing property-target dispatcher on the same paths.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const T262 = join(__dirname, "..", "test262");
const HAVE_T262 = existsSync(join(T262, "harness", "assert.js"));
const abs = (rel: string) => join(T262, "test", rel);

const files = [
  "language/statements/for-of/dstr/array-rest-put-let.js",
  "language/statements/for-of/dstr/array-rest-put-const.js",
  "language/statements/for-of/dstr/array-elem-put-let.js",
  "language/statements/for-of/dstr/array-elem-put-const.js",
];

const controls = [
  "language/statements/for-of/dstr/array-rest-put-prop-ref.js",
  "language/statements/for-of/dstr/array-elem-put-prop-ref.js",
  "language/statements/for-of/dstr/array-rest-after-element.js",
];

describe.skipIf(!HAVE_T262)("#4715 for-of assignment lexical writes", () => {
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "host";
    it(`exact rows and member controls pass in ${lane}`, { timeout: 240_000 }, async () => {
      for (const rel of [...files, ...controls]) {
        const result = await runTest262File(abs(rel), "issue-4715", 120_000, target);
        expect(`${lane} ${rel}: ${result.status}: ${result.error ?? ""}`).toBe(`${lane} ${rel}: pass: `);
      }
    });
  }
});
