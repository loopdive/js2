// #1691 — JS-host lane: `yield*` forwards `.throw()` / `.return()` to the
// delegate iterator (§14.4.14 step 7) instead of draining it eagerly.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) throw new Error(`Compile error: ${result.errors?.[0]?.message}`);
  // The generator must ride the native state machine, not the eager buffer.
  expect(result.imports.map((i) => i.name)).toContain("__gen_yield_star_step");
  expect(result.imports.map((i) => i.name)).not.toContain("__gen_yield_star");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
  imports.setInstance?.(instance);
  return (instance.exports as any).test();
}

const PRELUDE = `
var log: any[] = [];
var iterable: any = {};
`;

describe("#1691 yield* throw/return delegation (JS host)", () => {
  it("forwards throw(v) to the delegate and binds its done value", async () => {
    const out = await runHost(`${PRELUDE}
      var inner: any = {
        next: function () { log.push("next"); return { done: false, value: 1 }; },
        throw: function (v: any) { log.push("throw:" + v); return { done: true, value: 5 }; },
      };
      iterable[Symbol.iterator] = function () { return inner; };
      function* g() {
        var r = yield* iterable;
        log.push("r:" + r);
      }
      export function test() {
        var iter = g();
        var first = iter.next();
        var res = iter.throw(7777);
        log.push("first:" + first.value + "/" + first.done, "done:" + res.done);
        return log.join(",");
      }
    `);
    expect(out).toBe("next,throw:7777,r:5,first:1/false,done:true");
  });

  it("re-yields a not-done throw result", async () => {
    const out = await runHost(`${PRELUDE}
      var inner: any = {
        next: function () { return { done: false, value: 1 }; },
        throw: function (v: any) { return { done: false, value: v + 1 }; },
      };
      iterable[Symbol.iterator] = function () { return inner; };
      function* g() { yield* iterable; }
      export function test() {
        var iter = g();
        iter.next();
        var res = iter.throw(41);
        return res.value + "/" + res.done;
      }
    `);
    expect(out).toBe("42/false");
  });

  it("closes the delegate and throws TypeError when it has no throw method", async () => {
    const out = await runHost(`${PRELUDE}
      var caught: any;
      var inner: any = {
        next: function () { return { done: false }; },
        return: function () { log.push("return"); return {}; },
      };
      iterable[Symbol.iterator] = function () { return inner; };
      function* g() {
        try {
          yield* iterable;
        } catch (err) {
          caught = err;
        }
      }
      export function test() {
        var iter = g();
        iter.next();
        iter.throw(1);
        return log.join(",") + ":" + (caught instanceof TypeError);
      }
    `);
    expect(out).toBe("return:true");
  });

  it("forwards return(v) to the delegate", async () => {
    const out = await runHost(`${PRELUDE}
      var inner: any = {
        next: function () { return { done: false }; },
        return: function (v: any) { log.push("return:" + v); return { done: true, value: v * 2 }; },
      };
      iterable[Symbol.iterator] = function () { return inner; };
      function* g() { yield* iterable; }
      export function test() {
        var iter: any = g();
        iter.next();
        var res = iter.return(21);
        return log.join(",") + ":" + res.value + "/" + res.done;
      }
    `);
    expect(out).toBe("return:21:42/true");
  });
});
