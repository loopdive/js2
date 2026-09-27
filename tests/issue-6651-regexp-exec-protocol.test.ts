// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B2; carries #5198 Slice B / draft PR #5393's pinned
 * contract) §22.2.7.1 RegExpExec — `RegExp.prototype[@@search]` and
 * `[@@match]` must read `exec` through an ordinary `[[Get]]`, call a callable
 * override with the regexp as `this`, propagate its abrupt completions, reject
 * a non-Object non-null result, and admit a NON-RegExp receiver that supplies
 * `exec`.
 *
 * The ten exact test262 rows are the acceptance set. They are listed in full
 * rather than summarised because each one pins a different observable step, and
 * a substrate that loses any single one of them still looks green on the others:
 *
 * - `get-lastindex-err` / `lastindex-no-restore` — the §22.2.6.12 lastIndex
 *   save/restore, including that there are exactly TWO reads and that the
 *   restoring `Set` is conditional.
 * - `set-lastindex-init` / `set-lastindex-restore` — those `Set`s actually run.
 * - `match-err` — the custom `exec`'s abrupt completion propagates, AND
 *   `lastIndex` is left at the value the init `Set` wrote (not restored).
 * - `cstm-exec-return-index` / `success-get-index-err` — the result's `index` is
 *   read through a real `Get` off whatever object `exec` returned.
 * - `@@match/this-val-non-regexp` — the brand-check widening, stated as
 *   directly as test262 can state it: `.call(objWithExec)` must NOT throw and
 *   `.call(objWithoutExec)` MUST throw a TypeError. One row, both halves.
 * - `@@match/get-flags-err` — step 4's `flags` Get precedes everything, and
 *   `global`/`unicode` are NOT read separately.
 * - `@@match/g-get-exec-err` — the global arm still performs its
 *   `Set(rx, "lastIndex", +0)` and its first RegExpExec.
 *
 * The three source-level controls pin what would be lost SILENTLY: the ordinary
 * `RegExp.prototype.test`/`.exec` reflective lane must keep its brand check (the
 * widening moved that check, it did not delete it), and the static
 * `"…".search(/…/)` fast lane must still answer through the native engine.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "built-ins/RegExp/prototype/Symbol.match/g-get-exec-err.js",
  "built-ins/RegExp/prototype/Symbol.match/get-flags-err.js",
  "built-ins/RegExp/prototype/Symbol.match/this-val-non-regexp.js",
  "built-ins/RegExp/prototype/Symbol.search/cstm-exec-return-index.js",
  "built-ins/RegExp/prototype/Symbol.search/get-lastindex-err.js",
  "built-ins/RegExp/prototype/Symbol.search/lastindex-no-restore.js",
  "built-ins/RegExp/prototype/Symbol.search/match-err.js",
  "built-ins/RegExp/prototype/Symbol.search/set-lastindex-init.js",
  "built-ins/RegExp/prototype/Symbol.search/set-lastindex-restore.js",
  "built-ins/RegExp/prototype/Symbol.search/success-get-index-err.js",
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
      "issue-6651-cluster-b2",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

/** Compile standalone, assert no host import leaked, and run the `test` export. */
async function runStandalone(source: string, fileName: string): Promise<number> {
  const result = await compile(source, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#6651 B2 — observable RegExpExec substrate (standalone)", () => {
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

  it("control — the reflective .test brand check still rejects a non-RegExp receiver", async () => {
    // The widening moved the brand check into RegExpExec step 5; it must not
    // have moved for the members that genuinely require the internal slot.
    const source = `
export function test(): number {
  const m: any = (RegExp.prototype as any).test;
  try {
    m.call({}, "a");
    return 1;
  } catch (e) {
    return 2;
  }
}
`;
    expect(await runStandalone(source, "b2-brand-control.ts")).toBe(2);
  }, 200_000);

  it("control — the static String.prototype.search fast lane is unchanged", async () => {
    const source = `
export function test(): number {
  return "a string".search(/string/);
}
`;
    expect(await runStandalone(source, "b2-static-search-control.ts")).toBe(2);
  }, 200_000);

  it("control — the static RegExp.prototype.exec lane still returns its match array", async () => {
    const source = `
export function test(): number {
  const m = /b(c)/.exec("abcd");
  if (m === null) return -1;
  return m.index;
}
`;
    expect(await runStandalone(source, "b2-static-exec-control.ts")).toBe(1);
  }, 200_000);
});
