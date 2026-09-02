// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5268) ES2015 standalone Array + Object built-ins — r2 residual pass.
 *
 * One `describe` per landed step of the issue's implementation plan. Every pin
 * EXECUTES the operation it guards through the module's own `__stdout_*`
 * channel (#3469) — a standalone module cannot hand a string to the host any
 * other way — and every pin was verified RED on the pre-change tree.
 *
 * `runLines` asserts `result.imports` is EMPTY on every compile: the standalone
 * lane's host-import leak scan (#2961, `tests/test262-runner.ts`) fails any
 * module that emits an `env::` import, so a step that "fixes" a row by adding
 * one has not fixed it.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile `body` as a standalone module and return the lines it printed.
 * `LOG(s)` is `console.log`; a module-level throw is reported as a trailing
 * `THREW` line so a pin can assert on a refusal without decoding a Wasm-GC
 * exception payload.
 */
async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5268-es2015-array-object-r2.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  let threw = false;
  try {
    exports.__module_init!();
  } catch {
    threw = true;
  }
  const length = exports.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < length; i++) sink += String.fromCharCode(exports.__stdout_char!(i) & 0xffff);
  const lines = sink.split("\n").filter((l) => l.length > 0);
  if (threw) lines.push("THREW");
  return lines;
}

describe("#5268 step 1 — Object.prototype.__proto__ accessor pair (standalone)", () => {
  it("gOPD(Object.prototype, '__proto__') is an accessor pair with the §17 names", async () => {
    // RED on base: the descriptor is `undefined`, so `desc.get` throws
    // "Cannot access property on null or undefined".
    const lines = await runLines(`
      var desc = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
      LOG("value=" + (desc.value === undefined));
      LOG("get=" + (typeof desc.get));
      LOG("set=" + (typeof desc.set));
      LOG("getName=" + desc.get.name);
      LOG("setName=" + desc.set.name);
      LOG("getLength=" + desc.get.length);
      LOG("setLength=" + desc.set.length);
      LOG("enumerable=" + desc.enumerable);
      LOG("configurable=" + desc.configurable);
    `);
    expect(lines).toEqual([
      "value=true",
      "get=function",
      "set=function",
      "getName=get __proto__",
      "setName=set __proto__",
      "getLength=0",
      "setLength=1",
      "enumerable=false",
      "configurable=true",
    ]);
  });

  it("the reflective getter reads [[GetPrototypeOf]] and throws for nullish `this`", async () => {
    // RED on base: the descriptor read itself throws.
    const lines = await runLines(`
      var get = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__").get;
      var proto = {};
      var withCustomProto = Object.create(proto);
      var withNullProto = Object.create(null);
      LOG("custom=" + (get.call(withCustomProto) === proto));
      LOG("null=" + (get.call(withNullProto) === null));
      var verdict = "no-throw";
      try { get.call(undefined); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("undef=" + verdict);
      verdict = "no-throw";
      try { get.call(null); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("nul=" + verdict);
    `);
    expect(lines).toEqual(["custom=true", "null=true", "undef=TypeError", "nul=TypeError"]);
  });

  it("the reflective setter ignores a non-Object proto and a non-Object receiver", async () => {
    // §B.2.2.1.2 steps 2/3 — both return undefined WITHOUT a write and WITHOUT
    // a throw. RED on base: the descriptor read throws first.
    const lines = await runLines(`
      var set = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__").set;
      var proto = {};
      var subject = Object.create(proto);
      LOG("bool=" + set.call(subject, true));
      LOG("num=" + set.call(subject, 1));
      LOG("str=" + set.call(subject, "string"));
      LOG("kept=" + (Object.getPrototypeOf(subject) === proto));
      LOG("primThis=" + set.call(true));
      var verdict = "no-throw";
      try { set.call(undefined); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("nullish=" + verdict);
    `);
    expect(lines).toEqual([
      "bool=undefined",
      "num=undefined",
      "str=undefined",
      "kept=true",
      "primThis=undefined",
      "nullish=TypeError",
    ]);
  });

  it("the syntactic `o.__proto__ = v` form throws on a refused [[SetPrototypeOf]]", async () => {
    // §B.2.2.1.2 step 5. RED on base: `__object_setPrototypeOf` is deliberately
    // a silent no-op for a cycle, so no exception was thrown at all.
    const lines = await runLines(`
      var root = {};
      var intermediary = Object.create(root);
      var leaf = Object.create(intermediary);
      var verdict = "no-throw";
      try { root.__proto__ = leaf; } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("cycle=" + verdict);
    `);
    expect(lines).toEqual(["cycle=TypeError"]);
  });

  it("%Object.prototype% is an immutable-prototype exotic object (§10.4.7)", async () => {
    // RED on base: both the throw and the `false` were a silent success/`true`.
    const lines = await runLines(`
      var ObjProto = Object.prototype;
      var verdict = "no-throw";
      try { Object.setPrototypeOf(ObjProto, {}); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("obj=" + verdict);
      verdict = "no-throw";
      try { Object.setPrototypeOf(ObjProto, ObjProto); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("self=" + verdict);
      LOG("reflect=" + Reflect.setPrototypeOf(ObjProto, {}));
    `);
    expect(lines).toEqual(["obj=TypeError", "self=TypeError", "reflect=false"]);
  });
});
