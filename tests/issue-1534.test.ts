// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1534 — Web API host import unit tests.
//
// Coverage notes — the compiler does NOT specialize `fetch`, `setTimeout`,
// `localStorage`, etc. with dedicated import intents. Instead, the standard
// route is to access them through `globalThis`:
//
//   `(globalThis as any).fetch(url)`
//        ↓
//   `__get_globalThis` (declared_global { name: "globalThis" })
//      then __extern_get to read `.fetch`
//      then __extern_method_call to invoke it on globalThis
//
// `resolveImport`'s "declared_global" case (`src/runtime.ts`) consults the
// optional `globalSandbox` option supplied to `buildImports` before falling
// back to the real host `globalThis`. We exploit that here: each test builds
// a `vm.createContext` sandbox carrying the mock Web API surface, threads
// it through `buildImports`, and asserts that the compiled Wasm reaches the
// mock.
//
// This matches the pattern documented in tests/issue-1310.test.ts.

import { randomFillSync } from "node:crypto";
import { createContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileWithSandbox(source: string, sandboxProps: Record<string, unknown>) {
  const r = await compile(source, { fileName: "input.ts" });
  expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  expect(r.success).toBe(true);
  const sandbox = createContext({ ...sandboxProps }) as Record<string, unknown>;
  const built = buildImports(r.imports, undefined, r.stringPool, {
    globalSandbox: sandbox,
  });
  const { instance } = await WebAssembly.instantiate(r.binary, built);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return { instance, sandbox };
}

describe("#1534 — Web API host imports (via globalThis + globalSandbox)", () => {
  describe("setTimeout / clearTimeout", () => {
    it("setTimeout(fn, 0) invokes the mock and returns its id", async () => {
      const calls: { ms: number; cbType: string }[] = [];
      const { instance } = await compileWithSandbox(
        `
          export function fireOnce(): any {
            return (globalThis as any).setTimeout(() => {}, 0);
          }
        `,
        {
          setTimeout: (cb: unknown, ms: number) => {
            calls.push({ ms, cbType: typeof cb });
            // Call the cb immediately so we observe the invocation path.
            if (typeof cb === "function") (cb as () => void)();
            return 7777;
          },
        },
      );
      const id = (instance.exports.fireOnce as () => unknown)();
      // The id returned through externref/ToNumber may surface as a JS number
      // or be passed straight through — accept either shape.
      expect(id).toBe(7777);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.ms).toBe(0);
      expect(calls[0]!.cbType).toBe("function");
    });

    it("clearTimeout(id) invokes the mock with the provided id", async () => {
      const cleared: unknown[] = [];
      const { instance } = await compileWithSandbox(
        `
          export function cancel(id: number): void {
            (globalThis as any).clearTimeout(id);
          }
        `,
        {
          clearTimeout: (id: unknown) => {
            cleared.push(id);
          },
        },
      );
      (instance.exports.cancel as (i: number) => void)(42);
      expect(cleared).toEqual([42]);
    });
  });

  describe("fetch (mocked Response)", () => {
    it("fetch(url) returns the mock's Response; response.json() resolves to parsed JSON", async () => {
      // The compiled Wasm just forwards fetch's return value as externref.
      // We assert on the round-trip: Wasm hands the externref back to JS,
      // and JS observes the same object the mock produced.
      const expectedJson = { ok: true, value: 42 };
      const seenUrls: string[] = [];
      const fakeResponse = {
        json: () => Promise.resolve(expectedJson),
        text: () => Promise.resolve(JSON.stringify(expectedJson)),
        ok: true,
        status: 200,
      };
      const { instance } = await compileWithSandbox(
        `
          export function doFetch(url: string): any {
            return (globalThis as any).fetch(url);
          }
        `,
        {
          fetch: (url: string) => {
            seenUrls.push(url);
            return fakeResponse;
          },
        },
      );
      const got = (instance.exports.doFetch as (u: string) => unknown)("https://example.com/api");
      expect(got).toBe(fakeResponse);
      expect(seenUrls).toEqual(["https://example.com/api"]);
      // JSON round-trip happens entirely in JS land — confirm the mock works.
      await expect((got as { json: () => Promise<unknown> }).json()).resolves.toEqual(expectedJson);
    });
  });

  describe("localStorage (in-memory mock)", () => {
    it("setItem / getItem round-trip a value through the host mock", async () => {
      const store = new Map<string, string>();
      const mockLocalStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      };
      const { instance } = await compileWithSandbox(
        `
          export function lsSet(k: string, v: string): void {
            (globalThis as any).localStorage.setItem(k, v);
          }
          export function lsGet(k: string): any {
            return (globalThis as any).localStorage.getItem(k);
          }
        `,
        { localStorage: mockLocalStorage },
      );
      (instance.exports.lsSet as (k: string, v: string) => void)("greeting", "hello, web api");
      expect((instance.exports.lsGet as (k: string) => unknown)("greeting")).toBe("hello, web api");
      // Missing key → null sentinel, surfaced as externref(null) → JS null.
      expect((instance.exports.lsGet as (k: string) => unknown)("absent")).toBeNull();
      // Sanity: the mock actually saw the writes.
      expect(store.get("greeting")).toBe("hello, web api");
    });
  });

  describe("crypto.getRandomValues (Node randomFillSync as mock)", () => {
    it("getRandomValues fills the provided typed array with entropy", async () => {
      // The simplest mock is Node's randomFillSync — same API shape on
      // Uint8Array/Uint32Array/etc. Wrap in a `crypto` namespace mirroring
      // the Web Crypto API surface that the compiled Wasm reaches via
      // `globalThis.crypto.getRandomValues(...)`.
      const mockCrypto = {
        getRandomValues: <T extends ArrayBufferView>(arr: T): T => randomFillSync(arr as never),
      };
      // The param is typed `any` so the compiler treats the Wasm-side type as
      // externref — the host receives the real Uint8Array, not a wasmGC vec
      // struct that would require the DataView marshaling fallback.
      const { instance } = await compileWithSandbox(
        `
          export function fillBytes(arr: any): any {
            return (globalThis as any).crypto.getRandomValues(arr);
          }
        `,
        { crypto: mockCrypto },
      );
      const buf = new Uint8Array(16);
      const returned = (instance.exports.fillBytes as (a: Uint8Array) => unknown)(buf);
      // The mock returns `arr` itself; the Wasm forwards it back as externref.
      expect(returned).toBe(buf);
      // At least one byte should be non-zero with overwhelming probability.
      expect(buf.some((b) => b !== 0)).toBe(true);
    });
  });
});
