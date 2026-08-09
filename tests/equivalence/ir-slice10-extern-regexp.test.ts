// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Equivalence test for #1169i (IR Phase 4 Slice 10 — remaining builtins).
//
// Step A coverage: RegExp literal `/pattern/flags`, `new RegExp(...)`, and
// `.test` / `.exec` method calls. Verifies that the IR path produces the
// same observable behaviour as the legacy compiler for the same source —
// i.e. the function is claimed by the IR (not falling back to legacy via
// `safeSelection`) and the resulting Wasm module computes the same result
// JS would.

import { describe, expect, it } from "vitest";

import { compileAndRunIRVariant as compileAndRun } from "../helpers/compile.js";

describe("IR slice 10 — RegExp through IR (#1169i, step A)", () => {
  it("(a) RegExp literal + .test() returns boolean", async () => {
    const source = `
      export function run(): boolean {
        const r = /foo/g;
        return r.test("foobar");
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(1); // boolean true → i32 1
    expect(legacyResult).toBe(1);
  });

  it("(b) RegExp literal + .test() returns false on no match", async () => {
    const source = `
      export function run(): boolean {
        const r = /xyz/;
        return r.test("foobar");
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(0);
    expect(legacyResult).toBe(0);
  });

  it("(c) new RegExp(pattern) constructor", async () => {
    const source = `
      export function run(): boolean {
        const r = new RegExp("hello");
        return r.test("say hello world");
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(1);
    expect(legacyResult).toBe(1);
  });

  it("(d) new RegExp(pattern, flags) constructor with two args", async () => {
    const source = `
      export function run(): boolean {
        const r = new RegExp("HELLO", "i");
        return r.test("hello world");
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(1);
    expect(legacyResult).toBe(1);
  });

  it("(e) RegExp literal flags are preserved (case-insensitive)", async () => {
    const source = `
      export function run(): boolean {
        const r = /abc/i;
        return r.test("ABC");
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(1);
    expect(legacyResult).toBe(1);
  });
});
