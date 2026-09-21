// #4682 — the standalone NewPromiseCapability executor must reject an
// ordinary custom constructor whose captured resolve/reject pair is not
// callable, before the empty Promise.all iterable path asks for `resolve`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Exports {
  test: () => number;
}

async function runStandalone(source: string): Promise<{ imports: string[]; value: number }> {
  const result = await compile(source, { fileName: "issue-4682.ts", target: "standalone" });
  expect(result.success, result.success ? "" : JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  const imports = (result.imports ?? []).map((item) => `${item.module}.${item.name}`);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return { imports, value: (instance.exports as unknown as Exports).test() };
}

describe("#4682 standalone Promise.all custom capability executor", () => {
  it("passes the six capability-executor-not-callable subcases", async () => {
    const source = `
      let checkPoint = 0;
      function fn1(executor: any) {
        checkPoint += 1;
      }
      function fn2(executor: any) {
        checkPoint += 1;
        executor();
        checkPoint += 1;
      }
      function fn3(executor: any) {
        checkPoint += 1;
        executor(undefined, undefined);
        checkPoint += 1;
      }
      function fn4(executor: any) {
        checkPoint += 1;
        executor(undefined, function () {});
        checkPoint += 1;
      }
      function fn5(executor: any) {
        checkPoint += 1;
        executor(function () {}, undefined);
        checkPoint += 1;
      }
      function fn6(executor: any) {
        checkPoint += 1;
        executor(123, "invalid value");
        checkPoint += 1;
      }
      export function test(): number {
        try { Promise.all.call(fn1, []); } catch (e) { checkPoint += 10; }
        try { Promise.all.call(fn2, []); } catch (e) { checkPoint += 10; }
        try { Promise.all.call(fn3, []); } catch (e) { checkPoint += 10; }
        try { Promise.all.call(fn4, []); } catch (e) { checkPoint += 10; }
        try { Promise.all.call(fn5, []); } catch (e) { checkPoint += 10; }
        try { Promise.all.call(fn6, []); } catch (e) { checkPoint += 10; }
        return checkPoint;
      }
    `;
    const result = await runStandalone(source);
    expect(result.imports).toEqual([]);
    // fn1 contributes 1; every other constructor contributes 1 + 1 before
    // NewPromiseCapability validates the captured pair and throws (+10).
    expect(result.value).toBe(71);
  });

  // REWRITTEN for #6651 cluster D (#5197 R3-3). This case used to assert the
  // NON-EMPTY custom-constructor shape still leaked `env.Promise_all` — i.e.
  // that it did not compile at all under `--target standalone`. It now takes
  // the native element pipeline, so the assertion is inverted: no host import,
  // and the capability's own `resolve` is called with the values array.
  it("lowers the non-empty custom-constructor shape natively (no host import)", async () => {
    const result = await runStandalone(
      `let observed = 0;
       function C(executor: any) {
         executor(function (values: any) { observed = Array.isArray(values) ? values.length : -1; }, function () {});
       }
       C.resolve = function (value: any) { return value; };
       const element: any = { then: function (onFulfilled: any) { onFulfilled("v"); } };
       export function test(): number { Promise.all.call(C, [element]); return observed; }`,
    );
    expect(result.imports).toEqual([]);
    expect(result.value).toBe(1);
  });

  it("keeps the gc/host custom-constructor path unchanged", async () => {
    const result = await compile(
      `function C(executor: any) { executor(function () {}, function () {}); }
       export function test(): number { Promise.all.call(C, []); return 1; }`,
      { fileName: "issue-4682-host-control.ts" },
    );
    expect(result.success, result.success ? "" : JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
    expect((result.imports ?? []).map((item) => `${item.module}.${item.name}`)).toContain("env.Promise_all");
  });
});
