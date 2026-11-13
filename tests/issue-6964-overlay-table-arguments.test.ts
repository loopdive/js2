// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6964) Standalone: every observable sloppy `arguments` object defined its own
// `@@iterator` / `callee` through the generic `__defineProperty_value`. On a vec
// receiver that ran the array-exotic define preamble — `__vec_overlay_ensure`
// (a full newest-first MISS scan of the append-only companion table) and, for
// `callee`, the extensibility guard's `__integrity_bag`, which allocated an
// expando bag per arguments object after walking the whole bag list. Both
// tables grew by one entry per call, so each call was slower than the last
// (Octane earley-boyer 1.5 s -> 13 s over five runs). Separately, once ANY
// companion held a numeric key, every vec read miss in `__extern_get_idx`
// scanned the whole companion table.
//
// The fix: (1) the indexed READ / HAS prologues scan only companions that hold
// a numeric entry (`__vec_overlay_lookup_num`, a second table registered by
// `__vec_overlay_mark_num` at every site that arms the numeric flag); (2) the
// arguments seeds use `__args_own_define_value` / `_accessor`, which define on
// the companion directly (no scan for a branded fresh vec, no bag); an
// unobservable sloppy arguments object no longer gets `callee` at all.
//
// Expected values are node's answers for the same source run as a sloppy script.
import { describe, expect, it } from "vitest";

import { tryNativeExnRender } from "../scripts/lib/wasm-exn-render.mjs";
import { compile } from "../src/index.js";

const OPTS = {
  fileName: "probe.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "standalone" as const,
  inferModuleStrictArguments: false,
  runtimeEvalProvider: false as const,
};

async function build(source: string, emitWat = false) {
  const result = await compile(source, emitWat ? { ...OPTS, emitWat: true } : OPTS);
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const instance = await WebAssembly.instantiate(mod, {});
  return { instance, wat: result.wat ?? "" };
}

async function runMain(source: string): Promise<string> {
  const { instance } = await build(source);
  const raw = (instance.exports as { main: () => unknown }).main();
  return raw !== null && typeof raw === "object" ? (tryNativeExnRender(instance, raw) ?? "[wasm-object]") : String(raw);
}

const ARGS_SRC = `
  function f() { return arguments; }
  function g() { var a = arguments; return a.callee === g; }
  function h() { "use strict"; return arguments; }
  var lifted = function () { return arguments.callee; };
  function unobs(x) { return arguments.length + arguments[0]; }
  export function main() {
    var out = [];
    var a = f(1, 2);
    out.push(Object.prototype.hasOwnProperty.call(a, "callee"), a.callee === f);
    var d = Object.getOwnPropertyDescriptor(a, "callee");
    out.push(d.writable, d.enumerable, d.configurable);
    out.push(Object.getOwnPropertyNames(a).join(","), Object.keys(a).join(","));
    out.push(a[Symbol.iterator] === Array.prototype.values);
    var di = Object.getOwnPropertyDescriptor(a, Symbol.iterator);
    out.push(di.writable, di.enumerable, di.configurable);
    out.push(g(), lifted() === lifted);
    a.x = 5;
    out.push(Object.keys(a).join(","));
    var s = h(3);
    try { s.callee; out.push("no-throw"); } catch (e) { out.push(e instanceof TypeError); }
    out.push(Object.getOwnPropertyNames(s).join(","));
    var b = f(7, 8, 9);
    Object.defineProperty(b, "callee", { value: 42 });
    out.push(b.callee, b[1], b.length);
    b[1] = 10;
    out.push(b[1]);
    var sum = 0;
    for (var v of f(1, 2, 3)) sum += v;
    out.push(sum);
    var c = f(4);
    Object.freeze(c);
    out.push(Object.isFrozen(c));
    c[0] = 99;
    out.push(c[0], unobs(5, 6));
    var e = f(1);
    Object.defineProperty(e, "0", { get: function () { return 77; } });
    out.push(e[0]);
    return out.join("|");
  }
`;

