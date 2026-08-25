import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { runTest262File } from "./test262-runner.js";

const CASES = [
  // Exact Set iterator-method/non-constructor targets.
  ["Set", "prototype/Symbol.iterator/not-a-constructor.js"],
  ["Set", "prototype/entries/not-a-constructor.js"],
  ["Set", "prototype/values/not-a-constructor.js"],
  // Nearby Map iterator controls exercise the shared prototype-symbol path.
  ["Map", "prototype/Symbol.iterator/not-a-constructor.js"],
  ["Map", "prototype/keys/not-a-constructor.js"],
  ["Map", "prototype/values/not-a-constructor.js"],
  ["Map", "prototype/entries/not-a-constructor.js"],
  // Set's separate ES2015 identity control (`keys === values`).
  ["Set", "prototype/keys/keys.js"],
] as const;

const TEST262_ROOT = resolve(import.meta.dirname ?? ".", "..", "test262", "test");

describe("#4731 Set/Map iterator prototype value reads", () => {
  for (const lane of ["host", "standalone"] as const) {
    describe(lane, () => {
      for (const [builtin, relativePath] of CASES) {
        it(`${builtin}/${relativePath}`, async () => {
          const testPath = `built-ins/${builtin}/${relativePath}`;
          const result = await runTest262File(
            resolve(TEST262_ROOT, testPath),
            `${builtin}/${relativePath.split("/")[0]}`,
            120000,
            lane === "standalone" ? "standalone" : undefined,
          );
          expect(result.status, result.error ?? testPath).toBe("pass");
        });
      }
    });
  }
});
