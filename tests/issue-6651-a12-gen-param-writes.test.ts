/**
 * #6651 cluster A, slice A12 — a write to a generator PARAMETER survives a
 * suspension.
 *
 * The native generator frame carries each parameter in a `param_*` field. The
 * resume function copies those fields into locals on EVERY `.next()`, and the
 * fields were immutable: nothing stored a parameter local back before the
 * generator suspended (the spill store covers body-declared locals only). So
 * any write to a parameter was undone by the next resume, on both targets:
 *
 *  - through the mapped `arguments` object
 *    (`language/expressions/yield/formal-parameters-after-reassignment-non-strict.js`:
 *    `arguments[1] = 54; yield a; yield b` yielded 45 for `b`);
 *  - by a plain assignment, an update, a destructuring assignment or a `var`
 *    re-declaration of the parameter.
 *
 * A12 makes the field of every parameter the body can write mutable and stores
 * it back with the spills. A parameter nothing writes keeps its immutable
 * field and its wasm type (an f64 lane stays f64).
 *
 * Every case is RED on the base commit except the ones marked GUARD, which pin
 * the neighbouring behaviour that must not move (green on base too). All run
 * standalone and assert the binary imports NOTHING.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; wat?: string; errors?: unknown; imports?: unknown[] };

async function build(prelude: string): Promise<Compiled> {
  const r = (await compile(`${prelude}\nexport function test(): any { return 0; }`, {
    fileName: "t.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  return r;
}

async function run(body: string, prelude: string): Promise<unknown> {
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

/** The `(field $param_<name> …)` declaration of generator `g`'s frame. */
function paramField(wat: string, name: string): string | undefined {
  const frame = wat.split("\n").find((l) => l.includes("(type $__GenState_g "));
  return frame?.match(new RegExp(`\\(field \\$param_${name} ([^()]+|\\([^()]+\\))\\)`))?.[1];
}

describe("#6651 A12 · the mapped `arguments` object keeps aliasing across a suspension", () => {
  it("target row: writes through `arguments` before the first yield are seen after each resume", async () => {
    const prelude = `function* g(a: any, b: any, c: any, d?: any) {
  arguments[0] = 32;
  arguments[1] = 54;
  arguments[2] = 333;
  yield a;
  yield b;
  yield c;
  yield d;
}`;
    const body = `var iter = g(23, 45, 33);
var r1 = iter.next(); var r2 = iter.next(); var r3 = iter.next(); var r4 = iter.next(); var r5 = iter.next();
return (r1.value === 32 ? 1 : 0) + (r2.value === 54 ? 10 : 0) + (r3.value === 333 ? 100 : 0)
  + (r4.value === undefined && r4.done === false ? 1000 : 0) + (r5.done === true ? 10000 : 0);`;
    expect(await run(body, prelude)).toBe(11111);
  });

  it("a write through `arguments` AFTER a yield reaches the parameter read after the next one", async () => {
    const prelude = `function* g(a: any) { yield 0; arguments[0] = 11; yield 0; yield a; }`;
    expect(await run("var i = g(1); i.next(); i.next(); return i.next().value;", prelude)).toBe(11);
  });

  it("an escaping `arguments` (passed to a function) marks every parameter writable", async () => {
    const prelude = `function set0(args: any) { args[0] = 7; }
function* g(a: any) { set0(arguments); yield 0; yield a; }`;
    const r = await build(prelude);
    expect(paramField(r.wat ?? "", "a")).toBe("(mut externref)");
  });
});

