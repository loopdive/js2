// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice W1a — String exotic objects (§10.4.3) on `--target standalone`,
// plus the trapless-Proxy [[Set]] forward onto a non-extensible Array.
//
// ## The causes
//
// 1. `s[4]` with a NUMERIC key on a statically-`String` receiver lowered to the
//    §10.4.3.5 index read and answered `undefined` out of range — it never
//    consulted the wrapper's own `$Object` table, so `s[4] = 1; s[4]` (and a
//    `Reflect.defineProperty(s, "4", …)`) read back `undefined`. The miss now
//    falls through to `__extern_get_idx` (OrdinaryGetOwnProperty, §10.4.3.1).
// 2. `Reflect.set(s, "0" | "length", v)` answered `true`, a strict assignment
//    did not throw, and `Object.defineProperty(s, "0", {value: "x"})` was
//    accepted: only the sloppy `__extern_set` knew the String-exotic own
//    properties are non-writable/non-configurable. `__reflect_set`,
//    `__extern_set_strict` and both define appliers now share the same
//    `__strexo_hasown` predicate (§10.4.3.2 ValidateAndApplyPropertyDescriptor
//    against the immutable descriptor).
// 3. `Reflect.set(proxy(proxy(nonExtensibleArray)), "foo", v)` answered
//    `true`: the vec define applier only refused a FRESH INDEX on a
//    non-extensible array, not a new named key, and the §10.1.9.2 receiver walk
//    let a define rejection escape as a throw instead of `false`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));
const ROW = "built-ins/Proxy/set/trap-is-null-target-is-proxy.js";
const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  existsSync(join(TEST262_ROOT, "test", ROW));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

/** Compile an untyped program for standalone and answer `__r`. */
async function runStandalone(body: string): Promise<number> {
  const source = `var __r: any = 0;\n${body}\nexport function run() { return __r; }\n`;
  const r = await compile(source, {
    target: "standalone",
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, () => number>;
  ex.__module_init?.();
  return ex.run!();
}

describe("#6651 W1a — String exotic [[DefineOwnProperty]] / [[Set]] / expandos (standalone)", () => {
  it("§10.4.3.1 — a numeric-key read past [[StringData]] reads the wrapper's own expando", async () => {
    expect(
      await runStandalone(`
var s = new String("str"); s[4] = 1; var k = 4;
__r = (s[4] === 1 ? 1 : 0) + (s[k] === 1 ? 10 : 0) + (s[1] === "t" ? 100 : 0) + (s[3] === undefined ? 1000 : 0);`),
    ).toBe(1111);
    expect(
      await runStandalone(`
var s = new String("str");
var ok = Reflect.defineProperty(s, "4", {value: 4});
__r = (ok ? 1 : 0) + (s[4] === 4 ? 10 : 0);`),
    ).toBe(11);
  });

  it("§10.1.9.2 — [[Set]] of an index or `length` answers false / throws in strict code", async () => {
    expect(
      await runStandalone(`
var s = new String("str");
var r = 0;
if (!Reflect.set(s, "0", "x")) r += 1;
if (!Reflect.set(s, "length", 3)) r += 10;
if (Reflect.set(s, "4", 7) && s[4] === 7) r += 100;
try { (function () { "use strict"; s[0] = "x"; })(); } catch (e) { if (e instanceof TypeError) r += 1000; }
if (s[0] === "s" && s.length === 3) r += 10000;
__r = r;`),
    ).toBe(11111);
  });

  it("§10.4.3.2 — an incompatible define throws / answers false, a compatible one is a no-op", async () => {
    expect(
      await runStandalone(`
var s = new String("str");
var r = 0;
try { Object.defineProperty(s, "0", {value: "x"}); } catch (e) { if (e instanceof TypeError) r += 1; }
try { Object.defineProperty(s, "length", {value: 5}); } catch (e) { if (e instanceof TypeError) r += 10; }
if (!Reflect.defineProperty(s, "0", {configurable: true})) r += 100;
if (!Reflect.defineProperty(s, "1", {get: function () { return 1; }})) r += 1000;
if (Reflect.defineProperty(s, "0", {value: "s", writable: false, enumerable: true}) &&
    Reflect.defineProperty(s, "length", {value: 3})) r += 10000;
if (!Reflect.defineProperty(s, "length", {enumerable: true})) r += 100000;
__r = r;`),
    ).toBe(111111);
  });

  it("a trapless Proxy forwards [[Set]] / [[DefineOwnProperty]] onto the String wrapper", async () => {
    expect(
      await runStandalone(`
var s = new String("str");
var p = new Proxy(new Proxy(s, {}), {set: null});
p[4] = 1;
var r = s[4] === 1 ? 1 : 0;
if (!Reflect.set(p, "0", "s")) r += 10;
if (!Reflect.set(p, "length", 3)) r += 100;
var q = new Proxy(new Proxy(s, {}), {});
try { Object.defineProperty(q, "0", {value: "x"}); } catch (e) { if (e instanceof TypeError) r += 1000; }
__r = r;`),
    ).toBe(1111);
  });

  it("§10.1.9.2 / §7.3.5 — [[Set]] through a trapless Proxy onto a non-extensible array answers false", async () => {
    expect(
      await runStandalone(`
var a = [1, 2, 3];
var p = new Proxy(new Proxy(a, {}), {set: null});
p.length = 0;
var r = a.length === 0 ? 1 : 0;
Object.preventExtensions(a);
if (!Reflect.set(p, "foo", 2)) r += 10;
if (!Reflect.defineProperty(a, "bar", {value: 1})) r += 100;
try { (function () { "use strict"; p[0] = 3; })(); } catch (e) { if (e instanceof TypeError) r += 1000; }
var o = {x: 1}; Object.preventExtensions(o);
if (!Reflect.set(new Proxy(o, {}), "foo", 2)) r += 10000;
__r = r;`),
    ).toBe(11111);
  });

  itWithTest262(`test262 ${ROW} passes`, async () => {
    const r = await runTest262File(join(TEST262_ROOT, "test", ROW), "built-ins/Proxy", 60_000, "standalone");
    expect(r.status, (r as { error?: string }).error ?? "").toBe("pass");
  });
});
