// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B7) test262 rows for §22.2.4.1 `RegExp(pattern,
 * flags)` over an OBJECT pattern (`regexp-ctor-regexp-like.ts`), Annex B
 * `compile`'s spec ToString, and a sentinel-seeded expando slot that later
 * holds a primitive (`object-shape-widening.ts`). The inline programs live in
 * `issue-6651-b7-regexp-ctor-compile-flags-inline.test.ts` (split so one vitest
 * fork never holds both — B5 hit the 512 MB fork heap).
 *
 * Every row below fails on the pre-B7 tree:
 *
 * - `from-regexp-like*` — IsRegExp reads `@@match`, then `source`/`flags` are
 *   read with `Get` (getters run, abrupt completions propagate).
 * - `from-regexp-like-short-circuit` — `RegExp(obj)` returns `obj` itself when
 *   `obj.constructor === RegExp`.
 * - `compile/{pattern,flags}-to-string-err` — a Symbol pattern/flags throws a
 *   TypeError (§7.1.17), not a SyntaxError on its rendered text.
 * - `flags/coercion-global` — `r.global = undefined; r.global = "string"` keeps
 *   the string, so the generic `flags` getter's ToBoolean sees it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "built-ins/RegExp/from-regexp-like.js",
  "built-ins/RegExp/from-regexp-like-get-source-err.js",
  "built-ins/RegExp/from-regexp-like-short-circuit.js",
  "annexB/built-ins/RegExp/prototype/compile/pattern-to-string-err.js",
  "annexB/built-ins/RegExp/prototype/compile/flags-to-string-err.js",
  "built-ins/RegExp/prototype/flags/coercion-global.js",
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
      "issue-6651-cluster-b7",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

describe("#6651 B7 — test262 rows: RegExp ctor over an object, compile ToString, sentinel slot", () => {
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