describe("#6651 A12 · a direct write to a parameter survives a suspension", () => {
  it("assignment before the first yield", async () => {
    const prelude = `function* g(a: any) { a = 5; yield a; yield a; }`;
    expect(
      await run("var i = g(1); var x = i.next().value; return x === 5 && i.next().value === 5 ? 1 : 0;", prelude),
    ).toBe(1);
  });

  it("assignment between two yields", async () => {
    const prelude = `function* g(a: any) { yield a; a = 7; yield 0; yield a; }`;
    expect(await run("var i = g(1); i.next(); i.next(); return i.next().value;", prelude)).toBe(7);
  });

  it("postfix update, compound assignment and destructuring assignment", async () => {
    const prelude = `function* g(a: any, b: any, c: any) { a++; b += 2; [c] = [6]; yield 0; yield a + b + c; }`;
    expect(await run("var i = g(1, 1, 1); i.next(); return i.next().value;", prelude)).toBe(2 + 3 + 6);
  });

  it("the value `next(v)` delivers to `a = yield` survives the NEXT suspension", async () => {
    const prelude = `function* g(a: any) { a = yield 1; yield 0; yield a; }`;
    expect(await run("var i = g(1); i.next(); i.next(42); return i.next().value;", prelude)).toBe(42);
  });

  it("a `var` re-declaration of the parameter (its resume local is re-typed to f64)", async () => {
    const prelude = `function* g(a: any) { var a = 5; yield 0; yield a; }`;
    expect(await run("var i = g(1); i.next(); return i.next().value;", prelude)).toBe(5);
  });

  it("a numeric parameter keeps its f64 lane and its write", async () => {
    const prelude = `function* g(a: number) { a = a + 1; yield a; yield a; }`;
    expect(
      await run("var i = g(1); var x = i.next().value; return x === 2 && i.next().value === 2 ? 1 : 0;", prelude),
    ).toBe(1);
    expect(paramField((await build(prelude)).wat ?? "", "a")).toBe("(mut f64)");
  });

  it("class generator method (strict, unmapped `arguments`)", async () => {
    const prelude = `class C { *m(a: any) { a = 5; yield 0; yield a; } }`;
    expect(await run("var i = new C().m(1); i.next(); return i.next().value;", prelude)).toBe(5);
  });

  it("object-literal generator method", async () => {
    const prelude = `var o: any = { *m(a: any) { a = 5; yield 0; yield a; } };`;
    expect(await run("var i = o.m(1); i.next(); return i.next().value;", prelude)).toBe(5);
  });

  it("generator function expression with a defaulted parameter", async () => {
    const prelude = `var g: any = function* (a: any = 3) { a = a + 5; yield 0; yield a; };`;
    expect(await run("var i = g(); i.next(); return i.next().value;", prelude)).toBe(8);
  });
});

describe("#6651 A12 · GUARD — behaviour that must not move", () => {
  it("GUARD: strict generator — `arguments` is unmapped, the parameter keeps its value", async () => {
    const prelude = `function* g(a: any) { "use strict"; arguments[0] = 13; yield a; yield a; yield arguments[0]; }`;
    const body = `var i = g(1); var x = i.next().value; var y = i.next().value; var z = i.next().value;
return x === 1 && y === 1 && z === 13 ? 1 : 0;`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("GUARD: non-generator sloppy function — mapped `arguments` still aliases", async () => {
    const prelude = `function f(a: any) { arguments[0] = 2; var x = a; a = 3; return x * 10 + arguments[0]; }`;
    expect(await run("return f(1);", prelude)).toBe(23);
  });

  it("GUARD: a parameter write is still visible through `arguments` after suspensions", async () => {
    const prelude = `function* g(a: any) { yield 0; a = 9; yield 0; yield arguments[0]; }`;
    expect(await run("var i = g(1); i.next(); i.next(); return i.next().value;", prelude)).toBe(9);
  });

  it("GUARD: read-only parameters keep immutable f64 fields (bytes unchanged)", async () => {
    const prelude = `function* g(a: number, b: number) { yield a; yield b; yield a + b; }`;
    const r = await build(prelude);
    expect(paramField(r.wat ?? "", "a")).toBe("f64");
    expect(paramField(r.wat ?? "", "b")).toBe("f64");
    const body = `var i = g(1, 2); var x = i.next().value; var y = i.next().value; var z = i.next().value;
return x === 1 && y === 2 && z === 3 ? 1 : 0;`;
    expect(await run(body, prelude)).toBe(1);
  });

  it("GUARD: a pure read of mapped `arguments` does not make a parameter writable", async () => {
    const prelude = `function* g(a: any, b: any) { yield arguments.length; yield arguments[1]; yield a; }`;
    const r = await build(prelude);
    expect(paramField(r.wat ?? "", "a")).toBe("externref");
    expect(paramField(r.wat ?? "", "b")).toBe("externref");
  });
});
