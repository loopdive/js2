/**
 * #3673 — i31 small-int boxing in the standalone lane.
 *
 * `__box_number` encodes integral values in the signed-31-bit range as an
 * unboxed `(ref i31)` instead of allocating a `$BoxedNumber` struct. These
 * pins guard the discriminator arms that make the encoding observable-free:
 * classification (`typeof`), arithmetic through the tag-5 dynamic lane,
 * truthiness, string coercion, equality across encodings, the -0 exclusion
 * (i31 cannot carry the sign), and WeakSet's number rejection.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function runStandalone(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.binary?.length ?? 0).toBeGreaterThan(0);
  const module = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(module).length).toBe(0);
  const { exports } = await WebAssembly.instantiate(module, {});
  return (exports as { test?: () => unknown }).test?.();
}

describe("#3673 — i31 small-int boxing (standalone)", () => {
  it("dynamic fnctor-field arithmetic stays numeric (the acorn finishOp shape)", async () => {
    const got = await runStandalone(`var F = function F(inp) { this.input = inp; this.pos = 1; };
F.prototype.finishOp = function (size) { return this.input.slice(this.pos, this.pos + size); };
var f = new F("a+b");
export function test(): number { return f.finishOp(1) === "+" ? 1 : 0; }`);
    expect(got).toBe(1);
  });

  it("typeof a dynamically-held small int is 'number'", async () => {
    const got = await runStandalone(`var x: any = 7;
export function test(): number { return typeof x === "number" ? 1 : 0; }`);
    expect(got).toBe(1);
  });

  it("small-int === compares by value across dynamic reads", async () => {
    const got = await runStandalone(`var o: any = { a: 5, b: 5 };
export function test(): number { return o.a === o.b ? 1 : 0; }`);
    expect(got).toBe(1);
  });

  it("-0 keeps its sign through dynamic storage (excluded from i31)", async () => {
    const got = await runStandalone(`var z: any = -0;
export function test(): number { return 1 / z === -Infinity ? 1 : 0; }`);
    expect(got).toBe(1);
  });

  it("string concatenation of a dynamic small int", async () => {
    const got = await runStandalone(`var n: any = 42;
var s = "" + n;
export function test(): number { return s === "42" ? 1 : 0; }`);
    expect(got).toBe(1);
  });

  it("truthiness: dynamic 0 is falsy, 1 is truthy", async () => {
    const got = await runStandalone(`var a: any = 0;
var b: any = 1;
export function test(): number { return (a ? 0 : 1) + (b ? 1 : 0); }`);
    expect(got).toBe(2);
  });

  it("JSON.stringify of a dynamic small int", async () => {
    const got = await runStandalone(`var n: any = 9;
export function test(): number { return JSON.stringify(n) === "9" ? 1 : 0; }`);
    expect(got).toBe(1);
  });
});
