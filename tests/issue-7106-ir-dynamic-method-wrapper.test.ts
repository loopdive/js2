// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 4 — a built-in method call on a DYNAMIC receiver
// (`x.toString()`, `list.join("-")`, `x.push(v)`, `f.call(t, a, b)`) lowers
// through the per-(method, arity) wrapper `__ir_dyn_mcall_<m>_<n>` on the
// host-free lanes. The wrapper performs the call's single [[Get]]; a callable
// result (an own or inherited user method) is invoked with the receiver as
// `this`, otherwise legacy's own any-receiver brand dispatch runs (number,
// boolean, string, symbol, vec). Before it, #7110/#7117 kept these calls
// legacy, because the generic `__extern_method_call` answers `undefined` for
// primitive and vec receivers off the host lane.
//
// Every program is also run under node and must agree, and every subject must
// be an IR body that calls the wrapper.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

type Lane = "standalone" | "default";

function node(source: string): number {
  return new Function(`"use strict";\n${source.replace(/\bexport /g, "")}\nreturn run();`)() as number;
}

function row(result: CompileResult, name: string) {
  return (result.irOutcomes ?? []).find((entry) => entry.displayName === name);
}

async function compileOn(source: string, lane: Lane, extra: Record<string, unknown> = {}) {
  const result = await compile(source, {
    fileName: "test.js",
    allowJs: true,
    ...(lane === "standalone" ? { target: "standalone" } : {}),
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    ...extra,
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function instantiate(result: CompileResult, lane: Lane): Promise<WebAssembly.Instance> {
  const imports = (lane === "standalone" ? {} : result.importObject) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (result.importObject as { setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.setInstance?.(instance);
  return instance;
}

/** Each check is a boolean expression; `run()` sets bit i when check i holds. */
function program(prelude: string, checks: readonly string[], body = ""): string {
  return `${prelude}
export function run() {
  var n = 0;
  var list = [1, 2];
${body}${checks.map((check, i) => `  if (${check}) n += ${2 ** i};`).join("\n")}
  return n;
}`;
}

function wrong(checks: readonly string[], got: number, expected: number): string[] {
  return checks.filter((_, i) => (expected & (2 ** i)) !== 0 && (got & (2 ** i)) === 0);
}

const SUBJECTS = `function str0(x) { return x.toString(); }
function join1(x) { return x.join("-"); }
function push1(x) { return x.push(9); }
function slice2(x) { return x.slice(1, 3); }
function call3(f, t) { return f.call(t, 2, 3); }
function Box(v) { this.v = v; }
Box.prototype.toString = function () { return "Box(" + this.v + ")"; };
Box.prototype.join = function (s) { return "J" + s + this.v; };
Box.prototype.push = function (v) { this.v = this.v + v; return this.v; };
Box.prototype.slice = function (a, b) { return this.v * 100 + a * 10 + b; };
function Plain(v) { this.v = v; }
function gTop(a, b) { return this.k + a * b; }
gTop.extra = 1;
function hTop(a, b) { return a + b; }`;

const CHECKS = [
  // toString across brands
  `str0(5) === "5"`,
  `str0(2.5) === "2.5"`,
  `str0(true) === "true"`,
  `str0("ab") === "ab"`,
  `str0(Symbol("s")) === "Symbol(s)"`,
  `str0([1, 2]) === "1,2"`,
  `str0({ a: 1 }) === "[object Object]"`,
  `str0({ toString: function () { return "own"; } }) === "own"`,
  `str0(new Box(3)) === "Box(3)"`,
  `str0(new Plain(3)) === "[object Object]"`,
  // join: vec (legacy's generic algorithm), own method, constructor prototype
  `join1([1, 2, 3]) === "1-2-3"`,
  `join1({ join: function (s) { return s + s; } }) === "--"`,
  `join1(new Box(4)) === "J-4"`,
  // push: vec (mutates the caller's vec), own method, constructor prototype
  `push1(list) === 3 && list.length === 3 && list[2] === 9`,
  `push1({ v: 1, push: function (v) { return this.v + v; } }) === 10`,
  `push1(new Box(1)) === 10`,
  // a two-argument built-in: string, vec, constructor prototype
  `slice2("hello") === "el"`,
  `String(slice2([1, 2, 3, 4])) === "2,3"`,
  `slice2(new Box(4)) === 413`,
  // Function.prototype.call on a closure receiver, three arguments
  `call3(function (a, b) { return this.k + a * b; }, { k: 1 }) === 7`,
  `call3(function (a, b) { return this.v + a + b; }, new Box(2)) === 7`,
  // … and on function-object receivers: a declaration with an expando, a bare one
  `call3(gTop, { k: 2 }) === 8`,
  `call3(hTop, null) === 5`,
] as const;

const SOURCE = program(SUBJECTS, CHECKS);
const WRAPPED = ["str0", "join1", "push1", "slice2", "call3"] as const;

describe("#7106 Stage 4 — the dynamic method-call brand-dispatch wrapper", () => {
  it("node agrees with every expectation (the fixture is honest)", () => {
    expect(wrong(CHECKS, node(SOURCE), 2 ** CHECKS.length - 1)).toEqual([]);
  });

  for (const lane of ["standalone", "default"] as const) {
    it(`top-level IR bodies call the wrapper and match node on the ${lane} lane`, async () => {
      const result = await compileOn(SOURCE, lane);
      for (const name of WRAPPED) expect(row(result, name)?.irBodyEmitted, name).toBe(true);
      const wat = result.wat ?? "";
      for (const helper of [
        "__ir_dyn_mcall_toString_0",
        "__ir_dyn_mcall_join_1",
        "__ir_dyn_mcall_push_1",
        "__ir_dyn_mcall_slice_2",
        "__ir_dyn_mcall_call_3",
      ]) {
        expect(wat, helper).toContain(`(func $${helper} `);
      }
      // The wrapper's parameters and result are the dynamic carrier (externref).
      const typeIndex = Number(/\(func \$__ir_dyn_mcall_call_3 \(type (\d+)\)/.exec(wat)?.[1]);
      const typeDecls = wat.split("\n").filter((line) => /^\s*\(type \$/.test(line));
      expect(typeDecls[typeIndex]).toContain(
        "(func (param externref externref externref externref) (result externref))",
      );
      const expected = node(SOURCE);
      const got = ((await instantiate(result, lane)).exports.run as () => number)();
      expect(wrong(CHECKS, got, expected)).toEqual([]);
    }, 60_000);
  }

  it("lowers a planned member closure's dynamic method calls in <module-init>", async () => {
    // The harness shape (assert.js / compareArray.js): void member closures on
    // a function object, whose dynamic parameters are the receivers.
    const members = `/** @returns {number} */ function subject() { return 0; }
subject.str = function (x, expected) { if (x.toString() !== expected) throw "str"; };
subject.join = function (x, s, expected) { if (x.join(s) !== expected) throw "join"; };
subject.push = function (x, v, expected) { if (x.push(v) !== expected) throw "push"; };
subject.invoke = function (f, t, a, b, expected) { if (f.call(t, a, b) !== expected) throw "call"; };
subject.slice = function (x, a, b, expected) { if (x.slice(a, b).toString() !== expected) throw "slice"; };`;
    const calls = [
      `subject.str(5, "5")`,
      `subject.str(true, "true")`,
      `subject.str("ab", "ab")`,
      `subject.str(Symbol("s"), "Symbol(s)")`,
      `subject.str([1, 2], "1,2")`,
      `subject.str({ a: 1 }, "[object Object]")`,
      `subject.str({ toString: function () { return "own"; } }, "own")`,
      `subject.join([1, 2, 3], "-", "1-2-3")`,
      `subject.join({ v: 4, join: function (s) { return "J" + s + this.v; } }, "+", "J+4")`,
      `subject.push(list, 9, 3)`,
      `subject.str(list, "1,2,9")`,
      `subject.push({ v: 1, push: function (v) { this.v = this.v + v; return this.v; } }, 5, 6)`,
      `subject.invoke(function (a, b) { return this.k + a * b; }, { k: 1 }, 2, 3, 7)`,
      `subject.slice("hello", 1, 3, "el")`,
      `subject.slice([1, 2, 3, 4], 1, 3, "2,3")`,
    ];
    const source = `${members}
export function run() {
  var n = 0;
  var list = [1, 2];
${calls.map((call, i) => `  try { ${call}; n += ${2 ** i}; } catch (e) { n += 0; }`).join("\n")}
  return n;
}`;
    expect(node(source)).toBe(2 ** calls.length - 1);
    const result = await compileOn(source, "standalone", { deferTopLevelInit: true });
    expect(row(result, "<module-init>")?.irBodyEmitted).toBe(true);
    expect(result.wat ?? "").toContain("(func $__ir_dyn_mcall_join_1 ");
    const instance = await instantiate(result, "standalone");
    (instance.exports.__module_init as () => void)();
    const got = (instance.exports.run as () => number)();
    expect(wrong(calls, got, node(source))).toEqual([]);
  }, 60_000);

  it("keeps a user method name with at most one argument on the generic open-$Object call", async () => {
    const source = program(`function label(o) { return o.label(); }`, [
      `label({ label: function () { return "a"; } }) === "a"`,
      `label({ x: 1, label: function () { return "b"; } }) === "b"`,
    ]);
    const result = await compileOn(source, "standalone");
    expect(row(result, "label")?.irBodyEmitted).toBe(true);
    expect(result.wat ?? "").not.toContain("__ir_dyn_mcall_label");
    expect(((await instantiate(result, "standalone")).exports.run as () => number)()).toBe(3);
  }, 60_000);

  it("routes a wider user method call through the wrapper", async () => {
    const source = program(
      `function add(o) { return o.add(2, 3); }
function Acc(v) { this.v = v; }
Acc.prototype.add = function (a, b) { return this.v + a + b; };`,
      [`add({ add: function (a, b) { return a * b; } }) === 6`, `add(new Acc(10)) === 15`],
    );
    const result = await compileOn(source, "standalone");
    expect(row(result, "add")?.irBodyEmitted).toBe(true);
    expect(result.wat ?? "").toContain("(func $__ir_dyn_mcall_add_2 ");
    expect(((await instantiate(result, "standalone")).exports.run as () => number)()).toBe(node(source));
  }, 60_000);
});
