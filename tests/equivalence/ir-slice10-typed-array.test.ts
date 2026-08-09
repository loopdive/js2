// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Equivalence test for #1169j (IR Phase 4 Slice 10 step B — TypedArray
// through IR).
//
// Step B coverage:
//   - `new <TypedArray>(N)` construction (Uint8/Int8/.../Float64/BigInt64
//     element types).
//   - `arr.length` (the TypedArray length getter through `extern.prop`).
//   - `arr[i]` element read (lowered through the new extern element-access
//     path) — see the issue for the dispatch decision.
//   - `arr[i] = v` element write.
//
// Each test compiles the same source with `experimentalIR: true` (forces
// the IR claim path) and `experimentalIR: false` (legacy direct-emit) and
// asserts both paths produce identical observable results.

import { describe, expect, it } from "vitest";

import { compileAndRunIRVariant as compileAndRun } from "../helpers/compile.js";

describe("IR slice 10 — TypedArray through IR (#1169j, step B)", () => {
  it("(a) new Uint8Array(N) compiles and instantiates cleanly", async () => {
    const source = `
      export function run(): number {
        const a = new Uint8Array(8);
        return a.length;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(8);
    expect(legacyResult).toBe(8);
  });

  it("(b) new Int32Array(N) — different element type", async () => {
    const source = `
      export function run(): number {
        const a = new Int32Array(4);
        return a.length;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(4);
    expect(legacyResult).toBe(4);
  });

  it("(c) new Float64Array(N) — float element type", async () => {
    const source = `
      export function run(): number {
        const a = new Float64Array(3);
        return a.length;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(3);
    expect(legacyResult).toBe(3);
  });

  it("(d) arr[i] read on Uint8Array (element index 0)", async () => {
    const source = `
      export function run(): number {
        const a = new Uint8Array(4);
        return a[0];
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(0); // newly-allocated Uint8Array starts at 0
    expect(legacyResult).toBe(0);
  });

  it("(e) arr[i] = v write then read round-trips", async () => {
    const source = `
      export function run(): number {
        const a = new Uint8Array(4);
        a[2] = 42;
        return a[2];
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(42);
    expect(legacyResult).toBe(42);
  });
});
