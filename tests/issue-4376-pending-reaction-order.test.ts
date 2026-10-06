// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(["fulfill", "reject"])("runs pending %s reactions in registration order", async (mode) => {
  const result = await compile(
    `
    let log = 0;
    let settle:any;
    const pending = new Promise((resolve, reject) => { settle = ${mode === "fulfill" ? "resolve" : "reject"}; });
    export function register():void {
      pending.${mode === "fulfill" ? "then" : "catch"}(() => { log=log*10+1; });
      pending.${mode === "fulfill" ? "then" : "catch"}(() => { log=log*10+2; });
      pending.${mode === "fulfill" ? "then" : "catch"}(() => { log=log*10+3; });
    }
    export function complete():void { settle(42); }
    export function observed():number { return log; }
  `,
    { target: "standalone", platform: "deno", hostBridge: "always" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void })?.__setInstance?.(instance);
  const e = instance.exports as unknown as Record<string, Function>;
  e.register();
  e.complete();
  expect(e.observed()).toBe(0);
  e.__drain_microtasks();
  expect(e.observed()).toBe(123);
});

it("keeps reentrant and rejection jobs behind already queued sibling reactions", async () => {
  const result = await compile(
    `
    let log=0;
    let settle:any;
    const marker={reason:42};
    const pending=new Promise(resolve => { settle=resolve; });
    export function register():void {
      pending.then(() => { log=log*10+1; pending.then(() => { log=log*10+4; }); });
      pending.then(() => { log=log*10+2; throw marker; }).catch(reason => { if(reason!==marker) throw new Error("changed reason"); log=log*10+5; });
      pending.then(() => { log=log*10+3; });
    }
    export function complete():void { settle(42); }
    export function observed():number { return log; }
  `,
    { target: "standalone", platform: "deno", hostBridge: "always" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void })?.__setInstance?.(instance);
  const e = instance.exports as unknown as Record<string, Function>;
  e.register();
  e.complete();
  expect(e.observed()).toBe(0);
  e.__drain_microtasks();
  expect(e.observed()).toBe(12345);
});
