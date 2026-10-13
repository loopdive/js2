// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6973 stage 2) A function constructor that delegates with
// `Parent.call(this, …)` — directly, or through a `superConstructor` property
// bound by an `inheritsFrom`-style helper (Octane deltablue) — now reserves
// presence-tracked struct slots for the fields the delegate assigns, instead of
// leaving them in the instance's expando bag where every read hashed through
// `__extern_get`.
//
// Names a slot could not mirror exactly are left in the bag: anything written
// onto a prototype, `defineProperty`'d or `delete`d, and the Object.prototype
// member names. Expected values are Node's for the identical source.
import { afterEach, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SRC = `
Object.defineProperty(Object.prototype, "inheritsFrom", {
  value: function (shuper) {
    function Inheriter() { }
    Inheriter.prototype = shuper.prototype;
    this.prototype = new Inheriter();
    this.superConstructor = shuper;
  }
});
function Base(a, b) { this.a = a; this.b = b; this.dir = 1; if (a > 100) this.big = true; if (a > 50) this.mid = 9; }
Base.prototype.out = function () { return this.dir == 1 ? this.b : this.a; };
Base.prototype.big = "proto-big";
function Sub(a, b) { Sub.superConstructor.call(this, a, b); this.own = 7; }
Sub.inheritsFrom(Base);
Sub.prototype.flip = function () { this.dir = -1; };
Sub.prototype.drop = function () { delete this.b; };

function Point(x) { this.x = x; this.tag = "p"; }
function Point3(x, z) { Point.call(this, x); this.z = z; }
Point3.prototype.sum = function () { return this.x + this.z; };

export function t_inherits() {
  var s = new Sub(2, 3);
  var r = s.out() * 100;
  s.flip();
  r += s.out() * 10;
  return r + s.own;
}
export function t_presence() {
  var s = new Sub(2, 3), t = new Sub(200, 1);
  var r = (s.big === "proto-big" ? 1 : 0) + (t.big === true ? 10 : 0) + (s.hasOwnProperty("big") ? 100 : 0);
  r += (s.mid === undefined ? 10000 : 0) + (t.mid === 9 ? 100000 : 0);
  r += ("mid" in s ? 1000000 : 0) + (s.hasOwnProperty("mid") ? 10000000 : 0) + (t.hasOwnProperty("mid") ? 100000000 : 0);
  return r;
}
export function t_delete() {
  var t = new Sub(200, 1);
  t.drop();
  return (t.b === undefined ? 1 : 0) + ("b" in t ? 10 : 0) + (t.hasOwnProperty("a") ? 100 : 0);
}
export function t_direct_call() {
  var p = new Point3(4, 5);
  return p.sum() + (p.hasOwnProperty("x") ? 100 : 0) + (p.tag === "p" ? 1000 : 0);
}
export function t_write_later() {
  var s = new Sub(1, 2);
  s.mid = 4;
  s.a = s.a + s.mid;
  return s.a * 10 + s.mid;
}
export function t_loop() {
  var s1 = new Sub(1, 2), s2 = new Sub(3, 4);
  s2.flip();
  var total = 0;
  for (var i = 0; i < 300; i++) total += (i % 2 ? s1 : s2).out();
  return total;
}
export function t_point_loop() {
  var p = new Point3(4, 5), q = new Point3(1, 1);
  var total = 0;
  for (var i = 0; i < 300; i++) total += (i % 2 ? p : q).sum();
  return total;
}
`;

const EXPECTED: Record<string, number> = {
  t_inherits: 327,
  t_presence: 100110011,
  t_delete: 101,
  t_direct_call: 1109,
  t_write_later: 54,
  t_loop: 750,
  t_point_loop: 1650,
};

async function run(): Promise<Record<string, number>> {
  const result = await compile(SRC, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const census = instance.exports.__exec_count___extern_get as WebAssembly.Global | undefined;
  const out: Record<string, number> = {};
  for (const name of Object.keys(EXPECTED)) {
    const before = (census?.value as number | undefined) ?? 0;
    out[name] = (instance.exports[name] as () => number)();
    out[`calls:${name}`] = ((census?.value as number | undefined) ?? 0) - before;
  }
  return out;
}

describe("#6973 stage 2 — fields grown from `Parent.call(this, …)` delegation", () => {
  const saved = process.env.JS2WASM_EXEC_CENSUS;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EXEC_CENSUS");
    else process.env.JS2WASM_EXEC_CENSUS = saved;
  });

  it("answers what Node answers", async () => {
    const out = await run();
    for (const [name, expected] of Object.entries(EXPECTED)) expect(out[name], name).toBe(expected);
  });

  it("reads delegate-assigned fields from struct slots, not through __extern_get", async () => {
    process.env.JS2WASM_EXEC_CENSUS = "__extern_get";
    const out = await run();
    expect(out.t_point_loop).toBe(1650);
    // 300 `sum()` calls: the method lookup itself is one `__extern_get` each;
    // `this.x` (assigned by `Point.call(this, x)`) is now a slot read. Through
    // the bag it added another 300.
    expect(out["calls:t_point_loop"]).toBeLessThanOrEqual(310);
  });
});
