// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster E, slice E4 — `%TypedArray%.from` / `%TypedArray%.of` as
 * first-class VALUES in standalone.
 *
 *  - §23.2.2 / §23.2.6: every concrete constructor INHERITS `from`/`of` from
 *    `%TypedArray%` — `C.of === TypedArray.of`, and `C` has no own `of`.
 *  - §23.2.2.2 `of` and §23.2.2.1 `from` have real bodies behind the value, so
 *    `TypedArray.of.call(C, …)` / `TypedArray.from.call(C, …)` build a `C`
 *    instead of throwing the "not yet implemented" refusal.
 *  - §23.2.2.1 step 3 through the VALUE: an explicit `null` mapfn is a
 *    TypeError while an omitted one maps nothing — the reason `from` takes the
 *    packed variadic ABI.
 *  - §23.2.4.6 TypedArrayCreate for an ORDINARY constructor `this`.
 *
 * Every case combines a value the pre-E4 base could not produce (its `from` /
 * `of` values threw the refusal) with the assertion, so each is red on the base.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<unknown> {
  const result = await compile(`export function test(): number { ${body} }`, {
    fileName: "issue-6651-e4.ts",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

// The `testWithTypedArrayConstructors` shape: constructors as `any` VALUES, and
// the intrinsic reached through `Object.getPrototypeOf`.
const FIX = `const ctors: any[] = [Float64Array, Int8Array]; var answer = 0;
  const TA: any = Object.getPrototypeOf(Int8Array);
  for (let i = 0; i < ctors.length; i++) { const C: any = ctors[i];`;

describe("#6651 E4 — %TypedArray%.{from,of} values", () => {
  it("inherits one identity-stable value per member, without an own property", async () => {
    expect(
      await run(`${FIX}
      answer = answer * 10 + (C.of === TA.of ? 1 : 0) + (C.from === TA.from ? 2 : 0) + (C.hasOwnProperty("of") ? 4 : 0);
    } return answer;`),
    ).toBe(33);
  });

  it("runs §23.2.2.2 `of` through the value", async () => {
    expect(
      await run(`${FIX}
      const r: any = TA.of.call(C, 7, 8);
      answer = answer * 100 + r.length * 10 + (r[1] === 8 ? 1 : 0);
    } return answer;`),
    ).toBe(2121);
  });

  it("runs §23.2.2.1 `from`, with and without a mapfn, through the value", async () => {
    expect(
      await run(`${FIX}
      const a: any = TA.from.call(C, [3, 4, 5]);
      const b: any = TA.from.call(C, [1, 2], function (v: any) { return v * 3; });
      answer = answer * 100 + a.length * 10 + b[1];
    } return answer;`),
    ).toBe(3636);
  });

  it("throws for an explicit null mapfn but maps nothing for an omitted or undefined one", async () => {
    expect(
      await run(`${FIX}
      var threw = 0;
      try { TA.from.call(C, [1], null); } catch (e) { threw = e instanceof TypeError ? 1 : 2; }
      answer = answer * 100 + TA.from.call(C, [9], undefined)[0] * 10 + threw;
    } return answer;`),
    ).toBe(9191);
  });

  it("constructs through an ordinary constructor `this` exactly once", async () => {
    expect(
      await run(`${FIX}
      var calls = 0;
      const ctor: any = function (len: any) { calls++; return new C(len); };
      const r: any = TA.of.call(ctor, 42, 43, 44);
      answer = answer * 100 + calls * 10 + r.length;
    } return answer;`),
    ).toBe(1313);
  });

  it("rejects a non-constructor `this` and a nullish source with a TypeError", async () => {
    expect(
      await run(`${FIX}
      var bits = TA.of.call(C, 5)[0] === 5 ? 1 : 0;
      try { TA.of.call({ m() { return 1; } }.m, 1); } catch (e) { if (e instanceof TypeError) bits += 2; }
      try { TA.from.call(C); } catch (e) { if (e instanceof TypeError) bits += 4; }
      answer = answer * 10 + bits;
    } return answer;`),
    ).toBe(77);
  });
});
