// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice V11 — a writable [[Prototype]] on the builtin prototype objects
// on the standalone lane.
//
// `Object.setPrototypeOf(Number.prototype, p)` was a silent no-op on the
// `$NativeProto` carrier: `getPrototypeOf` kept answering `Object.prototype`,
// and the companion consult chain jumped from the receiver's brand straight to
// Object's. test262 `language/types/reference/put-value-prop-base-primitive.js`
// re-parents the four wrapper prototypes onto a Proxy and expects a sloppy
// primitive write (`0..x = null`) to reach its `set` trap.
//
// The first describe fails on the base tree; the control passes on both.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/** Compile `source` (top-level SCRIPT semantics: sloppy) and read the exported `__s`. */
async function runSloppy(source: string): Promise<string> {
  const full = `${source}
export function prepare() { return __s.length; }
export function at(i) { return __s.charCodeAt(i); }`;
  const result = (await compile(full, {
    target: "standalone",
    hostBridge: "off",
    fileName: "/p.ts",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  } as never)) as unknown as { success: boolean; errors?: { message: string }[]; binary?: Uint8Array };
  expect(result.success, (result.errors ?? []).map((error) => error.message).join("\n")).toBe(true);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(result.binary as Uint8Array), {});
  const exports = instance.exports as unknown as { prepare(): number; at(i: number): number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < Math.min(length, 400); index++) out += String.fromCharCode(exports.at(index));
  return out;
}

describe("#6651 V11 builtin prototypes take a new [[Prototype]]", () => {
  it("routes primitive writes to a Proxy parent's set trap", { timeout: 600_000 }, async () => {
    const out = await runSloppy(`var n = 0, s = 0, b = 0, y = 0, spy;
spy = new Proxy({}, { set: function () { n += 1; return true; } });
Object.setPrototypeOf(Number.prototype, spy);
0..test262 = null;
spy = new Proxy({}, { set: function () { s += 1; return true; } });
Object.setPrototypeOf(String.prototype, spy);
''.test262 = null;
spy = new Proxy({}, { set: function () { b += 1; return true; } });
Object.setPrototypeOf(Boolean.prototype, spy);
true.test262 = null;
spy = new Proxy({}, { set: function () { y += 1; return true; } });
Object.setPrototypeOf(Symbol.prototype, spy);
Symbol().test262 = null;
let __s = "" + n + s + b + y;`);
    expect(out).toBe("1111");
  });

  it("answers getPrototypeOf, Get and HasProperty through the stored parent", { timeout: 600_000 }, async () => {
    const out = await runSloppy(`var r = [];
var spy = new Proxy({}, { get: function (t, k) { return "G" + String(k); }, has: function () { return true; } });
r.push(Object.setPrototypeOf(Number.prototype, spy) === Number.prototype);
r.push(Object.getPrototypeOf(Number.prototype) === spy);
r.push(Reflect.getPrototypeOf(Number.prototype) === spy);
r.push((5).zz);
r.push("zz" in Number.prototype);
var par = { inh: 7 };
Object.setPrototypeOf(Number.prototype, par);
r.push((3).inh, (3).missing, (3).toFixed(1), Object.getPrototypeOf(Number.prototype) === par);
Object.setPrototypeOf(Number.prototype, null);
r.push(Object.getPrototypeOf(Number.prototype), (3).hasOwnProperty === undefined);
Object.setPrototypeOf(Number.prototype, Object.prototype);
r.push(typeof (3).hasOwnProperty);
try { Object.setPrototypeOf(Object.prototype, {}); r.push("noThrow"); } catch (e) { r.push(e instanceof TypeError); }
r.push(Reflect.setPrototypeOf(Object.prototype, {}), Reflect.setPrototypeOf(Object.prototype, null));
let __s = r.join(",");`);
    expect(out).toBe("true,true,true,Gzz,true,7,,3.0,true,,true,function,true,false,true");
  });
});

describe("#6651 V11 control — unchanged on both trees", () => {
  it("keeps an un-reparented wrapper prototype's members and writes", { timeout: 600_000 }, async () => {
    const out = await runSloppy(`Number.prototype.t = "np";
var o = { a: 1 };
Object.setPrototypeOf(o, { b: 2 });
let __s = (1).t + "|" + (2).toFixed(1) + "|" + o.b + "|" + String((0).x);`);
    expect(out).toBe("np|2.0|2|undefined");
  });
});
