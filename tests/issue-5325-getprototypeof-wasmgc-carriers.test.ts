// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5325 — `Object.getPrototypeOf(<receiver that reaches the host as a WasmGC
// carrier>)` must answer the carrier's real built-in prototype.
//
// Codegen folds `Object.getPrototypeOf` at compile time whenever the ARGUMENT
// SHAPE identifies the receiver (`new Date()`, an array literal, a `ctx.classSet`
// instance …). A receiver that arrives through a call boundary — a plain
// parameter, i.e. every `isPlainObject(value)`-style guard in real npm code —
// matches none of those arms and falls through to the `__getPrototypeOf` host
// import, where the only two answers were:
//
//   `__is_data_struct(obj) === 1` → `%Object.prototype%`   (so a Date)
//   otherwise the native walk     → `null`                 (so an Array, a fn)
//
// Both are wrong, and both are invisible until something WALKS the chain. Redux
// 5's `isPlainObject` walks to the terminal and then compares
// `getPrototypeOf(obj) === terminal || getPrototypeOf(obj) === null`, so a Date
// took the first disjunct and an Array the second: `isPlainObject` answered TRUE
// for everything. A second hop off the array threw "Cannot convert null to
// object".
//
// The fixtures are untyped `.js` in a two-file project on purpose: an annotated
// parameter and a single-source graph are both still routed through the same
// fallback, but untyped multi-source is the shape real packages present, and it
// keeps the test honest about which arm it exercises.
//
// ONE DOCUMENTED RESIDUAL, asserted below so it cannot move silently. (The
// second one this file shipped with — a compiled CLASS INSTANCE answering
// `%Object.prototype%` — was closed by #5347's `__class_instance_proto`
// discriminator, and its two assertions now read the other way.)
//
//  - `Object.setPrototypeOf` on an ARRAY literal never reaches
//    `__host_set_struct_proto`, so no explicit link is recorded for the vec and
//    the new vec arm answers `Array.prototype`. That is not the assigned
//    prototype — but neither was the `null` it answered before.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(join(tmpdir(), "js2-5325-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return compileProject(join(root, entry), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
}

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

// The dependency is the whole point of the second file: it puts the entry in the
// multi-source lane without contributing anything to the query under test.
const DEP = `
export function identity(v) { return v; }
`;

const ENTRY = `
import { identity } from './dep.js';

// Redux 5's src/utils/isPlainObject.js, verbatim in shape.
function isPlainObject(obj) {
  if (typeof obj !== 'object' || obj === null) return false;
  let proto = obj;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return Object.getPrototypeOf(obj) === proto || Object.getPrototypeOf(obj) === null;
}

function protoIsObjectPrototype(v) { return Object.getPrototypeOf(v) === Object.prototype; }
function protoIsNull(v) { return Object.getPrototypeOf(v) === null; }
function protoIsArrayPrototype(v) { return Object.getPrototypeOf(v) === Array.prototype; }
function protoIsDatePrototype(v) { return Object.getPrototypeOf(v) === Date.prototype; }
function protoIsFunctionPrototype(v) { return Object.getPrototypeOf(v) === Function.prototype; }

class Action { constructor() { this.type = 'x'; } }

export function plainForLiteral() { return isPlainObject(identity({ a: 1 })) ? 1 : 0; }
export function plainForNullProto() { return isPlainObject(Object.create(null)) ? 1 : 0; }
export function plainForDate() { return isPlainObject(identity(new Date())) ? 1 : 0; }
export function plainForArray() { return isPlainObject(identity([1, 2, 3])) ? 1 : 0; }
export function plainForFunction() { return isPlainObject(identity(function q() { return 1; })) ? 1 : 0; }

export function dateProtoIsObjectProto() { return protoIsObjectPrototype(new Date()) ? 1 : 0; }
export function dateProtoIsDateProto() { return protoIsDatePrototype(new Date()) ? 1 : 0; }
export function arrayProtoIsNull() { return protoIsNull([1, 2]) ? 1 : 0; }
export function arrayProtoIsArrayProto() { return protoIsArrayPrototype([1, 2]) ? 1 : 0; }
export function fnProtoIsFunctionProto() { return protoIsFunctionPrototype(function q() { return 1; }) ? 1 : 0; }

// Two hops off an array must reach %Object.prototype% instead of throwing
// "Cannot convert null to object" on the second call.
export function arrayTwoHopIsObjectProto() {
  const one = Object.getPrototypeOf(identity([1, 2]));
  return Object.getPrototypeOf(one) === Object.prototype ? 1 : 0;
}

// Preserved behaviour: an ordinary object literal, an Object.create(null)
// dictionary, and an Object.create(<literal>) result must not move.
export function literalProtoIsObjectProto() { return protoIsObjectPrototype(identity({ x: 1 })) ? 1 : 0; }
export function createNullProtoIsNull() { return protoIsNull(Object.create(null)) ? 1 : 0; }
export function createFromLiteralKeepsSource() {
  const base = { y: 2 };
  return Object.getPrototypeOf(identity(Object.create(base))) === base ? 1 : 0;
}
export function setPrototypeOfStillWins() {
  const base = { y: 2 };
  const o = { z: 1 };
  Object.setPrototypeOf(o, base);
  return Object.getPrototypeOf(identity(o)) === base ? 1 : 0;
}
// Residual (see the file header): Object.setPrototypeOf on an ARRAY literal
// never reaches __host_set_struct_proto, so no explicit link is recorded and
// the vec arm answers Array.prototype. Measured null before this change —
// equally not base, and equally not an answer anything can walk.
export function setPrototypeOfOnArrayIsArrayProto() {
  const base = { y: 2 };
  const a = [1, 2];
  Object.setPrototypeOf(a, base);
  return Object.getPrototypeOf(identity(a)) === Array.prototype ? 1 : 0;
}

// (#5347) The class-instance residual this file used to pin. It answers
// Action.prototype since the __class_instance_proto discriminator landed;
// kept here as the no-regression control for the #5325 carriers next to it.
export function classInstanceProtoIsObjectProto() { return protoIsObjectPrototype(identity(new Action())) ? 1 : 0; }
export function classInstanceProtoIsClassProto() { return Object.getPrototypeOf(identity(new Action())) === Action.prototype ? 1 : 0; }
`;

