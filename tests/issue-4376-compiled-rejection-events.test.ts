// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { buildPromiseRejectionEvent } from "../src/runtime/wasmgc/promise/rejection-event-bodies.js";
import { promiseRejectionDispatcher } from "../src/codegen/promise-rejection-dispatch.js";
import type { CodegenContext } from "../src/codegen/context/types.js";

it.each([
  "function __v8x_deno_promise_reject_dispatch():void {}",
  "function __v8x_deno_promise_reject_dispatch(event:string,promise:any,reason:any):void {}",
  "function __v8x_deno_promise_reject_dispatch(event:number,promise:number,reason:any):void {}",
  "function __v8x_deno_promise_reject_dispatch(event:number,promise:any,reason:any):number {return 1;}",
  "async function __v8x_deno_promise_reject_dispatch(event:number,promise:any,reason:any):Promise<void> {}",
  "declare function __v8x_deno_promise_reject_dispatch(event:number,promise:any,reason:any):void;",
])("refuses an incompatible reserved dispatcher before producing a binary: %s", async (declaration) => {
  const result = await compile(`${declaration} export function run():any {return Promise.reject(42);}`, {
    target: "standalone",
    platform: "deno",
    hostBridge: "always",
    link: ["env"],
  });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.errors)).toMatch(/rejection dispatcher must be/);
});

it("refuses an uninspectable target instead of guessing its signature", () => {
  const ctx = {
    funcMap: new Map([["__v8x_deno_promise_reject_dispatch", 0]]),
    numImportFuncs: 0,
    mod: { functions: [], types: [] },
    asyncFunctions: new Set(),
  } as unknown as CodegenContext;
  expect(() => promiseRejectionDispatcher(ctx)).toThrow("rejection dispatcher must be");
});

async function fixture(body: string, notify = true) {
  const events: { event: number; promise: unknown; reason: unknown }[] = [];
  const result = await compile(
    `
    declare function recordEvent(event:number, promise:any, reason:any):void;
    ${
      notify
        ? `export function __v8x_deno_promise_reject_dispatch(event:number, promise:any, reason:any):void {
      recordEvent(event,promise,reason);
    }`
        : ""
    }
    const marker={token:42};
    export function original():any { return marker; }
    ${body}
  `,
    {
      target: "standalone",
      platform: "deno",
      hostBridge: "always",
      externImportModule: "v8x:events",
      link: ["v8x:events"],
    },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(module, {
    ...result.importObject,
    "v8x:events": {
      recordEvent: (event: number, promise: unknown, reason: unknown) => events.push({ event, promise, reason }),
    },
  });
  (result.importObject as { __setInstance?: (value: WebAssembly.Instance) => void })?.__setInstance?.(instance);
  return { events, e: instance.exports as unknown as Record<string, Function> };
}

it("reports rejection transitions from a dependency with the dispatcher defined in the entry module", async () => {
  const events: { event: number; promise: unknown; reason: unknown }[] = [];
  const result = await compileMulti(
    {
      "/events/entry.ts": `
      import {reject,attach,original} from "./dependency.ts";
      declare function recordEvent(event:number,promise:any,reason:any):void;
      export function __v8x_deno_promise_reject_dispatch(event:number,promise:any,reason:any):void {recordEvent(event,promise,reason);}
      export function run():any {return reject();}
      export function handle():void {attach();}
      export function reason():any {return original();}
    `,
      "/events/dependency.ts": `
      const marker={token:42};
      let promise:any;
      export function reject():any {promise=Promise.reject(marker);return promise;}
      export function attach():void {promise.catch(()=>42);}
      export function original():any {return marker;}
    `,
    },
    "/events/entry.ts",
    {
      target: "standalone",
      platform: "deno",
      hostBridge: "always",
      externImportModule: "v8x:events",
      link: ["v8x:events"],
    },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {
    ...result.importObject,
    "v8x:events": {
      recordEvent: (event: number, promise: unknown, reason: unknown) => events.push({ event, promise, reason }),
    },
  });
  (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void })?.__setInstance?.(instance);
  const e = instance.exports as unknown as Record<string, Function>;
  const promise = e.run();
  expect(events).toEqual([{ event: 0, promise, reason: e.reason() }]);
  e.handle();
  e.handle();
  expect(events).toEqual([
    { event: 0, promise, reason: e.reason() },
    { event: 1, promise, reason: null },
  ]);
});

it("reports direct rejected construction with exact Promise and reason identity", async () => {
  const { e, events } = await fixture(`export function reject():any { return Promise.reject(marker); }`);
  const promise = e.reject();
  expect(events).toEqual([{ event: 0, promise, reason: e.original() }]);
});

it("reports pending rejection and duplicate reject attempts without replacing the result", async () => {
  const { e, events } = await fixture(`
    let rejecter:any;
    const p=new Promise((resolve,reject) => {rejecter=reject;});
    export function promise():any {return p;}
    export function reject():void {rejecter(marker);}
  `);
  expect(events).toEqual([]);
  e.reject();
  e.reject();
  expect(events).toEqual([
    { event: 0, promise: e.promise(), reason: e.original() },
    { event: 2, promise: e.promise(), reason: e.original() },
  ]);
  expect(e.__promise_boundary_state(e.promise())).toBe(2);
});

