// #2785 canary follow-up — `Array.prototype.<cb-method>.call(arrayLike, fn)`
// must hand V8 a callable wrapper for a compiled callback. `__proto_method_call`
// host-wraps struct args first; classifying the wrapped Proxy (not the raw
// closure) left the callback an uncallable object ("object is not a function").
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2785 — proto-method .call on an array-like passes a callable callback", () => {
  it("map.call on a plain array-like object", async () => {
    expect(
      await run(`
        export function test(): number {
          function cb(v: any, i: any, o: any): boolean { return true; }
          var obj: any = { 0: 1, 1: 2, length: 2 };
          var r: any = Array.prototype.map.call(obj, cb);
          return r.length;
        }
      `),
    ).toBe(2);
  });

  it("map.call with an accessor length that writes an element (15.4.4.19-8-b-2)", async () => {
    expect(
      await run(`
        export function test(): boolean {
          function callbackfn(val: any, idx: any, obj: any): boolean {
            if (idx === 2 && val === "length") { return false; } else { return true; }
          }
          var obj: any = {};
          Object.defineProperty(obj, "length", {
            get: function () { obj[2] = "length"; return 3; },
            configurable: true,
          });
          var testResult = Array.prototype.map.call(obj, callbackfn);
          return testResult[2] === false;
        }
      `),
    ).toBe(1);
  });
});
