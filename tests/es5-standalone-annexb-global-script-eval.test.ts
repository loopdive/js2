// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Focused standalone coverage for Annex B rows that execute a fresh global
 * Script through the Test262 `$262.evalScript` host hook.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const GLOBAL_SCRIPT_EVAL_ROWS = [
  "annexB/language/eval-code/direct/script-decl-lex-no-collision.js",
  "annexB/language/global-code/script-decl-lex-collision.js",
] as const;

const GLOBAL_SCRIPT_EVAL_CONTROLS = [
  "annexB/language/global-code/block-decl-global-existing-global-init.js",
  "annexB/language/global-code/block-decl-global-existing-non-enumerable-global-init.js",
  "annexB/language/global-code/if-decl-no-else-global-existing-global-init.js",
  "annexB/language/global-code/if-decl-no-else-global-existing-non-enumerable-global-init.js",
] as const;

async function runAnnexBRow(file: string) {
  return runTest262File(join("test262/test", file), "es5-annexb-global-script-eval", 120_000, "standalone");
}

describe("ES5 Annex B standalone global Script eval", () => {
  it.each(GLOBAL_SCRIPT_EVAL_ROWS)("passes the exact residual row %s", async (file) => {
    const result = await runAnnexBRow(file);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(GLOBAL_SCRIPT_EVAL_CONTROLS)("keeps the neighboring global declaration control %s passing", async (file) => {
    const result = await runAnnexBRow(file);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
