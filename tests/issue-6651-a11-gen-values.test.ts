/**
 * #6651 cluster A, slice A11 — generator rows that compiled but computed the
 * wrong VALUE in standalone.
 *
 * Group 1, the method-receiver model. A method called WITHOUT its object:
 *
 *  - an object-literal method's receiver is the literal's closed struct, so an
 *    extracted call (`var f = obj.m; f()`) reached the body with a null struct
 *    and a bare `this` read as JS `null`. §10.2.1.2 OrdinaryCallBindThis binds
 *    the global object in sloppy code and `undefined` in strict code
 *    (`method-definition/{generator,name}-invoke-fn-{strict,no-strict}.js`);
 *  - a class generator method's function value (`C.prototype.gen`) returned
 *    its private `$GenState` struct, which no dynamic call arm matches ("not a
 *    function"), and the #2025 null-receiver TypeError fired because the
 *    generator FACTORY stores param 0 into its frame even when the body never
 *    reads `this` (`class/gen-method/yield-spread-arr-*.js`).
 *
 * Group 2, a consumed yield's resumption value. `function* g() { actual =
 * yield; }` had no non-numeric operand, so it took the f64 carrier and
 * `next({})` stored NaN (`yield/iter-value-{specified,unspecified}.js`).
 *
 * Group 3, a runtime-keyed class SETTER (`static set [yield](v)`) was never
 * reached by an assignment: `__extern_set` had no twin of the #5195 read arm
 * (`class/accessor-name-static-computed-yield-expr.js`).
 *
 * Group 4, singles: an object-literal method's parameter default read
 * `arguments` before the object existed (`params-dflt-gen-meth-ref-arguments`),
 * and a nested closure's sloppy write to a named function expression's own
 * name overwrote the immutable binding (`generators/scope-name-var-open-*`).
 *
 * Every case is RED on the base commit except the ones marked GUARD, which pin
 * that the new arms do not fire where they must not (green on base too). All
 * run standalone and assert the binary imports NOTHING.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(body: string, prelude = "", strict = false): Promise<unknown> {
  const src = `${strict ? '"use strict";\n' : ""}${prelude}\nexport function test(): any {\n${body}\n}`;
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

const GLOBAL = "var global: any = (function () { return this; })();";

describe("#6651 A11 · group 1 · an extracted object-literal method binds the caller's receiver", () => {
  it("sloppy generator method called bare: `this` is the global object", async () => {
    const prelude = `${GLOBAL}
var thisValue: any = null;
var method: any = { *method() { thisValue = this; } }.method;
method().next();`;
    expect(await run("return thisValue === global ? 1 : thisValue === null ? 2 : 3;", prelude)).toBe(1);
  });

  it("generator method with its own 'use strict' called bare: `this` is undefined", async () => {
    const prelude = `var thisValue: any = null;
var method: any = { *method() { 'use strict'; thisValue = this; } }.method;
method().next();`;
    expect(await run("return thisValue === undefined ? 1 : thisValue === null ? 2 : 3;", prelude)).toBe(1);
  });

  it("sloppy plain method called bare: `this` is the global object", async () => {
    const prelude = `${GLOBAL}
var thisValue: any = null;
var method: any = { method() { thisValue = this; } }.method;
method();`;
    expect(await run("return thisValue === global ? 1 : thisValue === null ? 2 : 3;", prelude)).toBe(1);
  });

  it("plain method with its own 'use strict' called bare: `this` is undefined", async () => {
    const prelude = `var thisValue: any = null;
var method: any = { method() { 'use strict'; thisValue = this; } }.method;
method();`;
    expect(await run("return thisValue === undefined ? 1 : thisValue === null ? 2 : 3;", prelude)).toBe(1);
  });

  it("a plain method invoked with a foreign receiver sees that receiver", async () => {
    const prelude = `var thisValue: any = null;
var other: any = { z: 1 };
var method: any = { method() { thisValue = this; } }.method;
method.call(other);`;
    expect(await run("return thisValue === other ? 1 : thisValue === null ? 2 : 3;", prelude)).toBe(1);
  });

  it("GUARD: a bound call still sees its own object, bare and through `this.x`", async () => {
    const prelude = `var seen: any = null;
var obj: any = { v: 5, m() { seen = this; return this.v; }, *g() { seen = this; yield this.v; } };`;
    const body = `var s = 0;
if (obj.m() === 5 && seen === obj) s += 1;
seen = null;
var r = obj.g().next();
if (r.value === 5 && seen === obj) s += 10;
return s;`;
    expect(await run(body, prelude)).toBe(11);
  });
});

describe("#6651 A11 · group 1 · an extracted class generator method is callable", () => {
  it("`var gen = C.prototype.gen; gen()` drives the body (it threw before the body ran)", async () => {
    const prelude = `class C { *gen() { yield 1; } }
var gen: any = C.prototype.gen;`;
    expect(await run("var r = gen().next(); return r.value === 1 && r.done === false ? 1 : 0;", prelude)).toBe(1);
  });

  it("the yield-spread-arr row shape: an unbound class generator method re-yields a sent array", async () => {
    const prelude = `var arr: any = ['a', 'b', 'c'];
var callCount = 0;
class C { *gen(): any { callCount += 1; yield [...(yield)]; } }
var gen: any = C.prototype.gen;`;
    const body = `var iter = gen();
iter.next(false);
var item = iter.next(arr);
var value = item.value;
return value !== arr && value.length === 3 && value[0] === 'a' && value[2] === 'c' && item.done === false && callCount === 1 ? 1 : 0;`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("GUARD: an unbound class generator method that READS `this` still throws a catchable TypeError", async () => {
    const prelude = `class C { x = 1; *gen() { yield this.x; } }
var gen: any = C.prototype.gen;`;
    const body = `try { gen().next(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("GUARD: the same method called through an instance still yields", async () => {
    const prelude = `class C { *gen() { yield 1; } }`;
    expect(await run("return new C().gen().next().value === 1 ? 1 : 0;", prelude)).toBe(1);
  });
});

/** The `sent` field type of `$__GenState_<name>` in the standalone WAT. */
async function sentCarrier(src: string, name: string): Promise<string | undefined> {
  const r = (await compile(src, {
    fileName: "t.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    emitWat: true,
  })) as unknown as Compiled & { wat?: string };
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  const m = new RegExp(`\\$__GenState_${name} [^\\n]*\\(field \\$sent \\(mut (\\w+)\\)\\)`).exec(r.wat ?? "");
  return m?.[1];
}

