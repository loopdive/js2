// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7377 (#7354 O5) — for-in over a dynamic receiver on the Prepared path, script-level heads. A `var` head is a
// script var under the Prepared producer's script-var model, and an identifier head writes its script var; either
// way each key lands in the binding, so a read after the loop, a write in the body and a closure all see the binding
// itself. The keys are the realm's EnumerateObjectProperties snapshot (`js.object.for-in-keys`,
// src/runtime/wasmgc/values/own-key-walk-bodies.ts). Programs batch their checks into `out`; node computes the
// answer, the Prepared program asserts it and a wrong one (helpers/prepared-node-agreement.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import { createEmptyModule } from "../src/ir/types.js";
import {
  argumentVectorElement,
  argumentVectorLength,
  buildArgumentVectorNewBody,
  buildArgumentVectorPushBody,
  buildArgumentVectorPushLocals,
  createArgumentVectorArrayType,
} from "../src/runtime/wasmgc/values/argument-vector-bodies.js";
import {
  buildForInKeysDefinition,
  eachOwnKey,
  type ForInKeysOperands,
} from "../src/runtime/wasmgc/values/own-key-walk-bodies.js";
import { isModuleInitVarList, type ScriptVarModel } from "../src/shared/var-declaration-lists.js";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { ts } from "../src/ts-api.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  abortBodies,
  abortsAtRunTime,
  agreesWithNode,
  refusal,
  runnerOptions,
} from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;

describe("#7377 — for-in over a dynamic receiver, script-level heads", () => {
  it.each([
    [
      // [[OwnPropertyKeys]]: array indices ascending, then strings in insertion order.
      "visits keys in own-key order; a var head, an identifier head, a body write and a closure see the binding",
      [
        "var o = { b: 1, 2: 1, a: 1, 1: 1 }; var out = '';",
        "for (var k in o) out += k + ',';",
        "out += '|' + k;",
        "var j; for (j in o) {} function last() { return j; } var t = last(); out += '|' + t;",
        "var w = ''; var seen = ''; for (w in o) { seen += w; w = w + '!'; } out += '|' + seen + '|' + w;",
        "var f = null; for (var c in o) { f = function () { return c; }; } out += '|' + f();",
      ].join("\n"),
    ],
    [
      // A non-enumerable own key is skipped and hides an enumerable inherited one of its name.
      "skips non-enumerable keys and walks the prototype chain with shadowing",
      [
        "var out = '';",
        "var o = { a: 1 }; Object.defineProperty(o, 'h', { value: 1, enumerable: false }); o.z = 2;",
        "for (var k in o) out += k;",
        "var p = { x: 1, y: 2 }; var q = Object.create(p);",
        "Object.defineProperty(q, 'y', { value: 1, enumerable: false }); q.z = 3;",
        "out += '|'; for (var m in q) out += m;",
        "var r = Object.create(p, { w: { value: 1, enumerable: true }, v: { value: 1 } });",
        "out += '|'; for (var n in r) out += n;",
      ].join("\n"),
    ],
    [
      // §14.7.5.6 step 6.b; a key added during iteration is not visited (the snapshot, which §14.7.5.9 allows).
      "runs no iteration for null and undefined, and skips a key added during the loop",
      [
        "var out = ''; var u = null; var v = undefined; var count = 0;",
        "for (var k in u) count++; for (var k2 in v) count++; out += count;",
        "var o = { a: 1 }; for (var m in o) { out += m; o.b = 1; } out += '|' + m;",
      ].join("\n"),
    ],
  ])("%s", (_label, body) => agreesWithNode(body, true, runnerOptions()), SLOW);
});

