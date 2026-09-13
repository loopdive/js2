// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5198 continuation — static and dynamic RegExp @@match sticky cursor.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

type Lane = "host" | "standalone";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const CURSOR_ROWS = ["built-ins/RegExp/prototype/Symbol.match/y-fail-global-return.js"] as const;

type Test262Row = (typeof CURSOR_ROWS)[number];

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  CURSOR_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, "test", relativePath)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

async function runMatchRow(relativePath: Test262Row, lane: Lane) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-5198-match-cursor",
      180_000,
      lane === "standalone" ? lane : undefined,
    );
  } finally {
    restoreHostBuiltins();
  }
}

async function runStandaloneStickyControl(): Promise<number> {
  const result = await compile(
    `
      function invoke(receiver: any, regexp: any): any {
        return String.prototype.match.call(receiver, regexp);
      }
      export function test(): number {
        // Runtime flags must reach the shared native match-all caller, rather
        // than the compile-time static /g fast path.
        const sticky: any = /a/gy;
        const stickyMatches = invoke("aaba", sticky);
        if (stickyMatches === null || stickyMatches.length !== 2) return 1;

        const global: any = /a/g;
        const globalMatches = invoke("aaba", global);
        if (globalMatches === null || globalMatches.length !== 3) return 2;

        return 0;
      }
    `,
    {
      fileName: "issue-5198-dynamic-match-sticky-control.ts",
      target: "standalone",
    },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#5198 static RegExp @@match sticky cursor", () => {
  for (const lane of ["host", "standalone"] as const) {
    for (const relativePath of CURSOR_ROWS) {
      itWithTest262(`${lane}: cursor row ${relativePath}`, { timeout: 200_000 }, async () => {
        const result = await runMatchRow(relativePath, lane);
        expect(`${result.status}: ${result.error ?? ""}`, `${lane} ${relativePath}`).toBe("pass: ");
      });
    }
  }

  it("preserves dynamic sticky dispatch through borrowed String.prototype.match", async () => {
    expect(await runStandaloneStickyControl()).toBe(0);
  });
});
