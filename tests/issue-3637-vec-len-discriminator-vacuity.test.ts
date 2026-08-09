// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3637 — `typeof __vec_len(x) === "number"` is a VACUOUS vec discriminator.
//
// `__vec_len` is a length accessor, not a predicate: the `ref.test` chain built
// by `codegen/vec-access-exports.ts` ends in `i32.const 0; return`, so it
// answers 0 for any non-vec value WITHOUT throwing. Every host-side site that
// used it as a discriminator therefore classified plain objects, class
// instances and boxed values as EMPTY ARRAYS.
//
// Every assertion below is on an OBSERVABLE value and every one of them was
// confirmed to produce the recorded pre-fix answer on unmodified main. The
// `want` in each comment is what plain V8 answers for the identical source.
//
// The receiver used throughout is `class Empty { m() { return 1; } }` — a class
// instance with METHODS ONLY. That matters: several of these sites sit behind a
// `_getStructFieldNames(v) === null` pre-filter which masks the bug for a struct
// with named fields, so a field-carrying receiver would test nothing.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<Record<string, any>> {
  const result: any = await compile(src, { fileName: "probe.mjs" });
  expect(
    result.success,
    `Compile failed:\n${(result.errors ?? []).map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return {
    raw: instance.exports,
    wrapped: wrapExports(instance.exports, { signatures: result.exportSignatures }),
  };
}

describe("#3637 — __vec_len is not a discriminator", () => {
  it("the codegen invariant: a module exporting __vec_len also exports __is_vec", async () => {
    // This is what makes `_isWasmVec`'s legacy `__vec_len` fallback unreachable.
    // Both are emitted unconditionally by `_emitVecAccessExportsInner`; if that
    // ever changes, the vacuous fallback silently comes back to life.
    const { raw } = await run(`
      // @ts-nocheck
      export function f() { return [1, 2, 3]; }
    `);
    expect(typeof raw.__vec_len).toBe("function");
    expect(typeof raw.__is_vec).toBe("function");
    // And it must actually DISCRIMINATE: 1 for a vec, 0 for a non-vec struct,
    // while __vec_len answers 0 for BOTH. Without this assertion the test above
    // would pass on a hypothetical `__is_vec` that returns 1 unconditionally.
    const { raw: raw2 } = await run(`
      // @ts-nocheck
      class Empty { m() { return 1; } }
      export function vec() { return [1, 2, 3]; }
      export function obj() { return new Empty(); }
    `);
    const v = (raw2.vec as Function)();
    const o = (raw2.obj as Function)();
    expect((raw2.__is_vec as Function)(v)).toBe(1);
    expect((raw2.__is_vec as Function)(o)).toBe(0);
    // The vacuity itself, asserted directly: __vec_len cannot tell them apart.
    expect((raw2.__vec_len as Function)(o)).toBe(0);
    expect((raw2.__vec_len as Function)((raw2.vec as Function)())).toBe(3);
  });

  it("iteration: a non-iterable struct throws TypeError instead of iterating zero times", async () => {
    const { wrapped } = await run(`
      // @ts-nocheck
      export function forOfObject() {
        try { for (var x of { a: 1 }) {} return "no-throw"; } catch (e) { return "throws:" + e.name; }
      }
      export function spreadObject() {
        try { return "no-throw:" + JSON.stringify([...{ a: 1 }]); } catch (e) { return "throws:" + e.name; }
      }
      export function forOfClassInstance() {
        class Empty { m() { return 1; } }
        try { for (var x of new Empty()) {} return "no-throw"; } catch (e) { return "throws:" + e.name; }
      }
    `);
    // Pre-fix: "no-throw" / "no-throw:[]" / "no-throw" — the vacuous
    // `__vec_len` probe synthesized a zero-length iterator for every struct.
    expect(wrapped.forOfObject()).toBe("throws:TypeError");
    expect(wrapped.spreadObject()).toBe("throws:TypeError");
    expect(wrapped.forOfClassInstance()).toBe("throws:TypeError");
  });

  it("iteration: genuine iterables are untouched (this is not a blanket TypeError)", async () => {
    const { wrapped } = await run(`
      // @ts-nocheck
      export function vecLoop() { var n = 0; for (var x of [1, 2, 3]) { n += x; } return n; }
      export function emptyVecLoop() { var n = 0; for (var x of []) { n += 1; } return "count:" + n; }
      export function mapLoop() {
        var m = new Map(); m.set("a", 1); m.set("b", 2);
        var out = ""; for (var e of m) { out += e[0] + ":" + e[1] + ";" } return out;
      }
      export function setLoop() { var n = 0; for (var v of new Set([1, 2, 3])) { n += v; } return n; }
      export function genLoop() { function* g() { yield 1; yield 2; } var n = 0; for (var v of g()) { n += v; } return n; }
      export function stringLoop() { var out = ""; for (var c of "abc") { out += c + "."; } return out; }
      export function argumentsLoop() {
        function f() { var n = 0; for (var v of arguments) { n += v; } return n; }
        return f(1, 2, 3);
      }
      export function customIterator() {
        var o = {};
        o[Symbol.iterator] = function () {
          var i = 0;
          return { next: function () { return i < 2 ? { value: i++, done: false } : { value: undefined, done: true }; } };
        };
        return JSON.stringify([...o]);
      }
    `);
    // The EMPTY vec is the case the old code could not distinguish from a
    // non-vec — it must still iterate (zero times) rather than throw.
    expect(wrapped.emptyVecLoop()).toBe("count:0");
    expect(wrapped.vecLoop()).toBe(6);
    expect(wrapped.mapLoop()).toBe("a:1;b:2;");
    expect(wrapped.setLoop()).toBe(6);
    expect(wrapped.genLoop()).toBe(3);
    expect(wrapped.stringLoop()).toBe("a.b.c.");
    expect(wrapped.argumentsLoop()).toBe(6);
    expect(wrapped.customIterator()).toBe("[0,1]");
  });

  it("JSON.stringify: a field-less struct serializes as an object, not an empty array", async () => {
    const { wrapped } = await run(`
      // @ts-nocheck
      class Empty { m() { return 1; } }
      export function bare() { return JSON.stringify(new Empty()); }
      export function nested() { return JSON.stringify({ a: new Empty() }); }
      export function withReplacer() { return JSON.stringify(new Empty(), function (k, v) { return v; }); }
      export function realEmptyArray() { return JSON.stringify([]); }
      export function nestedEmptyArray() { return JSON.stringify({ a: [] }); }
      export function nonEmpty() { return JSON.stringify({ a: 1, b: [1, 2] }); }
    `);
    // Pre-fix: "[]" / {"a":[]} / "[]" — `_wasmToPlain` treated `__vec_len === 0`
    // as "empty array", and `_liveIsArray` (the replacer walk) agreed.
    expect(wrapped.bare()).toBe("{}");
    expect(wrapped.nested()).toBe('{"a":{}}');
    expect(wrapped.withReplacer()).toBe("{}");
    // A REAL empty array must still be `[]`, so the fix cannot be "never say
    // array when the length is 0".
    expect(wrapped.realEmptyArray()).toBe("[]");
    expect(wrapped.nestedEmptyArray()).toBe('{"a":[]}');
    expect(wrapped.nonEmpty()).toBe('{"a":1,"b":[1,2]}');
  });

  it('Array.prototype.join: an object element stringifies via ToPrimitive, not to ""', async () => {
    const { wrapped } = await run(`
      // @ts-nocheck
      export function objectElement() { var o = { x: 1 }; return String([o].join("|")); }
      export function mixed() { var o = { x: 1 }; return String([1, o].join("-")); }
      export function nestedArrays() { return String([[1, 2], [3]].join(";")); }
    `);
    // Pre-fix: "" / "1-" — the element was walked as a zero-length vec.
    expect(wrapped.objectElement()).toBe("[object Object]");
    expect(wrapped.mixed()).toBe("1-[object Object]");
    // Nested REAL vecs still recurse into `join(",")` per ToString(array).
    expect(wrapped.nestedArrays()).toBe("1,2;3");
  });

  it("Array.prototype.concat: an object argument is appended, not silently dropped", async () => {
    const { wrapped } = await run(`
      // @ts-nocheck
      export function objectArg() { var o = { x: 1 }; return JSON.stringify([0].concat(o)); }
      export function arrayArg() { return JSON.stringify([0].concat([1, 2])); }
      export function emptyArrayArg() { return JSON.stringify([0].concat([])); }
    `);
    // Pre-fix: "[0]" — `tryVecLen` reported spread length 0 for the object, so
    // §23.1.3.1 appended zero elements instead of the value itself.
    expect(wrapped.objectArg()).toBe('[0,{"x":1}]');
    // A genuine vec argument must STILL be spread (#1969), and an empty one
    // must still contribute nothing — the two answers the old code conflated.
    expect(wrapped.arrayArg()).toBe("[0,1,2]");
    expect(wrapped.emptyArrayArg()).toBe("[0]");
  });

  it("Array.prototype.flat / flatMap: object elements survive the deep unwrap", async () => {
    const { wrapped } = await run(`
      // @ts-nocheck
      export function objectElement() { return JSON.stringify([{ x: 1 }].flat()); }
      export function nestedVec() { return JSON.stringify([[1], [2]].flat()); }
      export function flatMapped() { return JSON.stringify([1, 2].flatMap(function (v) { return [v, v]; })); }
    `);
    // Pre-fix: "[]" — `_toJsArrayDeep` rewrote the object element as `[]` (its
    // doc comment already CLAIMED "a non-vec value passes through unchanged").
    expect(wrapped.objectElement()).toBe('[{"x":1}]');
    expect(wrapped.nestedVec()).toBe("[1,2]");
    expect(wrapped.flatMapped()).toBe("[1,1,2,2]");
  });

  it("wrapExports marshalling: a field-less instance crosses as {}, a closure stays callable", async () => {
    const { wrapped } = await run(`
      // @ts-nocheck
      class Empty { m() { return 1; } }
      export function mkInstance() { return new Empty(); }
      export function mkObject() { return { a: 1 }; }
      export function mkVec() { return [1, 2]; }
      export function mkEmptyVec() { return []; }
      export function mkClosure() { return function (x) { return x + 1; }; }
    `);
    // Pre-fix: `[]`. The double vacuity — `looksMarshalable` said "vec" and
    // `_wasmToPlain` then rendered `[]`.
    expect(wrapped.mkInstance()).toEqual({});
    expect(wrapped.mkObject()).toEqual({ a: 1 });
    expect(wrapped.mkVec()).toEqual([1, 2]);
    expect(wrapped.mkEmptyVec()).toEqual([]);
    // #1308 regression guard: a closure must NOT be marshalled — and the
    // deliberate non-narrowing of `looksMarshalable` (see the issue file) is
    // what keeps a field-less INSTANCE out of this same callable-wrapper arm.
    expect(typeof wrapped.mkClosure()).toBe("function");
    expect(wrapped.mkClosure()(1)).toBe(2);
  });
});
