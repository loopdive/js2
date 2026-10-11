// #6651 cluster D (#5197 R3-3) — `Promise.{all,race}.call(C, iterable)` for an
// ordinary compiled constructor lowers natively under `--target standalone`.
//
// Before this slice the shape leaked `env::Promise_all` / `env::Promise_race`
// (plus `__js_array_new`/`__js_array_push`) and therefore did not compile at
// all in a host-free module: 28 ES2015 test262 rows were `compile_error`.
// Every case below asserts BOTH that no host import is emitted and that the
// observable §27.2.4.1.1 / §27.2.4.3.1 protocol is what runs.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Exports {
  test: () => number;
}

async function runStandalone(source: string): Promise<{ imports: string[]; value: number }> {
  const result = await compile(source, { fileName: "issue-6651.ts", target: "standalone" });
  expect(result.success, result.success ? "" : JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  const imports = (result.imports ?? []).map((item) => `${item.module}.${item.name}`);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return { imports, value: (instance.exports as unknown as Exports).test() };
}

describe("#6651 standalone Promise.{all,race}.call(C, iterable)", () => {
  it("calls C.resolve per element and settles the capability with the values array", async () => {
    const result = await runStandalone(`
      let callCount = 0;
      let isArray = 0;
      let len = -1;
      let first: any = null;
      function Constructor(executor: any) {
        function resolve(values: any) {
          callCount += 1;
          isArray = Array.isArray(values) ? 1 : 0;
          len = values.length;
          first = values[0];
        }
        executor(resolve, function () {});
      }
      Constructor.resolve = function (v: any) { return v; };
      const p1: any = {
        then: function (onFulfilled: any) {
          onFulfilled("expectedValue");
          // §27.2.4.1.2 [[AlreadyCalled]] — the second call is ignored.
          onFulfilled("unexpectedValue");
        },
      };
      export function test(): number {
        Promise.all.call(Constructor, [p1]);
        return callCount * 1000 + isArray * 100 + len * 10 + (first === "expectedValue" ? 1 : 0);
      }
    `);
    expect(result.imports).toEqual([]);
    expect(result.value).toBe(1111);
  });

  it("keeps [[RemainingElements]] bookkeeping across deferred elements", async () => {
    const result = await runStandalone(`
      let callCount = 0;
      let len = -1;
      let v0: any = null;
      let v2: any = null;
      let f1: any = null;
      let f2: any = null;
      let f3: any = null;
      function Constructor(executor: any) {
        executor(function (values: any) { callCount += 1; len = values.length; v0 = values[0]; v2 = values[2]; }, function () {});
      }
      Constructor.resolve = function (v: any) { return v; };
      const p1: any = { then: function (a: any) { f1 = a; } };
      const p2: any = { then: function (a: any) { f2 = a; } };
      const p3: any = { then: function (a: any) { f3 = a; } };
      export function test(): number {
        Promise.all.call(Constructor, [p1, p2, p3]);
        if (callCount !== 0) return -1;
        f1("a");
        f1("ignored");
        if (callCount !== 0) return -2;
        f2("b");
        f3("c");
        if (callCount !== 1) return -3;
        return (len === 3 ? 100 : 0) + (v0 === "a" ? 10 : 0) + (v2 === "c" ? 1 : 0);
      }
    `);
    expect(result.imports).toEqual([]);
    expect(result.value).toBe(111);
  });

  it("hands race the capability's OWN resolve/reject to every element", async () => {
    const result = await runStandalone(`
      let seen1 = 0;
      let seen2 = 0;
      let resolveFn: any = null;
      let rejectFn: any = null;
      function Constructor(executor: any) {
        resolveFn = function () {};
        rejectFn = function () {};
        executor(resolveFn, rejectFn);
      }
      Constructor.resolve = function (v: any) { return v; };
      const p1: any = { then: function (a: any, b: any) { seen1 = (a === resolveFn ? 2 : 0) + (b === rejectFn ? 1 : 0); } };
      const p2: any = { then: function (a: any, b: any) { seen2 = (a === resolveFn ? 2 : 0) + (b === rejectFn ? 1 : 0); } };
      export function test(): number {
        Promise.race.call(Constructor, [p1, p2]);
        return seen1 * 10 + seen2;
      }
    `);
    expect(result.imports).toEqual([]);
    expect(result.value).toBe(33);
  });

  it("throws the NewPromiseCapability TypeError for a constructor that never calls its executor", async () => {
    const result = await runStandalone(`
      function ZeroArgConstructor() {}
      export function test(): number {
        try {
          Promise.all.call(ZeroArgConstructor, []);
          return 0;
        } catch (e) {
          return e instanceof TypeError ? 1 : 2;
        }
      }
    `);
    expect(result.imports).toEqual([]);
    expect(result.value).toBe(1);
  });

  it("propagates a throwing constructor, with no iterable argument at all", async () => {
    const result = await runStandalone(`
      function CustomPromise() { throw new Error("boom"); }
      export function test(): number {
        try {
          Promise.all.call(CustomPromise);
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result.imports).toEqual([]);
    expect(result.value).toBe(1);
  });

  it("rejects the capability when the capability's own resolve throws", async () => {
    const result = await runStandalone(`
      let rejected = 0;
      function Constructor(executor: any) {
        executor(function () { throw new Error("resolve boom"); }, function (reason: any) { rejected += 1; });
      }
      Constructor.resolve = function (v: any) { return v; };
      export function test(): number {
        // Empty iterable ⇒ the capability resolve runs inside PerformPromiseAll,
        // so its throw is IfAbruptRejectPromise, not a caller-visible throw.
        Promise.all.call(Constructor, []);
        return rejected;
      }
    `);
    expect(result.imports).toEqual([]);
    expect(result.value).toBe(1);
  });

  it("rejects the capability when C.resolve throws for an element", async () => {
    const result = await runStandalone(`
      let rejected = 0;
      let resolveCalls = 0;
      function Constructor(executor: any) {
        executor(function () {}, function (reason: any) { rejected += 1; });
      }
      Constructor.resolve = function (v: any) { resolveCalls += 1; throw new Error("resolve boom"); };
      const p1: any = { then: function (a: any) { a(1); } };
      const p2: any = { then: function (a: any) { a(2); } };
      export function test(): number {
        Promise.all.call(Constructor, [p1, p2]);
        // One rejection, and the loop stops at the first abrupt element.
        return rejected * 10 + resolveCalls;
      }
    `);
    expect(result.imports).toEqual([]);
    expect(result.value).toBe(11);
  });

  it("leaves the gc/host lane on its existing host path", async () => {
    const result = await compile(
      `function C(executor: any) { executor(function () {}, function () {}); }
       C.resolve = function (value: any) { return value; };
       export function test(): number { Promise.all.call(C, [1]); return 1; }`,
      { fileName: "issue-6651-host-control.ts" },
    );
    expect(result.success, result.success ? "" : JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
    expect((result.imports ?? []).map((item) => `${item.module}.${item.name}`)).toContain("env.Promise_all");
  });
});
