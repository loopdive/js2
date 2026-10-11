/**
 * #6651 cluster A, slice A7 — a named function expression's own name, a folded
 * computed method key, and `Object.getPrototypeOf(g)` for a generator binding.
 *
 * Group 1. A named function expression's name is an IMMUTABLE binding to the
 * function (§15.2.5 / §15.5.4 CreateImmutableBinding): a write is ignored in
 * sloppy code and throws a TypeError in strict code (§9.1.1.1.5 step 5). The
 * base commit (a) refused every generator expression whose body names itself
 * (host `env::__gen_*` imports in standalone), (b) ignored the write in strict
 * code too, and (c) froze a SHADOWING binding of the same name — a parameter,
 * a body `var`/`let`, a block `let`, a catch parameter — so writes to it were
 * swallowed as well. The shadow cases run in sloppy AND strict code: with the
 * strict throw added and no shadow guard, the strict twins would throw.
 *
 * Group 4. `var k = 'm'; ({ [k]() {} })` in an any-context literal dropped the
 * method: the router folded the key and sent the literal to the open-object
 * path, whose method arm then skipped every computed key.
 *
 * Group 5a. `var g = function* () {}; Object.getPrototypeOf(g)` took the
 * generic callable arm instead of `%GeneratorFunction.prototype%`.
 *
 * Every case is RED on the base commit except the two marked GUARD, which pin
 * that the new arms do not claim a value they cannot prove (both answer the
 * same on base). All run standalone and assert the binary imports NOTHING.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(body: string, strict: boolean, prelude = ""): Promise<unknown> {
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

const MODES = [
  ["sloppy", false],
  ["strict", true],
] as const;

describe("#6651 A7 · named generator expression reassigning its own name (group 1)", () => {
  it("strict: the write throws a TypeError from next()", async () => {
    const body = `var ref: any = function* g() { g = 1; yield 5; };
try { ref().next(); return 1; } catch (e) { return e instanceof TypeError ? 2 : 3; }`;
    expect(await run(body, true)).toBe(2);
  });

  it("sloppy: the write is ignored and the name still denotes the generator", async () => {
    const body = `var ref: any = function* g() { g = 1; yield g; };
return ref().next().value === ref ? 1 : 0;`;
    expect(await run(body, false)).toBe(1);
  });

  it("strict, from an inlined arrow: the write throws a TypeError", async () => {
    const body = `var ref: any = function* g() { (() => { g = 1; })(); yield 5; };
try { ref().next(); return 1; } catch (e) { return e instanceof TypeError ? 2 : 3; }`;
    expect(await run(body, true)).toBe(2);
  });

  it("a generator that delegates to itself by name runs natively", async () => {
    const body = `var gen: any = function* s(n: number): any { yield n; if (n > 0) yield* s(n - 1); };
var acc = 0;
for (var v of gen(2)) acc = acc * 10 + v;
return acc;`;
    expect(await run(body, false)).toBe(210);
  });
});

describe("#6651 A7 · strict write to a named function expression's own name (group 1)", () => {
  it("non-generator: throws a TypeError in strict code", async () => {
    const body = `try { (function f() { f = 1; })(); return 1; } catch (e) { return e instanceof TypeError ? 2 : 3; }`;
    expect(await run(body, true)).toBe(2);
  });
});

describe("#6651 A7 · a binding that SHADOWS the name stays mutable (group 1 shadow guard)", () => {
  for (const [mode, strict] of MODES) {
    it(`${mode}: body var`, async () => {
      expect(await run(`return (function f() { var f: any = 1; f = 2; return f; })();`, strict)).toBe(2);
    });

    it(`${mode}: parameter`, async () => {
      expect(await run(`return (function f(f: any) { f = 3; return f; })(1);`, strict)).toBe(3);
    });

    it(`${mode}: body let`, async () => {
      expect(await run(`return (function f() { let f: any = 1; f = 5; return f; })();`, strict)).toBe(5);
    });

    it(`${mode}: block let, the name is the function again after the block`, async () => {
      const body = `return (function f(): any { var r: any; { let f: any = 1; f = 6; r = f; } return r === 6 && typeof f === "function" ? 1 : 0; })();`;
      expect(await run(body, strict)).toBe(1);
    });

    it(`${mode}: catch parameter`, async () => {
      expect(
        await run(`return (function f(): any { try { throw 1; } catch (f: any) { f = 8; return f; } })();`, strict),
      ).toBe(8);
    });

    it(`${mode}: generator body var`, async () => {
      expect(
        await run(`var g: any = function* h() { var h: any = 1; h = 4; yield h; }; return g().next().value;`, strict),
      ).toBe(4);
    });
  }
});

describe("#6651 A7 · object-literal method with a statically folded computed key (group 4)", () => {
  it("method and generator method keyed by a var", async () => {
    const body = `var k = 'm';
var o: any = { [k]() { return 7; }, *[k + 'g']() { yield 9; } };
return Object.prototype.hasOwnProperty.call(o, 'm') && o.m() === 7 && o.mg().next().value === 9 ? 1 : 0;`;
    expect(await run(body, false)).toBe(1);
  });

  it("GUARD: a key read from a REBOUND var is not folded to its stale initializer", async () => {
    const body = `var k = 'a';
k = 'b';
var o: any = { [k]() { return 1; } };
return Object.prototype.hasOwnProperty.call(o, 'a') ? 0 : 1;`;
    expect(await run(body, false)).toBe(1);
  });
});

describe("#6651 A7 · Object.getPrototypeOf of a generator-expression binding (group 5a)", () => {
  // The shape of `language/expressions/generators/prototype-relation-to-function.js`
  // (its `function f() {}` sits at the top level, as here).
  it("is %GeneratorFunction.prototype%, whose [[Prototype]] is %Function.prototype%", async () => {
    const body = `var g = function* () {};
const gp: any = Object.getPrototypeOf(g);
let r = 0;
if (gp === Object.getPrototypeOf(function* () {})) r |= 1;
if (Object.getPrototypeOf(gp) === Object.getPrototypeOf(f)) r |= 2;
return r;`;
    expect(await run(body, false, "function f() {}")).toBe(3);
  });

  it("GUARD: a rebound binding is not claimed", async () => {
    const body = `var g: any = function* () {};
g = function () {};
return Object.getPrototypeOf(g) === Object.getPrototypeOf(function* () {}) ? 0 : 1;`;
    expect(await run(body, false)).toBe(1);
  });
});
