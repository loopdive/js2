import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Exports = Record<string, (() => number) | undefined>;

async function runStandalone(source: string): Promise<Exports> {
  const result = await compile(source, { fileName: "issue-4735.ts", target: "standalone" });
  expect(result.success, result.success ? "" : JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  expect(result.imports ?? []).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as unknown as Exports;
}

describe("#4735 standalone Promise.resolve custom then", () => {
  it("invokes an own then override after the Promise identity fast path", async () => {
    const ex = await runStandalone(`
      let value: any = {};
      let promise: any = new Promise<void>(function(resolve: any) { resolve(); });
      promise.then = function(resolve: any): any { resolve(value); };
      let seen: any;
      export function test(): number {
        Promise.resolve(promise).then(function(result: any) { seen = result; });
        return seen === value ? 1 : 0;
      }
    `);

    expect(ex.test?.()).toBe(1);
  });

  it("keeps the native Promise identity path unchanged without an override", async () => {
    const ex = await runStandalone(`
      let promise: any = Promise.resolve(7);
      export function test(): number { return Promise.resolve(promise) === promise ? 1 : 0; }
    `);

    expect(ex.test?.()).toBe(1);
  });
});
