// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4032 — non-`$Object` carriers had no `[[Extensible]]` slot.
//
// In `--target standalone` the object-integrity predicates decided object-ness
// with a single `ref.test $Object` and answered the ES *non-object argument*
// rule when it failed. An Array is a `__vec_*`, a function is a closure struct
// and a built-in prototype is its own brand struct — all objects, all answered
// with the primitive rule (never extensible, always sealed, always frozen).
//
// Every expectation below is the value **Node** produces for the identical
// source, and the HOST lane is asserted alongside standalone so a regression in
// either is caught. The host lane was already correct on all of these before
// the fix, which is what made this a standalone-lane defect.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<Record<string, number>> {
  const result = await compile(source, lane === "standalone" ? { target: "standalone" } : {});
  expect(
    result.success,
    `compile failed (${lane}):\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  const exports = instance.exports as Record<string, () => number>;
  const out: Record<string, number> = {};
  for (const name of Object.keys(exports)) {
    if (typeof exports[name] === "function" && name.startsWith("t_")) out[name] = exports[name]!();
  }
  return out;
}

// name -> [body, expected] where `expected` is Node's answer.
const PRISTINE: Array<[string, string, number]> = [
  ["t_ext_fn", `function foo() {} return Object.isExtensible(foo) ? 1 : 0;`, 1],
  ["t_ext_objproto", `return Object.isExtensible(Object.prototype) ? 1 : 0;`, 1],
  ["t_ext_arrproto", `return Object.isExtensible(Array.prototype) ? 1 : 0;`, 1],
  ["t_ext_errproto", `return Object.isExtensible(Error.prototype) ? 1 : 0;`, 1],
  ["t_ext_strproto", `return Object.isExtensible(String.prototype) ? 1 : 0;`, 1],
  ["t_ext_arr", `return Object.isExtensible([1, 2]) ? 1 : 0;`, 1],
  ["t_ext_math", `return Object.isExtensible(Math) ? 1 : 0;`, 1],
  ["t_ext_objctor", `return Object.isExtensible(Object) ? 1 : 0;`, 1],
  ["t_sealed_objproto", `return Object.isSealed(Object.prototype) ? 1 : 0;`, 0],
  ["t_sealed_arrproto", `return Object.isSealed(Array.prototype) ? 1 : 0;`, 0],
  ["t_sealed_fn", `function foo() {} return Object.isSealed(foo) ? 1 : 0;`, 0],
  ["t_frozen_objproto", `return Object.isFrozen(Object.prototype) ? 1 : 0;`, 0],
  ["t_frozen_arrproto", `return Object.isFrozen(Array.prototype) ? 1 : 0;`, 0],
  ["t_frozen_fn", `function foo() {} return Object.isFrozen(foo) ? 1 : 0;`, 0],
];

// The half that must NOT regress: an integrity mutation still has to be
// observable afterwards. Before #4032 these were right for the wrong reason —
// the predicate returned the restricted constant unconditionally.
const AFTER_MUTATION: Array<[string, string, number]> = [
  ["t_prevext_fn", `function foo() {} Object.preventExtensions(foo); return Object.isExtensible(foo) ? 1 : 0;`, 0],
  ["t_prevext_obj", `const o = { a: 1 }; Object.preventExtensions(o); return Object.isExtensible(o) ? 1 : 0;`, 0],
  ["t_sealed_after_seal", `const o = { a: 1 }; Object.seal(o); return Object.isSealed(o) ? 1 : 0;`, 1],
  ["t_frozen_after_freeze", `const o = { a: 1 }; Object.freeze(o); return Object.isFrozen(o) ? 1 : 0;`, 1],
  ["t_frozen_arr_after_freeze", `const a = [1, 2]; Object.freeze(a); return Object.isFrozen(a) ? 1 : 0;`, 1],
  ["t_sealed_arr_after_seal", `const a = [1, 2]; Object.seal(a); return Object.isSealed(a) ? 1 : 0;`, 1],
];

// The ES non-object rule must survive: `isExtensible` on a primitive is false,
// `isFrozen`/`isSealed` are true. The oracle folds `null` into the `"object"`
// tag for `typeof` fidelity, so it is the interesting case.
const NON_OBJECT: Array<[string, string, number]> = [
  ["t_ext_number", `return Object.isExtensible(5) ? 1 : 0;`, 0],
  ["t_frozen_number", `return Object.isFrozen(5) ? 1 : 0;`, 1],
  ["t_sealed_number", `return Object.isSealed(5) ? 1 : 0;`, 1],
];

const ALL = [...PRISTINE, ...AFTER_MUTATION, ...NON_OBJECT];
const SOURCE = ALL.map(([name, body]) => `export function ${name}(): number {\n${body}\n}`).join("\n");

describe("#4032 — [[Extensible]] on non-$Object carriers", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: matches Node on every integrity query`, async () => {
      const got = await run(SOURCE, lane);
      const expected: Record<string, number> = {};
      for (const [name, , want] of ALL) expected[name] = want;
      expect(got).toEqual(expected);
    }, 180_000);
  }
});
