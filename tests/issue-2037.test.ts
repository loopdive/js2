import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2037 — standalone NamedEvaluation: the `.name` of an anonymous
 * function/arrow/generator/class used as a *destructuring default value* must
 * be the bound identifier (§8.4.5 NamedEvaluation / §8.6.3
 * KeyedBindingInitialization). 683 test262 cases in the
 * `dstr/*-id-init-fn-name-{fn,arrow,gen,cover,class}` family pass in JS-host
 * mode but were reported failing in standalone (verified on 936d1ac51).
 *
 * Reproduced as FIXED on current main for the path the real (untyped) test262
 * `.js` files take: an object-literal `{}` source infers as a typed empty-object
 * struct, and that destructuring-default binding-initialization path now sets
 * the inferred name correctly. (The per-iteration destructure-buffer reset in
 * #1970 / commit 4c14a0256 covers the for-head shape that diverged.)
 *
 * These guards deliberately mirror the test262 `.js` shapes WITHOUT `as any`
 * casts — an `{} as any` source routes through the externref destructuring path,
 * which is a *separate* standalone concern (it traps), not the `.name` bug #2037
 * tracks. The bound `cover`/`fn`/… are untyped here exactly as in the `.js`
 * source.
 *
 * Compiled standalone (`target: "wasi"` → pure WasmGC, no JS host); the `.name`
 * assertion runs inside Wasm and returns a numeric code. The only host import
 * these patterns need is `__extern_is_undefined` (so the default fires when the
 * property is missing); a faithful stub is provided.
 */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const env: Record<string, (...a: unknown[]) => unknown> = {
    __extern_is_undefined: (v: unknown) => (v === undefined ? 1 : 0),
  };
  for (const i of WebAssembly.Module.imports(mod)) {
    if (i.module === "env" && i.kind === "function" && !(i.name in env)) {
      env[i.name] = () => 0;
    }
  }
  const { instance } = await WebAssembly.instantiate(r.binary, { env });
  return (instance.exports as { test(): number }).test();
}

describe("#2037 standalone NamedEvaluation of destructuring-default fns/classes", () => {
  it("for-head: cover-parenthesized default gets the binding name", async () => {
    // `for (var { cover = (function () {}) } = {}; ...)` → cover.name === "cover"
    const code = await runStandalone(
      `export function test() {
        let r = 0;
        for (var { cover = (function () {}) } = {}; r < 1; ) {
          const nm = cover.name;
          r = nm === "cover" ? 1 : (typeof nm === "string" ? 100 + nm.length : 999);
        }
        return r;
      }`,
    );
    expect(code).toBe(1);
  });

  it("for-head: cover-comma initializer stays anonymous", async () => {
    // `xCover = (0, function() {})` is NOT a NamedEvaluation → name is ""
    const code = await runStandalone(
      `export function test() {
        let r = 0;
        for (var { xCover = (0, function () {}) } = {}; r < 1; ) {
          const nm = xCover.name;
          // pass when the name is empty (anonymous); fail (999) if it picked up "xCover"
          r = nm === "xCover" ? 999 : (typeof nm === "string" ? 1 + nm.length : 998);
        }
        return r;
      }`,
    );
    expect(code).toBe(1); // empty name → 1 + 0
  });

  it("var multi-binding: fn / arrow / generator each named", async () => {
    const code = await runStandalone(
      `export function test() {
        var { fn = function () {}, arrow = () => {}, gen = function* () {} } = {};
        return (fn.name === "fn" ? 1 : 0) * 100 +
               (arrow.name === "arrow" ? 1 : 0) * 10 +
               (gen.name === "gen" ? 1 : 0);
      }`,
    );
    expect(code).toBe(111);
  });

  it("let multi-binding: fn / arrow named", async () => {
    const code = await runStandalone(
      `export function test() {
        let { fn = function () {}, arrow = () => {} } = {};
        return (fn.name === "fn" ? 1 : 0) * 10 + (arrow.name === "arrow" ? 1 : 0);
      }`,
    );
    expect(code).toBe(11);
  });

  it("let single-binding: class default gets the binding name", async () => {
    const code = await runStandalone(
      `export function test() {
        let { C = class {} } = {};
        const nm = C.name;
        return nm === "C" ? 1 : (typeof nm === "string" ? 100 + nm.length : 999);
      }`,
    );
    expect(code).toBe(1);
  });
});
