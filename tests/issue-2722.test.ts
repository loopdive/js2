import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers";
import { compile } from "../src/index.js";

/**
 * #2722 — Nested OPTIONAL object-field destructuring default not firing.
 *
 *   function f({ a: { b = 3 } = {} }: { a?: { b?: number } } = {}): number { return b; }
 *
 * `a?` is the union `{ b? } | undefined`. The #1589A empty-object widening guard
 * in `ensureStructForType` used `propType.getProperties().length === 0` to decide
 * "this field is a genuinely empty `{}`" — but `getProperties()` on a union returns
 * only the *common* properties, which for `T | undefined` is ALWAYS `[]`. So the
 * guard clobbered the correct `ref_null structB` back to externref, routing the
 * value through the host `__extern_get`/`__sget_b` f64-`0` else-branch and stopping
 * the nested `b = 3` default from ever firing.
 *
 * Path A fix — two coordinated edits:
 *   Change 1 (index.ts): gate the #1589A widening on the RESOLVED struct actually
 *     being empty (via ctx.structFields), not the union's common-property count.
 *   Change 2 (literals.ts): strip a 2-member `T | undefined` union to `T` before
 *     resolveStructName, so optional-typed inner literals build as structs.
 *
 * NOTE: a WasmGC struct param cannot be passed directly from JS
 * (`instance.exports.f({…})` throws a type incompatibility), so every repro builds
 * its argument inside TS and calls `f` internally through a no-arg exported wrapper.
 */
const CORE = `
function f({ a: { b = 3 } = {} }: { a?: { b?: number } } = {}): number { return b; }
// controls (all pass pre-fix — the defect is precisely "nested + optional field")
function g({ a: { b = 3 } }: { a: { b?: number } }): number { return b; }      // required nested
function h({ b = 3 }: { b?: number } = {}): number { return b; }               // single-level optional
function m([{ b = 3 } = {}]: Array<{ b?: number }> = []): number { return b; } // array-element nested
// 3-level deep nested optional
function f3lvl({ a: { b: { c = 5 } = {} } = {} }: { a?: { b?: { c?: number } } } = {}): number { return c; }
// mixed optional + required
function fmix({ a: { b = 3 } = {}, d: { e = 4 } }: { a?: { b?: number }; d: { e?: number } }): number { return b + e; }
// optional field, no default, no nested pattern (binds ref_null structB)
function fopt({ a }: { a?: { b?: number } } = {}): number { return a ? 2 : 1; }
// optional PRIMITIVE field — guard's ref precondition must NOT fire
function fprim({ a = 9 }: { a?: number } = {}): number { return a; }
// genuinely-empty optional object — stays externref
function femptyq({ a }: { a?: {} } = {}): number { return a ? 1 : 0; }

export function f0(): number { return f(); }
export function f1(): number { return f({}); }
export function f2(): number { return f({ a: {} }); }
export function f3(): number { return f({ a: { c: 1 } }); }
export function f4(): number { return f({ a: { b: 5 } }); }
export function g0(): number { return g({ a: {} }); }
export function h0(): number { return h(); }
export function h1(): number { return h({}); }
export function m0(): number { return m(); }
export function m1(): number { return m([{}]); }
export function d0(): number { return f3lvl(); }
export function d1(): number { return f3lvl({ a: {} }); }
export function d2(): number { return f3lvl({ a: { b: {} } }); }
export function d3(): number { return f3lvl({ a: { b: { c: 9 } } }); }
export function mix0(): number { return fmix({ d: {} }); }
export function mix1(): number { return fmix({ a: { b: 7 }, d: { e: 8 } }); }
export function opt0(): number { return fopt(); }
export function opt1(): number { return fopt({ a: { b: 7 } }); }
export function prim0(): number { return fprim(); }
export function prim1(): number { return fprim({ a: 4 }); }
export function emptyq0(): number { return femptyq(); }
export function emptyq1(): number { return femptyq({ a: {} }); }
`;

describe("#2722 nested optional object-field default (gc/host)", () => {
  let exp: Record<string, Function>;
  const call = (n: string) => (exp[n] as Function)();

  it("compiles", async () => {
    exp = (await compileToWasm(CORE)) as Record<string, Function>;
    expect(typeof exp.f0).toBe("function");
  });

  it("four core repros return the spec-correct value (3/3/3/5)", () => {
    expect(call("f0")).toBe(3); // f()
    expect(call("f1")).toBe(3); // f({})
    expect(call("f2")).toBe(3); // f({ a: {} })
    expect(call("f3")).toBe(3); // f({ a: { c: 1 } }) — excess c dropped, b defaults
    expect(call("f4")).toBe(5); // f({ a: { b: 5 } }) — inner literal HAS the field
  });

  it("controls g / h / m stay green", () => {
    expect(call("g0")).toBe(3); // required nested twin
    expect(call("h0")).toBe(3); // single-level optional
    expect(call("h1")).toBe(3);
    expect(call("m0")).toBe(3); // array-element nested
    expect(call("m1")).toBe(3);
  });

  it("3-level-deep nested optional (5/5/5/9)", () => {
    expect(call("d0")).toBe(5);
    expect(call("d1")).toBe(5);
    expect(call("d2")).toBe(5);
    expect(call("d3")).toBe(9);
  });

  it("mixed optional + required field", () => {
    expect(call("mix0")).toBe(7); // 3 + 4
    expect(call("mix1")).toBe(15); // 7 + 8
  });

  it("optional field, no default, no nested pattern → undefined when omitted", () => {
    expect(call("opt0")).toBe(1); // a undefined
    expect(call("opt1")).toBe(2); // a present
  });

  it("optional primitive field is untouched by the guard", () => {
    expect(call("prim0")).toBe(9);
    expect(call("prim1")).toBe(4);
  });

  it("genuinely-empty optional object stays externref", () => {
    expect(call("emptyq0")).toBe(0); // a undefined
    expect(call("emptyq1")).toBe(1); // a present {}
  });
});

describe("#2722 nested optional object-field default (standalone)", () => {
  it("four core repros + controls compile + run valid under standalone", async () => {
    const r = await compile(CORE, { target: "standalone" });
    expect(r.success, r.errors?.map((e) => e.message).join("; ")).toBe(true);
    expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const call = (n: string) => (instance.exports[n] as Function)() as number;
    expect(call("f0")).toBe(3);
    expect(call("f2")).toBe(3);
    expect(call("f3")).toBe(3);
    expect(call("f4")).toBe(5);
    expect(call("g0")).toBe(3);
    expect(call("h0")).toBe(3);
    expect(call("m0")).toBe(3);
  });
});