it("does not report a pending Promise with an early rejection handler", async () => {
  const { e, events } = await fixture(`
    let rejecter:any;
    const p=new Promise((resolve,reject)=>{rejecter=reject;});
    export function attach():void {p.catch(()=>42);}
    export function reject():void {rejecter(marker);}
  `);
  e.attach();
  e.reject();
  e.__drain_microtasks();
  expect(events).toEqual([]);
});

it.each([
  `async function fail():Promise<any> {throw marker;} export function run():any {return fail();}`,
  `export function run():any {return Promise.resolve(42).then(()=>{throw marker;});}`,
])("reports compiled async or reaction rejection at its actual transition", async (body) => {
  const { e, events } = await fixture(body);
  const promise = e.run();
  e.__drain_microtasks?.();
  expect(events).toEqual([{ event: 0, promise, reason: e.original() }]);
});

it("ordinary graphs without a dispatcher receive no event instructions", () => {
  expect(
    buildPromiseRejectionEvent(undefined, 0, [{ op: "local.get", index: 0 }], [{ op: "local.get", index: 1 }]),
  ).toEqual([]);
});

it("locks an executor resolving pair while adopting a pending Promise", async () => {
  const { e, events } = await fixture(`
    let complete:any;
    const inner=new Promise(resolve=>{complete=resolve;});
    let resolveOuter:any, rejectOuter:any;
    const outer=new Promise((resolve,reject)=>{resolveOuter=resolve;rejectOuter=reject;});
    export function promise():any {return outer;}
    export function adopt():void {resolveOuter(inner);}
    export function duplicate():void {rejectOuter(marker);resolveOuter(marker);}
    export function finish():void {complete(marker);}
  `);
  e.adopt();
  e.duplicate();
  expect(e.__promise_boundary_state(e.promise())).toBe(0);
  expect(events).toEqual([
    { event: 2, promise: e.promise(), reason: e.original() },
    { event: 3, promise: e.promise(), reason: e.original() },
  ]);
  e.finish();
  e.__drain_microtasks();
  expect(e.__promise_boundary_state(e.promise())).toBe(1);
});

it("does not read a second resolution's then getter", async () => {
  const { e, events } = await fixture(`
    let reads=0;
    let resolveOuter:any;
    const outer=new Promise(resolve=>{resolveOuter=resolve;});
    const other={get then():any {reads++;throw marker;}};
    export function promise():any {return outer;}
    export function run():void {resolveOuter(marker);resolveOuter(other);}
    export function count():number {return reads;}
    export function attempted():any {return other;}
  `);
  e.run();
  expect(e.count()).toBe(0);
  expect(e.__promise_boundary_state(e.promise())).toBe(1);
  expect(events).toEqual([{ event: 3, promise: e.promise(), reason: e.attempted() }]);
});

it("ignores an executor throw after resolution adopts a pending Promise", async () => {
  const { e, events } = await fixture(`
    let complete:any;
    const inner=new Promise(resolve=>{complete=resolve;});
    export function run():any {return new Promise(resolve=>{resolve(inner);throw marker;});}
    export function finish():void {complete(marker);}
  `);
  const promise = e.run();
  expect(e.__promise_boundary_state(promise)).toBe(0);
  expect(events.filter((event) => event.event === 0)).toEqual([]);
  e.finish();
  e.__drain_microtasks();
  expect(e.__promise_boundary_state(promise)).toBe(1);
});

it("gives a thenable job a fresh resolving pair, locked through pending adoption and a subsequent throw", async () => {
  const { e, events } = await fixture(`
    let complete:any;
    const inner=new Promise(resolve=>{complete=resolve;});
    const thenable={then(resolve:any,reject:any):void {resolve(inner);reject(marker);throw marker;}};
    const outer=new Promise(resolve=>resolve(thenable));
    export function promise():any {return outer;}
    export function finish():void {complete(marker);}
  `);
  e.__drain_microtasks();
  expect(e.__promise_boundary_state(e.promise())).toBe(0);
  expect(events).toEqual([
    { event: 2, promise: e.promise(), reason: e.original() },
    { event: 2, promise: e.promise(), reason: e.original() },
  ]);
  e.finish();
  e.__drain_microtasks();
  expect(e.__promise_boundary_state(e.promise())).toBe(1);
});

it("locks before a then getter can reenter the sibling reject function", async () => {
  const { e, events } = await fixture(`
    let resolveOuter:any,rejectOuter:any;
    const outer=new Promise((resolve,reject)=>{resolveOuter=resolve;rejectOuter=reject;});
    const thenable={get then():any {rejectOuter(marker);return (resolve:any)=>resolve(marker);}};
    export function promise():any {return outer;}
    export function run():void {resolveOuter(thenable);}
  `);
  e.run();
  expect(e.__promise_boundary_state(e.promise())).toBe(0);
  expect(events).toEqual([{ event: 2, promise: e.promise(), reason: e.original() }]);
  e.__drain_microtasks();
  expect(e.__promise_boundary_state(e.promise())).toBe(1);
});

