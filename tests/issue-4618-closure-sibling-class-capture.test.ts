// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: a hoisted function declaration inside a CLOSURE body that references
// a sibling CLASS declared later in the same statement list constructed from
// null — react's ParentComponent → ChildComponent shape. The plain
// function-body lane pre-collects classes in the collection phase, but a
// closure/callback/method body's classes were only collected when their
// statement executed — AFTER hoistFunctionDeclarations compiled the fn body —
// so `new Child()` compiled through the graceful-null identifier fallback.
// hoistFunctionDeclarations now pre-collects sibling class declarations
// (marked deferred so the statement-position compile still fills bodies).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-sibling-class.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4618 sibling class captured by a hoisted fn-decl in a closure body", () => {
  it("dynamically-dispatched sync and async closures construct the class", async () => {
    const exp = await run(`
      const register: any[] = [];
      function it(name: string, fn: any) { register.push(fn); }
      it("sync", () => {
        function Parent(u: any): string { return u ? "A" : new Child().v(); }
        class Child { v(): string { return "B"; } }
        (globalThis as any).__sync4618 = Parent(true) + "," + Parent(false);
      });
      it("async", async () => {
        function Parent(u: any): string { return u ? "A" : new Child().v(); }
        class Child { v(): string { return "B"; } }
        (globalThis as any).__async4618 = Parent(true) + "," + Parent(false);
      });
      export async function t(): Promise<string> {
        for (const fn of register) { const p = fn(); if (p && typeof p.then === "function") await p; }
        const g: any = globalThis;
        return String(g.__sync4618) + " | " + String(g.__async4618);
      }`);
    expect(await (exp.t!() as Promise<string>)).toBe("A,B | A,B");
  });
});
