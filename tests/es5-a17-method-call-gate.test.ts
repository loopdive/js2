// Focused standalone coverage for the ES5 with-scoped function initializer
// and the Object.defineProperty descriptor regression exposed by its dynamic
// method-call lowering.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = "test262/test";

async function expectStandalone(file: string): Promise<void> {
  const result = await runTest262File(join(TEST262_ROOT, file), "es5-a17", 120_000, "standalone");
  expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
}

describe("ES5 A17 with-scoped function and dynamic method-call gate", () => {
  it("passes the exact Object.defineProperty descriptor regression", async () => {
    await expectStandalone("built-ins/Object/defineProperty/15.2.3.6-3-138.js");
  });

  it.each(["S13.2.2_A17_T2.js", "S13.2.2_A16_T3.js"])(
    "keeps neighboring function-statement control %s passing",
    async (name) => {
      await expectStandalone(`language/statements/function/${name}`);
    },
  );
});
