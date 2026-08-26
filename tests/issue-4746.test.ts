// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4746 — standalone Promise constructor own-property order.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(__dirname, "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262, "harness", "assert.js"));

const abs = (relative: string) => join(TEST262, "test", relative);

async function run(relative: string, target?: "standalone") {
  return runTest262File(abs(relative), "issue-4746", 60_000, target);
}

describe.skipIf(!HAVE_TEST262)("#4746 — Promise constructor property order", () => {
  it("passes the exact row in the host lane", async () => {
    const result = await run("built-ins/Promise/property-order.js");
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });

  it("passes the exact row in the standalone lane", async () => {
    const result = await run("built-ins/Promise/property-order.js", "standalone");
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });

  // Object's constructor carrier exercises the same own-key reflection path
  // without depending on Promise's native async state or callback closures.
  it.each([undefined, "standalone"] as const)("keeps Object constructor order in %s", async (target) => {
    const result = await run("built-ins/Object/property-order.js", target ?? undefined);
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });
});
