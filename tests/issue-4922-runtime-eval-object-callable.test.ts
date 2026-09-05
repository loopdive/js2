// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262");
const TEST262_AVAILABLE = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const ROW = "built-ins/DataView/prototype/setUint32/detached-buffer.js";

describe.skipIf(!TEST262_AVAILABLE)("#4922 runtime-eval object callable carrier", () => {
  it("keeps the standalone detachArrayBuffer property callable", { timeout: 120_000 }, async () => {
    const result = await runTest262File(
      join(TEST262_ROOT, "test", ROW),
      "issue-4922-callable-carrier",
      120_000,
      "standalone",
    );
    expect(result.status, `${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