describe("#6651 A11 · group 2 · a consumed yield carries whatever `next(v)` sends", () => {
  it("`actual = yield` stores the object `next(obj)` sent (it stored NaN)", async () => {
    const prelude = `var actual: any;
function* g(): any { actual = yield; }
var expected: any = {};`;
    const body = `var iter = g();
var r1 = iter.next();
if (r1.done !== false || actual !== undefined) return 2;
var r2 = iter.next(expected);
return r2.done === true && actual === expected ? 1 : 0;`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("a bare yield yields undefined and a no-argument `next()` resumes it with undefined", async () => {
    const prelude = `var actual: any = 7;
function* g(): any { actual = yield; }`;
    const body = `var iter = g();
var r1: any = iter.next();
var r2: any = iter.next();
return Object.is(r1.value, undefined) && Object.is(r2.value, undefined) && Object.is(actual, undefined) ? 1 : 0;`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("a yield consumed inside a larger expression keeps a sent string", async () => {
    const prelude = "var t: any;\nfunction* g(): any { t = (yield 1) + '!'; }";
    const body = "var iter = g(); iter.next(); var r: any = iter.next('a'); return t === 'a!' && r.done ? 1 : 0;";
    expect(await run(body, prelude)).toBe(1);
  });

  it("GUARD: a `Generator<number, void, number>` keeps the f64 carrier and its answer", async () => {
    const prelude = "var total = 0;\nfunction* g(): Generator<number, void, number> { total = (yield 1) + 1; }";
    expect(await sentCarrier(`${prelude}\nexport function test(): number { return 0; }`, "g")).toBe("f64");
    expect(await run("var it = g(); it.next(); it.next(41); return total;", prelude)).toBe(42);
  });

  it("GUARD: a statement-position `yield;` does not move the carrier", async () => {
    const src = "function* g() { yield; yield 1; }\nexport function test(): number { return 0; }";
    expect(await sentCarrier(src, "g")).toBe("f64");
  });
});

describe("#6651 A11 · group 3 · an assignment reaches a runtime-keyed class setter", () => {
  it("a static setter keyed by `yield` inside a generator runs on `C.key = v`", async () => {
    const prelude = `var yieldSet: any, C: any;
function* g(): any {
  class C_ {
    static get [yield]() { return 'get yield'; }
    static set [yield](param: any) { yieldSet = param; }
  }
  C = C_;
}`;
    const body = `var iter = g(); iter.next(); iter.next('first'); iter.next('second');
C.second = 'set yield';
return C.first === 'get yield' && yieldSet === 'set yield' && C.second === undefined ? 1 : 0;`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("a runtime-keyed INSTANCE setter runs through the prototype, and its getter still answers", async () => {
    const prelude = `var log: any[] = [];
function mk(k: any): any {
  class C { set [k](v: any) { log.push(v); } get [k]() { return 'g'; } }
  return C;
}`;
    const body = "var C = mk('x'); var c: any = new C(); c.x = 1; return log[0] === 1 && c.x === 'g' ? 1 : 0;";
    expect(await run(body, prelude)).toBe(1);
  });

  it("GUARD: a key with no setter on the class chain is still an ordinary own write", async () => {
    const prelude = "function mk(k: any): any { class C { static get [k]() { return 1; } } return C; }";
    expect(await run("var C = mk('a'); C.b = 5; return C.b === 5 && C.a === 1 ? 1 : 0;", prelude)).toBe(1);
  });
});

describe("#6651 A11 · group 4 · singles", () => {
  it("an object-literal method's parameter default reads `arguments` (plain and generator)", async () => {
    const prelude = `var gp: any[] = [], gm: any[] = [];
var obj = {
  *method(x = arguments[2], y = arguments[3], z: any) { gm.push(x, y, z); },
  plain(x = arguments[2], y = arguments[3], z: any) { gp.push(x, y, z); },
};
function ok(a: any[]) { return a[0] === 'third' && a[1] === 'fourth' && a[2] === 'third'; }`;
    const body = `obj.plain(undefined, undefined, 'third', 'fourth');
obj.method(undefined, undefined, 'third', 'fourth').next();
return ok(gp) && ok(gm) ? 1 : 0;`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("GUARD: a simple-list object-literal method still reads its arguments object", async () => {
    const prelude = "var o = { m(a: any) { return arguments[0]; } };";
    expect(await run("return o.m(7);", prelude)).toBe(7);
  });

  it("a nested closure's sloppy write to a named function expression's own name is ignored", async () => {
    const prelude = `var probe: any, setIt: any;
var f: any = function g() { probe = function () { return g; }; setIt = function () { g = null as any; }; };
var h: any = function* k(_ = (setIt = function () { k = null as any; })) { probe = function () { return k; }; };`;
    const body = `f(); setIt(); var s = probe() === f ? 1 : 0;
h().next(); setIt(); return s + (probe() === h ? 10 : 0);`;
    expect(await run(body, prelude)).toBe(11);
  });

  it("GUARD: the same nested write in strict code throws a TypeError", async () => {
    const prelude = `var setIt: any;
var f: any = function g() { setIt = function () { g = null as any; }; };`;
    const body = "f(); try { setIt(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }";
    expect(await run(body, prelude, true)).toBe(1);
  });

  it("GUARD: a nested write to a same-named inner variable still writes", async () => {
    const prelude = `var probe: any, setIt: any;
var f: any = function g() { var g: any = 1; setIt = function () { g = 2; }; probe = function () { return g; }; };`;
    expect(await run("f(); setIt(); return probe();", prelude)).toBe(2);
  });
});
