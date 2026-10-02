/**
 * #6651 cluster A, slice A8 — the small generator residuals.
 *
 * 5b. A top-level `g.prototype = v` on a generator DECLARATION compiled to
 * nothing under standalone: the module-init collector keeps `F.prototype = …`
 * only for a user constructor and excludes `prototype` from its
 * function-static keep, so `g.prototype` still read the original object and
 * `g()` inherited from it (`statements/generators/default-proto.js`). On a
 * generator EXPRESSION binding the write was kept, but the binder's expando
 * declaration made `Object.getPrototypeOf(g)` lose its static answer
 * (`expressions/generators/default-proto.js`).
 *
 * 5d. A generator METHOD read off a struct object literal had no own
 * `prototype` (`method-definition/generator-prototype-prop.js`): the
 * struct-lane method closure never ran the generator-function initializer.
 *
 * Restricted properties. A generator function's `caller` / `arguments` are the
 * inherited %ThrowTypeError% accessors (§10.2.4); reading or writing them did
 * not throw (`statements/generators/restricted-properties.js`).
 *
 * A7 leftover. A STRICT compound / update / destructuring write to a named
 * function expression's own (immutable) name must throw a TypeError; only the
 * simple `t = v` form did (and only once A7 lands).
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

const GP = "Object.getPrototypeOf(function* () {}).prototype";

describe("#6651 A8 · top-level `g.prototype = v` on a generator declaration (5b)", () => {
  it("`g.prototype = null` lands, and g() falls back to %GeneratorPrototype%", async () => {
    const prelude = "function* g() {}\n(g as any).prototype = null;";
    const body = `return (g as any).prototype === null && Object.getPrototypeOf(g()) === ${GP} ? 1 : 0;`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("`g.prototype = obj` lands, and g() inherits from obj", async () => {
    const prelude = "function* g() {}\nvar o: any = {};\n(g as any).prototype = o;";
    expect(await run(`return Object.getPrototypeOf(g()) === o ? 1 : 0;`, prelude)).toBe(1);
  });

  it("on a generator EXPRESSION binding, the write does not un-fold `Object.getPrototypeOf(g)`", async () => {
    // The top-level write adds `g` to the binder's declarations (a JS expando),
    // which read as a second binding and dropped the static %GeneratorFunction.prototype% answer.
    const prelude = `var g: any = function* () {};
var GP: any = Object.getPrototypeOf(g).prototype;
g.prototype = null;`;
    expect(await run(`return GP !== undefined && Object.getPrototypeOf(g()) === GP ? 1 : 0;`, prelude)).toBe(1);
  });
});

describe("#6651 A8 · a generator method's own `prototype` (5d)", () => {
  it("exists, inherits from %GeneratorPrototype%, and is {w:true, e:false, c:false}", async () => {
    const body = `var m: any = { *method() {} }.method;
var d: any = Object.getOwnPropertyDescriptor(m, "prototype");
let r = 0;
if (typeof m.prototype === "object") r |= 1;
if (Object.getPrototypeOf(m.prototype) === ${GP}) r |= 2;
if (d && d.writable === true && d.enumerable === false && d.configurable === false) r |= 4;
return r;`;
    expect(await run(body)).toBe(7);
  });
});

describe("#6651 A8 · generator `caller` / `arguments` are %ThrowTypeError% (restricted properties)", () => {
  const prelude = "function* gen() {}";
  const throwsTypeError = (expr: string) =>
    `try { ${expr}; return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }`;

  it("reading `caller` throws", async () => {
    expect(await run(throwsTypeError("gen.caller"), prelude)).toBe(1);
  });
  it("writing `caller` throws", async () => {
    expect(await run(throwsTypeError("gen.caller = {}"), prelude)).toBe(1);
  });
  it("reading `arguments` throws", async () => {
    expect(await run(throwsTypeError("gen.arguments"), prelude)).toBe(1);
  });
  it("writing `arguments` throws", async () => {
    expect(await run(throwsTypeError("gen.arguments = {}"), prelude)).toBe(1);
  });

  it("GUARD: an own `caller` installed through a call argument is not folded to a throw", async () => {
    const guardPrelude = `function* gen() {}
Object.defineProperty(gen, "caller", { value: 7, configurable: true });`;
    expect(await run(`try { return gen.caller === 7 ? 1 : 0; } catch (e) { return 2; }`, guardPrelude)).toBe(1);
  });
});

describe("#6651 A8 · strict compound / update / destructuring write to a named fn-expr's own name", () => {
  const strictThrows = (stmt: string) =>
    `var k: any = function t() { ${stmt}; return 1; };
try { return k(); } catch (e) { return e instanceof TypeError ? 7 : 8; }`;

  it("`t++` throws a TypeError", async () => {
    expect(await run(strictThrows("t++"), "", true)).toBe(7);
  });
  it("`t += 1` throws a TypeError", async () => {
    expect(await run(strictThrows("t += 1"), "", true)).toBe(7);
  });
  it("`[t] = [1]` throws a TypeError", async () => {
    expect(await run(strictThrows("[t] = [1]"), "", true)).toBe(7);
  });

  it("GUARD: sloppy `t++` is ignored and the name still denotes the function", async () => {
    expect(await run(`var k: any = function t() { t++; return typeof t === "function" ? 1 : 0; }; return k();`)).toBe(
      1,
    );
  });
  it("GUARD: strict `t++` on a body `var t` shadow is an ordinary write", async () => {
    expect(await run(`var k: any = function t() { var t: any = 1; t++; return t; }; return k();`, "", true)).toBe(2);
  });
});
