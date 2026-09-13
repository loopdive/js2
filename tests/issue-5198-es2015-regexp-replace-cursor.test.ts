// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5198 C3a — static/backend-created RegExp @@replace cursor behavior.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

type Lane = "host" | "standalone";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const REPLACE_CURSOR_ROWS = [
  "built-ins/RegExp/prototype/Symbol.replace/g-init-lastindex-err.js",
  "built-ins/RegExp/prototype/Symbol.replace/y-init-lastindex.js",
  "built-ins/RegExp/prototype/Symbol.replace/y-set-lastindex.js",
  "built-ins/RegExp/prototype/Symbol.replace/y-fail-lastindex.js",
  "built-ins/RegExp/prototype/Symbol.replace/y-fail-lastindex-no-write.js",
  "built-ins/RegExp/prototype/Symbol.replace/y-fail-return.js",
  "built-ins/RegExp/prototype/Symbol.replace/y-fail-global-return.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  REPLACE_CURSOR_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, "test", relativePath)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

// Each row performs a synchronous standalone compile. Let Vitest drain its
// reporter RPCs between rows so a correct batch does not end in an unrelated
// onTaskUpdate timeout under a single fork.
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

async function runReplaceCursorRow(relativePath: (typeof REPLACE_CURSOR_ROWS)[number], lane: Lane) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-5198-replace-cursor",
      180_000,
      lane === "standalone" ? lane : undefined,
    );
  } finally {
    restoreHostBuiltins();
  }
}

describe("#5198 static RegExp @@replace cursor C3a", () => {
  for (const lane of ["host", "standalone"] as const) {
    for (const relativePath of REPLACE_CURSOR_ROWS) {
      itWithTest262(`${lane}: ${relativePath}`, { timeout: 200_000 }, async () => {
        const result = await runReplaceCursorRow(relativePath, lane);
        expect(`${result.status}: ${result.error ?? ""}`, `${lane} ${relativePath}`).toBe("pass: ");
      });
    }
  }
});
