// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1326 — Tests for standalone Promise resolve/reject and Promise.then.
//
// Phase 1A established the scaffold; later slices replaced the throwing
// Promise stubs with real Wasm-native `$Promise` struct construction and
// microtask-drained `.then` continuations in WASI mode.
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

  it("keeps the standalone Promise gate tied to WASI mode", () => {
    expect(isStandalonePromiseActive({ wasi: true } as Parameters<typeof isStandalonePromiseActive>[0])).toBe(true);
  });
});

describe("#1326 Phase 1B — JS-host mode (default) is unchanged", () => {
  // Phase 1B is purely additive for the JS-host path: the standalone
  // branch is gated on `ctx.wasi`, so non-WASI compilation must produce
  // the SAME Wasm bytes (modulo non-deterministic order of new
  // `async-scheduler` registrations, which only fire when the WASI
  // path is taken).
  it("Promise.resolve(value) compiles successfully in JS-host mode", async () => {
    const r = await compile(`
      export async function test(): Promise<number> {
        return await Promise.resolve(42);
      }
    `);
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
  });

  it("Promise.resolve(...).then(fn) compiles successfully", async () => {
    const r = await compile(`
      export function test(): number {
        let v = 0;
        Promise.resolve(7).then((x: number) => { v = x; });
        return v;
      }
    `);
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
  });

  it("JS-host mode emits Promise_resolve host import (unchanged)", async () => {
    const r = await compile(
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
    const r = await compile(
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
    const r = await compile(
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
    const r = await compile(
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

describe("#1326 Phase 1C-B — WASI microtask queue + Promise.then", () => {
  async function instantiateWasi(source: string): Promise<WebAssembly.Exports> {
    const r = await compile(source, { target: "wasi" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(r.wat).toContain('__drain_microtasks"');
    expect(r.wat).not.toContain("Promise_then");
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    (instance.exports._start as (() => void) | undefined)?.();
    return instance.exports;
  }

  it("runs a fulfilled .then callback only after __drain_microtasks", async () => {
    const exports = await instantiateWasi(`
      let out = 0;
      export function schedule(): number {
        Promise.resolve(7).then((x: number) => {
          out = x + 1;
          return out;
        });
        return out;
      }
      export function value(): number { return out; }
    `);

    expect((exports.schedule as () => number)()).toBe(0);
    (exports.__drain_microtasks as () => void)();
    expect((exports.value as () => number)()).toBe(8);
  });

  it("drains chained .then callbacks in microtask order", async () => {
    const exports = await instantiateWasi(`
      let out = 0;
      export function schedule(): number {
        Promise.resolve(1)
          .then((x: number) => x + 1)
          .then((x: number) => {
            out = x * 2;
            return out;
          });
        return out;
      }
      export function value(): number { return out; }
    `);

    expect((exports.schedule as () => number)()).toBe(0);
    (exports.__drain_microtasks as () => void)();
    expect((exports.value as () => number)()).toBe(4);
  });

  it("routes rejected promises through the onRejected continuation", async () => {
    const exports = await instantiateWasi(`
      let out = 0;
      export function schedule(): number {
        Promise.reject(5).then(undefined, (reason: number) => {
          out = reason + 2;
          return out;
        });
        return out;
      }
      export function value(): number { return out; }
    `);

    expect((exports.schedule as () => number)()).toBe(0);
    (exports.__drain_microtasks as () => void)();
    expect((exports.value as () => number)()).toBe(7);
  });

  // (#2165) Standalone `.catch(onRejected)` ≡ `.then(undefined, onRejected)`.
  // Removes the `Promise_catch` / `__make_callback` host-import leak in WASI
  // mode (the `instantiateWasi` helper asserts no `Promise_then` import, which
  // also covers the catch lowering since it routes through the same native
  // then-machinery).
  it("routes a rejected promise through .catch in WASI mode", async () => {
    const exports = await instantiateWasi(`
      let out = 0;
      export function schedule(): number {
        Promise.reject(5).catch((reason: number) => {
          out = reason + 3;
          return out;
        });
        return out;
      }
      export function value(): number { return out; }
    `);

    expect((exports.schedule as () => number)()).toBe(0);
    (exports.__drain_microtasks as () => void)();
    expect((exports.value as () => number)()).toBe(8);
  });

  it("a fulfilled promise skips its .catch handler in WASI mode", async () => {
    const exports = await instantiateWasi(`
      let out = 0;
      export function schedule(): number {
        Promise.resolve(10).catch((_reason: number) => {
          out = 999;
          return out;
        }).then((v: number) => {
          out = v;
          return out;
        });
        return out;
      }
      export function value(): number { return out; }
    `);

    expect((exports.schedule as () => number)()).toBe(0);
    (exports.__drain_microtasks as () => void)();
    // catch is skipped (no rejection); the fulfilled value (10) flows through.
    expect((exports.value as () => number)()).toBe(10);
  });
});
