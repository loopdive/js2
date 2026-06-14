// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #2038 (PATH A) — standalone native `{next()}`-protocol iterator carrier.
 *
 * A custom iterable `{ [Symbol.iterator]() { return { next() {…} } } }` compiles
 * to a *closed nominal WasmGC struct*, not the open `$Object` hash-map. The
 * vec-only native iterator runtime `ref.cast`s its arg to the externref vec, so a
 * custom-iterable subject trapped `illegal cast` (sync for-of), and the
 * `__extern_method_call`/`__extern_get` dispatch helpers (which gate on
 * `ref.test $Object`) returned null for it, hanging `__iterator_next` forever.
 *
 * PATH A wires the native carrier's USER arm through the closed-struct
 * dispatchers the finalize pass already emits — `__call_@@iterator` / `__call_next`
 * (`emitIteratorMethodExport`) and `__sget_value` / `__sget_done`
 * (`emitStructFieldGetters`) — via the #1719 reserve-then-fill discipline. This
 * fixes BOTH sync `for-of` and (sync-backed) async `for await` over a custom
 * iterable in standalone, with zero `env` imports. (Async generators + `yield*`
 * and genuinely-pending-Promise for-await stay deferred — sub-bucket B / PR-C.)
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** env imports leaked by the compiled module (must be empty in standalone). */
function envImports(result: Awaited<ReturnType<typeof compile>>): string[] {
  return result.imports.filter((i) => i.module === "env").map((i) => i.name);
}

/** Compile standalone (wasi), assert zero env imports + valid module, run `test`. */
async function runStandalone(src: string): Promise<unknown> {
  const result = await compile(src, { fileName: "t.ts", target: "wasi" });
  expect(result.success, `compile failed: ${result.errors?.map((e) => e.message).join("; ")}`).toBe(true);
  expect(envImports(result), "standalone module must leak no env imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const ret = (instance.exports as Record<string, () => unknown>).test?.();
  return ret;
}

/** Compile JS-host mode and run `test` (parity check). */
async function runHost(src: string): Promise<unknown> {
  const result = await compile(src, { fileName: "t.ts" });
  expect(result.success, `host compile failed: ${result.errors?.map((e) => e.message).join("; ")}`).toBe(true);
  const importObject = (result as unknown as { importObject: WebAssembly.Imports }).importObject;
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  (importObject as unknown as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  const ret = (instance.exports as Record<string, () => unknown>).test?.();
  return ret;
}

const SYNC_CUSTOM_ITERABLE = `
  export function test(): number {
    const it = {
      [Symbol.iterator]() {
        let i = 0;
        return { next() { return i < 3 ? { value: i++, done: false } : { value: undefined, done: true }; } };
      }
    };
    let sum = 0;
    for (const x of it) sum += x;
    return sum;
  }
`;

const SYNC_CUSTOM_ITERABLE_ARR = `
  export function test(): number {
    const arr = [10, 20, 30];
    const it = {
      [Symbol.iterator]() {
        let n = 0;
        return { next() { return n < arr.length ? { value: arr[n++], done: false } : { value: 0, done: true }; } };
      }
    };
    let sum = 0;
    for (const x of it) sum += x;
    return sum;
  }
`;

const ASYNC_FOR_AWAIT_SYNC_BACKED = `
  export async function test(): Promise<number> {
    const it = {
      [Symbol.iterator]() {
        let i = 0;
        return { next() { return i < 3 ? { value: i++, done: false } : { value: undefined, done: true }; } };
      }
    };
    let sum = 0;
    for await (const x of it) sum += x;
    return sum;
  }
`;

describe("#2038 — standalone native {next()} iterator carrier", () => {
  it("sync for-of over a custom {next()} iterable sums correctly (standalone)", async () => {
    expect(await runStandalone(SYNC_CUSTOM_ITERABLE)).toBe(3);
  });

  it("sync for-of over a custom iterable backed by an array (standalone)", async () => {
    expect(await runStandalone(SYNC_CUSTOM_ITERABLE_ARR)).toBe(60);
  });

  it("async for await over a sync-backed custom iterable (standalone, no env imports)", async () => {
    expect(await runStandalone(ASYNC_FOR_AWAIT_SYNC_BACKED)).toBe(3);
  });

  it("matches JS-host mode for the custom-iterable for-of", async () => {
    expect(await runHost(SYNC_CUSTOM_ITERABLE)).toBe(3);
    expect(await runHost(SYNC_CUSTOM_ITERABLE_ARR)).toBe(60);
  });

  it("array for-of stays standalone-clean (no regression)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { let s = 0; for (const x of [1, 2, 3, 4]) s += x; return s; }`,
      ),
    ).toBe(10);
  });

  it("array for await stays standalone-clean (no regression)", async () => {
    expect(
      await runStandalone(
        `export async function test(): Promise<number> { let s = 0; for await (const x of [1, 2, 3]) s += x; return s; }`,
      ),
    ).toBe(6);
  });
});
