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
 *   (B) every remaining non-native shape — `yield* await P`, nested yields in
 *       spread operands / for-await / try, delegation forwarding — is a compile
 *       error naming #7010, never a silent host import. Lowering those natively
 *       is IR producer work under the direct-AST development freeze.
 *
 * Every case runs under `semanticProviders: "native-first"` in a JS environment
 * (exports through `wrapCompiledExports`, checked against the JS oracle) AND
 * `target: "standalone"`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { genImports, jsOracle, runNativeFirst } from "./helpers/native-generator-contract.js";

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

// ── (B) every other non-native shape is a #7010 compile error, never a host import

const REFUSED: Record<string, string> = {
  // The 68 test262 class/elements rs-static-async-generator-method rows: they
  // were compile errors through their host imports, now through #7010. Native
  // lowering is IR producer work (the direct-AST development freeze).
  "async gen expression with yield* await": `
    export function test(): number {
      const g = async function* (value: any) { yield* await value; };
      g([1]);
      return 1;
    }`,
  "async gen with yield* await (static private method)": `
    class C {
      static async *#g(value: any) { yield* await value; }
      static get g() { return this.#g; }
    }
    export function test(): number { C.g([1]); return 1; }`,
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

describe("#7010 (B) — non-native generator shapes are refused, not host-buffered", () => {
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
