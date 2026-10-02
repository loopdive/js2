// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B8) test262 rows closed by B8. The inline programs
 * live in `issue-6651-b8-regexp-protocol-tail-inline.test.ts` (split so one
 * vitest fork never holds both — B5 hit the 512 MB fork heap).
 *
 * Every row below fails on the pre-B8 tree:
 *
 * - `@@match/g-match-empty-coerce-lastindex-err` — the `exec` override returns
 *   `null | { get 0() {…} }`; the closure's wasm return type was the checker's
 *   STRUCT for the literal, so the host-object result null-dropped on the
 *   return-path `ref.test` and the getter never ran (`index.ts`
 *   `resolveWasmTypeForClosureReturn` now looks through the union).
 * - `@@match/g-match-empty-set-lastindex-err` — `var r; r = /./g;` makes `r`
 *   `any`, and `r[Symbol.match]('')` compiled to NOTHING (the refusal was
 *   absorbed by the statement fallback); `regexp-symbol-any-receiver.ts`.
 * - `annexB/…/compile/flags-to-string` — `subject.compile('a', 'i')` drops `g`,
 *   but the `.test` lane kept the literal's static flags
 *   (`regexp-compile-binding.ts`).
 * - `String.prototype.replace/cstm-replace-get-err` — a ONE-argument
 *   `''.replace(obj)` was the #1474 compile refusal; the runtime dispatcher now
 *   takes it with `replaceValue = undefined` (`string-replace-dynamic.ts`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "built-ins/RegExp/prototype/Symbol.match/g-match-empty-coerce-lastindex-err.js",
  "built-ins/RegExp/prototype/Symbol.match/g-match-empty-set-lastindex-err.js",
  "annexB/built-ins/RegExp/prototype/compile/flags-to-string.js",
  "built-ins/String/prototype/replace/cstm-replace-get-err.js",
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
      "issue-6651-cluster-b8",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

describe("#6651 B8 — test262 rows: union returns, any-receiver @@ calls, compile flags, 1-arg replace", () => {
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
