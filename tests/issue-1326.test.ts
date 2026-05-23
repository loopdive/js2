// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1326 Phase 1B — Tests for standalone Promise.resolve / Promise.reject.
//
// Phase 1A established the scaffold; Phase 1B replaced the throwing stubs
// for `emitStandalonePromiseResolve` / `emitStandalonePromiseReject` with
// real Wasm-native `$Promise` struct constructions, and auto-enabled
// the standalone path in WASI target mode (`ctx.wasi === true`).
//
// Acceptance:
//   - In WASI mode, `Promise.resolve(42)` compiles AND validates without
//     the `Promise_resolve_import` host import (which would be missing
//     in standalone mode).
//   - In JS-host mode (default), the existing `Promise_resolve_import`
//     path is preserved bit-identical — no behaviour change.
//   - The emitted Wasm has a `$Promise` struct type with state | value |
//     callbacks fields (validated by inspecting the WAT).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import {
  PROMISE_STATE_PENDING,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_REJECTED,
  MICROTASK_QUEUE_INITIAL_SLOTS,
  emitStandalonePromiseThen,
  isStandalonePromiseActive,
} from "../src/codegen/async-scheduler.js";

describe("#1326 — async-scheduler module constants and gates", () => {
  it("exports the right state constants", () => {
    expect(PROMISE_STATE_PENDING).toBe(0);
    expect(PROMISE_STATE_FULFILLED).toBe(1);
    expect(PROMISE_STATE_REJECTED).toBe(2);
  });

  it("exports microtask queue dimensioning", () => {
    // Phase 1C-A: the queue is two WasmGC arrays (funcref + externref), not
    // linear memory. Initial slots = 8,192 — covers most async kernels
    // without forcing a grow on first use. The `SLOT_BYTES` constant from
    // Phase 1A was dropped (linear-memory artifact, never used).
    expect(MICROTASK_QUEUE_INITIAL_SLOTS).toBe(8192);
  });

  it("isStandalonePromiseActive returns false in JS-host mode", () => {
    // Default mode (`ctx.wasi === false`). The existing JS-host Promise
    // path stays bit-identical; non-WASI test262 baseline must not move.
    const fakeCtx = { wasi: false } as unknown as Parameters<typeof isStandalonePromiseActive>[0];
    expect(isStandalonePromiseActive(fakeCtx)).toBe(false);
  });

  it("isStandalonePromiseActive returns true in WASI target mode", () => {
    // WASI mode auto-enables the standalone Promise codegen (1B).
    const wasiCtx = { wasi: true } as unknown as Parameters<typeof isStandalonePromiseActive>[0];
    expect(isStandalonePromiseActive(wasiCtx)).toBe(true);
  });

  it("Phase 1C-B emit helper still throws with sub-slice marker", () => {
    // Phase 1C-A wired emitMicrotaskEnqueue + emitDrainMicrotasks to real
    // Wasm bodies (queue + drain). emitStandalonePromiseThen remains
    // stubbed until Phase 1C-B lands the .then continuation wrappers.
    const fakeCtx = {} as unknown as Parameters<typeof emitStandalonePromiseThen>[0];
    const fakeFctx = {} as unknown as Parameters<typeof emitStandalonePromiseThen>[1];
    expect(() => emitStandalonePromiseThen(fakeCtx, fakeFctx, [], [])).toThrow(/Phase 1C-B/);
  });
});

describe("#1326 Phase 1B — JS-host mode (default) is unchanged", () => {
  // Phase 1B is purely additive for the JS-host path: the standalone
  // branch is gated on `ctx.wasi`, so non-WASI compilation must produce
  // the SAME Wasm bytes (modulo non-deterministic order of new
  // `async-scheduler` registrations, which only fire when the WASI
  // path is taken).
  it("Promise.resolve(value) compiles successfully in JS-host mode", () => {
    const r = compile(`
      export async function test(): Promise<number> {
        return await Promise.resolve(42);
      }
    `);
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
  });

  it("Promise.resolve(...).then(fn) compiles successfully", () => {
    const r = compile(`
      export function test(): number {
        let v = 0;
        Promise.resolve(7).then((x: number) => { v = x; });
        return v;
      }
    `);
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
  });

  it("JS-host mode emits Promise_resolve host import (unchanged)", () => {
    const r = compile(
      `
      export async function test(): Promise<number> {
        return await Promise.resolve(42);
      }
    `,
      { target: "gc" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    // The legacy import path remains for non-WASI builds.
    expect(r.wat).toContain("Promise_resolve");
    // No standalone Promise struct should be registered when wasi=false.
    // The struct's `$state: i32` field is unique to the standalone path.
    expect(r.wat).not.toContain("(field $state");
  });
});

describe("#1326 Phase 1B — WASI mode emits Wasm-native $Promise struct", () => {
  // In WASI mode, `Promise_resolve` and `Promise_reject` host imports are
  // unsatisfiable. Phase 1B replaces them with `struct.new $Promise`.
  // The compiled module must NOT import `env::Promise_resolve` and must
  // contain a `$Promise` struct type definition.
  it("WASI: Promise.resolve(42) compiles + WAT shows no Promise_resolve host import", async () => {
    const r = compile(
      `
      export function test(): number {
        Promise.resolve(42);
        return 1;
      }
    `,
      { target: "wasi" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    // The standalone path uses struct.new $Promise instead of the host
    // import. The legacy Promise_resolve_import name must NOT appear.
    expect(r.wat).not.toContain("Promise_resolve_import");
    expect(r.wat).toContain("(field $state");
    // The compiled binary should validate (no missing-import errors).
    await WebAssembly.compile(r.binary);
  });

  it("WASI: Promise.reject('err') compiles + no Promise_reject host import", async () => {
    const r = compile(
      `
      export function test(): number {
        Promise.reject("err");
        return 1;
      }
    `,
      { target: "wasi" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(r.wat).not.toContain("Promise_reject_import");
    expect(r.wat).toContain("(field $state");
    await WebAssembly.compile(r.binary);
  });

  it("WASI: async function with await Promise.resolve(...) compiles + validates", async () => {
    const r = compile(
      `
      export async function test(): Promise<number> {
        return await Promise.resolve(42);
      }
    `,
      { target: "wasi" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(r.wat).not.toContain("Promise_resolve_import");
    expect(r.wat).toContain("(field $state");
    await WebAssembly.compile(r.binary);
  });
});
