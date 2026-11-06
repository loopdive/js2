// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6972) Standalone: a sloppy function whose `arguments` escapes (here into
// `this.initialize.apply(this, arguments)`, the Prototype.js `Class.create`
// shape Octane raytrace uses) materializes a branded `$__arguments_vec` and
// seeds its own `@@iterator` / `callee` onto an overlay companion `$Object`.
// That companion was registered in the global `$__overlay_tab` side table,
// which is strongly held and never pruned — so every construction retained its
// arguments object + companion (~400 B), raytrace grew ~29 MB per rep and hit a
// V8 OOM. The fix keeps a branded arguments object's companion in its own
// `overlayCompanion` field: it now dies with the arguments object.
//
// Expected strings are node's answers for the same source run as a sloppy script.
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
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
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return { instance, exports: instance.exports as Record<string, (...a: number[]) => unknown>, wat: result.wat ?? "" };
}

async function runMain(source: string): Promise<string> {
  const { instance, exports } = await build(source);
  const raw = exports.main!();
  return raw !== null && typeof raw === "object" ? (tryNativeExnRender(instance, raw) ?? "[wasm-object]") : String(raw);
}

// The issue repro assigns \`V.prototype = { … }\`; that literal form needs #6968,
// so the prototype methods are attached member-wise here (same leak on base).
const CTOR_APPLY_SRC = `
  var Class = { create: function () { return function () { this.initialize.apply(this, arguments); }; } };
  var V = Class.create();
  V.prototype.initialize = function (x, y, z) { this.x = x; this.y = y; this.z = z; };
  V.prototype.add = function (o) { return new V(this.x + o.x, this.y + o.y, this.z + o.z); };
  export function test(n) {
    var acc = new V(0, 0, 0);
    for (var i = 0; i < n; i++) acc = acc.add(new V(1, 2, 3));
    return acc.x + acc.y + acc.z;
  }
`;

// The same retention without a constructor: a plain forwarder.
const FORWARD_SRC = `
  function sum3(x, y, z) { return x + y + z; }
  function fwd() { return sum3.apply(null, arguments); }
  export function test(n) {
    var s = 0;
    for (var i = 0; i < n; i++) s += fwd(1, 2, 3);
    return s;
  }
`;

// Every companion-backed own property of an arguments object, read back through
// the string-key, symbol-key, index, descriptor, enumeration and delete paths.
// No non-arguments vec ever gets a companion here, so the global table holds
// nothing: the read prologues must still consult the arguments slot.
const SEMANTICS_SRC = `
  var out = [];
  function f() {
    var a = arguments;
    out.push(a.length, a.callee === f, typeof a[Symbol.iterator]);
    var d = Object.getOwnPropertyDescriptor(a, "callee");
    out.push(d.writable, d.enumerable, d.configurable);
    a.extra = 42;
    out.push(a.extra, Object.keys(a).join(","));
    Object.defineProperty(a, "named", { value: 7, enumerable: false });
    out.push(a.named, a.hasOwnProperty("named"), "named" in a);
    delete a.callee;
    out.push(a.callee === undefined, a.hasOwnProperty("callee"));
    var it = [];
    for (var x of a) it.push(x);
    out.push(it.join("|"));
    return a;
  }
  function g() {
    Object.defineProperty(arguments, "0", { value: "zero" });
    return arguments[0] + ":" + arguments.length;
  }
  function h() { return Array.prototype.slice.call(arguments).join("-"); }
  function k(x, y) {
    return (function () { return [].concat.apply([], arguments).length; }).apply(this, arguments);
  }
  export function main() {
    var r = f(1, 2, 3);
    out.push(r.extra, r[1]);
    out.push(g(1, 2), h(4, 5, 6), k(1, 2));
    var r2 = f("a");
    out.push(r === r2, r2.extra, Object.prototype.toString.call(r));
    return out.join(",");
  }
`;

// Negative control: an ordinary array's companion still lives in the global
// table and stays visible next to arguments-slot companions.
const MIXED_SRC = `
  function args() { var a = arguments; a.tag = "t" + a.length; return a; }
  export function main() {
    var arr = [1, 2, 3];
    Object.defineProperty(arr, "label", { value: "L", enumerable: false });
    var a1 = args(1), a2 = args(1, 2);
    Object.defineProperty(arr, "1", { get: function () { return 20; } });
    return [arr.label, arr[1], a1.tag, a2.tag, a1.callee === args, Object.getOwnPropertyNames(arr).join("")].join(",");
  }
`;

function heapGc(): () => number {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  return () => {
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };
}

describe("#6972 standalone arguments companion lives in the arguments object", () => {
  it("ctor `this.initialize.apply(this, arguments)` computes node's answer", async () => {
    const { exports } = await build(CTOR_APPLY_SRC);
    expect(exports.test!(1000)).toBe(6000);
  });

  // Base retained ~400 B per escaping arguments object: ≈ 47 MB here for the
  // ctor (3 × 40,000 constructions) and ≈ 24 MB for the forwarder.
  it.each([
    ["ctor apply", CTOR_APPLY_SRC],
    ["forwarder apply", FORWARD_SRC],
  ])("repeated %s calls do not retain memory", async (_name, source) => {
    const { exports } = await build(source);
    const heap = heapGc();
    expect(exports.test!(20000)).toBe(120000); // warm up
    const before = heap();
    for (let i = 0; i < 3; i++) expect(exports.test!(20000)).toBe(120000);
    expect((heap() - before) / 1e6).toBeLessThan(6);
  });

  it("arguments own properties (callee / @@iterator / expandos / defines) match node", async () => {
    expect(await runMain(SEMANTICS_SRC)).toBe(
      "3,true,function,true,false,true,42,0,1,2,extra,7,true,true,true,false,1|2|3,42,2,zero:2,4-5-6,2," +
        "1,true,function,true,false,true,42,0,extra,7,true,true,true,false,a,false,42,[object Arguments]",
    );
  });

  it("array companions keep using the global table alongside arguments slots", async () => {
    expect(await runMain(MIXED_SRC)).toBe("L,20,t1,t2,true,012lengthlabel");
  });

  it("the branded arguments type carries the companion slot", async () => {
    const { wat } = await build(CTOR_APPLY_SRC, true);
    expect(wat).toMatch(/\(type \$__arguments_vec[^\n]*overlayCompanion/);
  });
});
