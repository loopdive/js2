// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6833 — direct dynamic TypedArray find methods snapshot internal length.
 * #6835 tracks the separately measured borrowed prototype/miss, plain Array
 * undefined-value, expando-detached and entry-OOB failures. Their original
 * correct-expectation probes are preserved in the follow-up evidence.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-6833-typedarray-find-internal-length.js",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports ?? [], "standalone compiler imports").toEqual([]);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module), "standalone Wasm imports").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { probe: () => number }).probe();
}

const METHODS = ["find", "findIndex"] as const;
type Method = (typeof METHODS)[number];
const found = (method: Method) => (method === "find" ? "3" : "2");
const miss = (method: Method) => (method === "find" ? "undefined" : "-1");
function dynamic(body: string, taCtor = "Float64Array"): string {
  return `function run(TA) { ${body} } export function probe() { return run(${taCtor}); }`;
}

describe("#6833 dynamic TypedArray find/findIndex internal lengths", () => {
  for (const method of METHODS) {
    for (const target of ["a", "TA.prototype", "Object.getPrototypeOf(TA.prototype)"]) {
      it(`${method} ignores length accessors on ${target}`, async () => {
        expect(
          await runStandalone(
            dynamic(`
          const a = new TA([1, 2, 3]);
          let hits = 0;
          Object.defineProperty(${target}, "length", {
            configurable: true, get: function () { hits++; return 1; }
          });
          let calls = 0;
          const result = a.${method}(function (value) { calls++; return value === 3; });
          return hits === 0 && calls === 3 && result === ${found(method)} ? 1 : 0;
        `),
          ),
        ).toBe(1);
      });
    }

    it(`${method} ignores a throwing length getter`, async () => {
      expect(
        await runStandalone(
          dynamic(`
        const a = new TA([1, 2, 3]);
        Object.defineProperty(a, "length", { get: function () { throw 71; } });
        return a.${method}(function (value) { return value === 3; }) === ${found(method)} ? 1 : 0;
      `),
        ),
      ).toBe(1);
    });

    it(`borrowed Array ${method} observes an own length getter once`, async () => {
      expect(
        await runStandalone(
          dynamic(`
          const a = new TA([1, 2, 3]);
          let hits = 0;
          Object.defineProperty(a, "length", {
            configurable: true, get: function () { hits++; return 1; }
          });
          let calls = 0;
          const result = Array.prototype.${method}.call(a, function (value) { calls++; return value === ${method === "find" ? "1" : "3"}; });
          return hits === 1 && calls === 1 && result === ${method === "find" ? "1" : "-1"} ? 1 : 0;
        `),
        ),
      ).toBe(1);
    });

    it(`borrowed Array ${method} propagates length getter abrupt completion`, async () => {
      expect(
        await runStandalone(
          dynamic(`
        const a = new TA([1, 2, 3]);
        Object.defineProperty(a, "length", { get: function () { throw 71; } });
        let caught = 0;
        let calls = 0;
        try { Array.prototype.${method}.call(a, function () { calls++; return false; }); }
        catch (error) { caught = error === 71 ? 1 : 0; }
        return caught === 1 && calls === 0 ? 1 : 0;
      `),
        ),
      ).toBe(1);
    });

    it(`${method} preserves callback values, receiver, thisArg, order and first match`, async () => {
      expect(
        await runStandalone(
          dynamic(`
        const a = new TA([1, 2, 3]);
        const context = { token: 7 };
        let calls = 0, order = 0, valid = 1;
        const result = a.${method}(function (value, index, receiver) {
          calls++; order = order * 10 + index;
          if (receiver !== a || this !== context || value !== index + 1) valid = 0;
          return index === 1;
        }, context);
        return valid === 1 && calls === 2 && order === 1 && result === ${method === "find" ? "2" : "1"} ? 1 : 0;
      `),
        ),
      ).toBe(1);
    });

    it(`${method} handles empty views and misses`, async () => {
      expect(
        await runStandalone(
          dynamic(`
        const a = new TA([]), b = new TA([1, 2, 3]);
        let calls = 0;
        const empty = a.${method}(function () { calls++; return true; });
        const missing = b.${method}(function () { calls++; return false; });
        return calls === 3 && empty === ${miss(method)} && missing === ${miss(method)} ? 1 : 0;
      `),
        ),
      ).toBe(1);
    });

    it(`${method} rejects non-callable predicates and propagates predicate throws`, async () => {
      expect(
        await runStandalone(
          dynamic(`
        const a = new TA([1, 2, 3]);
        let typeError = 0, abrupt = 0;
        try { a.${method}(7); } catch (error) { if (error instanceof TypeError) typeError = 1; }
        try { a.${method}(function () { throw 72; }); } catch (error) { if (error === 72) abrupt = 1; }
        return typeError === 1 && abrupt === 1 ? 1 : 0;
      `),
        ),
      ).toBe(1);
    });

    it(`${method} reads later mutations live and returns the visited value or index`, async () => {
      expect(
        await runStandalone(
          dynamic(`
        const a = new TA([1, 2, 3]);
        let calls = 0;
        const result = a.${method}(function (value, index) {
          calls++;
          if (index === 0) a[1] = 7;
          if (index === 1) { a[1] = 9; return value === 7; }
          return false;
        });
        return calls === 2 && a[1] === 9 && result === ${method === "find" ? "7" : "1"} ? 1 : 0;
      `),
        ),
      ).toBe(1);
    });

    it(`${method} preserves detached entry rejection and callback detachment visits`, async () => {
      expect(
        await runStandalone(
          dynamic(`
        const entry = new TA([1, 2, 3]);
        const entryBuffer = entry.buffer;
        entryBuffer.__detached__ = true;
        let rejected = 0;
        try { entry.${method}(function () { return false; }); }
        catch (error) { if (error instanceof TypeError) rejected = 1; }
        const a = new TA([1, 2, 3]), buffer = a.buffer;
        let calls = 0, undefinedCalls = 0;
        const result = a.${method}(function (value, index) {
          calls++;
          if (index === 0) buffer.__detached__ = true;
          else if (value === undefined) undefinedCalls++;
          return false;
        });
        return rejected === 1 && calls === 3 && undefinedCalls === 2 && result === ${miss(method)} ? 1 : 0;
      `),
        ),
      ).toBe(1);
    });

    for (const taCtor of ["Int8Array", "Float64Array"]) {
      it(`${method} snapshots resized fixed/tracking ${taCtor} views with offsets`, async () => {
        expect(
          await runStandalone(
            dynamic(
              `
          const size = TA.BYTES_PER_ELEMENT;
          const buffer = new ArrayBuffer(4 * size, { maxByteLength: 8 * size });
          const fixed = new TA(buffer, size, 2), tracking = new TA(buffer, size);
          buffer.resize(5 * size);
          let fixedCalls = 0;
          fixed.${method}(function () { fixedCalls++; return false; });
          let trackingCalls = 0;
          tracking.${method}(function (value, index) {
            trackingCalls++;
            if (index === 0) buffer.resize(6 * size);
            return false;
          });
          let shrinkCalls = 0, undefinedCalls = 0;
          fixed.${method}(function (value, index) {
            shrinkCalls++;
            if (index === 0) buffer.resize(size);
            else if (value === undefined) undefinedCalls++;
            return false;
          });
          return fixedCalls === 2 && trackingCalls === 4 && shrinkCalls === 2 && undefinedCalls === 1 ? 1 : 0;
        `,
              taCtor,
            ),
          ),
        ).toBe(1);
      });
    }

    it(`generic Array ${method} keeps a plain dense receiver`, async () => {
      expect(
        await runStandalone(`
          function run(a) {
            let calls = 0;
            const result = a.${method}(function (value, index, receiver) {
              calls++;
              return value === 2 && index === 1 && receiver === a;
            });
            return calls === 2 && result === ${method === "find" ? "2" : "1"} ? 1 : 0;
          }
          export function probe() { return run([1, 2, 3]); }
        `),
      ).toBe(1);
    });

    it(`generic Array ${method} visits holes with dirty prototype indices`, async () => {
      expect(
        await runStandalone(`
          function run(a) {
            let calls = 0;
            const result = a.${method}(function (value, index, receiver) {
              calls++;
              return index === 1 && value === undefined && receiver === a;
            });
            return calls === 2 && result === ${method === "find" ? "undefined" : "1"} ? 1 : 0;
          }
          export function probe() {
            Object.prototype[7] = 99;
            const dense = run([1, undefined, 3]), sparse = run([1, , 3]);
            return dense === 1 && sparse === 1 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });
  }
});
