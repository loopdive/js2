// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2873 (language/expressions standalone cluster) — standalone `+` with a
// `String` wrapper-object operand (`new String("1")`) produced a spurious
// `false` on the outer `===`/`!==`.
//
// Root cause: TypeScript infers `new String("1") + <non-string>` as `any`
// (only `String-wrapper + primitive-string` narrows to `string`). The concat
// itself is compiled CORRECTLY (`compileStringBinaryOp` lowers each operand to a
// native `ref $AnyString` via ToString → "11"), but the outer `=== "11"` sees an
// `any` LEFT, misses the native string-equality dispatch, and falls to
// `ref.eq`/tag-dispatch → `false`. This de-masked the standalone
// `language/expressions/addition/S11.6.1_A3.2_T{1.1,2.1,2.2,2.3,2.4}` cluster
// (String/Number/Boolean wrapper `+` operands, mixed with number/boolean/
// undefined/null).
//
// Fix (binary-ops.ts, standalone/WASI-only): recognise a `+` whose operand is
// string- or String-wrapper-typed as a STRING-producing expression at the AST
// level (`isStringConcatExpr`, wired into `leftIsStrLike`/`rightIsStrLike`), so
// the `===`/`!==` classification routes to `__str_equals` (content compare).
// Mirrors the #2192 caught-Error `.message` and #2888 relational augmentations.
//
// String returns from a standalone module are native-string refs (not JS
// strings), so these assert via boolean → number (1/0) exports.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // No host import may leak under standalone (host-free pass).
  expect(r.imports ?? []).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2873 — standalone `+` with a String wrapper operand, compared via ===/!==", () => {
  it("new String('1') + new String('1') === '11'  →  true", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (new String("1") + new String("1") === "11") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("new String('1') + 1 === '11'  →  true", async () => {
    expect(
      await runStandalone(`export function test(): number { return (new String("1") + 1 === "11") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("1 + new String('1') === '11'  →  true", async () => {
    expect(
      await runStandalone(`export function test(): number { return (1 + new String("1") === "11") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("new String('1') + new Number(1) === '11'  →  true", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (new String("1") + new Number(1) === "11") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("true + new String('1') === 'true1'  →  true (boolean coerced)", async () => {
    expect(
      await runStandalone(`export function test(): number { return (true + new String("1") === "true1") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("new Boolean(true) + new String('1') === 'true1'  →  true", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (new Boolean(true) + new String("1") === "true1") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("new String('1') + undefined === '1undefined'  →  true", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (new String("1") + undefined === "1undefined") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("new String('1') + null === '1null'  →  true", async () => {
    expect(
      await runStandalone(`export function test(): number { return (new String("1") + null === "1null") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("!== is the mirror: new String('1') + 1 !== '99'  →  true", async () => {
    expect(
      await runStandalone(`export function test(): number { return (new String("1") + 1 !== "99") ? 1 : 0; }`),
    ).toBe(1);
  });

  // ── Regression guards ──
  it("String-wrapper + primitive-string still passes (already-string TS type)", async () => {
    expect(
      await runStandalone(`export function test(): number { return (new String("1") + "1" === "11") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Number wrapper + number stays NUMERIC: new Number(1) + 1 === 2", async () => {
    expect(await runStandalone(`export function test(): number { return (new Number(1) + 1 === 2) ? 1 : 0; }`)).toBe(1);
  });

  it("plain numeric equality unaffected: 1 + 1 === 2", async () => {
    expect(await runStandalone(`export function test(): number { return (1 + 1 === 2) ? 1 : 0; }`)).toBe(1);
  });

  it("plain string concat equality unaffected: 'a' + 'b' === 'ab'", async () => {
    expect(await runStandalone(`export function test(): number { return ("a" + "b" === "ab") ? 1 : 0; }`)).toBe(1);
  });
});
