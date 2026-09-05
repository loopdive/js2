// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: the `__call_fn_N` / `__call_fn_method_N` dispatchers terminated in a
// bare `ref.null.extern` when the callee matched NO closure-struct arm — but a
// callable that crossed the host boundary and came back (react's
// `Children.forEach(children, callback, ctx)` passes the jest-mock callback
// through an extern method call; the compiled wrapper then runs
// `forEachFunc.apply(this, arguments)`) is a genuine HOST function there, and
// the invocation was silently dropped — every ReactChildren mock-args/count
// test (react 97 → 109/146 on this fix). The terminal now calls
// `__call_function_<arity>(fn, thisArg, args…)` for a non-null unmatched
// callee in the host lane.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string, fileName: string) {
  const result = await compile(source, { testRuntime: true, fileName, skipSemanticDiagnostics: true });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4618 unmatched-callable dispatch falls back to the host call", () => {
  it("react Children.forEach shape: method wrapper applies a boundary-crossed callback", async () => {
    const exp = await run(
      `
      function mapish(children, fn, ctx) { fn.call(ctx, children, 0); return 1; }
      var Children = {
        forEach: function (children, forEachFunc, forEachContext) {
          mapish(
            children,
            function () {
              forEachFunc.apply(this, arguments);
            },
            forEachContext
          );
        },
        count: function (children) {
          var n = 0;
          mapish(children, function () { n++; });
          return n;
        }
      };
      export function drive() {
        let hits = 0;
        Children.forEach("kid", function (k, i) { hits++; }, {});
        return String(hits) + "|" + String(Children.count("kid"));
      }`,
      "issue-4618-children-foreach.js",
    );
    expect(exp.drive!()).toBe("1|1");
  });

  it("jest-mock callable through the same lane keeps its call record", async () => {
    const exp = await run(
      `
      function __jestFn2(implementation) {
        var impl = typeof implementation === "function" ? implementation : null;
        function mock() {
          var args = Array.prototype.slice.call(arguments);
          mock.mock.calls.push(args);
          if (impl) return impl.apply(this, args);
          return undefined;
        }
        mock.mock = { calls: [] };
        return mock;
      }
      function mapish(children, fn, ctx) { fn.call(ctx, children, 0); return 1; }
      var Children = {
        forEach: function (children, forEachFunc, forEachContext) {
          mapish(children, function () { forEachFunc.apply(this, arguments); }, forEachContext);
        }
      };
      export function drive() {
        let hits = 0;
        const cb = __jestFn2(function (k, i) { hits++; return k; });
        Children.forEach("kid", cb, {});
        return String(hits) + "|" + String(cb.mock.calls.length) + "|" + String(cb.mock.calls[0][0]) + "|" + String(cb.mock.calls[0][1]);
      }`,
      "issue-4618-children-mock.js",
    );
    expect(exp.drive!()).toBe("1|1|kid|0");
  });
});
