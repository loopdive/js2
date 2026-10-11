// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster E, slice E2 — three standalone TypedArray mechanisms.
 *
 *  - §10.4.5.6 `[[OwnPropertyKeys]]` on a dynamic view: the integer indices in
 *    ascending order, then the own string keys, and NOT `"length"` (an
 *    integer-indexed exotic object has no `length` own property — the vec arm
 *    that used to answer here is written for an ordinary Array).
 *  - §23.2.1 — the `%TypedArray%` intrinsic is admitted to the
 *    `from`/`of` static call-site arm, so `%TypedArray%.from(src)` performs
 *    the source drain and only THEN fails TypedArrayCreate. Before, the
 *    abstract-constructor TypeError was its first observable act, which hid
 *    every abrupt completion the drain was supposed to surface.
 *  - §23.2.2.1 step 3 — `IsCallable(mapfn)` is checked before step 4's
 *    `GetMethod(source, @@iterator)`, and `null` is not `undefined`.
 *
 * The `any`-typed constructor binding is load-bearing in the MOP tests: a
 * statically-typed `new Int8Array(2)` lowers to a plain compiler vec, a
 * different representation with different key semantics. Only an `any` callee
 * produces the `$__ta_dyn_view` these rows are about.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<unknown> {
  const result = await compile(`export function test(): number { ${body} }`, {
    fileName: "issue-6651-e2.ts",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

// An `any`-typed constructor value — the `testWithTypedArrayConstructors`
// shape, and the only one that reaches the dynamic-view representation.
const DYN = `const ctors: any[] = [Int8Array]; var answer = 0;
  for (const C of ctors) {`;

// The `%TypedArray%` intrinsic arm is gated on a live `$__ta_ctor` TYPE
// (`ctx.taCtorTypeIdx >= 0 || builtinObjectGlobals.has("ctor:Int8Array")`), and
// that type is only registered once some constructor is used as a first-class
// VALUE. `testTypedArray.js` always does (`testWithTypedArrayConstructors`
// stores the constructors in an array), so every row this closes has it — but a
// module that only mentions `Object.getPrototypeOf(Int8Array)` does NOT, and
// there `TA.from` still reaches the refusal closure. Keeping the ctor value in
// the fixture is what makes this test measure the arm rather than the gate.
const INTRINSIC = `const ctors: any[] = [Int8Array]; var answer = 0;
  const warm: any = ctors[0].from([1]);
  answer += warm.length - 1;
  const TA: any = Object.getPrototypeOf(Int8Array);`;

describe("#6651 E2 — §10.4.5.6 [[OwnPropertyKeys]] on a dynamic view", () => {
  it("answers the integer indices only, without a spurious `length`", async () => {
    expect(
      await run(`${DYN}
      const sample: any = new C(3);
      const keys: any = Reflect.ownKeys(sample);
      answer = keys.length * 10 + (keys.indexOf("length") < 0 ? 1 : 0);
    } return answer;`),
    ).toBe(31);
  });

  it("answers an empty key list for a zero-length view", async () => {
    expect(
      await run(`${DYN}
      const keys: any = Reflect.ownKeys(new C());
      answer = keys.length;
    } return answer;`),
    ).toBe(0);
  });

  it("appends own string keys after the indices, in creation order", async () => {
    expect(
      await run(`${DYN}
      const sample: any = new C(2);
      sample.test262 = 42;
      const keys: any = Reflect.ownKeys(sample);
      answer =
        (keys.length === 3 ? 1 : 0) +
        (keys[0] === "0" ? 2 : 0) +
        (keys[1] === "1" ? 4 : 0) +
        (keys[2] === "test262" ? 8 : 0);
    } return answer;`),
    ).toBe(15);
  });

  it("agrees with Object.getOwnPropertyNames and leaves a plain object alone", async () => {
    expect(
      await run(`${DYN}
      const sample: any = new C(2);
      const plain: any = { a: 1, b: 2 };
      answer =
        (Object.getOwnPropertyNames(sample).length === 2 ? 1 : 0) +
        (Object.getOwnPropertyNames(plain).length === 2 ? 2 : 0) +
        (Reflect.ownKeys([1, 2, 3]).length === 4 ? 4 : 0);
    } return answer;`),
    ).toBe(7);
  });
});

describe("#6651 E2 — %TypedArray% static from/of", () => {
  it("surfaces an abrupt completion from the array-like length read", async () => {
    expect(
      await run(`${INTRINSIC}
      const src: any = {};
      Object.defineProperty(src, "length", {
        get: function () { throw new RangeError("marker"); },
      });
      try { TA.from(src); } catch (e) { answer = e instanceof RangeError ? 1 : e instanceof TypeError ? 2 : 3; }
      return answer;`),
    ).toBe(1);
  });

  it("still refuses to CONSTRUCT the abstract %TypedArray%", async () => {
    expect(
      await run(`${INTRINSIC}
      try { TA.from([1, 2]); } catch (e) { answer = e instanceof TypeError ? 1 : 2; }
      return answer;`),
    ).toBe(1);
  });
});

describe("#6651 E2 — §23.2.2.1 step 3 IsCallable(mapfn)", () => {
  it("throws a TypeError for a present, non-callable mapfn", async () => {
    expect(
      await run(`${DYN}
      try { C.from([1, 2], null); } catch (e) { answer += e instanceof TypeError ? 1 : 0; }
      try { C.from([1, 2], 42); } catch (e) { answer += e instanceof TypeError ? 2 : 0; }
      try { C.from([1, 2], {}); } catch (e) { answer += e instanceof TypeError ? 4 : 0; }
    } return answer;`),
    ).toBe(7);
  });

  it("checks the mapfn before reading source[@@iterator]", async () => {
    expect(
      await run(`${DYN}
      var gets = 0;
      const src: any = {};
      Object.defineProperty(src, Symbol.iterator, { get: function () { gets = gets + 1; } });
      try { C.from(src, null); } catch (e) { /* expected */ }
      answer = gets;
    } return answer;`),
    ).toBe(0);
  });

  it("keeps an absent or undefined mapfn on the no-mapping path", async () => {
    expect(
      await run(`${DYN}
      answer = C.from([1, 2, 3]).length * 10 + C.from([1, 2], undefined).length;
    } return answer;`),
    ).toBe(32);
  });
});
