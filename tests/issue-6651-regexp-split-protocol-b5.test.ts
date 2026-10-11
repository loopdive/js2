// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B5) §22.2.6.14 `RegExp.prototype[@@split]`, generic
 * over an Object receiver, standalone: SpeciesConstructor, the splitter
 * Construct, ToUint32(limit), and the sticky splitter walk over B2's
 * observable RegExpExec — reached from the reflective closure AND from the
 * direct `re[Symbol.split](…)` spelling (B3's route).
 *
 * The exact rows each pin a different step:
 *
 * - `species-ctor-y` / `coerce-flags` — the species constructor receives
 *   `newFlags` (step 7: `y` appended exactly when absent, `ToString(flags)`).
 * - `species-ctor-species-non-ctor` — a non-constructor `@@species` is a
 *   TypeError (and the direct spelling reaches the body, not the static core).
 * - `species-ctor-ctor-undef` — an own `constructor = undefined` is the
 *   default lane (and the `.constructor` WRITE no longer binds the
 *   `Object_set_constructor` host import).
 * - `limit-0-bail` — `lim = 0` answers `[]` before any exec.
 * - `str-set-lastindex-match` — the walk's `lastIndex` Set per position.
 * - Annex B `Symbol.match-getter-recompiles-source` — the default splitter's
 *   `IsRegExp` read of `@@match` runs before the receiver's slots are cloned.
 *
 * Seven rows, not every row that went green, and the inline cases live in
 * `issue-6651-regexp-split-protocol-b5-inline.test.ts`: each file gets one
 * 512 MB vitest fork (`VITEST_FORK_MAX_OLD_SPACE_SIZE`), and these in-process
 * test262 compiles plus the inline cases exhausted it once `@@replace`'s body
 * joined the RegExp glue (B5b). The inline cases cover the steps the dropped
 * rows pinned (captures + `ToLength(length)`, the limit, the default lane).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "annexB/built-ins/RegExp/prototype/Symbol.split/Symbol.match-getter-recompiles-source.js",
  "built-ins/RegExp/prototype/Symbol.split/coerce-flags.js",
  "built-ins/RegExp/prototype/Symbol.split/limit-0-bail.js",
  "built-ins/RegExp/prototype/Symbol.split/species-ctor-ctor-undef.js",
  "built-ins/RegExp/prototype/Symbol.split/species-ctor-species-non-ctor.js",
  "built-ins/RegExp/prototype/Symbol.split/species-ctor-y.js",
  "built-ins/RegExp/prototype/Symbol.split/str-set-lastindex-match.js",
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
      "issue-6651-cluster-b5",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

describe("#6651 B5 — RegExp.prototype[@@split], generic, standalone", () => {
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
