// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 cluster I, slice I4 — two standalone-only gaps. Both were verified RED
// on this slice's base (`5b396ebc`, the project-thread tip) by a file-copy A/B
// before either fix was written; the "[base: …]" note on each case records what
// the base tree actually answered.
//
// 1. **`Object(sym)` had no Symbol row.** §7.1.18 ToObject Table 13 says a
//    Symbol coerces to a Symbol WRAPPER object, so `typeof Object(Symbol())`
//    is `"object"` and `Object(s) !== s`. `emitObjectCoercion` (calls-guards.ts)
//    gated its Symbol arm on `!noJsHost(ctx)`, so the host-free lane fell
//    through to the identity tail and `Object(s)` evaluated to the symbol
//    ITSELF — `typeof` read "symbol".
//
//    The wrapper is the same `[[PrimitiveValue]]` `$Object` every other
//    standalone wrapper uses, so the builder is `__new_String`'s, aliased under
//    the name `__new_Symbol`: the value handed to it is already boxed (the
//    `$Symbol` GC carrier from `__box_symbol`, #2866) and neither builder
//    inspects what it wraps. Aliasing rather than copying keeps the cost at
//    zero bytes for every standalone program that never writes `Object(sym)`.
//
//    KNOWN RESIDUAL, deliberately not covered here: this whole ladder dispatches
//    on the argument's STATIC type, so an `any`-typed argument (`const s: any =
//    Symbol(); Object(s)`) still takes the identity tail on the host-free lane.
//    That is the pre-existing shape of `emitObjectCoercion` — the host lane
//    answers it at runtime through `__to_object`, which has no host-free twin
//    yet — and it is unchanged by this slice.
//
// 2. **`<obj>.<member>.bind(t)()` trapped.** Under a native
//    `Function.prototype.bind` provider a `.bind(…)` mints a `$__bound_fn`
//    CARRIER (#3140), not a closure struct. The call-of-call path in
//    `compileTailDispatch` matched the bind result's TS call signature against
//    the registered closure shapes, `ref.cast` the carrier to the winner
//    (guarded ⇒ null) and then null-checked it: "dereferencing a null pointer
//    in __module_init". The JS-host lane has carried an explicit arm against
//    exactly this shape for a while; the host-free twin was missing.
//
//    Note which spelling broke: storing the bind result first (`const b =
//    f.af.bind(u); b();`) already worked, because THAT call site reaches
//    `tryEmitInlineDynamicCall`, whose `boundArm` understands the carrier.
//    Only the IMMEDIATE call was routed past it.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // A leaked `env` import would mean the case silently ran on a JS host
  // fast-path and the answer is not the standalone substrate's.
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#6651 I4 — Object(symbol) is a wrapper object (§7.1.18 Table 13)", () => {
  // test262 language/expressions/typeof/symbol.js
  it('typeof Object(Symbol()) is "object" [base: "symbol"]', async () => {
    expect(
      await runStandalone(`export function run(): number {
        const s = Symbol();
        return typeof Object(s) === "object" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("the symbol itself stays a symbol — the coercion does not consume it", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const s = Symbol("A");
        const o: any = Object(s);
        return typeof o === "object" && typeof s === "symbol" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  // test262 built-ins/Object/symbol_object-returns-fresh-symbol.js
  it("Object(sym) is a FRESH object, not the symbol [base: identity, so 0]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const s = Symbol("A");
        const o: any = Object(s);
        return o !== (s as any) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("two coercions of the same symbol are distinct objects (§7.1.18 allocates)", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const s = Symbol("A");
        return (Object(s) as any) !== (Object(s) as any) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  // Regression lock: the other §7.1.18 rows keep their answers. A shared
  // `[[PrimitiveValue]]` builder is exactly where a new Symbol row could
  // disturb the String row it is aliased onto.
  it("Object(string) / Object(number) / Object(boolean) are unchanged", async () => {
    expect(
      await runStandalone(`export function run(): number {
        let n = 0;
        if (typeof Object("x") === "object") n = n + 1;
        if (typeof Object(5) === "object") n = n + 2;
        if (typeof Object(true) === "object") n = n + 4;
        return n;
      }`),
    ).toBe(7);
  });
});

describe("#6651 I4 — an immediately-called bind of an object-field callable", () => {
  // The bind target must be STATICALLY typed for this to reproduce, which is
  // why the cases below avoid `any`. The trap is in the closure-signature match
  // that precedes the dynamic dispatch, and that match only fires when the
  // checker can hand it a call signature: an `any`-typed `f.af.bind(u)()`
  // declines it and reaches the carrier-aware path on its own. test262's
  // `arrow-function/lexical-this.js` is checked as JS, so its `this.af = _ =>
  // this` DOES get a signature — that row is the sweep-level witness for the
  // same defect, measured separately in the slice's row diff.
  it("an object-literal method: the immediate bind call RUNS [base: null-pointer trap]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const f = { af: function () { return 1; } };
        const u = {};
        return f.af.bind(u)();
      }`),
    ).toBe(1);
  });

  it("a class field holding a function expression [base: null-pointer trap]", async () => {
    expect(
      await runStandalone(`class C { af = function () { return 5; }; }
        export function run(): number {
          const c = new C();
          const u = {};
          return c.af.bind(u)();
        }`),
    ).toBe(5);
  });

  // Regression lock: the shapes that already worked — the static arms ahead of
  // the new one in the dispatcher, the partial-argument path, and the
  // store-then-call spelling that was never broken.
  it("partial args, a named function's bind, and a stored bind result are unchanged", async () => {
    expect(
      await runStandalone(`function g(): number { return 7; }
        export function run(): number {
          const o = { m: function (a: number, b: number) { return a + b; } };
          const t = {};
          let n = 0;
          if (o.m.bind(t, 20)(3) === 23) n = n + 1;
          if ((g as any).bind(t)() === 7) n = n + 2;
          const f = { af: function () { return 9; } };
          const b = f.af.bind(t);
          if (b() === 9) n = n + 4;
          return n;
        }`),
    ).toBe(7);
  });
});
