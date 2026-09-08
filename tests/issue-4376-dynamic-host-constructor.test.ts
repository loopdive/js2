import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each([undefined, "deno"] as const)(
  "executes a returned closure constructor and exposes new.target on %s",
  async (platform) => {
    const result = await compile(
      `
      let observed = 0;
      function factory(id: number): any {
        return function(this: any, ...args: any[]): any {
          observed = new.target ? id : -id;
        };
      }
      export function ordinary(): number {
        observed = 0;
        const callable: any = factory(7);
        callable();
        return observed;
      }
      export function construct(): number {
        observed = 0;
        const callable: any = factory(7);
        new callable();
        return observed;
      }
    `,
      { target: "standalone", platform, hostBridge: "always" },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.ordinary as () => number)()).toBe(-7);
    expect((instance.exports.construct as () => number)()).toBe(7);
  },
);

it.each([undefined, "deno"] as const)("keeps ordinary constructor frames isolated on %s", async (platform) => {
  const result = await compile(
    `
    let observed: any = undefined;
    let nestedOrdinary = false;
    function make(fail: boolean): any {
      return function(this: any): any {
        const target = new.target;
        const ordinary = function(): any { return new.target; };
        nestedOrdinary = ordinary() === undefined;
        observed = target;
        if (fail) throw new TypeError("constructor failure");
        if (new.target !== target) throw new Error("changed new.target");
      };
    }
    function constructValue(value: any): void { new value(); }
    export function probe(): number {
      const success: any = make(false);
      constructValue(success);
      if (observed !== success) return -11;
      if (!nestedOrdinary) return -12;
      try { constructValue(make(true)); } catch (_) {}
      success();
      if (observed !== undefined || !nestedOrdinary) return -2;
      constructValue(success);
      return observed === success ? 1 : -3;
    }
  `,
    { target: "standalone", platform, hostBridge: "always" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  expect((instance.exports.probe as () => number)()).toBe(1);
});
