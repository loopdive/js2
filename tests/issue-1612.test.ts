// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1612 — top-level-await syntax tests with an array-literal operand
// (`void await []`, `if (await []) {}`, …) used to fail to compile with
// "An element access expression should take an argument."
//
// Root cause was in the test262 harness, not the compiler parser: `wrapTest`
// wraps the test body in a *synchronous* `export function test()`, where
// `await` is an ordinary identifier — so `await []` misparses as element
// access on an identifier. The fix emits top-level-await bodies at module top
// level (where `await` is a keyword) and keeps `test()` as a trivial probe of
// the harness `__fail` counter.
//
// These are syntax-only tests (no assertions): a pass is "compiles cleanly".

import { describe, expect, it } from "vitest";

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { compile } from "../src/index.js";
import { wrapTest } from "./test262-runner.js";

const TLA_SYNTAX_DIR = "test262/test/language/module-code/top-level-await/syntax";

function resolveTla(): string {
  const candidates = [resolve(__dirname, "..", TLA_SYNTAX_DIR), `/workspace/${TLA_SYNTAX_DIR}`];
  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {
      // try next
    }
  }
  return candidates[0];
}

function parseMeta(src: string): { features: string[]; flags: string[] } {
  const featM = src.match(/features:\s*\[([^\]]*)\]/);
  const flagM = src.match(/flags:\s*\[([^\]]*)\]/);
  const split = (s: string | undefined) =>
    s
      ? s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
  return { features: split(featM?.[1]), flags: split(flagM?.[1]) };
}

describe("issue #1612 — top-level-await + array-literal operand parses", () => {
  const dir = resolveTla();
  const files = readdirSync(dir).filter((f) => f.includes("array-literal") && f.endsWith(".js"));

  it("discovers the array-literal TLA syntax tests", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const f of files) {
    it(`compiles ${f}`, async () => {
      const src = readFileSync(`${dir}/${f}`, "utf-8");
      const meta = parseMeta(src);
      const { source } = wrapTest(src, meta);
      const r = await compile(source, {
        fileName: "test.ts",
        skipSemanticDiagnostics: true,
      });
      expect(
        r.success,
        `compile failed: ${r.errors
          .slice(0, 1)
          .map((e) => e.message)
          .join("")}`,
      ).toBe(true);
    });
  }
});

describe("issue #1612 — non-TLA wrapping is unaffected", () => {
  it("only rewrites the wrapper when top-level-await is in features", () => {
    // A plain body without the TLA feature flag must still be wrapped inside
    // the synchronous `export function test()` with a try/catch.
    const body = "var x: number = 1;\nassert_sameValue(x, 1);\n";
    const fakeSource = `/*---\nfeatures: []\n---*/\n${body}`;
    const { source } = wrapTest(fakeSource, { features: [], flags: [] });
    expect(source).toContain("export function test(): number {");
    expect(source).toContain("try {");
  });
});
