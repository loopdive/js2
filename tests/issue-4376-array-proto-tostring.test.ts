import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { execFileSync } from "node:child_process";

async function run(body: string): Promise<number> {
  const result = await compile(
    `export function test(): number {
    function invoke(receiver: any): any {
      const proto: any = Array.prototype;
      return Reflect.apply(proto.toString, receiver, [] as any[]);
    }
    ${body}
  }`,
    { target: "standalone", fileName: "array-string.ts", skipSemanticDiagnostics: true, hostBridge: "always" },
  );
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return Number(
    execFileSync(
      process.execPath,
      [
        "--experimental-wasm-exnref",
        "-e",
        `
    const fs = require('node:fs');
    const e = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(0)), {}).exports;
    try { process.stdout.write(String(e.test())); }
    catch (err) {
      if (err instanceof WebAssembly.Exception && err.is(e.__exn_tag)) {
        const n = e.__exn_render_prepare(err.getArg(e.__exn_tag, 0));
        let s = ''; for (let i=0;i<n;i++) s += String.fromCharCode(e.__exn_render_char(i));
        console.error(s);
      } else console.error(err);
      process.exitCode = 1;
    }
  `,
      ],
      { input: result.binary, encoding: "utf8" },
    ),
  );
}

describe("first-class Array.prototype.toString", () => {
  it.each(["42", "true", "'abc'", "1n", "Symbol('x')"])("boxes primitive %s before calling join", async (value) => {
    expect(
      await run(`const value: any = ${value};
      const proto: any = Object.prototype;
      proto.join = function() { "use strict"; return typeof this === "object" && this !== value; };
      return invoke(value) === true ? 1 : 0;`),
    ).toBe(1);
  });
  it.each([
    ["42", "Number"],
    ["true", "Boolean"],
    ["'abc'", "String"],
    ["1n", "BigInt"],
    ["Symbol('x')", "Symbol"],
  ])("tags primitive %s without join", async (value, tag) => {
    expect(await run(`return invoke(${value}) === "[object ${tag}]" ? 1 : 0;`)).toBe(1);
  });
  it("honors an array own join override", async () => {
    expect(
      await run(`const a: any = [1,2,3]; a.join = function() { return this === a ? "custom" : "wrong"; };
      return invoke(a) === "custom" ? 1 : 0;`),
    ).toBe(1);
  });
  it("uses the intrinsic tag after a non-callable array join override", async () => {
    expect(await run(`const a: any = [1,2,3]; a.join = null; return invoke(a) === "[object Array]" ? 1 : 0;`)).toBe(1);
  });
  it("joins an array", async () => {
    expect(await run(`return invoke([1, 2, 3]) === '1,2,3' ? 1 : 0;`)).toBe(1);
  });
  it("preserves holes and nullish elements", async () => {
    expect(await run(`const a: any[] = [1, , undefined, null, 5]; return invoke(a) === '1,,,,5' ? 1 : 0;`)).toBe(1);
  });
  it("reads join once and calls with receiver and no arguments", async () => {
    expect(
      await run(`let count = 0;
      const receiver: any = { get join() { count++; return function() {
        return this === receiver && arguments.length === 0 ? 42 : -1;
      }; } };
      return invoke(receiver) === 42 && count === 1 ? 1 : 0;`),
    ).toBe(1);
  });
  it("returns a join result without coercing it", async () => {
    expect(
      await run(`const marker = {}; const receiver = { join() { return marker; } };
      return invoke(receiver) === marker ? 1 : 0;`),
    ).toBe(1);
  });
  it("falls back to the intrinsic object tag for non-callable join", async () => {
    expect(await run(`return invoke({ join: 3, toString() { throw 99; } }) === '[object Object]' ? 1 : 0;`)).toBe(1);
  });
  it.each(["null", "undefined"])("rejects %s", async (receiver) => {
    expect(
      await run(`try { invoke(${receiver}); } catch(e) { return e instanceof TypeError ? 1 : 0; } return 0;`),
    ).toBe(1);
  });
  it("propagates join getter exceptions", async () => {
    expect(
      await run(`try { invoke({ get join() { throw 77; } }); } catch(e) { return e === 77 ? 1 : 0; } return 0;`),
    ).toBe(1);
  });
  it("propagates join call exceptions", async () => {
    expect(await run(`try { invoke({ join() { throw 88; } }); } catch(e) { return e === 88 ? 1 : 0; } return 0;`)).toBe(
      1,
    );
  });
});
