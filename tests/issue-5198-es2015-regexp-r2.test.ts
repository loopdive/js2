// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5198 Slice A — observable RegExpBuiltinExec lastIndex behavior.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

type Lane = "host" | "standalone";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "built-ins/RegExp/prototype/exec/failure-lastindex-access.js",
  "built-ins/RegExp/prototype/exec/success-lastindex-access.js",
  "built-ins/RegExp/prototype/exec/u-lastindex-adv.js",
  "built-ins/RegExp/prototype/exec/y-fail-lastindex-no-write.js",
  "built-ins/RegExp/prototype/exec/y-fail-lastindex.js",
  "built-ins/RegExp/prototype/exec/y-fail-return.js",
  "built-ins/RegExp/prototype/test/y-fail-lastindex-no-write.js",
  "built-ins/RegExp/prototype/test/y-fail-lastindex.js",
  "built-ins/RegExp/prototype/test/y-fail-return.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  EXACT_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, "test", relativePath)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number], lane: Lane) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-5198-slice-a",
      180_000,
      lane === "standalone" ? lane : undefined,
    );
  } finally {
    restoreHostBuiltins();
  }
}

async function runStandaloneIdentityScopeControl(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-5198-lastindex-identity-scope.ts",
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#5198 RegExpBuiltinExec lastIndex Slice A", () => {
  for (const lane of ["host", "standalone"] as const) {
    for (const relativePath of EXACT_ROWS) {
      itWithTest262(`${lane}: ${relativePath}`, { timeout: 200_000 }, async () => {
        const result = await runExactRow(relativePath, lane);
        expect(`${result.status}: ${result.error ?? ""}`, `${lane} ${relativePath}`).toBe("pass: ");
      });
    }
  }

  it("keeps same-shape unrelated objects on normal ToPrimitive after raw lastIndex", async () => {
    expect(
      await runStandaloneIdentityScopeControl(`
        function addOne(value: any): number { return value + 1; }
        type Value = { valueOf: () => number };
        function makeValue(number: number): Value {
          return { valueOf: function () { return number; } };
        }
        export function test(): number {
          const assigned = makeValue(4);
          const unrelated = makeValue(7);
          const regexp = /a/;
          // @ts-expect-error RegExp.lastIndex stores this object opaquely.
          regexp.lastIndex = assigned;
          return addOne(unrelated);
        }
      `),
    ).toBe(8);
  });

  it("keeps the no-raw-slot baseline for the same-shape object (A/B)", async () => {
    expect(
      await runStandaloneIdentityScopeControl(`
        function addOne(value: any): number { return value + 1; }
        type Value = { valueOf: () => number };
        function makeValue(number: number): Value {
          return { valueOf: function () { return number; } };
        }
        export function test(): number {
          const unrelated = makeValue(7);
          const regexp = /a/;
          regexp.lastIndex = 0;
          return addOne(unrelated);
        }
      `),
    ).toBe(8);
  });
});
