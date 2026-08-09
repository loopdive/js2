// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2581 — native OBJECT-LITERAL generator methods in a no-JS-host target.
 *
 * Follow-up to #2571 (which landed native CLASS generator methods). Before this
 * slice, an object-literal generator method (`const o = { *m(){ yield … } }`)
 * still imported the eager-buffer host runtime (`__gen_create_buffer` /
 * `__create_generator` / …) and could not instantiate standalone — #2571
 * deferred it because object-literal methods lower through a different
 * (lifted-closure) emit path.
 *
 * The enabling observation: the object-literal method body func ALSO leads with
 * a `this` struct param (`methodFctxParams[0] = (ref $struct)`, literals.ts), so
 * the #2571 synthetic-`this` state-struct model applies uniformly. Wiring the
 * literals.ts generator-method emit through `compileNativeGeneratorFunction`
 * (and lifting the object-literal arm of the candidate-gate bail) makes them
 * native — the closure trampoline carries the `$GenState` ref result through.
 *
 * Asserts: ZERO `__gen_*` host imports, instantiates with an EMPTY import
 * object, correct values + laziness. Capturing / `arguments` / `super` object-
 * literal method generators keep the host bail (valid Wasm, no regression).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HOST_GEN_RE = /^(__gen_|__create_generator|__create_async_generator)/;

async function compileNoHost(src: string): Promise<{ binary: Uint8Array; genImports: string[] }> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const genImports = WebAssembly.Module.imports(mod)
    .filter((i) => HOST_GEN_RE.test(i.name))
    .map((i) => `${i.module}::${i.name}`);
  return { binary: r.binary, genImports };
}