// (R5) `delete` has no lowering on the path yet (pinned below), so no program can remove a key mid-loop: the order is
// pinned on the module-init's code instead. The loop tests liveness, and only its live branch writes the script var.
describe("#7377 — the head is written after the liveness test", () => {
  it(
    "writes the script var only in the live branch",
    async () => {
      const result = await compile("var o = { a: 1 }; for (var k in o) {}", { ...runnerOptions(), emitWat: true });
      expect(result.errors.map((error) => error.message)).toEqual([]);
      const wat = result.wat ?? "";
      const init = wat.slice(
        wat.indexOf("(func $<module-init>"),
        wat.indexOf("\n  (func", wat.indexOf("(func $<module-init>") + 1),
      );
      const loop = init.slice(init.indexOf("(loop"));
      const [beforeLive, live] = [loop.slice(0, loop.indexOf("(if")), loop.slice(loop.indexOf("(if"))];
      // The liveness call decides the branch; nothing is stored before it.
      expect(beforeLive).toMatch(/call \d+\s*$/);
      expect(beforeLive).not.toContain("global.set");
      expect(live).toMatch(/^\(if\s+\(then\s+local\.get \d+\s+global\.set \d+/);
    },
    SLOW,
  );
});

describe("#7377 — the run-time abort for a primitive receiver", () => {
  // EnumerateObjectProperties of a primitive needs ToObject and the wrapper's keys; the snapshot aborts, never
  // answering an empty list.
  it.each([
    ["a number", "var x = 5;"],
    ["a Boolean", "var x = true;"],
    ["a string", "var x = 'ab';"],
  ])("aborts for %s", (_label, setup) => abortsAtRunTime(`${setup} for (var k in x) {}`, runnerOptions()), SLOW);
});

describe("#7377 — refusals by name", () => {
  it.each([
    ["a member head", "var o = { a: 1 }; var t = {}; for (t.p in o) {}", "for-in head is not an identifier"],
    ["a destructuring head", "var o = { ab: 1 }; var a; for ([a] in o) {}", "for-in head is not an identifier"],
    [
      "a destructuring var head (no script var)",
      "var o = { ab: 1 }; for (var [a] in o) {}",
      "module-init unit contains a nested var declaration",
    ],
    ["a let head", "var o = { a: 1 }; for (let k in o) {}", 'for-in head "k" declares no script var'],
    // (N3) An undeclared head would be an implicit global: never the loop's private slot.
    ["an undeclared head", "var o = { a: 1 }; for (k in o) {}", 'assignment to undeclared identifier "k"'],
    // R5 pin: `delete` has no lowering on this path yet, so the deleted-key case cannot run.
    ["a delete in the body", "var o = { a: 1, b: 2 }; for (var k in o) { delete o.b; }", "delete has no IR lowering"],
    // R1 pin: a Symbol-keyed descriptor cannot be named here, so the walk's Symbols are pinned on a kernel fixture.
    [
      "a Symbol-keyed defineProperties",
      "var p = {}; Object.defineProperty(p, Symbol.iterator, { value: { value: 1 }, enumerable: true }); " +
        "var o = Object.defineProperties({}, p);",
      'identifier "Symbol" is not in scope',
    ],
  ])(
    "refuses %s",
    async (_label, source, text) => expect(await refusal(source, runnerOptions())).toContain(text),
    SLOW,
  );

  // (R4, N3) A function's head would need the function's `var` hoisting: its body is the run-time abort, whatever the
  // head (a `var`, or an identifier naming a declared local).
  it.each([
    ["a var head", "function f() { var o = { a: 1 }; for (var k in o) {} return 1; }"],
    ["an identifier head", "function f() { var k; var o = { a: 1 }; for (k in o) {} return k; }"],
  ])(
    "refuses %s in a function",
    async (_label, source) =>
      expect(await abortBodies(`${source} var out = typeof f;`)).toEqual([
        "f: ir/from-ast: for-in head in a function: function `var` hoisting is not modelled on the Prepared path (f)",
      ]),
    SLOW,
  );
});

describe("#7377 — the script-var model", () => {
  /** Every `var` list of `source`, with each model's answer. */
  function answers(source: string): { text: string; forInHead: boolean; answer: Record<ScriptVarModel, boolean> }[] {
    const file = ts.createSourceFile("m.js", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const rows: { text: string; forInHead: boolean; answer: Record<ScriptVarModel, boolean> }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclarationList(node))
        rows.push({
          text: node.getText(),
          forInHead: ts.isForInStatement(node.parent) && node.parent.initializer === node,
          answer: {
            "statement-and-for-heads": isModuleInitVarList(node, "statement-and-for-heads"),
            "with-for-in-heads": isModuleInitVarList(node, "with-for-in-heads"),
          },
        });
      node.forEachChild(visit);
    };
    visit(file);
    return rows;
  }
  const SOURCE = [
    "var a = 1; let b = 2; const c = 3;",
    "if (a) { var d; for (var i = 0; i < 1; i++) {} }",
    "for (var k in o) {} for (let l in o) {} for (var [p] in o) {} for (var m = 1 in o) {}",
    "for (var e of o) {} label: for (var n in o) {}",
    "function f() { var g; for (var h in o) {} }",
    "with (o) { var q; for (var r in o) {} }",
    "try {} catch (s) { var s; for (var s in o) {} }",
  ].join("\n");

  it("answers alike on every list that is not a for-in head", () => {
    const rows = answers(SOURCE).filter((row) => !row.forInHead);
    expect(rows.length).toBeGreaterThan(8);
    for (const row of rows)
      expect(row.answer["with-for-in-heads"], row.text).toBe(row.answer["statement-and-for-heads"]);
  });

  it("admits a for-in head only under the Prepared model, and only a plain script-level one", () => {
    const heads = answers(SOURCE).filter((row) => row.forInHead);
    for (const row of heads) expect(row.answer["statement-and-for-heads"], row.text).toBe(false);
    expect(heads.filter((row) => row.answer["with-for-in-heads"]).map((row) => row.text)).toEqual(["var k", "var n"]);
  });
});

/**
 * A kernel fixture for the realm's walk and snapshot: an object is a struct whose field 0 is its [[Prototype]] and
 * field 4 its flags (the realm's `$Object` layout); a string key is one struct type, a Symbol another; `ownKeys` and
 * `ownDescriptor` answer from a JS table, building the key list with the fixture's own argument-vector functions.
 */
function fixture() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ext = { kind: "externref" } as const,
    i32 = { kind: "i32" } as const;
  const string = tx.reserveType("str", {
    kind: "struct",
    name: "$Str",
    fields: [{ name: "n", type: i32, mutable: false }],
  });
  const symbol = tx.reserveType("sym", {
    kind: "struct",
    name: "$Sym",
    fields: [{ name: "n", type: { kind: "f64" }, mutable: false }],
  });
  const object = tx.reserveType("obj", {
    kind: "struct",
    name: "$Obj",
    fields: [
      { name: "proto", type: { kind: "anyref" }, mutable: true },
      ...[1, 2, 3].map((n) => ({ name: `pad${n}`, type: i32, mutable: false })),
      { name: "flags", type: i32, mutable: false },
    ],
  });
  const array = tx.reserveType("vecarr", createArgumentVectorArrayType());
  const vector = tx.reserveType("vec", {
    kind: "struct",
    name: "$ObjVec",
    fields: [
      { name: "length", type: i32, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: array.typeIndex }, mutable: true },
    ],
  });
  const imported = (name: string, params: readonly { kind: string }[], results: readonly { kind: string }[]) =>
    tx.reserveFunctionImport(`kernel:${name}`, "kernel", name, { params, results } as never);
  const ownKeys = imported("ownKeys", [ext], [ext]);
  const ownDescriptor = imported("ownDescriptor", [ext, ext], [i32, i32, ext, ext, ext]);
  const sameValue = imported("sameValue", [ext, ext], [i32]);
  const match = imported("match", [ext], [i32]);
  const getPrototypeOf = imported("getPrototypeOf", [ext], [ext]);
  const initializer = imported("initializer", [], []);
  const define = (name: string, params: readonly { kind: string }[], results: readonly { kind: string }[]) =>
    tx.reserveFunction(`fixture:${name}`, name, { params, results } as never);
  const newVector = define("newVector", [], [ext]);
  const push = define("push", [ext, ext], []);
  const forIn = define("forIn", [ext], [ext]);
  const walk = define("walk", [ext], [ext]);
  const length = define("length", [ext], [i32]);
  const element = define("element", [ext, i32], [ext]);
  const makers = {
    str: define("str", [i32], [ext]),
    sym: define("sym", [i32], [ext]),
    obj: define("obj", [ext, i32], [ext]),
  };
  const undefinedGlobal = tx.reserveGlobal("undefined", "undefined", { kind: "anyref" }, false);
  const objectPrototype = tx.reserveGlobal("objectPrototype", "objectPrototype", ext, false);
  tx.freezeReservations();
  const layout = { objVecArrTypeIdx: array.typeIndex, objVecTypeIdx: vector.typeIndex };
  const types = { vectorTypeIdx: vector.typeIndex, vectorArrayTypeIdx: array.typeIndex };
  const d = {
    ...types,
    ownKeys: ownKeys.handle,
    ownDescriptor: ownDescriptor.handle,
    sameValue: sameValue.handle,
    match: match.handle,
    getPrototypeOf: getPrototypeOf.handle,
    initializer: initializer.handle,
    newVector: newVector.handle,
    push: push.handle,
    objectTypeIdx: object.typeIndex,
    anyStrTypeIdx: string.typeIndex,
    objectPrototype: tx.physicalIndex(objectPrototype),
    undefinedGlobal: tx.physicalIndex(undefinedGlobal),
  } as unknown as ForInKeysOperands;
  const get = (index: number): Instr => ({ op: "local.get", index });
  tx.fillGlobal(undefinedGlobal, [
    { op: "i32.const", value: -1 },
    { op: "struct.new", typeIdx: string.typeIndex },
  ]);
  tx.fillGlobal(objectPrototype, [{ op: "ref.null.extern" }]);
  tx.fillFunction(newVector, { locals: [], body: buildArgumentVectorNewBody(layout) });
  tx.fillFunction(push, { locals: buildArgumentVectorPushLocals(layout), body: buildArgumentVectorPushBody(layout) });
  tx.fillFunction(forIn, buildForInKeysDefinition(d));
  // Every own key with its attribute word, in walk order: the walk's own pin.
  tx.fillFunction(walk, {
    locals: [
      { name: "list", type: ext },
      { name: "keys", type: ext },
      { name: "index", type: i32 },
      { name: "key", type: ext },
      { name: "word", type: i32 },
    ],
    body: [
      { op: "call", funcIdx: newVector.handle },
      { op: "local.set", index: 1 },
      ...eachOwnKey(d, [get(0)], { keys: 2, index: 3, key: 4, word: 5 }, [
        get(1),
        get(4),
        { op: "call", funcIdx: push.handle },
      ]),
      get(1),
    ],
  });
  tx.fillFunction(length, { locals: [], body: argumentVectorLength(types, [get(0)]) });
  tx.fillFunction(element, { locals: [], body: argumentVectorElement(types, [get(0)], [get(1)]) });
  const box = (typeIdx: number, operands: Instr[]) => ({
    locals: [],
    body: [...operands, { op: "struct.new", typeIdx } as Instr, { op: "extern.convert_any" } as Instr],
  });
  tx.fillFunction(makers.str, box(string.typeIndex, [get(0)]));
  tx.fillFunction(makers.sym, box(symbol.typeIndex, [get(0), { op: "f64.convert_i32_s" }]));
  tx.fillFunction(
    makers.obj,
    box(object.typeIndex, [
      get(0),
      { op: "any.convert_extern" },
      ...[1, 2, 3].map((): Instr => ({ op: "i32.const", value: 0 })),
      get(1),
    ]),
  );
  for (const [name, token] of Object.entries({ forIn, walk, length, element, newVector, push, ...makers }))
    tx.defineExport(`export:${name}`, name, token);
  tx.seal();

  type Fn = (...args: unknown[]) => unknown;
  /** Each object's own keys in order, with their attribute word. */
  const table = new Map<unknown, [unknown, number][]>();
  let exports: Record<string, Fn> = {};
  const instance = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(module) as BufferSource), {
    kernel: {
      ownKeys: (target: unknown) => {
        const list = exports.newVector!();
        for (const [key] of table.get(target) ?? []) exports.push!(list, key);
        return list;
      },
      ownDescriptor: (target: unknown, key: unknown) => {
        const word = table.get(target)?.find(([own]) => own === key)?.[1];
        return [word === undefined ? 0 : 1, word ?? 0, null, null, null];
      },
      sameValue: (left: unknown, right: unknown) => (left === right ? 1 : 0),
      match: () => 0,
      getPrototypeOf: () => {
        throw new Error("no function objects in the fixture");
      },
      initializer: () => {},
    },
  });
  exports = instance.exports as unknown as Record<string, Fn>;
  const list = (vector: unknown): unknown[] =>
    Array.from({ length: exports.length!(vector) as number }, (_, i) => exports.element!(vector, i));
  return { exports, table, list };
}

