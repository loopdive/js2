import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Exports = Record<string, (() => number) | undefined>;

async function runStandalone(source: string): Promise<Exports> {
  const result = await compile(source, { fileName: "issue-4727.ts", target: "standalone" });
  expect(result.success, result.success ? "" : JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  expect(result.imports ?? []).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as unknown as Exports;
}

describe("#4727 standalone Promise.resolve.call custom constructors", () => {
  it("rejects a custom constructor's promise on self-resolution", async () => {
    const ex = await runStandalone(`
      let resolve: any, reject: any;
      let promise: any = new Promise(function(r: any, j: any) { resolve = r; reject = j; });
      let state = 0;
      let C = function(executor: any) { executor(resolve, reject); return promise; };
      export function test(): number {
        const result: any = Promise.resolve.call(C, promise);
        result.then(function() { state = 1; }, function(value: any) { state = value ? 2 : 3; });
        return result === promise ? 1 : 0;
      }
      export function stateValue(): number { return state; }
    `);

    expect(ex.test?.()).toBe(1);
    ex.__drain_microtasks?.();
    expect(ex.stateValue?.()).toBe(2);
  });

  it("passes ordinary values and thenables to the captured resolver", async () => {
    const ex = await runStandalone(`
      let ordinary: any, seenThenable: any;
      let resolve1: any, reject1: any;
      let promise1: any = new Promise(function(r: any, j: any) { resolve1 = r; reject1 = j; });
      let C1 = function(executor: any) { executor(resolve1, reject1); return promise1; };
      let resolve2: any, reject2: any;
      let promise2: any = new Promise(function(r: any, j: any) { resolve2 = r; reject2 = j; });
      let C2 = function(executor: any) { executor(resolve2, reject2); return promise2; };
      let thenable = { then: function(r: any) { r(7); } };
      export function test(): number {
        Promise.resolve.call(C1, 3).then(function(value: any) { ordinary = value; });
        Promise.resolve.call(C2, thenable).then(function(value: any) { seenThenable = value; }, function() { seenThenable = -1; });
        return 1;
      }
      export function ordinaryValue(): number { return ordinary; }
      export function thenableValue(): number { return seenThenable; }
    `);

    expect(ex.test?.()).toBe(1);
    ex.__drain_microtasks?.();
    expect(ex.ordinaryValue?.()).toBe(3);
    expect(ex.thenableValue?.()).toBe(7);
  });
});