describe("#5325 Object.getPrototypeOf on a WasmGC carrier receiver", () => {
  let exports: WebAssembly.Exports;

  const call = (name: string): number => (exports[name] as () => number)();

  it("compiles the two-file fixture", async () => {
    const result = await compileFixture({ "dep.js": DEP, "entry.js": ENTRY }, "entry.js");
    expect(result.success, result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")).toBe(true);
    exports = await instantiate(result);
  });

  it("answers the real built-in prototype for a Date, an Array and a compiled closure", () => {
    expect(call("dateProtoIsObjectProto")).toBe(0);
    expect(call("dateProtoIsDateProto")).toBe(1);
    expect(call("arrayProtoIsNull")).toBe(0);
    expect(call("arrayProtoIsArrayProto")).toBe(1);
    expect(call("fnProtoIsFunctionProto")).toBe(1);
  });

  it("walks two hops off an array to %Object.prototype% instead of throwing", () => {
    expect(call("arrayTwoHopIsObjectProto")).toBe(1);
  });

  it("makes redux's isPlainObject answer correctly for non-plain receivers", () => {
    expect(call("plainForLiteral")).toBe(1);
    expect(call("plainForNullProto")).toBe(1);
    expect(call("plainForDate")).toBe(0);
    expect(call("plainForArray")).toBe(0);
    expect(call("plainForFunction")).toBe(0);
  });

  it("leaves ordinary objects, null-prototype dictionaries and explicit links untouched", () => {
    expect(call("literalProtoIsObjectProto"), "literal").toBe(1);
    expect(call("createNullProtoIsNull"), "createNull").toBe(1);
    expect(call("createFromLiteralKeepsSource"), "createFromLiteral").toBe(1);
    expect(call("setPrototypeOfStillWins"), "setPrototypeOf").toBe(1);
  });

  it("records the setPrototypeOf-on-array residual", () => {
    // NOT a desired answer — the spec answer is the assigned `base`. Asserted so
    // the day `Object.setPrototypeOf` on a vec records its link, this line has to
    // change with it. It was `null` before #5325, i.e. also not `base`.
    expect(call("setPrototypeOfOnArrayIsArrayProto")).toBe(1);
  });

  it("answers the class prototype for a compiled class instance (#5347)", () => {
    // Was the last residual of this change: both lines read the other way until
    // `__class_instance_proto` landed. The full matrix lives in
    // tests/issue-5347-getprototypeof-compiled-class-instance.test.ts.
    expect(call("classInstanceProtoIsObjectProto")).toBe(0);
    expect(call("classInstanceProtoIsClassProto")).toBe(1);
  });
});
