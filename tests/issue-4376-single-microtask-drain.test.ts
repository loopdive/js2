// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { MICROTASK_QUEUE_INITIAL_SLOTS } from "../src/codegen/async-scheduler.js";
import type { CompileOptions } from "../src/index.js";

it.each<CompileOptions>([
  { target: "standalone", standaloneMicrotaskNotifyImport: { module: "host", name: "notify" } },
  { target: "standalone", link: ["host"], standaloneMicrotaskNotifyImport: { module: "host", name: "" } },
  { target: "standalone", link: ["host"], standaloneMicrotaskNotifyImport: { module: "", name: "notify" } },
  { target: "host", link: ["host"], standaloneMicrotaskNotifyImport: { module: "host", name: "notify" } },
])("refuses an invalid microtask notification binding %#", async (options) => {
  await expect(compile("export function run():number { return 42; }", options)).rejects.toThrow(
    "standaloneMicrotaskNotifyImport requires standalone",
  );
});

async function instance(source: string) {
  const result = await compile(source, { target: "standalone", platform: "deno", hostBridge: "always" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const wasm = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  (result.importObject as { __setInstance?: (value: WebAssembly.Instance) => void })?.__setInstance?.(wasm);
  const e = wasm.exports as unknown as Record<string, Function>;
  expect(typeof e.__drain_one_microtask).toBe("function");
  return e;
}

it.each([
  "export function notify():void {}",
  "declare function notify(value:number):void; export function hostCall():void { notify(42); }",
])("refuses a notification name collision instead of calling another function %#", async (declaration) => {
  const result = await compile(
    `${declaration}
    export function register():void { Promise.resolve(42).then(value => value); }
  `,
    {
      target: "standalone",
      platform: "deno",
      externImportModule: "host",
      link: ["host"],
      standaloneMicrotaskNotifyImport: { module: "host", name: "notify" },
    },
  );
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.errors)).toContain("native microtask notification");
});

it.each(["fulfill", "reject"])("drains exactly one pending %s reaction without running its siblings", async (mode) => {
  const e = await instance(`
    let log=0;
    let settle:any;
    const p=new Promise((resolve,reject) => { settle=${mode === "fulfill" ? "resolve" : "reject"}; });
    export function register():void {
      p.${mode === "fulfill" ? "then" : "catch"}(() => { log=log*10+1; });
      p.${mode === "fulfill" ? "then" : "catch"}(() => { log=log*10+2; });
      p.${mode === "fulfill" ? "then" : "catch"}(() => { log=log*10+3; });
    }
    export function complete():void { settle(42); }
    export function observed():number { return log; }
  `);
  expect(e.__microtasks_pending()).toBe(0);
  e.__drain_one_microtask();
  e.register();
  e.complete();
  expect(e.__microtasks_pending()).toBe(3);
  for (const [log, pending] of [
    [1, 2],
    [12, 1],
    [123, 0],
  ]) {
    e.__drain_one_microtask();
    expect(e.observed()).toBe(log);
    expect(e.__microtasks_pending()).toBe(pending);
  }
  e.__drain_one_microtask();
  expect(e.observed()).toBe(123);
});

it("leaves reentrant chained jobs queued until the next step", async () => {
  const e = await instance(`
    let log=0;
    export function register():void {
      Promise.resolve(42).then(v => { log=log*10+1; return v; })
        .then(v => { log=log*10+2; return v; })
        .then(v => { log=log*10+3; return v; });
    }
    export function observed():number { return log; }
  `);
  e.register();
  expect(e.__microtasks_pending()).toBe(1);
  for (const log of [1, 12]) {
    e.__drain_one_microtask();
    expect(e.observed()).toBe(log);
    expect(e.__microtasks_pending()).toBe(1);
  }
  e.__drain_microtasks();
  expect(e.observed()).toBe(123);
  expect(e.__microtasks_pending()).toBe(0);
});

it("steps a grown queue and retains the old complete-drain API", async () => {
  const e = await instance(`
    let count=0;
    export function register(n:number):void {
      for(let i=0;i<n;i++) Promise.resolve(42).then(() => { count++; });
    }
    export function observed():number { return count; }
  `);
  const jobs = MICROTASK_QUEUE_INITIAL_SLOTS + 1;
  e.register(jobs);
  expect(e.__microtasks_pending()).toBe(jobs);
  e.__drain_one_microtask();
  expect(e.observed()).toBe(1);
  expect(e.__microtasks_pending()).toBe(jobs - 1);
  e.__drain_microtasks();
  expect(e.observed()).toBe(jobs);
  expect(e.__microtasks_pending()).toBe(0);
});

it("notifies one shared host queue in enqueue order across two graphs and native work", async () => {
  const jobs: (() => void)[] = [];
  const observed: number[] = [];
  const makeGraph = async () => {
    const result = await compile(
      `
      declare function record(value:number):void;
      export function register(marker:number):void {
        Promise.resolve(42).then(() => { record(marker); })
          .then(() => { record(marker+10); });
      }
    `,
      {
        target: "standalone",
        platform: "deno",
        externImportModule: "v8x:deno",
        link: ["v8x:deno"],
        standaloneMicrotaskNotifyImport: { module: "v8x:deno", name: "notify" },
      },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(
      WebAssembly.Module.imports(module)
        .map((entry) => [entry.module, entry.name, entry.kind])
        .sort(),
    ).toEqual([
      ["v8x:deno", "notify", "function"],
      ["v8x:deno", "record", "function"],
    ]);
    const wasm = new WebAssembly.Instance(module, {
      "v8x:deno": {
        record: (value: number) => observed.push(value),
        notify: () => {
          expect(e.__microtasks_pending()).toBeGreaterThan(0);
          jobs.push(() => e.__drain_one_microtask());
        },
      },
    });
    const e = wasm.exports as unknown as Record<string, Function>;
    return e;
  };
  const a = await makeGraph();
  const b = await makeGraph();
  a.register(1);
  b.register(2);
  jobs.push(() => observed.push(3));
  expect(jobs).toHaveLength(3);
  expect(observed).toEqual([]);
  while (jobs.length) jobs.shift()!();
  expect(observed).toEqual([1, 2, 3, 11, 12]);
  expect(a.__microtasks_pending()).toBe(0);
  expect(b.__microtasks_pending()).toBe(0);
});
