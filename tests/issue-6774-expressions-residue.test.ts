// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6774 — ES2015 standalone expressions residue: one pin per plan probe
// (`plan/issues/6774-es2015-standalone-expressions-residue.md`). Each probe is a
// strict module whose `main()` returns a bit mask; every case FAILS (wrong mask,
// trap or throw) on the base sources and answers `expected` on the branch.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const r = await compile(source, {
    target: "standalone",
    fileName: "p.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    hostBridge: "always",
  } as Parameters<typeof compile>[1]);
  expect(r.success).toBe(true);
  expect(r.imports.filter((i) => i.module !== "wasm:js-string")).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { __module_init?: () => void; main: () => number };
  ex.__module_init?.();
  return ex.main();
}

const PRELUDE = `var bits = 0; function sv(a, b) { return a === b; } function ID(x) { return x; }\n`;
const EPILOGUE = `\nexport function main() { return bits; }`;

const PROBES: { name: string; step: string; expected: number; body: string }[] = [
  {
    name: "c1_getter_id",
    step: "S1",
    expected: 1,
    body: `var proto = { m() { return "pm"; } }; var o = { get [ID("b")]() { return "b" + super.m(); } }; Object.setPrototypeOf(o, proto); if (sv(o.b, "bpm")) bits |= 1;`,
  },
  {
    name: "c1_setter_id",
    step: "S1",
    expected: 1,
    body: `var got; var proto = { m(v) { got = v; } }; var o = { set [ID("b")](v) { super.m(v); } }; Object.setPrototypeOf(o, proto); o.b = 7; if (sv(got, 7)) bits |= 1;`,
  },
  {
    name: "k3_own_proto_reads",
    step: "S2",
    expected: 23,
    body: `var obj; var sample = {};
obj = { ['__proto__']: sample }; if (obj.__proto__ === sample) bits |= 1; if (Object.getPrototypeOf(obj) === Object.prototype) bits |= 2;
var sym = Symbol("L"); obj = { ['__proto__']: sym }; if (obj.__proto__ === sym) bits |= 4;
obj = { ['__proto__']: null }; if (obj.__proto__ === null) bits |= 16;`,
  },
  {
    name: "e4_new_tag_ident",
    step: "S3",
    expected: 7,
    body: `function K(x) { arg = x; } var arg = null, tobj; function tag(x) { tobj = x; return K; } var i = new tag\`a\`; if (i instanceof K) bits |= 1; if (sv(tobj[0], "a")) bits |= 2; i = new tag\`b\`("c"); if (sv(arg, "c")) bits |= 4;`,
  },
  {
    name: "a_fn_value",
    step: "S4",
    expected: 7,
    body: `var nt = null; function f() { nt = new.target; } new f(); if (sv(nt, f)) bits |= 1; nt = 1; f(); if (sv(nt, undefined)) bits |= 2; if (typeof nt === "undefined") bits |= 4;`,
  },
  {
    name: "a_cls_chain_value",
    step: "S4",
    expected: 3,
    body: `var pnt, bnt; class B { constructor() { bnt = new.target; } } class P extends B { constructor() { pnt = new.target; super(); } } class C extends P { constructor() { super(); } } new C(); if (sv(pnt, C)) bits |= 1; if (sv(bnt, C)) bits |= 2;`,
  },
  {
    name: "a_arrow_iife_and_closure",
    step: "S4",
    expected: 7,
    body: `var hits = 0; function F() { if ((_ => new.target)() !== undefined) hits++; this.af = _ => (new.target ? 1 : 2); } F(); var o = new F(); if (hits === 1) bits |= 1; if (o.af() === 1) bits |= 2; var gnt; var g = function () { gnt = new.target; }; new g(); if (sv(gnt, g)) { g(); if (sv(gnt, undefined)) bits |= 4; }`,
  },
  {
    name: "c3_obj_eval_dot_elem",
    step: "S5",
    expected: 3,
    body: `var proto = { fromA: "a" }; var o = { fromA: "c", m() { return eval("super.fromA;"); }, n() { return eval('super["fromA"];'); } }; Object.setPrototypeOf(o, proto); if (sv(o.m(), "a")) bits |= 1; if (sv(o.n(), "a")) bits |= 2;`,
  },
  {
    name: "c3_cls_eval",
    step: "S5",
    expected: 1,
    body: `class A {} class B extends A {} class C extends B { method() { return eval("super.fromA;"); } } A.prototype.fromA = "a"; C.prototype.fromA = "c"; if (sv(C.prototype.method(), "a")) bits |= 1;`,
  },
  {
    name: "symbol_through_untyped_param",
    step: "S6",
    expected: 7,
    body: `var s1 = Symbol(), s2 = Symbol(); if (typeof ID(s2) === "symbol") bits |= 1; var o = { a: "A", [s1]: "B", [ID(s2)]: "D" }; if (sv(o[s2], "D")) bits |= 2; if (Object.getOwnPropertySymbols(o).length === 2) bits |= 4;`,
  },
  {
    name: "numeric_key_mix_element_call",
    step: "S6",
    expected: 3,
    body: `var o = { a() { return "A"; }, [1]() { return "B"; }, [ID(2)]() { return "D"; } }; if (sv(o.a(), "A")) bits |= 1; if (sv(o[1](), "B")) bits |= 2;`,
  },
  {
    name: "static_symbol_methods_own_symbols",
    step: "S6",
    expected: 3,
    body: `var s1 = Symbol(), s2 = Symbol(); class C { static a() {} static [s1]() { return 1; } static [ID(s2)]() { return 2; } } var syms = Object.getOwnPropertySymbols(C); if (syms.length === 2 && syms[0] === s1 && syms[1] === s2) bits |= 1; if (C[s2]() === 2) bits |= 2;`,
  },
  {
    name: "rest_binding_pattern_closures",
    step: "S7",
    expected: 7,
    body: `var g = function* (...[a]) { yield a; }; if (sv(g(8).next().value, 8)) bits |= 1; var o = { m(...[b]) { return b; } }; if (sv(o.m(6), 6)) bits |= 2; var f = function (...[x, y]) { return x * y; }; if (sv(f(3, 4), 12)) bits |= 4;`,
  },
  {
    name: "template_object_frozen",
    step: "S13",
    expected: 3,
    body: `var t = null; (function (p) { t = p; })\`a\`; try { t.x = 1; } catch (e) { if (e instanceof TypeError) bits |= 1; } if (Object.isFrozen(t) && Object.isFrozen(t.raw)) bits |= 2;`,
  },
  {
    name: "loose_eq_string_left_toprimitive_symbol",
    step: "S19",
    expected: 3,
    body: `var y = {}; var rv = "str"; y[Symbol.toPrimitive] = function () { return rv; }; if ("str" == y) bits |= 1; rv = Symbol.toPrimitive; if (Symbol.toPrimitive == y) bits |= 2;`,
  },
  {
    name: "object_pattern_member_target_with_initializer",
    step: "S11",
    expected: 3,
    body: `var holder = {}; var vals = { x: 23 }; ({ x: holder.y = 42 } = vals); if (holder.y === 23) bits |= 1; var got; ({ x: { set y(v) { got = v; } }.y = 42 } = vals); if (got === 23) bits |= 2;`,
  },
  {
    name: "strict_arrow_lexical_this_assigned",
    step: "S16",
    expected: 1,
    body: `var c3 = 1; var h3 = function () { return () => { c3 = this; }; }; h3()(); if (c3 === undefined) bits |= 1;`,
  },
  {
    name: "untyped_iife_tag_host_free",
    step: "S17",
    expected: 3,
    body: `var calls = 0, n = 0; var number = 5; var fn = function () { return 1; }; (function () { return function (site, a, b) { calls++; n = arguments.length; }; })()\`A\${number}B\${fn}\`; if (calls === 1) bits |= 1; if (n === 3) bits |= 2;`,
  },
  {
    name: "super_call_in_arrow",
    step: "S8",
    expected: 3,
    body: `var count = 0; class A { constructor() { count++; } } class B extends A { constructor() { (_ => super())(); } } new B(); if (count === 1) bits |= 1; class D extends A { constructor() { super(); this.af = _ => super(); } } var d = new D(); try { d.af(); } catch (e) { if (e instanceof ReferenceError && count === 3) bits |= 2; }`,
  },
  {
    name: "call_object_element_target",
    step: "S21",
    expected: 1,
    body: `var log = []; var o = { set q(v) { log.push("set"); } }; function t() { log.push("t"); return o; } [t()["q"]] = []; if (log.join() === "t,set") bits |= 1;`,
  },
  {
    name: "rest_binding_pattern_params",
    step: "S7",
    expected: 7,
    body: `function* gd(...[a]) { yield a; } var ge = function* (...[b]) { yield b; }; var fe = function (...[c]) { return c; }; if (gd(5).next().value === 5) bits |= 1; if (ge(6).next().value === 6) bits |= 2; if (fe(7) === 7) bits |= 4;`,
  },
];

describe("#6774 ES2015 standalone expressions residue", () => {
  for (const p of PROBES) {
    it(`${p.step} ${p.name}`, async () => {
      expect(await run(PRELUDE + p.body + EPILOGUE)).toBe(p.expected);
    });
  }
});
