// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: three name-keyed/pass-keyed defects around class-method captures of
// enclosing locals (react's `componentDidMount() { test = this; }` shape):
//  1. `promoteAccessorCapturesToGlobals` skipped any name present in funcMap,
//     so a MODULE-level `function test` (the react shim's registrar) blocked
//     promotion of a same-named enclosing `let test` — the method wrote a
//     phantom cell. Now a local that provably shadows a module-level function
//     (no funcMapOwnerDecl, not a hoisted value binding) still promotes.
//  2. The #2818 defer heuristic's `wouldPromote` carried the same veto, so a
//     TRY-nested class under the collision compiled EAGERLY (before the
//     block-let initialises) and promotion never fired at all.
//  3. A RE-compile of the enclosing body (module-init runs a discovery pass
//     and a final pass with `capturedGlobals` CLEARED in between) hit the
//     class's already-compiled early return and left the frame reading a
//     fresh local while the methods (compiled once, in pass 1) wrote the
//     pass-1 global. Per-class capture records (classMemberCaptureGlobals)
//     now re-bind the same globals on the re-compile.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function instantiate(source: string, fileName: string) {
  const result = await compile(source, { testRuntime: true, fileName, skipSemanticDiagnostics: true });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4618 class-method writes to enclosing locals under name/pass hazards", () => {
  it("module-level `function test` does not block promotion of a shadowing local (try-wrapped async)", async () => {
    (globalThis as Record<string, unknown>).__act4618mc = async (cb: () => void) => {
      cb();
    };
    let grabbed: (new () => { m(): unknown }) | null = null;
    (globalThis as Record<string, unknown>).__grab4618mc = (f: new () => { m(): unknown }) => {
      grabbed = f;
    };
    (globalThis as Record<string, unknown>).__mk4618mc = () => {
      const F = grabbed!;
      new F().m();
    };
    const exp = await instantiate(
      `
      export function test(): any { return "module-test"; }
      export async function t(): Promise<any> {
        "use strict";
        try {
          const act: any = (globalThis as any).__act4618mc;
          let test: any;
          class Foo {
            m(): any { test = this; return null; }
            render(): any { return null; }
          }
          await act(() => { (globalThis as any).__grab4618mc(Foo); (globalThis as any).__mk4618mc(); });
          return test == null ? "NULL" : "SET:" + (typeof test.m);
        } catch (e) {
          return "ERR:" + String(e);
        }
      }`,
      "issue-4618-mc-collision.ts",
    );
    expect(await exp.t!()).toBe("SET:function");
  });

  it("re-compiled async ARROW body (module-init double pass) keeps method writes visible", async () => {
    (globalThis as Record<string, unknown>).__act4618mc2 = async (cb: () => void) => {
      cb();
    };
    let grabbed: (new () => { m(): unknown }) | null = null;
    (globalThis as Record<string, unknown>).__grab4618mc2 = (f: new () => { m(): unknown }) => {
      grabbed = f;
    };
    (globalThis as Record<string, unknown>).__mk4618mc2 = () => {
      const F = grabbed!;
      new F().m();
    };
    let registered: (() => Promise<void>) | null = null;
    (globalThis as Record<string, unknown>).__runner4618mc2 = (fn: () => Promise<void>) => {
      registered = fn;
    };
    (globalThis as Record<string, unknown>).__kick4618mc2 = () => registered!();
    const reports: string[] = [];
    (globalThis as Record<string, unknown>).__report4618mc2 = (s: string) => {
      reports.push(s);
    };
    const exp = await instantiate(
      `
      const runner: any = (globalThis as any).__runner4618mc2;
      runner(async () => {
        const act: any = (globalThis as any).__act4618mc2;
        let test: any = null;
        class Foo {
          m(): any { test = this; return null; }
          render(): any { return null; }
        }
        await act(() => { (globalThis as any).__grab4618mc2(Foo); (globalThis as any).__mk4618mc2(); });
        (globalThis as any).__report4618mc2(test === null ? "NULL" : "SET");
      });
      export function kick(): any { return (globalThis as any).__kick4618mc2(); }`,
      "issue-4618-mc-recompile.ts",
    );
    await exp.kick!();
    expect(reports).toEqual(["SET"]);
  });
});
