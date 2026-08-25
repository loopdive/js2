import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(process.cwd(), "test262", "test");

describe("#4713 — for-of head var scope without a variable environment", () => {
  it("passes the exact for-of head-scope row", async () => {
    const result = await runTest262File(
      join(TEST262, "language/statements/for-of/scope-head-var-none.js"),
      "issue-4713",
      30_000,
    );
    expect(result.status, JSON.stringify(result)).toBe("pass");
  });

  it("passes the related classic-for and for-in head controls", async () => {
    for (const file of [
      "language/statements/for-in/scope-head-var-none.js",
      "language/statements/for/scope-head-var-none.js",
    ]) {
      const result = await runTest262File(join(TEST262, file), "issue-4713-control", 30_000);
      expect(result.status, `${file}: ${JSON.stringify(result)}`).toBe("pass");
    }
  });

  it("retains the passing for-of var-bound-name and body controls", async () => {
    for (const file of [
      "language/statements/for-of/head-var-bound-names-dup.js",
      "language/statements/for-of/head-var-bound-names-in-stmt.js",
      "language/statements/for-of/head-var-bound-names-let.js",
      "language/statements/for-of/scope-body-var-none.js",
    ]) {
      const result = await runTest262File(join(TEST262, file), "issue-4713-control", 30_000);
      expect(result.status, `${file}: ${JSON.stringify(result)}`).toBe("pass");
    }
  });
});
