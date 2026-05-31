// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1502 — localStorage / sessionStorage host imports with standalone fallback.
//
// The compiler recognises `localStorage` and `sessionStorage` identifier
// reads and emits the host imports `__get_localStorage` /
// `__get_sessionStorage`. The runtime returns a real browser Storage when
// the host exposes one, falls back to a user-supplied `deps.localStorage`
// override, or otherwise uses an in-memory Map-backed polyfill so the
// generated Wasm still runs end-to-end in Node / Bun / WASI.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function compileAndRun(source: string, deps?: Record<string, unknown>): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary\nWAT:\n${result.wat}`);
  }
  const runtimeResult = buildRuntimeImports(result.imports ?? [], deps, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtimeResult);
  if (runtimeResult.setExports) {
    runtimeResult.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports as Record<string, Function>;
}

/** Hide an ambient global (without `delete`) for the duration of a callback,
 *  so the runtime falls through to the in-memory polyfill path. */
async function withoutAmbientStorage<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const origLocal = Object.getOwnPropertyDescriptor(g, "localStorage");
  const origSession = Object.getOwnPropertyDescriptor(g, "sessionStorage");
  Object.defineProperty(g, "localStorage", { value: undefined, configurable: true, writable: true });
  Object.defineProperty(g, "sessionStorage", { value: undefined, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (origLocal) Object.defineProperty(g, "localStorage", origLocal);
    else Object.defineProperty(g, "localStorage", { value: undefined, configurable: true, writable: true });
    if (origSession) Object.defineProperty(g, "sessionStorage", origSession);
    else Object.defineProperty(g, "sessionStorage", { value: undefined, configurable: true, writable: true });
  }
}

/** Build an isolated polyfill Storage so tests don't bleed into one another. */
function makeStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(k: string): string | null {
      return store.has(k) ? store.get(k)! : null;
    },
    setItem(k: string, v: string): void {
      store.set(String(k), String(v));
    },
    removeItem(k: string): void {
      store.delete(k);
    },
    key(i: number): string | null {
      const keys = [...store.keys()];
      return keys[i] ?? null;
    },
  } as Storage;
}

describe("#1502 — localStorage / sessionStorage host imports", () => {
  it("setItem + getItem round-trip on injected localStorage", async () => {
    const source = `
      export function test(): string {
        localStorage.setItem("k1", "v1");
        const v = localStorage.getItem("k1");
        return v === null ? "MISSING" : v;
      }
    `;
    const exports = await compileAndRun(source, { localStorage: makeStorageMock() });
    expect(exports.test!()).toBe("v1");
  });

  it("removeItem clears the entry", async () => {
    const source = `
      export function test(): string {
        localStorage.setItem("k1", "v1");
        const before = localStorage.getItem("k1") || "MISSING";
        localStorage.removeItem("k1");
        const after = localStorage.getItem("k1");
        return before + "/" + (after === null ? "GONE" : after);
      }
    `;
    const exports = await compileAndRun(source, { localStorage: makeStorageMock() });
    expect(exports.test!()).toBe("v1/GONE");
  });

  it("localStorage and sessionStorage are distinct stores", async () => {
    const source = `
      export function test(): string {
        localStorage.setItem("scope", "L");
        sessionStorage.setItem("scope", "S");
        return localStorage.getItem("scope") + "|" + sessionStorage.getItem("scope");
      }
    `;
    const exports = await compileAndRun(source, {
      localStorage: makeStorageMock(),
      sessionStorage: makeStorageMock(),
    });
    expect(exports.test!()).toBe("L|S");
  });

  it("standalone fallback: no deps and no host global — polyfill works", async () => {
    await withoutAmbientStorage(async () => {
      const source = `
        export function test(): string {
          localStorage.setItem("foo", "bar");
          const v = localStorage.getItem("foo");
          return v === null ? "MISSING" : v;
        }
      `;
      const exports = await compileAndRun(source);
      expect(exports.test!()).toBe("bar");
    });
  });

  it("polyfill: localStorage and sessionStorage are distinct, with no deps", async () => {
    await withoutAmbientStorage(async () => {
      const source = `
        export function test(): string {
          localStorage.setItem("scope", "L");
          sessionStorage.setItem("scope", "S");
          return localStorage.getItem("scope") + "|" + sessionStorage.getItem("scope");
        }
      `;
      const exports = await compileAndRun(source);
      expect(exports.test!()).toBe("L|S");
    });
  });

  it("polyfill state survives within one buildImports() instance", async () => {
    await withoutAmbientStorage(async () => {
      const source = `
        export function setIt(): void {
          localStorage.setItem("k", "hello");
        }
        export function getIt(): string {
          const v = localStorage.getItem("k");
          return v === null ? "MISSING" : v;
        }
      `;
      const exports = await compileAndRun(source);
      exports.setIt!();
      expect(exports.getIt!()).toBe("hello");
    });
  });

  it("polyfill state is per-instance — two instantiations don't share", async () => {
    await withoutAmbientStorage(async () => {
      const source = `
        export function setIt(): void {
          localStorage.setItem("shared", "first");
        }
        export function getIt(): string {
          const v = localStorage.getItem("shared");
          return v === null ? "EMPTY" : v;
        }
      `;
      const a = await compileAndRun(source);
      const b = await compileAndRun(source);
      a.setIt!();
      expect(b.getIt!()).toBe("EMPTY");
      expect(a.getIt!()).toBe("first");
    });
  });
});
