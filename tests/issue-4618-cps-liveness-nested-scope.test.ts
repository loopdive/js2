// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618 defect (b), first slice: collectReferencedAfter skipped nested
// function scopes declared BEFORE the await point, so a body const read only
// inside a hoisted function declaration (react's `function ParentComponent()
// { … Fragment … }` before `await act(...)`) was never counted live-across-
// suspend, never spilled, and the post-resume call threw ReferenceError
// "Fragment is not defined" from inside the nested body. Nested scopes are
// now collected regardless of position — a closure created before the await
// is routinely invoked from the resumed continuation.
//
// The full react shape (the hoisted fn's VALUE crossing a host call and the
// post-resume direct call both working) still has a rebinding residual
// documented in #4618; this test locks the liveness half: the nested fn's
// capture resolves (no ReferenceError) and the pre-suspend host crossing
// reads the right value.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-cps-liveness.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

describe("#4618 CPS liveness includes pre-await nested scopes", () => {
  it("a hoisted fn-decl's capture survives the suspend (no ReferenceError)", async () => {
    const exp = await run(`
      const Host: any = { take: (f: any) => ({ f }), Fragment: "frag-sym" };
      async function act(cb: any): Promise<any> { return await cb(); }
      const register: any[] = [];
      function it(name: string, fn: any) { register.push(fn); }
      it("x", async () => {
        const Fragment = Host.Fragment;
        function Parent(u: any): string { return u ? String(Fragment) : "other"; }
        await act(() => {
          (globalThis as any).__mid4618 = String(Host.take(Parent).f(true));
        });
        (globalThis as any).__out4618 = "resumed";
      });
      export async function t(): Promise<string> {
        const p = register[0]();
        if (p && typeof p.then === "function") await p;
        await new Promise((res) => setTimeout(res, 20));
        return String((globalThis as any).__mid4618);
      }`);
    expect(await exp.t!()).toBe("frag-sym");
  });
});