async function runNative(src: string): Promise<number> {
  const { binary, genImports } = await compileNoHost(src);
  expect(genImports, "native object-literal method generator must emit NO __gen_* host import").toEqual([]);
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2581 native object-literal generator methods (no-JS-host target)", () => {
  it("simple object-literal method generator: o.m().next().value === 9, no host imports", async () => {
    const src = `export function test(): number {
  const o = { *m() { yield 9; } };
  return (o.m().next().value as number);
}`;
    expect(await runNative(src)).toBe(9);
  });

  it("object-literal method generator reading this: yields this.x", async () => {
    const src = `export function test(): number {
  const o = { x: 7, *m() { yield this.x; } };
  return (o.m().next().value as number);
}`;
    expect(await runNative(src)).toBe(7);
  });

  it("this AND a user param", async () => {
    const src = `export function test(): number {
  const o = { x: 10, *m(d: number) { yield this.x + d; } };
  return (o.m(5).next().value as number);
}`;
    expect(await runNative(src)).toBe(15);
  });

  it("multiple yields stream in order", async () => {
    const src = `export function test(): number {
  const o = { *m() { yield 1; yield 2; yield 3; } };
  const it = o.m();
  return (it.next().value as number) * 100 + (it.next().value as number) * 10 + (it.next().value as number);
}`;
    expect(await runNative(src)).toBe(123);
  });

  it("done flag after the last yield", async () => {
    const src = `export function test(): number {
  const o = { *m() { yield 7; } };
  const it = o.m();
  it.next();
  return it.next().done ? 1 : 0;
}`;
    expect(await runNative(src)).toBe(1);
  });

  it("lazy: the body does not run until the first .next()", async () => {
    const src = `let ran = 0;
export function test(): number {
  const o = { *m() { ran = 1; yield 1; } };
  const it = o.m();
  const before = ran;
  it.next();
  return before * 10 + ran;
}`;
    expect(await runNative(src)).toBe(1);
  });

  it("each o.m() call produces a FRESH generator state", async () => {
    const src = `export function test(): number {
  const o = { *m() { yield 1; yield 2; } };
  const a = o.m();
  const b = o.m();
  a.next();
  return (a.next().value as number) * 10 + (b.next().value as number);
}`;
    // a advanced twice (→2), b advanced once (→1): 2*10 + 1 = 21
    expect(await runNative(src)).toBe(21);
  });

  it("for-of drives the object-literal generator", async () => {
    const src = `export function test(): number {
  const o = { *m() { yield 1; yield 2; yield 3; } };
  let s = 0;
  for (const x of o.m()) s += x;
  return s;
}`;
    expect(await runNative(src)).toBe(6);
  });

  it("distinct-named object-literal generators each register their own state machine", async () => {
    // Two object literals with DIFFERENT method names → distinct method funcs +
    // distinct `$GenState` registrations (a same-NAME same-shape pair would
    // dedup to one method func — the pre-existing object-literal method dedup,
    // identical for non-generators — so use distinct names to exercise two
    // independent native generators).
    const src = `export function test(): number {
  const a = { *first() { yield 100; } };
  const b = { *second() { yield 200; } };
  return (a.first().next().value as number) * 1000 + (b.second().next().value as number);
}`;
    expect(await runNative(src)).toBe(100200);
  });

  it("a generator method coexists with a regular method on the same object", async () => {
    const src = `export function test(): number {
  const o = { v: 5, *gen() { yield this.v; }, plain() { return this.v + 1; } };
  return (o.gen().next().value as number) * 10 + o.plain();
}`;
    expect(await runNative(src)).toBe(56);
  });

  it("DEFAULT-param object-literal generator method lowers NATIVELY (#3948 — was: bail to host)", async () => {
    // (#3948) Pre-fix this asserted the eager-host bail, on a diagnosis that was
    // wrong twice over. The mechanism was NOT the closure trampoline — a plain
    // `o.m()` is a direct call and does reach `maybeSetArgcForKnownCall`; what it
    // found there was an empty `ctx.funcOptionalParams`, because object-literal
    // methods were the one method form that never registered optional-param
    // metadata. And the remedy was not sound either: routing to the eager-buffer
    // HOST path does not apply the default correctly — measured on the host lane,
    // this same source yields 0 there too. So the bail bought no correctness, only
    // a `__gen_*` leak. #3948 registers the metadata in literals.ts, which makes
    // the argc-driven default fire in both lanes, and lifts the bail.
    const src = `export function test(): number {
  const o = { *m(d: number = 5) { yield d; } };
  return (o.m().next().value as number);
}`;
    expect(await runNative(src)).toBe(5);
  });

  it("OPTIONAL(`?`)-param object-literal generator method still bails to host (value-rep gap)", async () => {
    // (#3948) The `questionToken` half of the old bail SURVIVES, and was measured
    // rather than inherited: with the argc registration in place, `a?: number`
    // still lowers to a bare f64 with no `undefined` inhabitant, so the missing-arg
    // branch has nothing to bind and the body reads 0, not 42. Admitting it would
    // trade a leak for a wrong value. The same 0 comes out of a NON-generator
    // `{ m(a?: number) }`, so this is a value-representation gap, not a gate one.
    const src = `export function test(): number {
  const o = { *m(d?: number) { yield d === undefined ? 42 : d; } };
  return (o.m().next().value as number);
}`;
    const { binary, genImports } = await compileNoHost(src);
    expect(genImports.length, "optional-param objlit generator must still bail to host").toBeGreaterThan(0);
    expect(WebAssembly.validate(binary), "optional-param bail module must be valid Wasm").toBe(true);
  });

  it("explicit-arg (no default) object-literal generator method stays native", async () => {
    const src = `export function test(): number {
  const o = { *m(d: number) { yield d; } };
  return (o.m(5).next().value as number);
}`;
    expect(await runNative(src)).toBe(5);
  });

  it("capturing object-literal method generator lowers NATIVELY in standalone (#3032 W4 — was: bail to host)", async () => {
    // (#3032 W4) Pre-W4 this asserted the eager-host bail; the method body
    // resolves `cap` through the promotion globals (fctx-independent), so the
    // standalone lane now routes native — zero host imports, lazy (§27.5),
    // and the value reads back correctly.
    const src = `function outer(): number {
  let cap = 3;
  const o = { *m() { yield cap; } };
  return (o.m().next().value as number);
}
export function test(): number { return outer(); }`;
    expect(await runNative(src)).toBe(3);
  });

  it("class + free function* generators stay native (regression guard)", async () => {
    expect(
      await runNative(`class C { *m() { yield 42; } }
export function test(): number { return (new C().m().next().value as number); }`),
    ).toBe(42);
    expect(
      await runNative(`function* g() { yield 5; }
export function test(): number { return (g().next().value as number); }`),
    ).toBe(5);
  });
});
