// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7160 — `#x in C` answered true for the class constructor `C` (and, on wasi,
// for `C.prototype`): both are lazily built singletons of the instance struct
// type and `__tag`, so the struct/tag brand predicate accepted them. Private
// brands are own brands of instances (§7.3.31), never of the constructor, its
// prototype or an object inheriting from an instance. Each row is diffed
// against native JS on the gc (native-first), standalone and wasi lanes.
// Private methods/accessors and static private names are #7162, not here.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const C = `class C { #x = 1; static has(v: any) { return #x in v; } static ht(v: C) { return #x in v; } t() { return #x in this; } static st() { return #x in this; } }\n`;
const D = `class D extends C { #y = 2; static hy(v: any) { return #y in v; } }\n`;

const ROWS: [string, string][] = [
  ["#x in new C()", `return C.has(new C());`],
  ["#x in C", `return C.has(C);`],
  ["#x in C.prototype", `return C.has(C.prototype);`],
  ["#x in Object.create(new C())", `return C.has(Object.create(new C()));`],
  ["#x in a subclass instance", `return C.has(new D());`],
  ["#x in the subclass constructor", `return C.has(D);`],
  ["#x in the subclass prototype", `return C.has(D.prototype);`],
  ["#y declared on the subclass", `return !D.hy(D) && D.hy(new D()) && !D.hy(new C()) && !D.hy(D.prototype);`],
  ["#x in a Proxy over an instance", `return C.has(new Proxy(new C(), {}));`],
  ["#x in this (instance method)", `return new C().t();`],
  ["#x in this (static method)", `return C.st();`],
  ["constructor through a typed parameter", `return !C.ht(C as unknown as C) && C.ht(new C());`],
  ["constructor then instance", `const a = C.has(C); const b = C.has(new C()); return !a && b;`],
  ["constructor read back from an array", `const a: any[] = [C, new C()]; return !C.has(a[0]) && C.has(a[1]);`],
  ["unrelated class with the same private name", `class E { #x = 1; } return !C.has(E) && !C.has(new E());`],
  [
    "class expression",
    `const K = class { #k = 1; static has(v: any) { return #k in v; } }; return !K.has(K) && K.has(new K()) && !K.has(K.prototype);`,
  ],
];

async function expectSameOnAllLanes(body: string): Promise<void> {
  const src = `${C}${D}function value(): boolean { ${body} }\nexport function test(): number { return value() ? 1 : 0; }`;
  const expected = evaluateAsJs(src).test!();
  for (const target of [undefined, "standalone", "wasi"] as const) {
    const lane = target ?? "gc";
    const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

describe("#7160 `#x in v` is an own-brand test: false for the constructor and its prototype", () => {
  for (const [name, body] of ROWS) {
    it(name, async () => {
      await expectSameOnAllLanes(body);
    });
  }
});
