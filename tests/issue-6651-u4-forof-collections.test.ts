/**
 * #6651 slice U4 — for-of residue + collection-ctor identity (G5 + G6). Every
 * case compiles `--target standalone`, asserts the binary imports nothing, and
 * is RED on the base commit unless marked GUARD (neighbouring behaviour that
 * must not move — green on base too).
 *
 * 1. Module-scope array bindings assigned to ONE ANOTHER (`first = second`)
 *    hold the same arrays, so they share one element carrier. A vec→vec store
 *    between `boolean[]` and `(null|undefined)[]` slots used to copy and
 *    convert (`[null, undefined]` became `[false, false]`) — `for-of/map.js`.
 * 2. A throw raised BY a finally block completes the try statement; none of
 *    that statement's own handlers may observe it. The inlined normal-exit
 *    finally sat inside the statement's catch_all, so `finally { i++; throw }`
 *    ran twice (`for-of/throw-from-finally.js`), and a catch clause caught its
 *    own finally's throw.
 * 3. A computed key in a for-of object assignment pattern is evaluated (and
 *    its abrupt completion propagates) — `for-of/dstr/obj-prop-name-evaluation-error.js`.
 * 4. `{ value: item }` aliases a widened module array instead of copying it, so
 *    an accessor installed on `item[0]` is seen by `new Map(iterable)`'s
 *    `Get(item, "0")`, which then closes the iterator —
 *    `{Map,WeakMap}/iterator-item-{first,second}-entry-returns-abrupt.js`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = {
  success: boolean;
  binary: Uint8Array;
  errors?: unknown;
  imports?: unknown[];
};

async function run(src: string, js = false): Promise<unknown> {
  const r = (await compile(src, {
    fileName: js ? "t.js" : "t.ts",
    allowJs: js,
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  expect(r.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 U4 · 1 · aliased module arrays share one element carrier", () => {
  it("`second = third` keeps null/undefined and identity", async () => {
    // JavaScript source, like test262: the checker infers `boolean[]` etc.
    const src = `var first = [0, 'a'];
var second = [true, false];
var third = [null, undefined];
first = second;
second = third;
export function test() {
  var r = 0;
  if (first[0] === true) r += 1;
  if (second[0] === null) r += 10;
  if (second[1] === undefined) r += 100;
  if (second === third) r += 1000;
  return r;
}`;
    expect(await run(src, true)).toBe(1111);
  });

  it("GUARD: same-domain aliasing keeps its numeric carrier", async () => {
    const src = `var a = [1, 2];
var b = [3, 4];
a = b;
export function test() { return a[0] * 10 + a[1] + (a === b ? 100 : 0); }`;
    expect(await run(src, true)).toBe(134);
  });
});

describe("#6651 U4 · 2 · a throw from finally completes the try statement", () => {
  it("for-of body: the finally runs once", async () => {
    const src = `export function test(): any {
  var i = 0;
  try {
    for (var x of [1]) {
      try { } finally { i++; throw 7; }
    }
  } catch (e) { }
  return i;
}`;
    expect(await run(src)).toBe(1);
  });

  it("plain nested try/finally: the finally runs once", async () => {
    const src = `export function test(): any {
  var i = 0;
  try {
    try { } finally { i++; throw 7; }
  } catch (e) { }
  return i;
}`;
    expect(await run(src)).toBe(1);
  });

  it("the statement's own catch clause does not see its finally's throw", async () => {
    const src = `export function test(): any {
  var i = 0;
  var caught = 0;
  var outer = 0;
  try {
    try { i += 1; } catch (e) { caught++; } finally { i += 10; throw 7; }
  } catch (e) { outer = e as any; }
  return i + caught * 1000 + outer * 100;
}`;
    expect(await run(src)).toBe(711);
  });

  it("break out of the try body: a throwing finally runs once", async () => {
    const src = `export function test(): any {
  var i = 0;
  try {
    while (true) {
      try { break; } finally { i++; throw 7; }
    }
  } catch (e) { }
  return i;
}`;
    expect(await run(src)).toBe(1);
  });

  it("GUARD: a throw from the try body still runs the finally once and propagates", async () => {
    const src = `export function test(): any {
  var i = 0;
  var got = 0;
  try {
    try { throw 5; } finally { i++; }
  } catch (e) { got = e as any; }
  return i * 10 + got;
}`;
    expect(await run(src)).toBe(15);
  });
});

describe("#6651 U4 · 3 · for-of assignment pattern evaluates computed keys", () => {
  it("an abrupt key evaluation propagates", async () => {
    const src = `var a: any;
var x: any;
export function test(): any {
  var counter = 0;
  try {
    for ({ [a.b]: x } of [{}]) { counter += 1; }
    counter += 10;
  } catch (e) {
    return e instanceof TypeError ? 100 + counter : -1;
  }
  return counter;
}`;
    expect(await run(src)).toBe(100);
  });

  it("a runtime key is evaluated once and read", async () => {
    const src = `var n = 0;
var x: any;
function k(): any { n++; return "p"; }
export function test(): any {
  for ({ [k()]: x } of [{ p: 7 }]) { }
  return n * 100 + x;
}`;
    expect(await run(src)).toBe(107);
  });
});

describe("#6651 U4 · 4 · collection ctor sees an accessor on a module array entry", () => {
  for (const ctor of ["Map", "WeakMap"]) {
    it(`new ${ctor}(iterable): Get(item, "0") throws and closes the iterator`, async () => {
      const src = `var count = 0;
var item = ['foo', 'bar'];
var marker = { tag: 1 };
Object.defineProperty(item, 0, { get: function () { throw marker; } });
var iterable: any = {};
iterable[Symbol.iterator] = function () {
  return {
    next: function () { return { value: item, done: false }; },
    return: function () { count++; }
  };
};
export function test(): any {
  var r = 0;
  try { new ${ctor}(iterable); } catch (e) { if (e === marker) r = 1; }
  return r * 10 + count;
}`;
      expect(await run(src)).toBe(11);
    });
  }

  it("GUARD: a non-object item is a TypeError and closes the iterator", async () => {
    const src = `var count = 0;
var iterable: any = {};
iterable[Symbol.iterator] = function () {
  return {
    next: function () { return { value: 1, done: false }; },
    return: function () { count++; }
  };
};
export function test(): any {
  var r = 0;
  try { new Map(iterable); } catch (e) { if (e instanceof TypeError) r = 1; }
  return r * 10 + count;
}`;
    expect(await run(src)).toBe(11);
  });
});
