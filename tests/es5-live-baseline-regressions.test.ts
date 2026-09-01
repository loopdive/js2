// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = "test262";
const TEST262 = join(TEST262_ROOT, "test");
const TEST262_READY = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

const CURRENT_ES5_ROWS = [
  "annexB/language/function-code/if-decl-else-decl-a-func-init.js",
  "annexB/language/function-code/if-decl-else-decl-b-func-init.js",
  "annexB/language/function-code/if-decl-else-stmt-func-init.js",
  "annexB/language/function-code/if-decl-no-else-func-init.js",
  "annexB/language/function-code/if-stmt-else-decl-func-init.js",
  "language/comments/S7.4_A5.js",
] as const;

describe.skipIf(!TEST262_READY)("current ES5 standalone baseline regressions", () => {
  it.each(CURRENT_ES5_ROWS)("passes %s", async (file) => {
    const result = await runTest262File(join(TEST262, file), "es5-live-baseline", 120_000, "standalone");
    expect(result.status, result.error ?? result.reason ?? file).toBe("pass");
  });
});
