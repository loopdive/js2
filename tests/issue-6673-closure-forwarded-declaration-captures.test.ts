// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6673 — a closure nested inside a lifted function declaration read a
// capture through the OUTER frame's local index. lodash's standalone compile
// died on it (`stack-balance invariant (entry): '__closure_72' references local
// 327, but only 3 params + 59 locals are declared`); in-range indexes read an
// unrelated local silently, in both lanes.
//
//  1. `new Stack` / `mk()` inside a closure in `baseMerge`, where `Stack` is a
//     capturing declaration whose VALUE is also observed. The invoke scan
//     stopped at the closure boundary, so `baseMerge` only carried the `Stack`
//     cell and never `Stack`'s own captures; and the closure refused to
//     inherit `Stack`'s captures because `Stack` is a leading capture PARAM of
//     `baseMerge` (read as "a user parameter shadows the declaration").
//  2. lodash `mixin`: `var chain` shadows `function chain` and is read only
//     from a closure nested in the `arrayEach` callback. The callback found no
//     shallow binding for `chain`, treated it as the function declaration and
//     never captured it; the inner closure then materialized the outer
//     function value from `runInContext`'s local indexes.
//
// Each case is a lane-independent miscompile (wrong value or codegen error),
// so both `standalone` and the JS-host `gc` target are pinned against Node.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

async function run(source: string, target: "standalone" | "gc"): Promise<string> {
  const entry = "/main.js";
  const options: Record<string, unknown> = { allowJs: true, skipSemanticDiagnostics: true, target };
  if (target === "standalone") options.hostBridge = "off";
  const result = await compileMulti({ [entry]: source }, entry, options as never);
  if (!result.success) return `CE ${result.errors?.[0]?.message?.slice(0, 160)}`;
  const imports = (result.importObject ?? {}) as Record<string, unknown> & {
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary as Uint8Array, imports as never);
  imports.__setInstance?.(instance);
  const exports = instance.exports as { main: () => number; __module_init?: () => void };
  exports.__module_init?.();
  return String(exports.main());
}

// `new Stack` in a callback nested in a declaration; `Stack` captures
// `ListCache` and `a9` from the factory frame (lodash `baseMerge`).
const CONSTRUCT_IN_CALLBACK = `
function runInContext() {
  var a1 = 1, a2 = 2, a3 = 3, a4 = 4, a5 = 5, a6 = 6, a7 = 7, a8 = 8, a9 = 9, a10 = 10;
  function ListCache(entries) { this.size = entries ? 1 : 0; }
  function Stack(entries) { var data = this.__data__ = new ListCache(entries); this.size = data.size + a9; }
  var direct = new Stack().size;
  function baseFor(obj, fn) { for (var k in obj) fn(obj[k], k); }
  function baseMerge(object, source, stack) {
    baseFor(source, function(srcValue, key) {
      stack || (stack = new Stack);
      object[key] = srcValue + stack.size;
    });
    return object;
  }
  return direct * 1000 + baseMerge({}, { x: 1, y: 2 }).x + a10;
}
export function main() { return runInContext(); }
`;

// Same shape through a CALL: the declaration observes `mk` as a value AND
// calls it from a nested closure.
const CALL_IN_CALLBACK = `
function runInContext() {
  var a9 = 9;
  var ListCache = function (entries) { this.size = entries ? 1 : 0; };
  function mk() { return { size: a9 + ListCache.length }; }
  function baseMerge(stack) {
    var g = mk;
    var f = function() {
      stack || (stack = mk());
      return stack.size;
    };
    return f() + (g === mk ? 100 : 0);
  }
  return baseMerge();
}
export function main() { return runInContext(); }
`;

// lodash `mixin`: a local `var chain` shadows `function chain` and is read
// only two closures deep.
const SHADOWED_IN_NESTED_CLOSURE = `
function runInContext() {
  var a1 = 1, a2 = 2, a3 = 3, a4 = 4, a5 = 5, a6 = 6, a7 = 7, a8 = 8, a9 = 9;
  function lodash(value) { return { v: value, k: a9 }; }
  function chain(value) { var result = lodash(value); result.__chain__ = true; return result; }
  var probe = chain;
  function arrayEach(arr, fn) { for (var i = 0; i < arr.length; i++) fn(arr[i]); }
  function mixin(object, names, options) {
    var chain = options ? true : false;
    arrayEach(names, function(methodName) {
      object[methodName] = function() {
        return chain ? "chained" : "plain";
      };
    });
    return object;
  }
  var on = mixin({}, ["a"], 1);
  var off = mixin({}, ["a"], 0);
  return (on.a() === "chained" ? 10 : 20) + (off.a() === "plain" ? 100 : 200) + (probe(5).k === 9 ? 1 : 2);
}
export function main() { return runInContext(); }
`;

const CASES: Array<[string, string, string]> = [
  ["construct of a capturing declaration inside a nested callback", CONSTRUCT_IN_CALLBACK, "9020"],
  ["call of a value-observed declaration inside a nested closure", CALL_IN_CALLBACK, "110"],
  ["shadowing local read only from a doubly nested closure", SHADOWED_IN_NESTED_CLOSURE, "111"],
];

describe("#6673 closures inherit the captures of the declarations they invoke", () => {
  for (const target of ["standalone", "gc"] as const) {
    for (const [name, source, expected] of CASES) {
      it(`${target}: ${name}`, async () => {
        expect(await run(source, target)).toBe(expected);
      });
    }
  }
});
