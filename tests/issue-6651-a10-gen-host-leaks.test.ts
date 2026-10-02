/**
 * #6651 cluster A, slice A10 — generator shapes that failed to compile, or leaked
 * the host generator runtime (`env::__create_generator` & co.), in standalone.
 *
 *  - (b) an object-literal generator METHOD that uses `super` — the closure lane
 *    already carries the method's [[HomeObject]], and its receiver is now the
 *    `this` the factory snapshots into the frame (the body runs later, in the
 *    resume function, when `__current_this` belongs to someone else);
 *  - (b) a CLASS generator method with a runtime computed key (keyed by the
 *    `__cmdyn$` synthetic name), and `static *m()` beside `*m()`;
 *  - (c) a rest parameter on a generator (declaration, expression, method);
 *  - (d) `*[yield]() {}` inside a generator sent TypeScript's checker into
 *    unbounded recursion; `yield* g2()` where `g2` is declared AFTER the
 *    outer generator emitted invalid Wasm (an `eqref` delegation slot read with
 *    `ref.as_non_null`); a `finally` that `return`s trapped on `.return(v)`;
 *    a top-level `obj.foo = yield` was a #680 refusal.
 *
 * Every case is RED on the base commit (compile failure, a host import, invalid
 * Wasm, or a trap) and asserts the standalone binary imports NOTHING.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(prelude: string, body: string): Promise<unknown> {
  const src = `${prelude}\nexport function test(): any {\n${body}\n}`;
  const r = (await compile(src, {
    fileName: "t.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  expect(r.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 A10 · object-literal generator method using super (group b)", () => {
  it("super.method() resolves through the home object's prototype", async () => {
    const prelude = `var proto: any = { method() { return 42; } };
var object: any = { *g() { yield super.method(); } };
Object.setPrototypeOf(object, proto);`;
    expect(await run(prelude, `return object.g().next().value;`)).toBe(42);
  });

  it("the super call's receiver is the method's this, snapshotted at call time", async () => {
    const prelude = `var proto: any = { who() { return this.tag; } };
var object: any = { tag: "o", *g() { yield super.who(); } };
Object.setPrototypeOf(object, proto);
var other: any = { tag: "x", g: object.g };`;
    expect(await run(prelude, `return object.g().next().value + other.g().next().value === "ox" ? 1 : 0;`)).toBe(1);
  });
});

describe("#6651 A10 · class generator methods keyed at runtime (group b)", () => {
  it("symbol-keyed generator methods carry their SetFunctionName names", async () => {
    const prelude = `var named = Symbol("t");
var anon = Symbol();
class A {
  *[named]() {}
  *[anon]() {}
  static *[named]() {}
  static *[anon]() {}
}`;
    const body = `return [A.prototype[named].name, A.prototype[anon].name, A[named].name, A[anon].name].join("|") === "[t]||[t]|" ? 1 : 0;`;
    expect(await run(prelude, body)).toBe(1);
  });

  it("a static generator runs beside a same-named instance generator", async () => {
    const prelude = `var named = Symbol("t");
class A {
  *id() { yield 1; }
  static *id() { yield 2; }
  static *[named]() { yield 3; }
}`;
    const body = `return new A().id().next().value * 100 + A.id().next().value * 10 + A[named]().next().value;`;
    expect(await run(prelude, body)).toBe(123);
  });
});

describe("#6651 A10 · rest parameters on generators (group c)", () => {
  it("top-level declaration: the rest vec is packed like a plain function's", async () => {
    const prelude = `function* g(...a: any[]) { yield a.length; yield a[1]; }`;
    const body = `var it = g(1, 2, 3); var n = it.next().value; return n * 10 + it.next().value;`;
    expect(await run(prelude, body)).toBe(32);
  });

  it("an empty rest is an empty array", async () => {
    const prelude = `function* g(...a: any[]) { yield a.length; }`;
    expect(await run(prelude, `return g().next().value;`)).toBe(0);
  });

  it("generator expression and object-literal method", async () => {
    const prelude = `var h: any = function* (x: any, ...a: any[]) { yield a.length + x; };
var o: any = { *m(...a: any[]) { yield a.length; } };`;
    expect(await run(prelude, `return h(10, 2, 3).next().value * 10 + o.m(1, 2, 3, 4).next().value;`)).toBe(124);
  });
});

describe("#6651 A10 · compile crash, invalid Wasm, residual bails (group d)", () => {
  it("a generator method keyed by the enclosing generator's yield compiles", async () => {
    const prelude = `var obj: any = null;
var iter: any = (function* () { obj = { *[yield]() {} }; })();`;
    const body = `iter.next(); iter.next("viaExpr"); return Object.getOwnPropertyNames(obj).join("|") === "viaExpr" ? 1 : 0;`;
    expect(await run(prelude, body)).toBe(1);
  });

  it("yield* into a generator declared later in the source", async () => {
    const prelude = `function* g() { yield* g2(); }
function* g2() { yield 7; }`;
    expect(await run(prelude, `return g().next().value;`)).toBe(7);
  });

  it("a finally that returns overrides .return(v)", async () => {
    const prelude = `function* g() { try { yield 1; } finally { return 2; } }`;
    const body = `var it = g(); it.next(); var r = it.return(45); return r.value * 10 + (r.done ? 1 : 0);`;
    expect(await run(prelude, body)).toBe(21);
  });

  it("obj.foo = yield receives the sent value", async () => {
    const prelude = `var obj: any = { foo: "not set" };
function* g() { obj.foo = yield; }`;
    const body = `var it = g(); it.next(); it.next("set"); return obj.foo === "set" ? 1 : 0;`;
    expect(await run(prelude, body)).toBe(1);
  });
});
