// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 4 — a built-in method call on a DYNAMIC receiver
// (`x.toString()`, `list.join("-")`, `x.push(v)`, `f.call(t, a, b)`) lowers
// through the per-(method, arity) wrapper `__ir_dyn_mcall_<m>_<n>` on the
// host-free lanes. The wrapper reads the property once; a callable result (an
// own or inherited user method) is invoked with the receiver as `this`, an
// undefined one runs legacy's any-receiver brand dispatch (number, boolean,
// string, symbol, vec), anything else throws TypeError. Known limit: the
// brand arm re-reads the property, so an accessor whose getter answers
// undefined runs twice. Before it, #7110/#7117 kept these calls
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

  it("admits a wrapped carrier call in a closure that mints a carrier join (#7113's new shape)", async () => {
    // assert.compareArray's shape: the join makes the closure a new shape, where
    // #7113 refuses a GENERIC carrier method call (it answers a value where JS
    // throws); the wrapper throws, so a wrapped call is admitted.
    const members = `/** @returns {number} */ function subject() { return 0; }
subject.msg = function (message, expected) {
  message = message === undefined ? "" : message;
  if (message.toString() !== expected) throw "msg";
};
subject.label = function (message) {
  message = message === undefined ? "" : message;
  return message.label();
};`;
    const calls = [
      `subject.msg(undefined, "")`,
      `subject.msg(5, "5")`,
      `subject.msg(Symbol("s"), "Symbol(s)")`,
      `subject.msg([1, 2], "1,2")`,
    ];
    const throwing = `  var nullReceiver = 0;
  try { subject.msg(null, ""); } catch (e) { nullReceiver = e instanceof TypeError ? 1 : 2; }
`;
    const checks = [
      ...calls.map((call) => `(function () { try { ${call}; return true; } catch (e) { return false; } })()`),
      `nullReceiver === 1`,
    ];
    const source = program(members, checks, throwing);
    const expected = node(source);
    expect(expected).toBe(2 ** checks.length - 1);
    const result = await compileOn(source, "standalone", { deferTopLevelInit: true });
    expect(row(result, "<module-init>")?.irBodyEmitted).toBe(false);
    // A user method name stays the generic call, which #7113 still refuses there.
    const withoutLabel = source.replace(/subject\.label = [\s\S]*?\n\};/, "");
    const admitted = await compileOn(withoutLabel, "standalone", { deferTopLevelInit: true });
    expect(row(admitted, "<module-init>")?.irBodyEmitted).toBe(true);
    expect(admitted.wat ?? "").toContain("(func $__ir_dyn_mcall_toString_0 ");
    const instance = await instantiate(admitted, "standalone");
    (instance.exports.__module_init as () => void)();
    expect(wrong(checks, (instance.exports.run as () => number)(), expected)).toEqual([]);
  }, 60_000);

  it("throws TypeError for a non-callable or nullish receiver property and reads a getter once", async () => {
    // The getter is on `push`, not `join`: a `{ join: 1 }` literal in the same
    // module makes legacy's any-receiver read of an accessor `join` answer a
    // data slot (pre-existing, measured on the PR head as a silent wrong value).
    const body = `  var nonCallable = 0;
  try { join1({ join: 1 }); } catch (e) { nonCallable = e instanceof TypeError ? 1 : 2; }
  var nullReceiver = 0;
  try { join1(null); } catch (e) { nullReceiver = e instanceof TypeError ? 1 : 2; }
  var ownUndefined = 0;
  try { str0({ toString: undefined }); } catch (e) { ownUndefined = e instanceof TypeError ? 1 : 2; }
  var reads = 0;
  var viaGetter = { v: 7 };
  Object.defineProperty(viaGetter, "push", {
    get: function () { reads++; return function (x) { return this.v + x; }; },
  });
`;
    const checks = [
      `nonCallable === 1`,
      `nullReceiver === 1`,
      `ownUndefined === 1`,
      `push1(viaGetter) === 16 && reads === 1`,
      `join1([1, 2]) === "1-2"`,
      `str0(5) === "5"`,
      `push1(list) === 3`,
    ];
    const source = program(SUBJECTS, checks, body);
    const expected = node(source);
    expect(expected).toBe(2 ** checks.length - 1);
    for (const lane of ["standalone", "default"] as const) {
      const result = await compileOn(source, lane);
      for (const name of ["join1", "str0", "push1"]) expect(row(result, name)?.irBodyEmitted, name).toBe(true);
      const got = ((await instantiate(result, lane)).exports.run as () => number)();
      expect(wrong(checks, got, expected), lane).toEqual([]);
    }
  }, 90_000);

  it("refuses a spread call and an arity above the wrapper range at select; a `$` name is wrapped", async () => {
    const source = program(
      `function spread(o, a) { return o.slice(...a); }
function wide(o) { return o.slice(0, 1, 2, 3); }
function dollar(o) { return o.$m(1, 2); }`,
      [`dollar({ $m: function (a, b) { return a + b; } }) === 3`],
    );
    const result = await compileOn(source, "standalone");
    for (const name of ["spread", "wide"]) {
      expect(row(result, name), name).toMatchObject({ irBodyEmitted: false, stage: "select" });
    }
    expect(row(result, "dollar")?.irBodyEmitted).toBe(true);
    const wat = result.wat ?? "";
    expect(wat).not.toContain("__ir_dyn_mcall_slice_");
    expect(wat).toContain("(func $__ir_dyn_mcall_$m_2 ");
    expect(((await instantiate(result, "standalone")).exports.run as () => number)()).toBe(1);
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
