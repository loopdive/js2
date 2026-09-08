import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { execFileSync } from "node:child_process";

async function run(body: string): Promise<number> {
  const result = await compile(
    `export function test(): number {
    // Explicit array typing isolates this intrinsic from the separately tracked
    // mixed-tuple argument-carrier defect in Reflect.apply.
    function invoke(target: any, receiver: any, args: any[]): any {
      return Reflect.apply(target, receiver, args);
    }
    const proto: any = Function.prototype;
    const apply: any = proto["apply"];
    ${body}
  }`,
    { target: "standalone", fileName: "apply.ts", skipSemanticDiagnostics: true, hostBridge: "always" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const output = execFileSync(
    process.execPath,
    [
      "--experimental-wasm-exnref",
      "-e",
      `
    const fs = require("node:fs");
    const e = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(0)), {}).exports;
    try { process.stdout.write(String(e.test())); }
    catch (error) {
      if (error instanceof WebAssembly.Exception && error.is(e.__exn_tag)) {
        const length = e.__exn_render_prepare(error.getArg(e.__exn_tag, 0));
        let message = "";
        for (let i = 0; i < length; i++) message += String.fromCharCode(e.__exn_render_char(i));
        console.error(message);
      } else console.error(error);
      process.exitCode = 1;
    }
  `,
    ],
    { input: result.binary, encoding: "utf8" },
  );
  return Number(output);
}

describe("first-class Function.prototype.apply", () => {
  it("calls a compiled function with its receiver and arguments", async () => {
    expect(
      await run(`
      const fn: any = function(a: number) { return this.base + a; };
      return invoke(apply, fn, [{ base: 1 }, [41]]);
    `),
    ).toBe(42);
  });
  it.each(["null", "undefined"])("accepts %s as an empty argument list", async (list) => {
    expect(
      await run(`
      const fn: any = function() { return arguments.length; };
      return invoke(apply, fn, [{}, ${list}]);
    `),
    ).toBe(0);
  });
  it("reads length once and indexed getters in order before calling", async () => {
    expect(
      await run(`
      let order = 0;
      const list: any = {
        get length() { order = order * 10 + 1; return 2; },
        get 0() { order = order * 10 + 2; return 2; },
        get 1() { order = order * 10 + 3; return 3; },
      };
      const fn: any = function(a: number, b: number) { return a + b; };
      const value = invoke(apply, fn, [null, list]);
      return value * 1000 + order;
    `),
    ).toBe(5123);
  });
  it.each(["1", "true", "'abc'", "Symbol('x')", "1n"])("rejects primitive list %s", async (list) => {
    expect(
      await run(`
      let called = 0;
      const fn: any = function() { called++; };
      try { invoke(apply, fn, [null, ${list}]); }
      catch (error) { return error instanceof TypeError && called === 0 ? 1 : -1; }
      return 0;
    `),
    ).toBe(1);
  });
  it("rejects a non-callable target before reading length", async () => {
    expect(
      await run(`
      let touched = 0;
      const list = { get length() { touched++; return 0; } };
      try { invoke(apply, {}, [null, list]); }
      catch (error) { return error instanceof TypeError && touched === 0 ? 1 : -1; }
      return 0;
    `),
    ).toBe(1);
  });
  it("propagates a getter's thrown value without calling the target", async () => {
    expect(
      await run(`
      let called = 0;
      const fn: any = function() { called++; };
      const list = { length: 1, get 0() { throw 77; } };
      try { invoke(apply, fn, [null, list]); }
      catch (error) { return error === 77 && called === 0 ? 1 : -1; }
      return 0;
    `),
    ).toBe(1);
  });
  it("propagates the target's thrown value", async () => {
    expect(
      await run(`
      const fn: any = function() { throw 88; };
      try { invoke(apply, fn, [null, []]); }
      catch (error) { return error === 88 ? 1 : -1; }
      return 0;
    `),
    ).toBe(1);
  });
});
