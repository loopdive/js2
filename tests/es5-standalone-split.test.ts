// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4220) Reflective `String.prototype.split` in `--target standalone`.
 *
 * The ES5 sputnik battery under `test/built-ins/String/prototype/split/`
 * exercises split almost exclusively through the TRANSFERRED form
 * (`Number.prototype.split = String.prototype.split; (123).split(1, 2)`), which
 * reaches the `native-proto.ts` closure factory rather than the direct
 * `"a,b".split(",")` lowering. That closure had no `split` arm and threw
 * `String.prototype.split is not yet implemented in --target standalone`.
 *
 * These cases pin the §22.1.3.23 behaviour the battery asserts: the array
 * result shape (`.constructor` / `.length` / element reads on an `externref`
 * receiver), ToString(this) on a non-string receiver, ToUint32(limit) including
 * its NaN / 2^32-1 / absent forms, and the step-4-before-step-5 ordering of
 * limit-ToNumber vs separator-ToString.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile `body` as a standalone (host-free) module exporting `f`, assert no
 * host imports leaked, instantiate, and return `f()`.
 *
 * The source is compiled as JS (`allowJs`) because the transferred-method idiom
 * has no TypeScript spelling — `Number.prototype.split = String.prototype.split`
 * is not on the lib's `Number` interface, and the TS-typed spellings route to a
 * different (already-native) lowering.
 */
async function runStandalone(body: string): Promise<unknown> {
  const result = await compile(`export function f() {\n${body}\n}`, {
    allowJs: true,
    fileName: "es5-standalone-split.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { f: () => unknown }).f();
}

/** The transferred-method preamble every reflective case shares. */
const TRANSFER = `var o = new Object(); o.split = String.prototype.split;`;

describe("#4220 — String.prototype.split in --target standalone", () => {
  describe("reflective (transferred) form", () => {
    it("an undefined separator yields [ToString(this)] (§22.1.3.23 step 7)", async () => {
      expect(await runStandalone(`${TRANSFER} return o.split().length;`)).toBe(1);
      expect(await runStandalone(`${TRANSFER} return o.split()[0] === "[object Object]" ? 1 : 0;`)).toBe(1);
    });

    it("ToString(this) runs on a non-string receiver before splitting", async () => {
      // 15.5.4.14_A2_T31: new Number(100111122133144155).split(1, 2) → ["", "00"]
      const src = `var n = new Number(100111122133144155); n.split = String.prototype.split;
        var r = n.split(1, 2);
        return (r.length === 2 && r[0] === "" && r[1] === "00") ? 1 : 0;`;
      expect(await runStandalone(src)).toBe(1);
    });

    it("ToString(separator) accepts a non-string separator", async () => {
      const src = `var b = new Boolean(true); b.split = String.prototype.split;
        var r = b.split("u");
        return (r.length === 2 && r[0] === "tr" && r[1] === "e") ? 1 : 0;`;
      expect(await runStandalone(src)).toBe(1);
    });

    it("an empty-string separator splits into code units", async () => {
      const src = `var s = new String("abc"); s.split = String.prototype.split;
        var r = s.split("");
        return (r.length === 3 && r[0] === "a" && r[2] === "c") ? 1 : 0;`;
      expect(await runStandalone(src)).toBe(1);
    });

    it("the result is a real Array (constructor / length / index reads)", async () => {
      expect(await runStandalone(`${TRANSFER} return o.split().constructor === Array ? 1 : 0;`)).toBe(1);
      // Compared IN-MODULE: a returned native string is a WasmGC struct the
      // host cannot read as a JS string.
      expect(await runStandalone(`${TRANSFER} return typeof o.split() === "object" ? 1 : 0;`)).toBe(1);
    });

    describe("limit — ToUint32 (§22.1.3.23 step 4)", () => {
      const split = (limit: string) =>
        `var s = new String("a,b,c,d"); s.split = String.prototype.split; return s.split(",", ${limit}).length;`;

      it("caps the piece count", async () => {
        expect(await runStandalone(split("2"))).toBe(2);
        expect(await runStandalone(split("1"))).toBe(1);
      });

      it("0 yields the empty array", async () => {
        expect(await runStandalone(split("0"))).toBe(0);
      });

      it("a non-numeric limit is ToUint32(NaN) = 0", async () => {
        expect(await runStandalone(split('"boo"'))).toBe(0);
      });

      it("an absent or explicitly-undefined limit is unbounded", async () => {
        expect(await runStandalone(split("undefined"))).toBe(4);
        expect(
          await runStandalone(`var s = new String("a,b,c,d"); s.split = String.prototype.split;
            return s.split(",").length;`),
        ).toBe(4);
      });

      it("2^32 - 1 is unbounded, not a truncated cap", async () => {
        expect(await runStandalone(split("Math.pow(2, 32) - 1"))).toBe(4);
      });

      it("an object limit is coerced through valueOf", async () => {
        expect(await runStandalone(split("{ valueOf: function () { return 2; } }"))).toBe(2);
      });
    });

    it("coerces the limit BEFORE the separator (step 4 precedes step 5)", async () => {
      // 15.5.4.14_A1_T14: the limit's throwing valueOf must win over the
      // separator's throwing toString. 1 = limit first (spec), 2 = separator
      // first (the pre-#4220 ordering a plain `__unbox_number` would give),
      // 3 = some other throw, 0 = no throw at all.
      const src = `var sep = { toString: function () { throw "intostr"; } };
        var lim = { valueOf: function () { throw "intoint"; } };
        var n = new Number(10001.10001); n.split = String.prototype.split;
        try { n.split(sep, lim); } catch (e) {
          return e === "intoint" ? 1 : (e === "intostr" ? 2 : 3);
        }
        return 0;`;
      expect(await runStandalone(src)).toBe(1);
    });

    it("throws a catchable TypeError on a null/undefined receiver", async () => {
      const src = `var m = String.prototype.split;
        try { m.call(null, ","); } catch (e) { return e instanceof TypeError ? 1 : 2; }
        return 0;`;
      expect(await runStandalone(src)).toBe(1);
    });
  });

  describe("direct form (unchanged)", () => {
    it("still splits on a string separator", async () => {
      const src = `var r = "a,b,c".split(",");
        return (r.length === 3 && r[0] === "a" && r[2] === "c") ? 1 : 0;`;
      expect(await runStandalone(src)).toBe(1);
    });
  });

  it("leaves the JS-host (gc) lane compiling the same sources", async () => {
    const result = await compile(`export function f() {\n${TRANSFER} return o.split().length;\n}`, {
      allowJs: true,
      fileName: "es5-split-gc.js",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
