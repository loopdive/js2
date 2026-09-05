// Focused standalone coverage for redeclared function bindings in with scopes.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const ROOT = "test262/test/language/statements/function";

describe("ES5 S13.2.2_A19_T8 redeclared with-scoped function binding", () => {
  it.each(["S13.2.2_A19_T8.js", "S13.2.2_A19_T7.js"])("preserves closure-map semantics for %s", async (name) => {
    const file = join(ROOT, name);
    const result = await runTest262File(file, "es5-a19", 120_000, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
