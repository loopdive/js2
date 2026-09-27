// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 TA1 — `toLocaleString`'s element step on a NUMBER, standalone.
 *
 * §23.2.3.29 (`%TypedArray%`) reuses §23.1.3.32 (`Array`) verbatim, and step
 * 6.c.i is `ToString(? Invoke(element, "toLocaleString"))` — not
 * `ToString(element)`. #4655 installed that Invoke only on the arms whose
 * element can carry an OWN `toLocaleString`, so a NUMBER element ignored a
 * `Number.prototype.toLocaleString` override on both `Array` and every
 * TypedArray view.
 *
 * Two disjoint lowerings are pinned here, because the receiver's static shape
 * decides which one runs and the first cut of the fix served only one of them
 * (its probe passed while all 10 test262 rows stayed red):
 *
 *  - a locally-resolvable view / a plain numeric array → the numeric element arm
 *    of `array-methods.ts::compileArrayJoinNative` (`__num_to_locale_string`);
 *  - a dynamically-typed receiver, which is what test262's
 *    `testWithTypedArrayConstructors` produces → the `toLocaleString` arm of
 *    `call-receiver-method.ts` (`__ta_to_locale_string`).
 *
 * The negative controls are as load-bearing as the positives: an UNPATCHED
 * module must keep rendering natively (absent-not-wrong, and no per-element
 * dispatch), and `join`/`toString` must not move — they are different methods
 * and take no element Invoke.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<unknown> {
  const result = await compile(`export function test(): any { ${body} }`, {
    fileName: "issue-6651-ta1.ts",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

/** The `testWithTypedArrayConstructors` shape: the ctor arrives as a parameter. */
const DYN = `function withTA(cb: any) {
    const ctors: any[] = [Int8Array, Float64Array];
    for (const C of ctors) cb(C);
  }`;

describe("#6651 TA1 — a number element runs Invoke(element, 'toLocaleString')", () => {
  it("invokes the override for a DYNAMIC TypedArray receiver (the test262 shape)", async () => {
    expect(
      await run(`${DYN}
      (Number.prototype as any).toLocaleString = function (this: any) { return "P" + this; };
      var answer = 0;
      withTA(function (C: any) {
        const sample: any = new C(2);
        sample[0] = 42;
        if (sample.toLocaleString() === "P42,P0") answer += 1;
      });
      return answer;`),
    ).toBe(2);
  });

  it("invokes the override for a locally-resolvable view and a plain numeric array", async () => {
    expect(
      await run(`(Number.prototype as any).toLocaleString = function (this: any) { return "P" + this; };
      var answer = 0;
      const view = new Int8Array(2);
      view[0] = 42;
      if (view.toLocaleString() === "P42,P0") answer += 1;
      const arr = [42, 0];
      if (arr.toLocaleString() === "P42,P0") answer += 2;
      return answer;`),
    ).toBe(3);
  });

  it("applies ToString to the Invoke RESULT, so an object result runs its toString", async () => {
    expect(
      await run(`${DYN}
      (Number.prototype as any).toLocaleString = function () {
        return { toString: function () { return "T"; } };
      };
      var answer = 0;
      withTA(function (C: any) {
        const sample: any = new C(2);
        if (sample.toLocaleString() === "T,T") answer += 1;
      });
      return answer;`),
    ).toBe(2);
  });

  it("propagates an abrupt completion out of the element's toLocaleString", async () => {
    expect(
      await run(`${DYN}
      (Number.prototype as any).toLocaleString = function () { throw new RangeError("boom"); };
      var answer = 0;
      withTA(function (C: any) {
        const sample: any = new C(2);
        try {
          sample.toLocaleString();
        } catch (e) {
          answer += e instanceof RangeError ? 1 : 0;
        }
      });
      return answer;`),
    ).toBe(2);
  });

  it("propagates an abrupt completion out of the RESULT's toString", async () => {
    expect(
      await run(`${DYN}
      (Number.prototype as any).toLocaleString = function () {
        return { toString: function () { throw new RangeError("boom"); } };
      };
      var answer = 0;
      withTA(function (C: any) {
        const sample: any = new C(2);
        try {
          sample.toLocaleString();
        } catch (e) {
          answer += e instanceof RangeError ? 1 : 0;
        }
      });
      return answer;`),
    ).toBe(2);
  });

  it("renders natively when the module does NOT override the member", async () => {
    expect(
      await run(`${DYN}
      var answer = 0;
      withTA(function (C: any) {
        const sample: any = new C(2);
        sample[0] = 42;
        if (sample.toLocaleString() === "42,0") answer += 1;
      });
      const arr = [42, 0];
      if (arr.toLocaleString() === "42,0") answer += 4;
      return answer;`),
    ).toBe(6);
  });

  it("leaves join and toString alone in an OVERRIDING module", async () => {
    expect(
      await run(`${DYN}
      (Number.prototype as any).toLocaleString = function (this: any) { return "P" + this; };
      var answer = 0;
      withTA(function (C: any) {
        const sample: any = new C(2);
        sample[0] = 42;
        if (sample.toString() === "42,0") answer += 1;
        if (sample.join("-") === "42-0") answer += 2;
      });
      const arr = [42, 0];
      if (arr.toString() === "42,0") answer += 12;
      if (arr.join("-") === "42-0") answer += 24;
      return answer;`),
    ).toBe(42);
  });

  it("leaves a NON-view externref receiver on the byte-identical pre-existing path", async () => {
    // `__ta_to_locale_string` is reached for EVERY externref receiver; its body
    // `ref.test`s the dynamic-view brand and its fallthrough tail is literally
    // `call __extern_toString` — the single instruction this arm emitted before
    // the fix (standalone maps `toLocaleString` to `__extern_toString`, see
    // `toLSName` in call-receiver-method.ts). So a plain object must keep
    // answering EXACTLY as it did, including the pre-existing standalone gap
    // that its OWN `toLocaleString` is not dispatched here — that gap is
    // §20.1.3.5 / §21.1.3.4 front-end work, out of this lane's scope, and
    // pinning it is what proves the fallthrough changed no bytes.
    expect(
      await run(`${DYN}
      (Number.prototype as any).toLocaleString = function (this: any) { return "P" + this; };
      var answer = 0;
      withTA(function (C: any) {
        const sample: any = new C(1);
        if (sample.toLocaleString() === "P0") answer += 1;
      });
      const plain: any = { toLocaleString: function () { return "OWN"; } };
      if (plain.toLocaleString() === "[object Object]") answer += 4;
      return answer;`),
    ).toBe(6);
  });
});
