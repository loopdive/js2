import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #6408 follow-up — a regular METHOD on an object literal that ALSO carries a
 * getter/setter must not leak the `__make_getter_callback` JS host import in
 * `--target standalone`.
 *
 * Defect: the object-literal accessor-path compiler
 * (`compileObjectLiteralWithAccessors`, src/codegen/literals.ts) compiled its
 * getter/setter arm through the standalone-aware `emitObjectLiteralAccessorFn`
 * (host-free `compileArrowAsClosure` under `ctx.standalone`, #1888 S5b), but the
 * three sibling MethodDeclaration arms called `compileArrowAsCallback(...,
 * { needsThis: true })` UNCONDITIONALLY. With `needsThis: true` that routes
 * through the `__make_getter_callback` `env::` host import (closures.ts:2961),
 * so a literal that mixes a regular method with a getter compiled clean but
 * IMPORTED `env::__make_getter_callback` — defeating standalone (pure-Wasm)
 * output. (A getter-only literal, or a data-property + getter literal, were
 * already host-free.)
 *
 * Fix: route the three method arms through `emitObjectLiteralMethodFn`, which
 * mirrors `emitObjectLiteralAccessorFn`: standalone → host-free closure; GC /
 * JS-host → the unchanged `compileArrowAsCallback` bridge. The standalone method
 * closure is invoked through the same `__current_this`-bound closure-call path
 * the getter closures use, so `this` is bound correctly.
 */

async function buildStandalone(body: string): Promise<{
  result: number;
  envImports: string[];
}> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary))
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  const importObject: Record<string, unknown> = {};
  const { instance } = await WebAssembly.instantiate(r.binary, importObject);
  (importObject as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  const result = (instance.exports as { test(): number }).test();
  return { result, envImports };
}

describe("#6408 follow-up — object-literal method + getter is host-import-free standalone", () => {
  it("the getter still works and no env import leaks", async () => {
    const { result, envImports } = await buildStandalone(
      `const o: any = { describe() { return 5; }, get id() { return 1; } }; return o.id as number;`,
    );
    expect(result).toBe(1);
    expect(envImports).toEqual([]);
  });

  it("the method reads `this` data and no env import leaks", async () => {
    const { result, envImports } = await buildStandalone(
      `const o: any = { tag: 7, describe() { return this.tag; }, get id() { return 1; } }; return o.describe() as number;`,
    );
    expect(result).toBe(7);
    expect(envImports).toEqual([]);
  });

  it("a `this`-mutating method + getter sees the mutation", async () => {
    const { result, envImports } = await buildStandalone(
      `const o: any = { count: 0, inc() { this.count = this.count + 1; return this.count; }, get c() { return this.count; } };
       o.inc(); o.inc(); return o.c as number;`,
    );
    expect(result).toBe(2);
    expect(envImports).toEqual([]);
  });

  it("a computed-key method + getter is host-free", async () => {
    const { result, envImports } = await buildStandalone(
      `const k = 'foo'; const o: any = { [k]() { return 9; }, get g() { return 1; } }; return o.foo() as number;`,
    );
    expect(result).toBe(9);
    expect(envImports).toEqual([]);
  });

  it("an iterator-shaped object (next() method + getter) is host-free", async () => {
    // The same shape the standalone-string-global-sentinel bucket flagged
    // (iterators with a getter) — but with a STRING-named `next` method rather
    // than a `[Symbol.iterator]` computed key, which would separately pull in
    // the `__box_symbol` host import (an orthogonal well-known-Symbol-key leak,
    // NOT the `__make_getter_callback` method-body leak this fix targets).
    const { result, envImports } = await buildStandalone(
      `const o: any = {
         _i: 0,
         get done() { return false; },
         next() { return { value: this._i, done: true }; }
       };
       return o.next().value as number;`,
    );
    expect(result).toBe(0);
    expect(envImports).toEqual([]);
  });

  it("method-only literal (no getter) stays host-free — regression guard", async () => {
    const { result, envImports } = await buildStandalone(
      `const o: any = { v: 3, get2() { return this.v + 1; } }; return o.get2() as number;`,
    );
    expect(result).toBe(4);
    expect(envImports).toEqual([]);
  });
});
