// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1500 — fetch() host import with Response bridge
//
// Verifies that compiled TypeScript can call `fetch(url)` and access
// `.status` / `.ok` / `.json()` / `.text()` on the resulting Response.
// The runtime bridge in src/runtime.ts wires `fetch` to `globalThis.fetch`
// and unwraps the Response via the existing extern_class / extern_get
// dispatch.
//
// The current `__await` host import is the identity function — full
// promise unwrap waits on #1326c (microtask queue). The tests here use a
// synchronous mock fetch (and sync .json()/.text() helpers) so the bridge
// itself can be exercised today; the full async path lands when #1326c
// upgrades `__await`. Per the issue: "the await machinery (case 'await'
// import) only unwraps real Promise instances — not the value the callback
// eventually returns".
//
// The compiled sources rely on lib.dom's `Response` type so the compiler
// routes `.status` / `.ok` / `.json()` / `.text()` through the
// `extern_class` host-import path (opaque externref). Locally declaring
// `interface Response { ... }` would synthesise a WasmGC struct type
// instead, which won't match a JS Response handle at runtime.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndInstantiate(src: string) {
  const result = await compile(src, { fileName: "test.ts" });
  expect(result.success, `compile failed: ${result.errors[0]?.message ?? "unknown"}`).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, any>;
}

// Synchronous Response-shaped stub. The compiler's `await` import is the
// identity function (#1326c tracks proper Promise unwrap); sync .json()
// and .text() allow the property/method bridge to be tested end-to-end
// without going through a microtask.
function makeSyncResponse(opts: { status?: number; ok?: boolean; jsonBody?: unknown; textBody?: string }): any {
  return {
    status: opts.status ?? 200,
    ok: opts.ok ?? true,
    statusText: "OK",
    headers: new Map<string, string>(),
    json: () => opts.jsonBody,
    text: () => opts.textBody ?? "",
  };
}

describe("#1500 fetch() host import", () => {
  let originalFetch: unknown;

  beforeEach(() => {
    originalFetch = (globalThis as any).fetch;
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("reads .status from awaited Response", async () => {
    (globalThis as any).fetch = vi.fn(() => makeSyncResponse({ status: 200 }));

    const src = `
      export async function getStatus(url: string): Promise<number> {
        const res = await fetch(url);
        return res.status;
      }
    `;
    const ex = await compileAndInstantiate(src);
    expect(ex.getStatus("/x")).toBe(200);
  });

  it("reads .ok flag from awaited Response (true)", async () => {
    (globalThis as any).fetch = vi.fn(() => makeSyncResponse({ ok: true, status: 200 }));

    const src = `
      export async function isOk(url: string): Promise<boolean> {
        const res = await fetch(url);
        return res.ok;
      }
    `;
    const ex = await compileAndInstantiate(src);
    expect(ex.isOk("/x")).toBeTruthy();
  });

  it("reads .ok flag from awaited Response (false)", async () => {
    (globalThis as any).fetch = vi.fn(() => makeSyncResponse({ ok: false, status: 404 }));

    const src = `
      export async function isOk(url: string): Promise<boolean> {
        const res = await fetch(url);
        return res.ok;
      }
    `;
    const ex = await compileAndInstantiate(src);
    expect(ex.isOk("/x")).toBeFalsy();
  });

  it("reads parsed JSON body via .json()", async () => {
    (globalThis as any).fetch = vi.fn(() => makeSyncResponse({ jsonBody: { name: "Alice" } }));

    const src = `
      export async function getName(url: string): Promise<string> {
        const res = await fetch(url);
        const obj: any = await res.json();
        return obj.name as string;
      }
    `;
    const ex = await compileAndInstantiate(src);
    expect(ex.getName("/x")).toBe("Alice");
  });

  it("reads response text via .text()", async () => {
    (globalThis as any).fetch = vi.fn(() => makeSyncResponse({ textBody: "hello world" }));

    const src = `
      export async function getText(url: string): Promise<string> {
        const res = await fetch(url);
        return await res.text();
      }
    `;
    const ex = await compileAndInstantiate(src);
    expect(ex.getText("/x")).toBe("hello world");
  });

  it("throws when globalThis.fetch is unavailable", async () => {
    (globalThis as any).fetch = undefined;

    const src = `
      export async function getStatus(url: string): Promise<number> {
        const res = await fetch(url);
        return res.status;
      }
    `;
    const ex = await compileAndInstantiate(src);
    expect(() => ex.getStatus("/x")).toThrow(/js2wasm: fetch is not available/);
  });

  it("forwards URL string to host fetch", async () => {
    const spy = vi.fn(() => makeSyncResponse({ status: 204 }));
    (globalThis as any).fetch = spy;

    const src = `
      export async function hit(url: string): Promise<number> {
        const res = await fetch(url);
        return res.status;
      }
    `;
    const ex = await compileAndInstantiate(src);
    expect(ex.hit("/api/users/42")).toBe(204);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe("/api/users/42");
  });
});