describe("#7377 — the own-key walk and the for-in snapshot on a kernel fixture", () => {
  const ENUMERABLE = 2;
  const EXPLICIT_NULL_PROTOTYPE = 128;
  const { exports, table, list } = fixture();
  const [a, h, x, y] = [1, 2, 3, 4].map((n) => exports.str!(n));
  const symbol = exports.sym!(5);
  const parent = exports.obj!(null, EXPLICIT_NULL_PROTOTYPE);
  const child = exports.obj!(parent, 0);
  table.set(parent, [
    [h, ENUMERABLE],
    [x, ENUMERABLE],
    [y, 0],
  ]);
  table.set(child, [
    [a, ENUMERABLE],
    [symbol, ENUMERABLE],
    [h, 0],
  ]);

  // (R1) The walk is descriptors-define's too: it yields every own key, Symbols included, in the kernel's order.
  it("walks every own key in order, Symbols included", () => {
    expect(list(exports.walk!(child))).toEqual([a, symbol, h]);
  });

  // Symbols skipped (§14.7.5.9); the non-enumerable own `h` hides the parent's enumerable one; `y` not enumerable.
  it("lists the enumerable string keys along the chain, each name once", () => {
    expect(list(exports.forIn!(child))).toEqual([a, x]);
    expect(list(exports.forIn!(parent))).toEqual([h, x]);
  });

  it("lists nothing for null and undefined, and aborts for any other carrier", () => {
    expect(list(exports.forIn!(null))).toEqual([]);
    expect(() => exports.forIn!(a)).toThrow(WebAssembly.RuntimeError);
    expect(() => exports.forIn!(symbol)).toThrow(WebAssembly.RuntimeError);
  });

  // A null link the kernel has not settled (no explicit-null flag) is not the end of the chain.
  it("aborts at an unsettled end of the chain", () => {
    const orphan = exports.obj!(null, 0);
    table.set(orphan, [[a, ENUMERABLE]]);
    expect(() => exports.forIn!(orphan)).toThrow(WebAssembly.RuntimeError);
  });
});
