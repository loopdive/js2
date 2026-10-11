// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 lane R1 — §10.1 [[GetPrototypeOf]] over a DYNAMICALLY-typed array in
// `--target standalone`.
//
// A compiled array is a `__vec_<elem>` struct, not an `$Object`, so it carries
// no `$proto` field and the `__getPrototypeOf` walk never started: the helper
// fell straight through to its boundary/null answer. Every STATICALLY
// array-typed receiver is folded to `%Array.prototype%` by
// `expressions/object-get-prototype-of.ts` long before the helper runs, so the
// gap was only reachable through an `any` binding:
//
//   function id(x) { return x; }
//   Object.getPrototypeOf(id([1]))     // null on base; node answers Array.prototype
//
// That is also why the three test262 rows that expose it are filed under
// cross-realm (`built-ins/Array/proto-from-ctor-realm-{one,two,zero}.js`): they
// read the prototype of a `Reflect.construct(...)` result, whose static type is
// `any`. The recorded diagnosis for those rows — "GetPrototypeFromConstructor
// does not fall back to the intrinsic default when `newTarget.prototype` is not
// an object" — is NOT the cause; that fallback already works on base (see the
// closing note below).
//
// The fix adds an array arm to `__getPrototypeOf` (`object-runtime-prototype.ts`)
// keyed on `__extern_is_array`, the same §7.2.2 predicate `Array.isArray` uses,
// answering the reserve-then-fill `%Array.prototype%` singleton.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** 1 = `=== Array.prototype`, 0 = null, 3 = undefined, 2 = some other value. */
async function protoCode(body: string): Promise<number> {
  const source = `
    function id(x: any): any { return x; }
    function classify(p: any): number {
      if (p === null) return 0;
      if (p === undefined) return 3;
      if (p === (Array as any).prototype) return 1;
      return 2;
    }
    export function test(): number {
      ${body}
    }
  `;
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#6651 R1 — Object.getPrototypeOf over a dynamically-typed array (standalone)", () => {
  it("answers %Array.prototype% for an `any`-typed array literal", async () => {
    expect(await protoCode(`return classify(Object.getPrototypeOf(id([1])));`)).toBe(1);
  });

  it("answers %Array.prototype% for an array read out of an `any` container", async () => {
    expect(await protoCode(`const box: any = { v: [1] }; return classify(Object.getPrototypeOf(box.v));`)).toBe(1);
  });

  // NOT a RED witness — `id(new Array(1))` is already folded to
  // `%Array.prototype%` on base. Kept as a hold-the-line guard so the new arm
  // cannot displace a statically-folded answer.
  it("keeps the `new Array(n)` answer unchanged", async () => {
    expect(await protoCode(`return classify(Object.getPrototypeOf(id(new Array(1))));`)).toBe(1);
  });

  it("answers %Array.prototype% through Reflect.getPrototypeOf as well", async () => {
    expect(await protoCode(`return classify(Reflect.getPrototypeOf(id([1, 2])));`)).toBe(1);
  });

  it("keeps the statically-typed answer unchanged", async () => {
    expect(await protoCode(`const a = [1]; return classify(Object.getPrototypeOf(a));`)).toBe(1);
  });

  it("does not claim %Array.prototype% for a non-array object", async () => {
    // Deliberately `not.toBe(1)`, not an exact answer: an `any`-typed ordinary
    // object literal still answers `null` here (a SEPARATE, pre-existing
    // `__getPrototypeOf` gap — the `$Object` arm's implicit-terminal handling
    // is not reached through this binding shape). This lane did not widen that
    // one; what it must never do is hand a non-array `%Array.prototype%`.
    expect(await protoCode(`return classify(Object.getPrototypeOf(id({ a: 1 })));`)).not.toBe(1);
  });

  it("does not claim %Array.prototype% for an `any`-typed string", async () => {
    expect(await protoCode(`return classify(Object.getPrototypeOf(id("abc")));`)).not.toBe(1);
  });

  // NOT covered here: the §10.1.14 intrinsic-default fallback for a
  // `Reflect.construct` with a distinct NewTarget whose `prototype` is not an
  // object. It is ALREADY correct on base — measured through the authoritative
  // test262 lane, `function NT(){} NT.prototype = null;
  // Reflect.construct(Array, [1], NT)` answers `Array.prototype` there — but it
  // cannot be pinned from this `compile()` lane: a TypeScript-source NewTarget
  // trips the pre-existing #3371 refusal
  // ("standalone Reflect.construct cannot preserve an arbitrary distinct
  // NewTarget ..."), which is a compile error rather than a wrong answer. The
  // three `built-ins/Array/proto-from-ctor-realm-*.js` rows are the live
  // coverage for it; see the receipt in plan/issues/6651-*.md.
});
