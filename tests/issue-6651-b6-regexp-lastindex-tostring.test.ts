// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B6) test262 rows for a `$NativeRegExp`'s own
 * `lastIndex` data property at RUN TIME — the dynamic `[[Get]]`/`[[Set]]`/
 * `[[DefineOwnProperty]]` arms of `regexp-lastindex-carrier.ts` — plus §7.1.17
 * ToString(Symbol) in the RegExp `@@` protocol and §22.1.3.23's own step order.
 * The inline programs live in `issue-6651-b6-regexp-lastindex-tostring-inline.test.ts`
 * (split so one vitest fork never holds both — B5 hit the 512 MB fork heap).
 *
 * Every row below fails on the pre-B6 tree. Each pins a different observable:
 *
 * - `@@replace/coerce-lastindex` — a dynamic `Get(rx,"lastIndex")` returns the
 *   RAW object a static write deferred, so ToLength runs its `valueOf`.
 * - `@@match/g-init-lastindex-err` — `Object.defineProperty(r,'lastIndex',
 *   {writable:false})` is recorded at run time and the protocol's
 *   `Set(rx,"lastIndex",0,true)` throws.
 * - `@@search/set-lastindex-init-err` — the protocol's `Set` is STRICT on an
 *   ordinary object with a non-writable `lastIndex`, too.
 * - `@@split/coerce-string-err` — ToString(Symbol) throws inside `@@split`.
 * - `compile/pattern-regexp-immutable-lastindex` — RegExpInitialize's `Set`
 *   throws after the program was replaced, and the defined value survives.
 * - `String.prototype.split/limit-touint32-error` — ToUint32(limit) precedes
 *   ToString(separator).
 * - `String.prototype.split/this-value-tostring-error` — step 2's
 *   `GetMethod(separator, @@split)` + Call run before ToString(this).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "built-ins/RegExp/prototype/Symbol.replace/coerce-lastindex.js",
  "built-ins/RegExp/prototype/Symbol.match/g-init-lastindex-err.js",
  "built-ins/RegExp/prototype/Symbol.search/set-lastindex-init-err.js",
  "built-ins/RegExp/prototype/Symbol.split/coerce-string-err.js",
  "annexB/built-ins/RegExp/prototype/compile/pattern-regexp-immutable-lastindex.js",
  "built-ins/String/prototype/split/limit-touint32-error.js",
  "built-ins/String/prototype/split/this-value-tostring-error.js",
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
      "issue-6651-cluster-b6",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

describe("#6651 B6 — test262 rows: runtime lastIndex carrier, ToString(Symbol), split order", () => {
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
