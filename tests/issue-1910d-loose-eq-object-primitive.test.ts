// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1910d / #1472 R1 — standalone loose-equality (`==`/`!=`) Object↔primitive
 * ToPrimitive arm (ECMA-262 §7.2.13 IsLooselyEqual steps 11-12).
 *
 * The standalone/WASI (`noJsHost`) loose-eq cascade in `binary-ops.ts` handled
 * number/boolean/bigint/string/reference-identity but had NO arm for "exactly
 * one operand is an Object, the other a primitive". So `new Number(7) == 7`,
 * `new Boolean(true) == 1`, and `{ valueOf: () => 5 } == 5` all fell through to
 * reference identity → wrong `false`. The fix reduces the object operand via the
 * native `__to_primitive` engine (LOOSE only — strict `===` never coerces) and
 * re-runs the primitive cascade.
 *
 * Number/Boolean wrapper + plain-valueOf object cases are covered here. The
 * object→String reduction cases (`new String("x") == "x"`, `{toString}` vs a
 * string literal) are blocked by a SEPARATE pre-existing standalone defect where
 * an `any`/object operand compared `==` against a *statically string-typed*
 * literal mis-coerces the string operand to NaN (reproduces with no objects
 * involved) — tracked separately, not part of this arm.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runBool(src: string): Promise<number> {
  const r = await compile(src, { fileName: "issue-1910d.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

const cases: Array<[string, string, number]> = [
  ["{valueOf} == number", `export function test(): boolean { const o = { valueOf: () => 5 }; return o == 5; }`, 1],
  ["number == {valueOf}", `export function test(): boolean { const o = { valueOf: () => 5 }; return 5 == o; }`, 1],
  ["{valueOf} != mismatch", `export function test(): boolean { const o = { valueOf: () => 5 }; return o != 6; }`, 1],
  [
    "{valueOf} == mismatch is false",
    `export function test(): boolean { const o = { valueOf: () => 5 }; return o == 6; }`,
    0,
  ],
  ["new Number(7) == 7", `export function test(): boolean { const n = new Number(7); return n == 7; }`, 1],
  ['"7" == new Number(7)', `export function test(): boolean { const n = new Number(7); return "7" == n; }`, 1],
  ["new Boolean(true) == 1", `export function test(): boolean { const b = new Boolean(true); return b == 1; }`, 1],
  ['"1" == new Boolean(true)', `export function test(): boolean { const b = new Boolean(true); return "1" == b; }`, 1],
  // strict === must NOT coerce a wrapper to its primitive (§7.2.16)
  [
    "new Number(7) === 7 is false",
    `export function test(): boolean { const n = new Number(7); return (n as any) === 7; }`,
    0,
  ],
];

describe("#1910d standalone loose-eq Object↔primitive ToPrimitive arm (§7.2.13)", () => {
  for (const [name, src, expected] of cases) {
    it(name, async () => {
      expect(await runBool(src)).toBe(expected);
    });
  }
});
