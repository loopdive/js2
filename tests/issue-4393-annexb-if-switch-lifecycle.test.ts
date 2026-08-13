import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const lifecycleCases = [
  "annexB/language/function-code/block-decl-func-init.js",
  "annexB/language/function-code/if-decl-else-decl-a-func-init.js",
  "annexB/language/function-code/if-decl-else-decl-b-func-init.js",
  "annexB/language/function-code/if-decl-else-stmt-func-init.js",
  "annexB/language/function-code/if-decl-no-else-func-init.js",
  "annexB/language/function-code/if-stmt-else-decl-func-init.js",
  "annexB/language/function-code/switch-case-func-init.js",
  "annexB/language/function-code/switch-dflt-func-init.js",
] as const;

const existingBindingCases = [
  "annexB/language/function-code/block-decl-func-existing-fn-no-init.js",
  "annexB/language/function-code/if-decl-else-decl-a-func-existing-fn-no-init.js",
  "annexB/language/function-code/if-decl-else-decl-b-func-existing-fn-no-init.js",
  "annexB/language/function-code/if-decl-else-stmt-func-existing-fn-no-init.js",
  "annexB/language/function-code/if-decl-no-else-func-existing-fn-no-init.js",
  "annexB/language/function-code/if-stmt-else-decl-func-existing-fn-no-init.js",
  "annexB/language/function-code/switch-case-func-existing-fn-no-init.js",
  "annexB/language/function-code/switch-dflt-func-existing-fn-no-init.js",
] as const;

const existingBindingUpdateCases = [
  "annexB/language/function-code/block-decl-func-existing-fn-update.js",
  "annexB/language/function-code/if-decl-else-decl-a-func-existing-fn-update.js",
  "annexB/language/function-code/if-decl-else-decl-b-func-existing-fn-update.js",
  "annexB/language/function-code/if-decl-else-stmt-func-existing-fn-update.js",
  "annexB/language/function-code/if-decl-no-else-func-existing-fn-update.js",
  "annexB/language/function-code/if-stmt-else-decl-func-existing-fn-update.js",
  "annexB/language/function-code/switch-case-func-existing-fn-update.js",
  "annexB/language/function-code/switch-dflt-func-existing-fn-update.js",
] as const;

describe("#4393 Annex B statement-position function lifecycle", () => {
  for (const relative of lifecycleCases) {
    for (const lane of [undefined, "standalone"] as const) {
      const laneName = lane ?? "host";
      it(`${relative} passes in ${laneName}`, async () => {
        const result = await runTest262File(resolve("test262/test", relative), "issue-4393", 120_000, lane);
        expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
      }, 180_000);
    }
  }

  for (const relative of existingBindingCases) {
    for (const lane of [undefined, "standalone"] as const) {
      const laneName = lane ?? "host";
      it(`${relative} preserves its existing binding in ${laneName}`, async () => {
        const result = await runTest262File(resolve("test262/test", relative), "issue-4393", 120_000, lane);
        expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
      }, 180_000);
    }
  }

  for (const relative of existingBindingUpdateCases) {
    for (const lane of [undefined, "standalone"] as const) {
      const laneName = lane ?? "host";
      it(`${relative} updates its existing binding in ${laneName}`, async () => {
        const result = await runTest262File(resolve("test262/test", relative), "issue-4393", 120_000, lane);
        expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
      }, 180_000);
    }
  }
});
