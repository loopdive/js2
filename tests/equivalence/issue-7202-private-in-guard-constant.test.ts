// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7202 — the #7160 own-brand guard for `#x in v` rejected the class-object and
// prototype singletons with one `ref.eq` pair per class in the declaring
// class's subtree, at every site. A class with descendants now calls one shared
// helper that switches on the receiver's `__tag` and tests only that class's
// two singletons. The answers must not change: instances of the class and of
// every subclass (direct and chained) are in, every singleton is out, also
// when a subclass's singletons were never materialised (their globals are
// still null), for class-expression subclasses and for an unrelated class with
// the same layout (#7158 twin). Each row is diffed against native JS on the gc
// (native-first), standalone and wasi lanes, for 1, 3 and 10 subclasses.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

/** `D0..D{n-1}`: even ones extend `C`, odd ones (from 3) extend the previous one. */
function hierarchy(n: number): string {
  let src = `class C { #x = 1; static has(v: any) { return #x in v; } t() { return #x in this; } }\n`;
  for (let i = 0; i < n; i++) {
    const parent = i % 2 === 0 || i < 2 ? "C" : `D${i - 1}`;
    src += `class D${i} extends ${parent} { #y${i} = ${i}; static hy${i}(v: any) { return #y${i} in v; } }\n`;
  }
  // Same private-name layout as C, different class (#7158 twin).
  src += `class T { #x = 1; }\n`;
  return src;
}

function rows(n: number): [string, string][] {
  const last = `D${n - 1}`;
  const mid = `D${Math.floor(n / 2)}`;
  return [
    ["instance of C", `return C.has(new C());`],
    ["C itself", `return C.has(C);`],
    ["C.prototype", `return C.has(C.prototype);`],
    ["instance of the first subclass", `return C.has(new D0());`],
    ["instance of the last subclass", `return C.has(new ${last}());`],
    // The last subclass's class object and prototype are never read before
    // these instance rows run, so their globals are still null.
    ["unmaterialised subclass singletons: instance first", `return C.has(new ${mid}()) && new ${mid}().t();`],
    ["the last subclass constructor", `return C.has(${last});`],
    ["the last subclass prototype", `return C.has(${last}.prototype);`],
    [
      "every subclass constructor and prototype",
      `const all: any[] = [${Array.from({ length: n }, (_, i) => `D${i}, D${i}.prototype`).join(", ")}]; let k = 0; for (const v of all) if (C.has(v)) k++; return k === 0;`,
    ],
    ["instance after its constructor was read", `const k: any = ${last}; return !C.has(k) && C.has(new ${last}());`],
    [
      "the subclass's own private name",
      `return ${last}.hy${n - 1}(new ${last}()) && !${last}.hy${n - 1}(${last}) && !${last}.hy${n - 1}(new C());`,
    ],
    ["Object.create over a subclass instance", `return C.has(Object.create(new ${last}()));`],
    ["twin-layout class", `return !C.has(new T()) && !C.has(T);`],
    ["plain object, array and closure", `return !C.has({}) && !C.has([]) && !C.has(() => 1);`],
    [
      "class-expression subclass",
      `const K = class extends C {}; return C.has(new K()) && !C.has(K) && !C.has(K.prototype);`,
    ],
    ["this in an inherited method", `return new ${last}().t() && new C().t();`],
  ];
}

const LANES = [undefined, "standalone", "wasi"] as const;

async function expectSameOnAllLanes(n: number, body: string): Promise<void> {
  const src = `${hierarchy(n)}function value(): boolean { ${body} }\nexport function test(): number { return value() ? 1 : 0; }`;
  const expected = evaluateAsJs(src).test!();
  for (const target of LANES) {
    const lane = target ?? "gc";
    const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

for (const n of [1, 3, 10]) {
  describe(`#7202 \`#x in v\` own-brand guard with ${n} subclass(es)`, () => {
    for (const [name, body] of rows(n)) {
      it(name, async () => {
        await expectSameOnAllLanes(n, body);
      });
    }
  });
}

describe("#7202 the guard is one shared helper, not a per-site chain", () => {
  it("each site is a call; the helper is emitted once per declaring class", async () => {
    let src = `class C { #x = 1; static a(v: any) { return #x in v; } static b(v: any) { return #x in v; } }\n`;
    for (let i = 0; i < 10; i++) src += `class D${i} extends C {}\n`;
    src += `export function test(): number { const o: any = new C(); return (C.a(o) ? 1 : 0) + (C.b(D0) ? 2 : 0); }`;
    for (const target of LANES) {
      const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
      expect(result.success, target ?? "gc").toBe(true);
      expect(result.wat.match(/\(func \$__private_in_own_brand_C_/g)?.length, target ?? "gc").toBe(1);
      const instance = await instantiateWithRuntime(result);
      expect((instance.exports.test as () => unknown)(), target ?? "gc").toBe(1);
    }
  });

  it("a class without subclasses keeps the inline guard", async () => {
    const src = `class C { #x = 1; static a(v: any) { return #x in v; } }\nexport function test(): number { return (C.a(new C()) ? 1 : 0) + (C.a(C) ? 2 : 0); }`;
    const result = await compile(src, { fileName: "probe.ts" });
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("__private_in_own_brand_");
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)()).toBe(1);
  });
});
