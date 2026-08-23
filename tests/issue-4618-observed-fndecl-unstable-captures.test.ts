// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: an OBSERVED function declaration (value returned / properties
// assigned) whose captures are not final at function entry (`var impl = …`
// assigned just above it) was SKIPPED by prepareHoistedFunctionValueBindings
// — every read, including SELF-reads inside the body, re-materialized a
// fresh closure struct, so jest's `__jestFn` shape (`function mock()` with
// `mock.mock = {calls: []}` written after the declaration) threw
// "Cannot read properties of null (reading 'push')" the moment any mock was
// invoked — the direct mechanism behind react's console-spy/mock buckets.
// Such declarations now ride the cyclic ref-cell strategy: the cell's
// identity is fixed at entry and the closure is materialized into it at the
// declaration statement, where every captured value is live.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

describe("#4618 observed fn-decl with entry-unstable captures", () => {
  it("jest __jestFn shape: self-read sees post-decl props; calls tracked across host/compiled", async () => {
    const result = await compile(
      `
      function maker(implementation: any): any {
        var impl = typeof implementation === "function" ? implementation : null;
        function mock(this: any): any {
          var args = Array.prototype.slice.call(arguments);
          (mock as any).mock.calls.push(args);
          if (impl) return (impl as any).apply(this, args);
          return undefined;
        }
        (mock as any).mock = { calls: [] };
        return mock;
      }
      const m: any = maker(null);
      export function callIt(x: any): any { m(x); return 1; }
      export function callCount(): any { return m.mock.calls.length; }
      export function getM(): any { return m; }`,
      { testRuntime: true, fileName: "issue-4618-observed-fndecl.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, {
      signatures: (result as { exportSignatures?: unknown }).exportSignatures,
    }) as Record<string, (...args: unknown[]) => unknown>;

    expect((exp.callIt as (x: unknown) => unknown)("a")).toBe(1);
    expect((exp.callCount as () => unknown)()).toBe(1);
    // a HOST-side invocation of the mock must not throw and must be tracked
    const m = (exp.getM as () => (...args: unknown[]) => unknown)();
    expect(() => m("b")).not.toThrow();
    expect((exp.callCount as () => unknown)()).toBe(2);
  });
});
