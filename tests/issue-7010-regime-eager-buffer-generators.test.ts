// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7010 — the eager-buffer generator fallback under the native regime.
 *
 * A generator that neither the native #680 state machine nor the async-generator
 * drive claims used to fall to the eager host buffer (`__gen_create_buffer` /
 * `__create_generator` / `__create_async_generator` + the `__gen_*` result
 * readers), registered with `allowNoJsHost` even on standalone, WASI and the
 * native-first JS lane — imports no host-free build can satisfy. Now:
 *
 *   (A) modules whose generators all lower natively no longer register the
 *       `__gen_*` readers at all, so `IteratorResult` reads stay native
 *       (issue-1388 #2: a detached static async generator method);
 *   (B) `yield* await P` in an async generator now drives natively (the
 *       class-elements `rs-static-async-generator-method-privatename` family);
 *   (C) every remaining non-native shape is a compile error naming #7010,
 *       never a silent host import.
 *
 * Every case runs under `semanticProviders: "native-first"` in a JS environment
 * (exports through `wrapCompiledExports`, checked against the JS oracle) AND
 * `target: "standalone"`.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, wrapCompiledExports } from "../src/runtime.js";

const GEN_IMPORT = /^(__gen_|__create_generator$|__create_async_generator$)/;

function genImports(r: { imports?: readonly { name: string }[] }): string[] {
  return (r.imports ?? []).map((i) => i.name).filter((n) => GEN_IMPORT.test(n));
}

async function jsOracle(src: string): Promise<string> {
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exp: Record<string, () => unknown> = {};
  new Function("exports", "module", js)(exp, { exports: exp });
  return String(await exp.test!());
}

async function runNativeFirst(src: string): Promise<string> {
  const r = await compile(src, { fileName: "test.ts", semanticProviders: "native-first" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  expect(genImports(r)).toEqual([]);
  const built = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown> & {
    setExports?: (exports: WebAssembly.Exports) => void;
  };
  const imports: WebAssembly.Imports = {
    env: built.env as WebAssembly.ModuleImports,
    string_constants: built.string_constants as WebAssembly.ModuleImports,
  };
  if (built["wasm:js-string"]) imports["wasm:js-string"] = built["wasm:js-string"] as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  built.setExports?.(instance.exports);
  return String(await (wrapCompiledExports(r, instance).test as () => unknown)());
}

/** Standalone: zero imports; `test()` reads a counter the native microtask drain filled. */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  expect(r.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

async function expectRefused(src: string, opts: Record<string, unknown>): Promise<void> {
  const r = await compile(src, { fileName: "test.ts", ...opts });
  expect(r.success).toBe(false);
  expect(r.errors.map((e) => e.message).join("\n")).toMatch(/generator-no-host-free-lowering[^\n]*#7010/);
  expect(genImports(r)).toEqual([]);
}

// ── (A) issue-1388 #2 ──────────────────────────────────────────────────────

const DETACHED_ASYNC_GEN = `
class C {
  static async *gen() { yield 1; yield 2; yield 3; }
}
export async function test(): Promise<number> {
  const f = C.gen;
  const it = f();
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const r = await it.next();
    if (r.done) break;
    total += r.value;
  }
  return total;
}
`;

describe("#7010 (A) — all-native modules register no __gen_* readers", () => {
  it("detached static async generator method (issue-1388 #2): native-first JS-equal, no gen imports", async () => {
    expect(await runNativeFirst(DETACHED_ASYNC_GEN)).toBe(await jsOracle(DETACHED_ASYNC_GEN));
  });

  it("detached static async generator method: standalone compiles with zero imports", async () => {
    const r = await compile(DETACHED_ASYNC_GEN, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    expect(r.imports ?? []).toEqual([]);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});

// ── (B) `yield* await P` drives natively ────────────────────────────────────

const YIELD_STAR_AWAIT = `
class C {
  static async *#g(value: any) {
    yield* await value;
  }
  static get g() {
    return this.#g;
  }
}
async function* free(value: any) {
  yield* await value;
}
export async function test(): Promise<string> {
  const out: string[] = [];
  const it = free(Promise.resolve([1, 2]));
  let r = await it.next();
  while (!r.done) {
    out.push(String(r.value));
    r = await it.next();
  }
  out.push(String(r.done));
  const r2 = await C.g([7]).next();
  out.push(String(r2.value) + ":" + String(r2.done));
  return out.join(",");
}
`;

describe("#7010 (B) — `yield* await P` in an async generator", () => {
  it("native-first: JS-equal, no gen imports (free function + static private method)", async () => {
    expect(await runNativeFirst(YIELD_STAR_AWAIT)).toBe(await jsOracle(YIELD_STAR_AWAIT));
  });

  it("standalone: zero imports and the delegated values arrive", async () => {
    const value = await runStandalone(`
      let n = 0;
      async function* free(value: any) {
        yield* await value;
      }
      class C {
        static async *#g(value: any) { yield* await value; }
        static get g() { return this.#g; }
      }
      function go() {
        async function a() { for await (const v of free(Promise.resolve([1, 2]))) { n += v; } }
        async function b() { const r = await C.g([40]).next(); n += r.value; }
        a();
        b();
      }
      export function test(): number { go(); return n; }
    `);
    expect(value).toBe(43);
  });

  it("a rejected awaited operand rejects next() (native-first, JS-equal)", async () => {
    const src = `
      async function* g(value: any) { yield* await value; }
      export async function test(): Promise<string> {
        try {
          await g(Promise.reject(new Error("boom"))).next();
          return "resolved";
        } catch (e) {
          return "rejected:" + (e as Error).message;
        }
      }
    `;
    expect(await runNativeFirst(src)).toBe(await jsOracle(src));
  });
});

// ── (C) everything else is a #7010 compile error, never a host import ──────

const REFUSED: Record<string, string> = {
  "async gen method: yield inside for-await": `
    async function* readFile() { yield 1; }
    class C { static async *gen() { for await (const line of readFile()) { yield line; } } }
    export function test(): number { C.gen(); return 1; }`,
  "static async gen method reading this": `
    class C { static v = 3; static async *m() { yield this.v; } }
    export function test(): number { C.m(); return 1; }`,
  "sync gen method with nested yields in object-spread operands": `
    class C { *m() { yield { ...yield, y: 1, ...yield yield }; } }
    export function test(): number { new C().m(); return 1; }`,
  "async gen expression with yield in a try": `
    export function test(): number {
      const g = async function* () { try { yield 1; } finally { } };
      g();
      return 1;
    }`,
};

describe("#7010 (C) — non-native generator shapes are refused, not host-buffered", () => {
  for (const [name, src] of Object.entries(REFUSED)) {
    it(`standalone: ${name}`, async () => {
      await expectRefused(src, { target: "standalone" });
    });
    it(`native-first (JS environment): ${name}`, async () => {
      await expectRefused(src, { semanticProviders: "native-first" });
    });
    it(`wasi: ${name}`, async () => {
      await expectRefused(src, { target: "wasi" });
    });
  }
});
