// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1695 — DisposableStack/AsyncDisposableStack stored-callback writeback fires
 * before the callback runs.
 *
 * `compileArrowAsCallback` registered a one-shot post-call writeback
 * (`pendingCallbackWritebacks`) for captured-mutable locals. For
 * `stack.defer(() => { x++; })` the writeback fires right after `defer`
 * returns — but `defer` only STORES the disposer; the mutation only happens
 * later when `dispose()` runs it. The pending writeback snapshots the still-
 * zero ref cell into the outer local; no second writeback re-syncs after
 * dispose.
 *
 * Fix: route writebacks through `persistentCallbackWritebacks` when the
 * callback is an argument to a stored-callback method on
 * DisposableStack / AsyncDisposableStack (defer / use / adopt). Persistent
 * writebacks are re-emitted after every subsequent call in the function, so
 * the post-dispose ref-cell value flows back to the outer local. Receiver-
 * type-gated so a user-defined `class Foo { defer(cb) {} }` is unaffected.
 */

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const exp = instance.exports as Record<string, unknown>;
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(exp);
  }
  const fn = exp.test as (() => unknown) | undefined;
  if (typeof fn !== "function") throw new Error("no test() export");
  return fn();
}

describe("#1695 DisposableStack deferred-callback writeback", () => {
  it("defer captures mutation — outer local sees post-dispose value", async () => {
    const src = `
      export function test(): number {
        const stack = new DisposableStack();
        let called = 0;
        stack.defer(() => { called = called + 1; });
        stack.dispose();
        return called === 1 ? 1 : 7777;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("defer with multiple mutable captures", async () => {
    const src = `
      export function test(): number {
        const stack = new DisposableStack();
        let a = 0;
        let b = 0;
        stack.defer(() => { a = 1; b = 2; });
        stack.dispose();
        return (a === 1 && b === 2) ? 1 : 7777;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("multiple defers — both writebacks observed after dispose", async () => {
    const src = `
      export function test(): number {
        const stack = new DisposableStack();
        let first = 0;
        let second = 0;
        stack.defer(() => { first = 1; });
        stack.defer(() => { second = 2; });
        stack.dispose();
        return (first === 1 && second === 2) ? 1 : 7777;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("adopt — second-arg disposer captures outer let", async () => {
    const src = `
      export function test(): number {
        const stack = new DisposableStack();
        let n = 0;
        stack.adopt(42, (v: number) => { n = v; });
        stack.dispose();
        return n === 42 ? 1 : 7777;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("AsyncDisposableStack.defer behaves the same shape", async () => {
    // We don't await disposeAsync here (out of scope) — we just verify the
    // module compiles and the persistent-writeback flag does not crash the
    // callback emission for the async-stack variant.
    const src = `
      export function test(): number {
        const stack = new AsyncDisposableStack();
        let touched = 0;
        stack.defer(() => { touched = 1; });
        // Don't dispose — just verify compile + register codegen path is sound.
        return touched === 0 ? 1 : 7777;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("negative: user class with .defer() must NOT take persistent path", async () => {
    // The receiver-type gate restricts promotion to DisposableStack /
    // AsyncDisposableStack. A user class with a method named `defer` that
    // invokes its callback synchronously must continue to work via the
    // legacy one-shot writeback path (or no writeback at all).
    const src = `
      class Q {
        defer(cb: () => void): void { cb(); }
      }
      export function test(): number {
        const q = new Q();
        let n = 0;
        q.defer(() => { n = 1; });
        return n === 1 ? 1 : 7777;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
