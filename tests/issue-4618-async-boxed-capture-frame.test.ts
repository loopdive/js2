// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618 — React upstream `await act(...)` bodies: two defects in the async
// frame lane, both reduced from React's own tests (ReactChildren, forwardRef,
// ReactStrictMode, ReactCreateElement, …).
//
//  1. A `let` captured by a function declaration hoisted inside a BLOCK (the
//     harness wraps every lifted test body in `try { … }`) is cell-boxed by
//     the function-body hoist BEFORE async activation. The `$AsyncFrame`
//     spill field for it was initialized to `ref.null` instead of that live
//     cell, so the resume function silently dropped `React = require(...)`
//     and the hoisted component read `null` ("Cannot read properties of null
//     (reading 'createElement')").
//  2. A `let x;` assigned only inside a callback has the checker flow type
//     `undefined`. Restored in the resume function as its ref cell, a member
//     read `x.prop` missed the "externref slot" dynamic-read admission and
//     folded to a constant `null` (`instance.props.prop` → undefined).

import { afterEach, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

type HostLib = {
  lib(): { make(x: unknown): { val: unknown } };
  run(cb: () => unknown): Promise<unknown>;
  call(f: (a: unknown) => unknown, a?: unknown): unknown;
};

const g = globalThis as unknown as { __issue4618Host?: HostLib };

async function run(source: string) {
  g.__issue4618Host = {
    lib: () => ({ make: (x: unknown) => ({ val: x }) }),
    run: async (cb) => {
      await Promise.resolve();
      return cb();
    },
    call: (f, a) => f(a),
  };
  const result = await compile(source, { fileName: "issue-4618-boxed-frame.js", skipSemanticDiagnostics: true });
  expect(result.success, result.errors?.map((e) => e.message).join("\n")).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  const hooks = importObject as {
    __setExports?: (e: WebAssembly.Exports) => void;
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  hooks.__setExports?.(instance.exports);
  hooks.__setInstance?.(instance);
  return wrapExports(instance.exports, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  } as never) as Record<string, () => Promise<unknown>>;
}

afterEach(() => {
  g.__issue4618Host = undefined;
});

describe("#4618 async frame keeps boxed captures live", () => {
  it("a block-hoisted function declaration sees the reassigned outer let after an await", async () => {
    const exp = await run(`
      var host = globalThis.__issue4618Host;
      export async function blockHoisted() {
        try {
          let React;
          React = host.lib();
          function Comp(p) { return React.make(p); }
          let out;
          await host.run(() => { out = host.call(Comp, 5); });
          return out && out.val;
        } catch (e) {
          return "ERR " + e.message;
        }
      }
      // Control: the same body without the enclosing block already worked.
      export async function topLevelHoisted() {
        let React;
        React = host.lib();
        function Comp(p) { return React.make(p); }
        let out;
        await host.run(() => { out = host.call(Comp, 6); });
        return out && out.val;
      }
    `);
    expect(await exp.topLevelHoisted!()).toBe(6);
    expect(await exp.blockHoisted!()).toBe(5);
  });

  it("a member read of a callback-assigned let after an await reads the runtime value", async () => {
    const exp = await run(`
      var host = globalThis.__issue4618Host;
      export async function memberAfterAwait() {
        let out;
        await host.run(() => { out = host.lib().make(7); });
        return out.val;
      }
      export async function memberAfterAwaitInExpression() {
        let out;
        await host.run(() => { out = host.lib().make(8); });
        return String(out.val);
      }
      // Controls: a sync read and a guarded read were already correct.
      export function syncMember() {
        let out;
        host.call(() => { out = host.lib().make(9); });
        return out.val;
      }
      export async function guardedMember() {
        let out;
        await host.run(() => { out = host.lib().make(10); });
        return out && out.val;
      }
    `);
    expect(await exp.syncMember!()).toBe(9);
    expect(await exp.guardedMember!()).toBe(10);
    expect(await exp.memberAfterAwait!()).toBe(7);
    expect(await exp.memberAfterAwaitInExpression!()).toBe("8");
  });

  it("a let written as `this` by a class method is readable (directly and through a copy)", async () => {
    const exp = await run(`
      var host = globalThis.__issue4618Host;
      export function syncPromoted() {
        let instance;
        class SyncMounted { constructor(p) { this.props = p; } mount() { instance = this; } }
        new SyncMounted({ prop: "s" }).mount();
        return instance.props.prop;
      }
      export async function asyncPromoted() {
        let instance;
        class AsyncMounted { constructor(p) { this.props = p; } mount() { instance = this; } }
        new AsyncMounted({ prop: "a" }).mount();
        await host.run(() => 1);
        return instance.props.prop;
      }
      export async function copiedBinding() {
        let instance;
        class CopyMounted { constructor(p) { this.props = p; } mount() { instance = this; } }
        new CopyMounted({ prop: "c" }).mount();
        await host.run(() => 1);
        const inst = instance;
        return inst.props.prop;
      }
      // Control: an identity comparison never went through the member read.
      export function identity() {
        let instance;
        class SameMounted { mount() { instance = this; } }
        const c = new SameMounted();
        c.mount();
        return instance === c ? "same" : "different";
      }
    `);
    expect(await exp.identity!()).toBe("same");
    expect(await exp.syncPromoted!()).toBe("s");
    expect(await exp.asyncPromoted!()).toBe("a");
    expect(await exp.copiedBinding!()).toBe("c");
  });

  it("a same-named class declared in a second async function survives an await", async () => {
    const exp = await run(`
      var host = globalThis.__issue4618Host;
      export async function first() {
        class Component { m() { return "first"; } }
        await host.run(() => 1);
        return host.call((C) => new C().m(), Component);
      }
      export async function second() {
        class Component { m() { return "second"; } }
        await host.run(() => 1);
        return host.call((C) => new C().m(), Component);
      }
    `);
    // Control: the first declaration owns the name and reads its global.
    expect(await exp.first!()).toBe("first");
    expect(await exp.second!()).toBe("second");
  });
});