// Numeric companion entries on one vec must stay visible to indexed reads /
// \`in\` while many string-key-only companions (arguments objects) exist, and a
// vec WITHOUT a numeric entry must keep reading its own elements.
const NUMERIC_SRC = `
  function args() { var a = arguments; return a.length; }
  function get(o, k) { return o[k]; }
  function has(o, k) { return k in o; }
  function put(o, k, v) { o[k] = v; return o[k]; }
  export function main() {
    var out = [];
    put({}, "z", 1);
    for (var i = 0; i < 50; i++) args(1, 2, 3);
    var arr = [1, 2, 3];
    Object.defineProperty(arr, "1", { get: function () { return 200; } });
    for (var j = 0; j < 50; j++) args(4);
    var plain = [7, 8, 9];
    out.push(get(arr, 1), get(arr, 0), get(plain, 1), has(arr, 1), has(plain, 2));
    var sparse = [1, 2, 3];
    delete sparse[1];
    out.push(get(sparse, 1), has(sparse, 1), sparse.length);
    var ro = [1, 2, 3];
    Object.defineProperty(ro, "2", { value: 30, writable: false });
    out.push(put(ro, 2, 31), put(ro, 0, 10), put(plain, 0, 70));
    var big = [];
    Object.defineProperty(big, "4294967294", { value: 5 });
    out.push(get(big, 4294967294), big.length);
    var g = [];
    put(g, g.length, 1);
    put(g, g.length, 2);
    out.push(g.join(","), get(g, 1));
    return out.join("|");
  }
`;

// The earley-boyer shape: every observable arguments object used to add a
// companion (and a bag), and one out-of-bounds store armed the numeric flag.
const GROWTH_SRC = `
  function sc_list() { var res = null; var a = arguments; for (var i = a.length - 1; i >= 0; i--) res = { car: a[i], cdr: res }; return res; }
  function put(a, k, v) { a[k] = v; }
  function mk(n) { var r = new Array(n); for (var i = 0; i < n; i++) put(r, i, i); return r; }
  function sum(v) { var s = 0; for (var i = 0; i < v.length; i++) s += v[i]; return s; }
  var g = [];
  put({}, "z", 1);
  export function run() {
    put(g, g.length, 1);
    for (var k = 0; k < 4000; k++) sc_list(1, 2, 3);
    var v = mk(100);
    var s = 0;
    for (var j = 0; j < 300; j++) s += sum(v);
    return s;
  }
`;

describe("#6964 standalone vec-overlay table stays bounded under sloppy arguments", () => {
  it("arguments own callee / @@iterator / descriptors match node", async () => {
    expect(await runMain(ARGS_SRC)).toBe(
      "true|true|true|false|true|0,1,length,callee|0,1|true|true|false|true|true|true|0,1,x|true|0,length,callee|42|8|3|10|6|true|4|7|77",
    );
  });

  it("numeric companion entries stay visible through the numeric-only table", async () => {
    expect(await runMain(NUMERIC_SRC)).toBe("200|1|8|true|true||false|3|30|10|70|5|4294967295|1,2|2");
  });

  it("the module carries the fresh-arguments define and the numeric-only lookup", async () => {
    const { wat } = await build(GROWTH_SRC, true);
    expect(wat).toContain("(func $__args_own_define_value");
    expect(wat).toContain("(func $__vec_overlay_lookup_num");
    expect(wat).toContain("(func $__vec_overlay_mark_num");
  });

  it("repeated runs do not get slower (no per-call table growth)", async () => {
    const { instance } = await build(GROWTH_SRC);
    const run = (instance.exports as { run: () => number }).run;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      expect(run()).toBe(1485000);
      times.push(performance.now() - t0);
    }
    // Base: ~200 ms -> ~2900 ms. Generous bound against scheduler noise.
    const first = Math.max(times[0]!, times[1]!);
    expect(times[4]!, times.map((t) => t.toFixed(0)).join(" / ")).toBeLessThan(Math.max(4 * first, first + 150));
  });

  it("unobservable sloppy arguments get no callee define (negative control: observable ones do)", async () => {
    // Only \`.length\` and a literal index: the observability proof elides every own-property seed.
    const unobservable = await build(
      `function u(x) { return arguments.length + arguments[0]; }
       export function main() { Object.defineProperty([], "q", { value: 1 }); return u(1, 2); }`,
      true,
    );
    expect(unobservable.wat).not.toContain("$__args_own_define_value");
    expect((unobservable.instance.exports as { main: () => number }).main()).toBe(3);
    const observable = await build(
      `function o() { return arguments; }
       export function main() { Object.defineProperty([], "q", { value: 1 }); return o(3).callee === o; }`,
      true,
    );
    expect(observable.wat).toContain("(func $__args_own_define_value");
    expect((observable.instance.exports as { main: () => number }).main()).toBe(1);
  });
});
