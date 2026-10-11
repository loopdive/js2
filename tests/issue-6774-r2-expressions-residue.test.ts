// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6774 r2 — ES2015 standalone expressions residue, steps S9/S10/S14/S20
// (`plan/issues/6774-es2015-standalone-expressions-residue.md`). Each probe is a
// strict module whose `main()` returns a bit mask; every case FAILS (wrong
// mask, trap or throw) on the base sources and answers `expected` on the branch.
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

const PROBES: { name: string; step: string; expected: number; base: string; body: string }[] = [
  {
    name: "c2_super_receiver_prototype",
    step: "S9",
    expected: 31,
    base: "16",
    body: `var viaMember, viaCall, viaElem, viaArg;
class Parent { getThis() { return this; } get This() { return this; } echo(a, b) { return [this, a, b]; } }
class C extends Parent { method() { viaMember = super.This; viaCall = super.getThis(); viaElem = super['getThis'](); viaArg = super.echo(1, 2); } }
C.prototype.method();
if (sv(viaMember, C.prototype)) bits |= 1; if (sv(viaCall, C.prototype)) bits |= 2; if (sv(viaElem, C.prototype)) bits |= 4;
if (sv(viaArg[0], C.prototype) && viaArg[1] === 1 && viaArg[2] === 2) bits |= 8;
var c = new C(); c.method(); if (sv(viaCall, c) && sv(viaMember, c) && sv(viaElem, c) && sv(viaArg[0], c)) bits |= 16;`,
  },
  {
    // propertyHelper.js's isConfigurable, verbatim shape: a dynamic delete then
    // hasOwnProperty, on closed object-literal structs (method / data / function
    // data / generator method).
    name: "j_literal_member_is_configurable",
    step: "S10",
    expected: 15,
    base: "0",
    body: `var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
function isConfigurable(obj, name) { try { delete obj[name]; } catch (e) { if (!(e instanceof TypeError)) throw e; } return !__hasOwnProperty(obj, name); }
if (isConfigurable({ method() {} }, "method")) bits |= 1; if (isConfigurable({ data: 1 }, "data")) bits |= 2;
if (isConfigurable({ f: function () {} }, "f")) bits |= 4; if (isConfigurable({ *g() {} }, "g")) bits |= 8;`,
  },
  {
    name: "k1_instanceof_native_array_chain",
    step: "S20",
    expected: 3,
    base: "2",
    body: `var calls = 0;
Object.defineProperty(Function.prototype, "prototype", { get: function () { calls++; return Array.prototype; } });
if ([] instanceof Function.prototype) bits |= 1; if (calls === 1) bits |= 2;`,
  },
  {
    // `super()` as a value, and a FUNCTION parent's returned object rebinding
    // the derived `this` (and the `new` result); class / plain-fnctor parents
    // as controls for the value.
    name: "b_super_value_and_fnctor_override",
    step: "S22",
    expected: 31,
    base: "0",
    body: `var custom = {}; var value, bound, value2, inst;
function Parent() { return custom; }
class Child extends Parent { constructor() { value = super(); bound = this; } }
inst = new Child(); if (sv(value, custom)) bits |= 1; if (sv(bound, custom)) bits |= 2; if (sv(inst, custom)) bits |= 4;
class B0 { constructor() { this.k = 1; } } class C0 extends B0 { constructor() { value2 = super(); } }
var c0 = new C0(); if (sv(value2, c0)) bits |= 8;
function P2() { this.z = 3; } class C2 extends P2 { constructor() { var v = super(); bound = this; value = v; } }
var c2 = new C2(); if (sv(value, c2) && sv(bound, c2) && c2.z === 3) bits |= 16;`,
  },
];

describe("#6774 r2 — ES2015 standalone expressions residue", () => {
  for (const p of PROBES) {
    it(`${p.step} ${p.name} (base: ${p.base})`, async () => {
      expect(await run(PRELUDE + p.body + EPILOGUE)).toBe(p.expected);
    }, 120_000);
  }
});
