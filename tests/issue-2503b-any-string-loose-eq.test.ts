// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2503b — `any`/object operand `==`/`===` against a statically string-typed
 * RIGHT operand mis-coerced the string to a boxed number.
 *
 * The coercion plan in `binary-ops.ts` routed `"lit" == any` (left string) to
 * `compileStringBinaryOp` (correct string-aware §7.2.15 dispatch), but the
 * reversed `any == "lit"` (right string) fell through to the equality/`noJsHost`
 * dispatch, which ToNumber-coerced the string literal to
 * `__box_number(__str_to_number("lit"))` = NaN. So equal strings compared
 * unequal — `function eq(a:any){return a=="ab";} eq("ab")` returned `false`
 * standalone (while `a==="ab"` and the reversed `"ab"==a` returned `true`).
 *
 * Root cause: in the struct-ref coercion block of `compileBinaryExpression`,
 * LOOSE equality (`==`/`!=`) where one operand is a native-string ref and the
 * other is externref (`any`) fell into the ToNumber path (`coerceType(ref →
 * f64)`), scanning the string to NaN. The STRICT (`===`/`!==`) counterpart was
 * already fixed (#1914 mixed externref+native-string arm); loose was not.
 *
 * Fix: a loose-equality guard boxes the native-string ref to externref and lets
 * BOTH operands fall through to the standalone abstract-equality cascade, which
 * dispatches on the RUNTIME tag (§7.2.15): string⇄string content compare,
 * string⇄number ToNumber, nullish guard, Object→ToPrimitive. This restores
 * operand-order independence WITHOUT static string routing — so an `any` that
 * holds a number/null/undefined/object is still compared per spec (the −3
 * test262 regression of the first attempt, which routed unconditionally to
 * `compileStringBinaryOp`). Tested in both standalone and JS-host modes.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runBool(src: string, target: "standalone" | "gc"): Promise<number> {
  const r = await compile(src, { fileName: "issue-2503b.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const imports = target === "standalone" ? {} : { env: { __box_number: (x: number) => x } };
  const { instance } = await WebAssembly.instantiate(r.binary, imports as never);
  return (instance.exports as { test(): number }).test();
}

const cases: Array<[string, string, number]> = [
  [
    "any == lit (equal)",
    `function eq(a: any): boolean { return a == "ab"; } export function test(): boolean { return eq("ab"); }`,
    1,
  ],
  [
    "any == lit (mismatch)",
    `function eq(a: any): boolean { return a == "ab"; } export function test(): boolean { return eq("xy") ? false : true; }`,
    1,
  ],
  [
    "any != lit (equal → false)",
    `function eq(a: any): boolean { return a != "ab"; } export function test(): boolean { return eq("ab") ? false : true; }`,
    1,
  ],
  [
    "any === lit (equal)",
    `function eq(a: any): boolean { return a === "ab"; } export function test(): boolean { return eq("ab"); }`,
    1,
  ],
  [
    "lit == any (reversed, equal)",
    `function eq(a: any): boolean { return "ab" == a; } export function test(): boolean { return eq("ab"); }`,
    1,
  ],
  // ── §7.2.15 abstract-equality regression guards (the −3 of the first attempt) ──
  // The first fix routed `any == "lit"` to a pure string-content compare, which
  // mis-handled an `any` that holds a NON-string at runtime. These pin the
  // runtime-dispatched cascade so it can't regress to static string routing.
  [
    "any(number) == numeric-string (ToNumber, not String())",
    // 5 == "5.0" → ToNumber("5.0")=5 → true (String(5)="5" would give false)
    `function eq(a: any): boolean { return a == "5.0"; } export function test(): boolean { return eq(5); }`,
    1,
  ],
  [
    "any(number 0) == empty string",
    // 0 == "" → ToNumber("")=0 → true
    `function eq(a: any): boolean { return a == ""; } export function test(): boolean { return eq(0); }`,
    1,
  ],
  [
    "any(number) == exponent string",
    // 100 == "1e2" → ToNumber("1e2")=100 → true
    `function eq(a: any): boolean { return a == "1e2"; } export function test(): boolean { return eq(100); }`,
    1,
  ],
  [
    "any(number) != numeric-string → false",
    `function eq(a: any): boolean { return a != "5.0"; } export function test(): boolean { return eq(5) ? false : true; }`,
    1,
  ],
  [
    "any(null) == lit → false (never coerces)",
    `function eq(a: any): boolean { return a == "ab"; } export function test(): boolean { return eq(null) ? false : true; }`,
    1,
  ],
  [
    "any(undefined) == lit → false",
    `function eq(a: any): boolean { return a == "ab"; } export function test(): boolean { return eq(undefined) ? false : true; }`,
    1,
  ],
  [
    "any(object toString) == lit → ToPrimitive then string compare",
    `function eq(a: any): boolean { return a == "ab"; } export function test(): boolean { return eq({ toString() { return "ab"; } }); }`,
    1,
  ],
  [
    "any(number) === numeric-string (strict → false by type)",
    `function eq(a: any): boolean { return a === "5"; } export function test(): boolean { return eq(5) ? false : true; }`,
    1,
  ],
];

describe("#2503b any-vs-typed-string `==` no NaN mis-coercion (standalone)", () => {
  for (const [name, src, expected] of cases) {
    it(name, async () => {
      expect(await runBool(src, "standalone")).toBe(expected);
    });
  }
});

// JS-host mode routes these comparisons through `__host_loose_eq`/`__host_eq`
// (correct JS `==`/`===`), so the standalone-only NaN mis-coercion never applied
// there. We only assert the rerouting does not break codegen/validation in
// JS-host mode (full host-string instantiation needs the wasm:js-string glue,
// out of scope for this unit test).
describe("#2503b any-vs-typed-string `==` (JS-host mode — compiles & validates)", () => {
  for (const [name, src] of cases) {
    it(name, async () => {
      const r = await compile(src, { fileName: "issue-2503b-host.ts", target: "gc" });
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
    });
  }
});