it("each nested thenable assimilation receives a new latch", async () => {
  const { e, events } = await fixture(`
    const next={then(resolve:any):void {resolve(marker);}};
    const first={then(resolve:any):void {resolve(next);}};
    export function run():any {return new Promise(resolve=>resolve(first));}
  `);
  const promise = e.run();
  e.__drain_microtasks();
  expect(e.__promise_boundary_state(promise)).toBe(1);
  expect(events).toEqual([]);
});

it("the any-valued executor route shares the resolving pair", async () => {
  const { e, events } = await fixture(`
    let complete:any;
    const inner=new Promise(resolve=>{complete=resolve;});
    const executor:any=(resolve:any,reject:any):void=>{resolve(inner);reject(marker);};
    export function run():any {return new Promise(executor);}
    export function finish():void {complete(marker);}
  `);
  const promise = e.run();
  expect(e.__promise_boundary_state(promise)).toBe(0);
  expect(events).toEqual([{ event: 2, promise, reason: e.original() }]);
  e.finish();
  e.__drain_microtasks();
  expect(e.__promise_boundary_state(promise)).toBe(1);
});

it("pending adoption is one-shot in ordinary graphs without a Deno dispatcher", async () => {
  const { e, events } = await fixture(
    `
    let complete:any;
    const inner=new Promise(resolve=>{complete=resolve;});
    const outer=new Promise((resolve,reject)=>{resolve(inner);reject(marker);});
    export function promise():any {return outer;}
    export function finish():void {complete(marker);}
  `,
    false,
  );
  expect(e.__promise_boundary_state(e.promise())).toBe(0);
  e.finish();
  e.__drain_microtasks();
  expect(e.__promise_boundary_state(e.promise())).toBe(1);
  expect(events).toEqual([]);
});

it.each(["then(()=>42)", "catch(()=>42)", "finally(()=>42)"])(
  "reports only the first late %s registration",
  async (method) => {
    const { e, events } = await fixture(`
    const p=Promise.reject(marker);
    export function promise():any {return p;}
    export function attach():void {p.${method};}
  `);
    const promise = e.promise();
    expect(events).toEqual([{ event: 0, promise, reason: e.original() }]);
    e.attach();
    e.attach();
    // Registration is synchronous; do not conflate child rejection jobs with
    // the receiver's first handle notification.
    expect(events).toEqual([
      { event: 0, promise, reason: e.original() },
      { event: 1, promise, reason: null },
    ]);
    expect(e.__promise_boundary_has_handler(promise)).toBe(1);
  },
);

it("explicit MarkAsHandled does not impersonate a late reaction", async () => {
  const { e, events } = await fixture(`
    const p=Promise.reject(marker);
    export function promise():any {return p;}
    export function attach():void {p.catch(()=>42);}
  `);
  const promise = e.promise();
  expect(events).toHaveLength(1);
  expect(e.__promise_boundary_mark_handled(promise)).toBe(1);
  e.attach();
  expect(events).toHaveLength(1);
});

it.each([
  "new Promise((resolve)=>resolve(p))",
  "consume()",
  "Promise.all([p])",
  "Promise.race([p])",
  "Promise.allSettled([p])",
  "Promise.any([p])",
])("reports the first late subscription through %s", async (expression) => {
  const { e, events } = await fixture(`
    const p=Promise.reject(marker);
    async function consume():Promise<any> {try {return await p;} catch {return 42;}}
    export function promise():any {return p;}
    export function attach():any {return ${expression};}
  `);
  const promise = e.promise();
  expect(events).toEqual([{ event: 0, promise, reason: e.original() }]);
  e.attach();
  e.attach();
  expect(events.filter((event) => event.promise === promise)).toEqual([
    { event: 0, promise, reason: e.original() },
    { event: 1, promise, reason: null },
  ]);
  expect(e.__promise_boundary_has_handler(promise)).toBe(1);
});

it.each([
  "new Promise((resolve)=>resolve(p))",
  "consume()",
  "Promise.all([p])",
  "Promise.race([p])",
  "Promise.allSettled([p])",
  "Promise.any([p])",
])("suppresses source rejection after an early subscription through %s", async (expression) => {
  const { e, events } = await fixture(`
    let rejecter:any;
    const p=new Promise((resolve,reject)=>{rejecter=reject;});
    async function consume():Promise<any> {try {return await p;} catch {return 42;}}
    export function promise():any {return p;}
    export function attach():any {return ${expression};}
    export function reject():void {rejecter(marker);}
  `);
  const promise = e.promise();
  expect(events).toEqual([]);
  e.attach();
  expect(e.__promise_boundary_has_handler(promise)).toBe(1);
  e.reject();
  e.__drain_microtasks?.();
  // Derived rejected promises may have their own events; never confuse them
  // with the input consumed by adoption, await or a combinator.
  expect(events.filter((event) => event.promise === promise)).toEqual([]);
  expect(e.__promise_boundary_state(promise)).toBe(2);
});
