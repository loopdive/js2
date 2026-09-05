// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616: three defects behind the jest-util deepCyclicCopy bucket (7 tests all
// "dereferencing a null pointer"), each with its own arm here:
//
//  1. Inline member-access `new`: `new (Object.getPrototypeOf(arr).constructor)(n)`
//     kept the ctor INSIDE the callee, so the bare-identifier dynamic-new arm
//     never saw it and the legacy `__new___unknown` fallthrough constructed
//     garbage (len=undefined, isArray false). Property/element-access callees
//     whose static type marks a dynamic ctor now route through the
//     `__construct_closure` bridge (new-super.ts), including in class-free
//     modules (the zero-candidate refusal is lifted for that base).
//
//  2. Rest-param closures in dynamic dispatch: `function spy(...args)` lifts
//     to the same `(self, vec) → res` funcref as a genuine one-vec-param
//     function, so the inline dynamic-call arm positionally cast call arg 0 to
//     the vec type — `illegal cast` on every `f(1, 2)` through an any-typed
//     binding. Rest candidates now pack call args into a fresh vec (calls.ts),
//     and capture-free singletons allocate a rest-marker subtype so the arm
//     can discriminate (method-trampolines.ts).
//
//  3. Object-literal METHOD bodies hoisted nested functions BEFORE
//     pre-allocating var/let/const locals (literals.ts), so a nested fn's
//     capture of a method local (`vi.fn`'s callList) silently missed
//     (`localIdx === undefined`) and the body read null.

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

describe("#4616 inline member-access new (deepCyclicCopy keepPrototype lane)", () => {
  it("constructs a real array from an inline prototype-chain ctor", async () => {
    const exp = await run(
      `
      export function t9(): any {
        const arr: any = [1, 2];
        const n: any = new (Object.getPrototypeOf(arr).constructor)(2);
        return "len=" + String(n.length) + " isArr=" + String(Array.isArray(n));
      }
      export function t10(): any {
        const arr: any = [1, 2];
        const c: any = Object.getPrototypeOf(arr).constructor;
        const n: any = new c(2);
        return "len=" + String(n.length) + " isArr=" + String(Array.isArray(n));
      }`,
      "issue-4616-inline-new.ts",
    );
    expect(exp.t9!()).toBe("len=2 isArr=true");
    expect(exp.t10!()).toBe("len=2 isArr=true");
  });
});

describe("#4616 rest-param closures through dynamic dispatch", () => {
  it("module-level rest fn called via any-typed alias packs all args", async () => {
    const exp = await run(
      `
      function spy(...args: any[]) { return args.length; }
      export function t(): any { const f: any = spy; return String(f(1, 2)); }`,
      "issue-4616-rest-module.ts",
    );
    expect(exp.t!()).toBe("2");
  });

  it("fixed+rest params split correctly", async () => {
    const exp = await run(
      `
      function spy(first: any, ...rest: any[]) { return String(first) + "|" + String(rest.length); }
      export function t(): any { const f: any = spy; return String(f("a", 1, 2)); }`,
      "issue-4616-rest-fixed.ts",
    );
    expect(exp.t!()).toBe("a|2");
  });

  it("capture-free nested rest fn returned as a value", async () => {
    const exp = await run(
      `
      function make(): any {
        function spy(...args: any[]) { return args.length === 0 ? "none" : args[0]; }
        return spy;
      }
      export function t(): any { const f: any = make(); return String(f("x")); }`,
      "issue-4616-rest-nested.ts",
    );
    expect(exp.t!()).toBe("x");
  });

  it("jest vi.fn shape: rest spy with captures, expando mock record, spyOn patch", async () => {
    const exp = await run(
      `
      const spies: any = [];
      const vi: any = {
        fn(implementation?: any) {
          const callList: any = [];
          function spy(...args: any[]) {
            callList.push(args);
            if (typeof implementation === "function") return implementation.apply(this, args);
          }
          spy.mock = { calls: callList };
          spy.mockImplementation = function (next: any) { implementation = next; return spy; };
          spy.mockRestore = function () {};
          return spy;
        },
        spyOn(object: any, key: any) {
          const original = object[key];
          const spy = vi.fn(function (this: any) { return original.apply(this, arguments); });
          spy.mockRestore = function () { object[key] = original; };
          spies.push({ object, key });
          object[key] = spy;
          return spy;
        },
      };
      export function t1(): any {
        const f: any = vi.fn(function (x: any) { return x + 1; });
        return String(f(1)) + "|" + String(f.mock.calls.length);
      }
      export function t4(): any {
        const s: any = vi.spyOn(Array, "isArray").mockImplementation(function () { return true; });
        const r = Array.isArray("not-an-array");
        s.mockRestore();
        return String(r) + "|" + String(s.mock.calls.length);
      }`,
      "issue-4616-vifn.ts",
    );
    expect(exp.t1!()).toBe("2|1");
    expect(exp.t4!()).toBe("true|1");
  });
});

describe("#4616 object-literal method locals visible to hoisted nested fns", () => {
  it("nested fn-decl captures a method-local array (with and without rest)", async () => {
    const exp = await run(
      `
      const vi: any = {
        mk(kind: any) {
          const callList: any = [];
          function restSpy(...args: any[]) { callList.push(args); return callList.length; }
          function plainSpy(a?: any) { callList.push(a); return callList.length; }
          return kind === "rest" ? restSpy : plainSpy;
        },
      };
      export function t(): any {
        const r: any = vi.mk("rest");
        const p: any = vi.mk("plain");
        return String(r(1)) + "|" + String(r(2)) + "|" + String(p("a")) + "|" + String(p("b"));
      }`,
      "issue-4616-method-hoist.ts",
    );
    expect(exp.t!()).toBe("1|2|1|2");
  });
});
