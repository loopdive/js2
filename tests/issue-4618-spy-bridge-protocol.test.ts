// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: a jest-style spy stored on a HOST object (`spyOn(console,'log')`)
// crossed as the BARE dynamic closure bridge — a plain host function that
// drops the closure's sidecar surface, so `console.log.mockRestore()` /
// `console.log.mock.calls` after installing the spy answered undefined and
// react's console-spy assertions (StrictMode "does not disable logs" family)
// could never pass. Fixes:
//  1. the dynamic bridge stamps live non-enumerable accessors for the mock
//     PROTOCOL props (gated on a sidecar carrying `mock` — stamping every
//     prop-carrying closure broke acorn wholesale);
//  2. the callable wrapper's get trap serves %Function.prototype% members
//     (`.call`/`.apply`) so host capability adapters can invoke the spy;
//  3. `__extern_get` resolves props through a bridge's registered raw closure.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

describe("#4618 spy stored on a host object keeps its mock protocol", () => {
  it("console spy: calls tracked, mock/mockRestore visible through console.log", async () => {
    const result = await compile(
      `
      function __jestFn(implementation: any): any {
        var impl = typeof implementation === "function" ? implementation : null;
        function mock(this: any): any {
          var args = Array.prototype.slice.call(arguments);
          (mock as any).mock.calls.push(args);
          if (impl) return (impl as any).apply(this, args);
          return undefined;
        }
        (mock as any).mock = { calls: [] };
        (mock as any).mockImplementation = function (next: any) {
          impl = typeof next === "function" ? next : null;
          return mock;
        };
        return mock;
      }
      function spyOn(target: any, key: any): any {
        var original = target[key];
        var m = __jestFn(original);
        (m as any).mockRestore = function () { target[key] = original; return m; };
        target[key] = m;
        return m;
      }
      export function t(): any {
        const spy: any = spyOn(console, 'log');
        spy.mockImplementation(() => {});
        (console as any).log('foo 1');
        console.log('foo 2');
        const n = spy.mock.calls.length;
        const viaConsole: any = (console as any).log;
        const same = viaConsole === spy;
        const restoreType = typeof viaConsole.mockRestore;
        (console as any).log.mockRestore();
        return String(n) + "|" + String(same) + "|" + restoreType;
      }`,
      { testRuntime: true, fileName: "issue-4618-spy-bridge.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, {
      signatures: (result as { exportSignatures?: unknown }).exportSignatures,
    }) as Record<string, () => unknown>;
    const origLog = console.log;
    try {
      expect(exp.t!()).toBe("2|true|function");
    } finally {
      console.log = origLog;
    }
  });
});
