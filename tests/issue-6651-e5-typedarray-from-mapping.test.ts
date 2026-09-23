// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster E, slice E5 — `%TypedArray%.from` mapping fidelity and the
 * static `<ConcreteTA>.from` / `.of` VALUE read, standalone.
 *
 *  - §23.2.6: `Int32Array.from` is the inherited `%TypedArray%.from` value, so
 *    `.call(C, …)` runs the real body (it read `undefined` before).
 *  - §23.2.2.1 steps 7.e / 11: mapfn is called with exactly « kValue, k »,
 *    per element, AFTER TypedArrayCreate and interleaved with that element's
 *    Set — so an abrupt ToNumber stops the mapping of the next element.
 *
 * Each case pairs a value only the fixed lowering produces with its assertion,
 * so each is red on the base.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<unknown> {
  const result = await compile(`export function test(): number { ${body} }`, {
    fileName: "issue-6651-e5.ts",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const FIX = `const ctors: any[] = [Float64Array, Int8Array]; var answer = 0;
  for (let i = 0; i < ctors.length; i++) { const C: any = ctors[i];`;

describe("#6651 E5 — %TypedArray%.from mapping + static from/of values", () => {
  it("reads `Int32Array.from` / `.of` as the inherited value and calls it", async () => {
    expect(
      await run(`const f: any = Int32Array.from; const o: any = Uint8Array.of;
      const a: any = f.call(Float64Array, [1.5, 2.5]);
      const b: any = o.call(Int16Array, 3, 4, 5);
      return a.length * 1000 + a[1] * 100 + b.length * 10 + b[2];`),
    ).toBe(2285);
  });

  it("calls mapfn with exactly two arguments, once per element", async () => {
    expect(
      await run(`${FIX}
      var calls = 0; var argc = 0;
      C.from([4, 5, 6], function (this: any, v: any, k: any) { calls++; argc += arguments.length; return v + k; });
      answer = answer * 100 + calls * 10 + argc;
    } return answer;`),
    ).toBe(3636);
  });

  it("stops mapping at an abrupt element Set", async () => {
    expect(
      await run(`${FIX}
      var last: any = 0; var threw = 0;
      const bad: any = { valueOf() { throw new RangeError("x"); } };
      try { C.from([7, bad, 9], function (v: any) { last = v; return v; }); } catch (e) { threw = e instanceof RangeError ? 1 : 2; }
      answer = answer * 100 + (last === bad ? 10 : 0) + threw;
    } return answer;`),
    ).toBe(1111);
  });

  it("ToNumbers an object element of a static `Int32Array.from` source", async () => {
    expect(
      await run(`var calls = 0; const src: any[] = [0, { valueOf() { calls++; return 100; } }, 2];
      const ta = Int32Array.from(src);
      return ta.length * 1000 + ta[1] + calls * 10;`),
    ).toBe(3110);
  });

  it("maps per element through the VALUE body too", async () => {
    expect(
      await run(`${FIX}
      const TA: any = Object.getPrototypeOf(Int8Array);
      var argc = 0; var last: any = 0;
      const bad: any = { valueOf() { throw new RangeError("x"); } };
      try { TA.from.call(C, [1, bad, 3], function (v: any) { argc += arguments.length; last = v; return v; }); } catch (e) {}
      answer = answer * 100 + argc * 10 + (last === bad ? 1 : 0);
    } return answer;`),
    ).toBe(4141);
  });
});
