// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7162 — `#m in v` folded to `false` at compile time whenever `#m` named a
// private method, a private accessor or a static private name. A method or
// accessor name is in `v` exactly when `v` carries the instance brand (own
// brand: the constructor and its prototype answer false, #7160); a static
// private name is in `v` exactly when `v` IS the declaring constructor (a
// subclass constructor answers false). Non-objects throw TypeError (#7150).
// Each row is diffed against native JS on the gc (native-first), standalone
// and wasi lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const PRELUDE = `
class C {
  #m() {}
  get #g() { return 1; }
  set #s(v: number) {}
  get #gs() { return 1; }
  set #gs(v: number) {}
  static #st = 1;
  static #sm() {}
  static get #sg() { return 1; }
  static hm(o: any) { return #m in o; }
  static hg(o: any) { return #g in o; }
  static hs(o: any) { return #s in o; }
  static hgs(o: any) { return #gs in o; }
  static hst(o: any) { return #st in o; }
  static hsm(o: any) { return #sm in o; }
  static hsg(o: any) { return #sg in o; }
  static typed(o: C) { return #m in o; }
  t() { return #m in this; }
  static st() { return #st in this; }
  static sm() { return #m in this; }
}
class D extends C {}
class E { #m() {} static #st = 1; static hm(o: any) { return #m in o; } static hst(o: any) { return #st in o; } }
class OnlyGet { get #a() { return 1; } static h(o: any) { return #a in o; } }
class OnlySet { set #a(v: number) {} static h(o: any) { return #a in o; } }
function t(f: () => boolean): number { try { return f() ? 1 : 0; } catch (e) { return e instanceof TypeError ? 2 : 3; } }
`;

const VALUES = [
  "new C()",
  "{}",
  "null",
  "undefined",
  "1",
  '"s"',
  "new D()",
  "D",
  "C",
  "C.prototype",
  "new Proxy(new C(), {})",
  "new E()",
  "E",
];

const ROWS: [string, string][] = [];
for (const [label, fn] of [
  ["private method", "C.hm"],
  ["getter/setter pair", "C.hgs"],
  ["getter-only accessor", "C.hg"],
  ["setter-only accessor", "C.hs"],
  ["static private field", "C.hst"],
  ["static private method", "C.hsm"],
  ["static private getter", "C.hsg"],
] as const) {
  for (const v of VALUES) ROWS.push([`${label}: ${fn}(${v})`, `return t(() => ${fn}(${v}));`]);
}
ROWS.push(
  [
    "class with only a getter",
    `return t(() => OnlyGet.h(new OnlyGet())) * 10 + t(() => OnlyGet.h({})) + t(() => OnlyGet.h(OnlySet));`,
  ],
  [
    "class with only a setter",
    `return t(() => OnlySet.h(new OnlySet())) * 10 + t(() => OnlySet.h(new OnlyGet())) + t(() => OnlySet.h(OnlySet));`,
  ],
  ["same-named private method on an unrelated class", `return t(() => E.hm(new C())) * 10 + t(() => E.hm(new E()));`],
  ["same-named static private on an unrelated class", `return t(() => E.hst(C)) * 10 + t(() => E.hst(E));`],
  ["typed parameter", `return t(() => C.typed(new C())) * 10 + t(() => C.typed(new D()));`],
  ["#m in this (instance method)", `return t(() => new C().t()) * 10 + t(() => new D().t());`],
  // `D.st()` is left out: a static method's `this` is compiled as the declaring
  // class on every lane (`this === C` inside `D.who()` is true), a separate defect.
  ["#st in this (static method)", `return t(() => C.st());`],
  ["#m in this (static method)", `return t(() => C.sm());`],
  ["Object.create over an instance", `return t(() => C.hm(Object.create(new C())));`],
  [
    "values read back from an array",
    `const a: any[] = [C, new C(), D]; return t(() => C.hst(a[0])) * 100 + t(() => C.hm(a[1])) * 10 + t(() => C.hst(a[2]));`,
  ],
  [
    "class expression",
    `const K = class { #k() {} static #ks = 1; static h(o: any) { return #k in o; } static hs(o: any) { return #ks in o; } };
     return t(() => K.h(new K())) * 1000 + t(() => K.h(K)) * 100 + t(() => K.hs(K)) * 10 + t(() => K.hs(new K()));`,
  ],
  [
    "named class expression",
    `const N = class Inner { static #s = 1; #m() {} static h(o: any) { return #s in o; } static hm(o: any) { return #m in o; } };
     return t(() => N.h(N)) * 1000 + t(() => N.h(new N())) * 100 + t(() => N.hm(new N())) * 10 + t(() => N.hm(N.prototype));`,
  ],
  [
    "nested class shadows the private name",
    `class O { #m() {} static I = class { #m() {} static h(o: any) { return #m in o; } }; static h(o: any) { return #m in o; } }
     return t(() => O.h(new O())) * 1000 + t(() => O.I.h(new O())) * 100 + t(() => O.I.h(new O.I())) * 10 + t(() => O.h(new O.I()));`,
  ],
);

async function expectSameOnAllLanes(body: string): Promise<void> {
  const src = `${PRELUDE}function value(): number { ${body} }\nexport function test(): number { return value(); }`;
  const expected = evaluateAsJs(src).test!();
  for (const target of [undefined, "standalone", "wasi"] as const) {
    const lane = target ?? "gc";
    const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

describe("#7162 `#m in v` for private methods, accessors and static private names", () => {
  for (const [name, body] of ROWS) {
    it(name, async () => {
      await expectSameOnAllLanes(body);
    });
  }
});
