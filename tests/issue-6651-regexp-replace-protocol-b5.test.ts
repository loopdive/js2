// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B5) §22.2.6.11 `RegExp.prototype[@@replace]`, generic
 * over an Object receiver, standalone: the collect loop, the per-result
 * `[[Get]]`s on an arbitrary result object, a functional replacer's argument
 * list, and GetSubstitution over captured STRINGS — reached from the reflective
 * closure and from the direct `re[Symbol.replace](…)` spelling (B3's route).
 *
 * The exact rows each pin a different step:
 *
 * - `result-coerce-length` — `$1$2$3` against `ToLength(length)` = 3 captures:
 *   the in-range indices substitute, `$3` stays literal.
 * - `result-coerce-index-undefined` — `` $` `` with `position` from a
 *   `@@toPrimitive` index (hint "number").
 * - `result-coerce-capture` — a capture object's `toString` (not `valueOf`).
 * - `result-coerce-matched-global` — the global collect loop advances an empty
 *   match's `lastIndex`.
 * - `fn-invoke-args-empty-result` — the replacer receives «matched, position,
 *   S» for an EMPTY result (`"undefined"`, 0, S).
 * - `g-pos-decrement` — a result whose position precedes `nextSourcePosition`
 *   is skipped.
 * - `arg-1-coerce` — `ToString(string)` runs inside the method.
 *
 * Seven rows, and the inline cases live in
 * `issue-6651-regexp-replace-protocol-b5-inline.test.ts`, for the same reason
 * as the `@@split` suite: one 512 MB vitest fork per file does not hold many
 * more in-process test262 compiles. The inline cases pin GetSubstitution
 * pattern by pattern, the replacer's argument list and the global collect loop
 * on a real RegExp.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "built-ins/RegExp/prototype/Symbol.replace/arg-1-coerce.js",
  "built-ins/RegExp/prototype/Symbol.replace/fn-invoke-args-empty-result.js",
  "built-ins/RegExp/prototype/Symbol.replace/g-pos-decrement.js",
  "built-ins/RegExp/prototype/Symbol.replace/result-coerce-capture.js",
  "built-ins/RegExp/prototype/Symbol.replace/result-coerce-index-undefined.js",
  "built-ins/RegExp/prototype/Symbol.replace/result-coerce-length.js",
  "built-ins/RegExp/prototype/Symbol.replace/result-coerce-matched-global.js",
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
      "issue-6651-cluster-b5r",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

describe("#6651 B5 — RegExp.prototype[@@replace], generic, standalone", () => {
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
