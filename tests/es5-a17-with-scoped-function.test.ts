// Focused standalone coverage for the ES5 with-scoped function initializer
// residual and its adjacent function-statement controls.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const ROOT = "test262/test/language/statements/function";

describe("ES5 S13.2.2_A17_T3 with-scoped function initializer", () => {
  it("passes the exact standalone residual", async () => {
    const file = join(ROOT, "S13.2.2_A17_T3.js");
    const result = await runTest262File(file, "es5-a17", 120_000, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(["S13.2.2_A17_T2.js", "S13.2.2_A16_T3.js"])(
    "keeps neighboring function-statement control %s passing",
    async (name) => {
      const file = join(ROOT, name);
      const result = await runTest262File(file, "es5-a17-controls", 120_000, "standalone");
      expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
    },
  );
});
