/**
 * #6651 slice V10d — `Symbol.prototype[@@toPrimitive]` removal
 * (`built-ins/Symbol/prototype/Symbol.toPrimitive/removed-symbol-wrapper-ordinary-toprimitive.js`).
 * Every case runs `--target standalone` and asserts the binary imports NOTHING.
 * GUARD cases pin neighbouring behaviour that must not move.
 *
 * 1. A READ-ONLY closure over a closure-valued top-level `let` captured the
 *    `__module_init` shadow local into a fresh ref cell. Later top-level writes
 *    update the module global (and, across init chunks, ONLY the global), so the
 *    closure and every other function forked from the binding. The closure now
 *    reads the live module global.
 * 2. `__extern_to_string_spec` threw "Cannot convert a Symbol value to a string"
 *    for every Symbol wrapper, assuming the intrinsic `@@toPrimitive`. Once it
 *    is deleted, §7.1.1 runs OrdinaryToPrimitive (`Symbol.prototype.toString`).
 * 3. `obj[key]` with an OBJECT key reached `__extern_get` uncoerced, so the
 *    closed-struct field ladder (`{ foo: 3 }[o]`) missed. ToPropertyKey now runs
 *    once at the head of `__extern_get`; a Symbol wrapper keys by its Symbol.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(src: string): Promise<unknown> {
  const r = (await compile(src, {
    fileName: "t.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  expect(r.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 V10d · 1 · read-only closure over a closure-valued top-level let", () => {
  it("closure and a sibling function both observe a later top-level write", async () => {
    const src = `let vf = () => 1;
var g = () => vf;
vf = null;
function h() { return vf; }
export function test() { return (h() === null ? 1 : 0) + (g() === null ? 10 : 0); }`;
    expect(await run(src)).toBe(11);
  });

  it("an accessor getter over the binding sees the reassignment", async () => {
    const src = `let c = 0;
let vf = () => 123;
var o = {};
Object.defineProperty(o, "v", { get: () => { ++c; return vf; } });
let tf = () => "foo";
var p = {};
Object.defineProperty(p, "w", { get: () => { ++c; return tf; } });
vf = null;
export function test() { return (o.v === null ? 1 : 0) + c * 10; }`;
    expect(await run(src)).toBe(11);
  });
});

describe("#6651 V10d · 2 · ToString of a Symbol wrapper after deleting @@toPrimitive", () => {
  it("OrdinaryToPrimitive runs Symbol.prototype.toString", async () => {
    const src = `var before = 0;
try { "".concat(Object(Symbol())); } catch (e) { before = e instanceof TypeError ? 1 : 2; }
var deleted = delete Symbol.prototype[Symbol.toPrimitive];
var after = "".concat(Object(Symbol("a"))) === "Symbol(a)" ? 1 : 0;
export function test() { return before * 100 + (deleted ? 10 : 0) + after; }`;
    expect(await run(src)).toBe(111);
  });

  it("GUARD: a bare named write to Symbol.prototype keeps the intrinsic TypeError", async () => {
    const src = `Symbol.prototype.foo = 1;
var ok = 0;
try { "".concat(Object(Symbol())); } catch (e) { ok = e instanceof TypeError ? 1 : 2; }
export function test() { return ok; }`;
    expect(await run(src)).toBe(1);
  });
});

describe("#6651 V10d · 3 · ToPropertyKey of an object key on a closed struct", () => {
  it("`{ foo: 3 }[o]` runs o.toString once", async () => {
    const src = `var calls = 0;
var o = { toString: function () { ++calls; return "foo"; } };
var t = { "123": 1, foo: 3 };
var v = t[o];
export function test() { return (v === 3 ? 1 : 0) + calls * 10; }`;
    expect(await run(src)).toBe(11);
  });

  it("an accessor-defined toString on Symbol.prototype keys the read", async () => {
    const src = `delete Symbol.prototype[Symbol.toPrimitive];
var gets = 0;
Object.defineProperty(Symbol.prototype, "toString", { get: () => { ++gets; return () => "foo"; } });
var v = { "123": 1, "Symbol()": 2, foo: 3 }[Object(Symbol())];
export function test() { return (v === 3 ? 1 : 0) + gets * 10; }`;
    expect(await run(src)).toBe(11);
  });

  it("GUARD: an intact Symbol wrapper keys by its Symbol, not its description", async () => {
    const src = `var s = Symbol("z");
var t = { "Symbol(z)": 2 };
t[s] = 5;
export function test() { return (t[Object(Symbol("z"))] === undefined ? 1 : 0) + (t[Object(s)] === 5 ? 10 : 0); }`;
    expect(await run(src)).toBe(11);
  });
});
