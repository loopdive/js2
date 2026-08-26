// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4745 — host Reflect.deleteProperty must retract a closed-struct field from
// the runtime own-property view, including when the call happens during the
// Test262 module-initialization path before the callback exports are wired.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join("test262", "test");
const HAVE_TEST262 = existsSync(join(TEST262, "built-ins", "Reflect", "deleteProperty", "delete-properties.js"));

const run = (relative: string, target?: "standalone") =>
  runTest262File(join(TEST262, relative), "issue-4745", 30_000, target);

describe.skipIf(!HAVE_TEST262)("#4745 — Reflect.deleteProperty struct tombstones", () => {
  it.each([
    "built-ins/Reflect/deleteProperty/delete-properties.js",
    "built-ins/Reflect/deleteProperty/return-boolean.js",
  ])("host exact row passes: %s", async (relative) => {
    const result = await run(relative);
    expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
  });

  it.each([
    "built-ins/Reflect/deleteProperty/delete-symbol-properties.js",
    "built-ins/Reflect/deleteProperty/target-is-not-object-throws.js",
    "built-ins/Reflect/deleteProperty/target-is-symbol-throws.js",
  ])("host control remains passing: %s", async (relative) => {
    const result = await run(relative);
    expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
  });

  it("keeps the standalone boolean-return control passing", async () => {
    const result = await run("built-ins/Reflect/deleteProperty/return-boolean.js", "standalone");
    expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
  });
});
