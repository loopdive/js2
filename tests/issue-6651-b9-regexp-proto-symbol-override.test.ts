// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B9) test262 rows closed by B9. The inline programs
 * live in `issue-6651-b9-regexp-proto-symbol-override-inline.test.ts` (split so
 * one vitest fork never holds both).
 *
 * Every row below fails on the pre-B9 tree. Each one replaces
 * `RegExp.prototype[Symbol.match|search]`, reads it back, and calls
 * `String.prototype.match|search` with a STRING argument, which is
 * `RegExpCreate` + `Invoke(rx, @@match|@@search, «S»)` (§22.1.3.11/.17):
 *
 * - the read-back folded to the builtin singleton
 *   (`tryCompileStandaloneBuiltinProtoIteratorRead`) — now declines when the
 *   file writes the member (`regexp-proto-symbol-writes.ts`);
 * - the String method lowered the builtin body inline — now a real [[Get]] +
 *   Call (`regexp-proto-symbol-invoke.ts`);
 * - `thisVal.flags` on the untyped receiver read the i32 bitfield through the
 *   `__get_member_flags` struct-field arm (`findAlternateStructsForField`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "built-ins/String/prototype/match/invoke-builtin-match.js",
  "built-ins/String/prototype/search/invoke-builtin-search-searcher-undef.js",
  "built-ins/String/prototype/search/invoke-builtin-search.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  EXACT_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, "test", relativePath)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number]) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-6651-cluster-b9",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

describe("#6651 B9 — test262 rows: a replaced RegExp.prototype[@@match|@@search]", () => {
  for (const relativePath of EXACT_ROWS) {
    itWithTest262(
      `test262 standalone: ${relativePath}`,
      async () => {
        const result = await runExactRow(relativePath);
        expect(`${relativePath}: ${result.status}`).toBe(`${relativePath}: pass`);
      },
      200_000,
    );
  }
});
