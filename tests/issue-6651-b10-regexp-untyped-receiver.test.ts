// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B10) test262 rows closed by B10. The inline programs
 * live in `issue-6651-b10-regexp-untyped-receiver-inline.test.ts` (split so one
 * vitest fork never holds both).
 *
 * Every row below fails on the pre-B10 tree. Each one reads a RegExp that
 * came back from `eval` — an `any` binding — and asserts
 * `Object.getPrototypeOf(result) === RegExp.prototype` (answered `null`: the
 * `__getPrototypeOf` native had no `$NativeRegExp` arm) and
 * `result.toString() === '/1/…'` (answered `"null"`: `__extern_get` found
 * `Object.prototype.toString` before `RegExp.prototype.toString`, and the
 * reified `RegExp.prototype.toString` closure body was a null placeholder).
 * See `src/codegen/regexp-untyped-receiver.ts` / `regexp-proto-to-string.ts`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

/**
 * Two lanes, two expected verdicts, every row asserted in both.
 *
 * `eval-block-*` evaluates `{}/1/;`, which the compiler resolves without a
 * runtime eval engine, so it passes on every lane. `eval-{class,fn}-*` needs a
 * REAL runtime eval: under the default (QuickJS) engine it passes. CI's
 * changed-root `quality` lane runs `JS2WASM_EVAL_ENGINE=interpreter` with the
 * REFUSAL provider (`build-runtime-eval-provider.mjs --refusal-only`), where
 * dynamic code throws a TypeError before any RegExp exists. There the pin
 * asserts that exact refusal, so a regression that turned it into any other
 * failure (e.g. the pre-B10 `getPrototypeOf` → null) still fails this test.
 */
const REFUSAL_TIER = process.env.JS2WASM_EVAL_ENGINE === "interpreter";
const REFUSAL_REASON = /dynamic code evaluation is not supported in this standalone build/;

const EXACT_ROWS = [
  { row: "language/statementList/eval-block-regexp-literal.js", runtimeEval: false },
  { row: "language/statementList/eval-block-regexp-literal-flags.js", runtimeEval: false },
  { row: "language/statementList/eval-class-regexp-literal.js", runtimeEval: true },
  { row: "language/statementList/eval-class-regexp-literal-flags.js", runtimeEval: true },
  { row: "language/statementList/eval-fn-regexp-literal.js", runtimeEval: true },
  { row: "language/statementList/eval-fn-regexp-literal-flags.js", runtimeEval: true },
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  EXACT_ROWS.every(({ row }) => existsSync(join(TEST262_ROOT, "test", row)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

async function runExactRow(relativePath: string) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-6651-cluster-b10",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

describe("#6651 B10 — test262 rows: an eval-produced (untyped) RegExp", () => {
  for (const { row, runtimeEval } of EXACT_ROWS) {
    const refused = runtimeEval && REFUSAL_TIER;
    itWithTest262(
      `test262 standalone${refused ? " (refusal lane: asserts the eval refusal)" : ""}: ${row}`,
      async () => {
        const result = await runExactRow(row);
        if (refused) {
          const detail = result as { reason?: string; error?: string };
          expect(`${row}: ${result.status}`).toBe(`${row}: fail`);
          expect(String(detail.reason ?? detail.error ?? "")).toMatch(REFUSAL_REASON);
        } else {
          expect(`${row}: ${result.status}`).toBe(`${row}: pass`);
        }
      },
      200_000,
    );
  }
});
