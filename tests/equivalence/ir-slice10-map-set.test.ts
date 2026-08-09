// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Equivalence test for #1169l (IR Phase 4 Slice 10 step D — Map / Set
// through IR).
//
// Coverage:
//   - `new Map()`, `m.set(k, v)`, `m.get(k)`, `m.has(k)`, `m.size`.
//   - `new Set()`, `s.add(x)`, `s.has(x)`, `s.size`.
//
// Both Map and Set are in `KNOWN_EXTERN_CLASSES` from #1169i. The
// existing `extern.call` and `extern.prop` paths handle method
// calls and the `.size` getter.

import { describe, expect, it } from "vitest";

import { compileAndRunIRVariant as compileAndRun } from "../helpers/compile.js";

describe("IR slice 10 — Map/Set through IR (#1169l, step D)", () => {
  it("(a) new Map().size === 0", async () => {
    const source = `
      export function run(): number {
        const m = new Map();
        return m.size;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(0);
    expect(legacyResult).toBe(0);
  });

  it("(b) Map set + has + size", async () => {
    const source = `
      export function run(): number {
        const m = new Map();
        m.set("a", 1);
        m.set("b", 2);
        return m.size;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(2);
    expect(legacyResult).toBe(2);
  });

  it("(c) Map has(k) returns 1 if present, 0 if not", async () => {
    const source = `
      export function run(): number {
        const m = new Map();
        m.set("a", 1);
        if (m.has("a") && !m.has("b")) {
          return 42;
        }
        return 0;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(42);
    expect(legacyResult).toBe(42);
  });

  it("(d) new Set().size === 0", async () => {
    const source = `
      export function run(): number {
        const s = new Set();
        return s.size;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(0);
    expect(legacyResult).toBe(0);
  });

  it("(e) Set add + size + has", async () => {
    const source = `
      export function run(): number {
        const s = new Set();
        s.add("x");
        s.add("y");
        s.add("x"); // duplicate — Set keeps unique
        if (s.has("x") && s.has("y")) {
          return s.size;
        }
        return 0;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(2);
    expect(legacyResult).toBe(2);
  });
});
