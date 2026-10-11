// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B) §22.1.3 step 2 — `String.prototype.{match,replace,search,
 * split}` must `GetMethod(searchValue, @@<protocol>)` and call it, standalone.
 *
 * The seven exact test262 rows are the acceptance set. The two source-level
 * controls pin the properties whose loss would be SILENT: an object with NO
 * protocol method must still reach the ordinary `ToString` lane **and still
 * satisfy a typed `string[]` consumer** (a probe that leaked its externref
 * carrier compiles green and fails at instantiate), and the plain string /
 * RegExp search-value lanes must be untouched — a probe that swallowed either
 * would break `"a,b".split(",")` itself.
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
  "built-ins/String/prototype/match/cstm-matcher-get-err.js",
  "built-ins/String/prototype/match/cstm-matcher-invocation.js",
  "built-ins/String/prototype/replace/cstm-replace-invocation.js",
  "built-ins/String/prototype/search/cstm-search-get-err.js",
  "built-ins/String/prototype/search/cstm-search-invocation.js",
  "built-ins/String/prototype/split/cstm-split-get-err.js",
  "built-ins/String/prototype/split/cstm-split-invocation.js",
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
      "issue-6651-cluster-b",
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

describe("#6651 B — String.prototype @@protocol dispatch (standalone)", () => {
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

  it("an absent @@split falls through to the string lane and keeps the typed carrier", async () => {
    const value = await runStandalone(
      `
      export function test(): number {
        // No @@split anywhere: the probe admits (the search value is an
        // ordinary object), finds nothing at runtime, and the ordinary
        // ToString lane must still produce the two parts — AND the result
        // must still satisfy a \`string[]\` local, which is what catches a
        // probe that leaks its externref carrier into a typed consumer.
        const sep = { toString: function () { return ","; } };
        const parts: string[] = "a,b".split(sep);
        return parts.length;
      }
      `,
      "issue-6651-null-protocol.ts",
    );
    expect(value).toBe(2);
  });

  it("leaves the ordinary string and RegExp search-value lanes alone", async () => {
    const value = await runStandalone(
      `
      export function test(): number {
        const parts: string[] = "a,b,c".split(",");
        const at: number = "abc".search(/b/);
        const replaced: string = "xbx".replace(/b/, "y");
        return parts.length * 100 + at * 10 + (replaced === "xyx" ? 1 : 0);
      }
      `,
      "issue-6651-protocol-controls.ts",
    );
    expect(value).toBe(311);
  });
});
