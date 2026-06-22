// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2106 (value-rep P3, undefined observability) — standalone strict `===` /
 * `!==` over two fully type-erased `any` nullish operands.
 *
 * Root cause (binary-ops.ts, the `noJsHost` externref-equality cascade): two
 * `any`-typed operands that both read back as `ref.null extern` (e.g. the
 * test262 `isSameValue` harness comparing `undefined`/`null` values pulled out
 * of an `any` carrier) fell through the number/boolean/bigint cascade to the
 * eqref-identity arm, where `any.convert_extern(null)` fails `ref.test $eq` and
 * returns 0. So `undefined === undefined` and `null === null` were both WRONG
 * (`false`) in standalone mode. The LOOSE path already had a both-nullish guard
 * (#2081); the STRICT path did not. This shares that guard across both modes.
 *
 * All cases run under `--target standalone` and assert ZERO `env` host imports
 * (the comparison stays pure-Wasm).
 *
 * KNOWN BOUNDARY: a fully type-erased `null === undefined` now returns `true`
 * (both operands are the identical `ref.null extern` bit pattern, so no inline
 * test can split them). Distinguishing the two requires the tag-1 `$undefined`
 * singleton (this issue's S1 slice). The type-AWARE path (operands with a
 * statically-known null/undefined type) still keeps `null === undefined` false
 * — see tests/issue-1021-null-vs-undefined.test.ts which stays green.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runBool(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  expect(result.success, result.success ? "" : `compile error: ${result.errors?.[0]?.message}`).toBe(true);
  // Host-free: the equality cascade must not leak an env import.
  const envImports = result.imports.filter((i) => i.module === "env");
  expect(envImports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return Boolean((instance.exports as { test: () => unknown }).test());
}

describe("#2106 — standalone strict equality over type-erased nullish `any`", () => {
  it("undefined === undefined is true (read back out of an any[] carrier)", async () => {
    // The `i = a.length - 2` index defeats the compiler's literal const-fold,
    // forcing a genuine runtime externref-vs-externref comparison.
    expect(
      await runBool(
        `export function test(): boolean { const a: any[] = [undefined, undefined]; const i = a.length - 2; return a[i] === a[i + 1]; }`,
      ),
    ).toBe(true);
  });

  it("null === null is true (read back out of an any[] carrier)", async () => {
    expect(
      await runBool(
        `export function test(): boolean { const a: any[] = [null, null]; const i = a.length - 2; return a[i] === a[i + 1]; }`,
      ),
    ).toBe(true);
  });

  it("undefined !== undefined is false", async () => {
    expect(
      await runBool(
        `export function test(): boolean { const a: any[] = [undefined, undefined]; const i = a.length - 2; return a[i] !== a[i + 1]; }`,
      ),
    ).toBe(false);
  });

  it("nullish !== non-nullish stays true (undefined === number is false)", async () => {
    expect(
      await runBool(
        `export function test(): boolean { const a: any[] = [undefined, 5]; const i = a.length - 2; return a[i] === a[i + 1]; }`,
      ),
    ).toBe(false);
  });

  it("non-nullish identity is unaffected (5 === 5 through any stays true)", async () => {
    expect(
      await runBool(
        `export function test(): boolean { const a: any[] = [5, 5]; const i = a.length - 2; return a[i] === a[i + 1]; }`,
      ),
    ).toBe(true);
  });

  it("loose `null == undefined` stays true (both-nullish, unchanged)", async () => {
    expect(
      await runBool(
        `export function test(): boolean { const a: any[] = [null, undefined]; const i = a.length - 2; return a[i] == a[i + 1]; }`,
      ),
    ).toBe(true);
  });
});
