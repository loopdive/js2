// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5347 — `Object.getPrototypeOf(<compiled class instance>)` must answer the
// class's prototype carrier, not `%Object.prototype%`.
//
// This is #5325's last residual. That change taught the host `__getPrototypeOf`
// import to answer the real built-in prototype for a Date / Array / closure
// carrier and stopped at the class instance, because a `$ClassName` struct and
// the class's own prototype singleton are the SAME WasmGC type and no export
// separated them. Both fell to the `__is_data_struct` default,
// `%Object.prototype%`.
//
// The consequence is an inverted predicate, not a rounding error. redux 5's
// `isPlainObject` walks to the chain terminal and compares against it, so with
// `getPrototypeOf(new C())` answering `%Object.prototype%` — which IS the
// terminal — `isPlainObject(new C())` answered **true**, and `isAction`, whose
// entire job is to reject a class instance, answered true with it.
//
// The fix is a codegen-side reverse map: `__class_instance_proto`
// (src/codegen/class-instance-proto.ts) `ref.test`s the value against the
// module's class-struct set, separates a genuine instance from the prototype
// and class-object singletons by REFERENCE IDENTITY against their globals, and
// materializes the lazily-initialised prototype singleton on demand — a program
// that only ever CONSTRUCTS the class (redux's `new Action()`) never writes
// `C.prototype`, so nothing else would have built it.
//
// Fixtures are untyped `.js` in a two-file project on purpose. Codegen FOLDS
// `Object.getPrototypeOf` at compile time whenever the argument's shape
// identifies the receiver, and the class-instance fold already answered
// correctly; the broken lane is a receiver that arrives through a call boundary
// as a bare parameter, i.e. every `isPlainObject(value)` guard in published JS.
// `identity()` from the second file is what puts each receiver in that lane.
//
// THREE RESIDUALS pinned below so none of them moves silently:
//
//  - `getPrototypeOf(<Derived>.prototype)` answers `%Object.prototype%` rather
//    than `Base.prototype` (§15.7.14 step 6). The prototype singleton declines
//    in the dispatcher, so the parent link is a separate change. It does not
//    change any WALK outcome: the chain still terminates at `%Object.prototype%`
//    and still is not `Derived.prototype`.
//  - `getPrototypeOf(<class value>)` answers `%Object.prototype%` rather than
//    `%Function.prototype%`. The class-object singleton reuses the `$ClassName`
//    struct type, so the dispatcher declines it BY IDENTITY — deliberately, or
//    a class value passed as a parameter would report its own `.prototype`.
//  - `Object.setPrototypeOf` on an ARRAY literal — inherited verbatim from
//    #5325, restated here because this file is the one that would notice.

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
  const root = mkdtempSync(join(tmpdir(), "js2-5347-"));
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

// The dependency is the whole point of the second file: it puts every receiver
// in the through-a-call-boundary lane without contributing to the query.
const DEP = `
export function identity(v) { return v; }
`;

const ENTRY = `
import { identity } from './dep.js';

// redux 5's src/utils/isPlainObject.js, verbatim in shape.
function isPlainObject(obj) {
  if (typeof obj !== 'object' || obj === null) return false;
  let proto = obj;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return Object.getPrototypeOf(obj) === proto || Object.getPrototypeOf(obj) === null;
}
// redux 5's src/utils/isAction.js.
function isAction(action) {
  return isPlainObject(action) && 'type' in action && typeof action.type === 'string';
}

function gpo(v) { return Object.getPrototypeOf(v); }

class Action { constructor() { this.type = 'totally an action'; } }
class Greeter { greet() { return 'hi'; } shout() { return 'HI'; } }
class Base { m() { return 1; } }
class Derived extends Base { n() { return 2; } }

// ── The fix ────────────────────────────────────────────────────────────────
export function instanceProtoIsClassProto() { return gpo(identity(new Action())) === Action.prototype ? 1 : 0; }
export function instanceProtoIsObjectProto() { return gpo(identity(new Action())) === Object.prototype ? 1 : 0; }
export function instanceProtoIsNull() { return gpo(identity(new Action())) === null ? 1 : 0; }
// Identity has to hold across the two lanes: the folded read and the host answer
// must be the same object, not two structurally equal ones.
export function foldedAndHostAgree() {
  return Object.getPrototypeOf(new Action()) === gpo(identity(new Action())) ? 1 : 0;
}
// Most-derived-first arm order: a $Derived instance also ref.tests as $Base.
export function derivedInstanceProtoIsDerivedProto() { return gpo(identity(new Derived())) === Derived.prototype ? 1 : 0; }
export function derivedInstanceProtoIsBaseProto() { return gpo(identity(new Derived())) === Base.prototype ? 1 : 0; }
export function baseInstanceProtoIsBaseProto() { return gpo(identity(new Base())) === Base.prototype ? 1 : 0; }

// ── redux's own predicates ─────────────────────────────────────────────────
export function plainForClassInstance() { return isPlainObject(identity(new Action())) ? 1 : 0; }
export function plainForLiteral() { return isPlainObject(identity({ a: 1 })) ? 1 : 0; }
export function plainForNullProto() { return isPlainObject(identity(Object.create(null))) ? 1 : 0; }
// The upstream isAction.spec.ts table, in order.
export function actionForLiteral() { return isAction(identity({ type: 'an action' })) ? 1 : 0; }
export function actionForLiteralWithExtra() { return isAction(identity({ type: 'more props', extra: true })) ? 1 : 0; }
export function actionForNumericType() { return isAction(identity({ type: 0 })) ? 1 : 0; }
export function actionForClassInstance() { return isAction(identity(new Action())) ? 1 : 0; }
export function actionForString() { return isAction(identity('a string')) ? 1 : 0; }
export function actionForFunction() { return isAction(identity(gpo)) ? 1 : 0; }

// ── The two other $ClassName-typed values must DECLINE ─────────────────────
// The prototype singleton itself. Answering the class prototype here would make
// getPrototypeOf(p) === p and spin the isPlainObject walk forever.
export function classProtoProtoIsObjectProto() { return gpo(identity(Action.prototype)) === Object.prototype ? 1 : 0; }
export function classProtoProtoIsItself() { return gpo(identity(Action.prototype)) === Action.prototype ? 1 : 0; }
export function chainWalkTerminates() {
  let proto = identity(new Action());
  let hops = 0;
  while (Object.getPrototypeOf(proto) !== null && hops < 50) { proto = Object.getPrototypeOf(proto); hops++; }
  return hops;
}
// The class-object singleton (a class passed as a VALUE).
export function classValueProtoIsClassProto() { return gpo(identity(Action)) === Action.prototype ? 1 : 0; }
export function classValueProtoIsObjectProto() { return gpo(identity(Action)) === Object.prototype ? 1 : 0; }

// ── A host-minted singleton keeps the method-name allowlist ────────────────
// The dispatcher builds Greeter.prototype (nothing else reads it) and has to
// make the same __register_prototype call emitLazyProtoGet makes, or the host
// enumerates the class's INSTANCE FIELD names for it.
export function greeterProtoOwnKeys() {
  const proto = gpo(identity(new Greeter()));
  const names = Object.getOwnPropertyNames(proto);
  return names.indexOf('greet') >= 0 && names.indexOf('shout') >= 0 ? 1 : 0;
}

// ── Preserved: more specific answers still win ─────────────────────────────
export function explicitSetPrototypeOfStillWins() {
  const base = { y: 2 };
  const inst = new Action();
  Object.setPrototypeOf(inst, base);
  return gpo(identity(inst)) === base ? 1 : 0;
}
export function objectCreateFromClassProtoKeepsSource() {
  return gpo(identity(Object.create(Action.prototype))) === Action.prototype ? 1 : 0;
}
export function literalProtoIsObjectProto() { return gpo(identity({ x: 1 })) === Object.prototype ? 1 : 0; }
export function createNullProtoIsNull() { return gpo(identity(Object.create(null))) === null ? 1 : 0; }

// ── #5325's carriers, as the no-regression control ─────────────────────────
export function dateProtoIsDateProto() { return gpo(identity(new Date())) === Date.prototype ? 1 : 0; }
export function arrayProtoIsArrayProto() { return gpo(identity([1, 2])) === Array.prototype ? 1 : 0; }
export function fnProtoIsFunctionProto() { return gpo(identity(function q() { return 1; })) === Function.prototype ? 1 : 0; }
export function arrayTwoHopIsObjectProto() {
  return gpo(gpo(identity([1, 2]))) === Object.prototype ? 1 : 0;
}
// Residual inherited from #5325: setPrototypeOf on an array literal never
// records a link, so the vec arm answers Array.prototype, not the assignment.
export function setPrototypeOfOnArrayIsArrayProto() {
  const base = { y: 2 };
  const a = [1, 2];
  Object.setPrototypeOf(a, base);
  return gpo(identity(a)) === Array.prototype ? 1 : 0;
}
`;

describe("#5347 Object.getPrototypeOf on a compiled class instance", () => {
  let exports: WebAssembly.Exports;

  const call = (name: string): number => (exports[name] as () => number)();

  it("compiles the two-file fixture", async () => {
    const result = await compileFixture({ "dep.js": DEP, "entry.js": ENTRY }, "entry.js");
    expect(result.success, result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")).toBe(true);
    exports = await instantiate(result);
  });

  it("answers the class prototype carrier for a compiled class instance", () => {
    // All three read 0 / 1 / 0 the other way before the discriminator landed:
    // the instance reported %Object.prototype%.
    expect(call("instanceProtoIsClassProto"), "instance → C.prototype").toBe(1);
    expect(call("instanceProtoIsObjectProto"), "instance → Object.prototype").toBe(0);
    expect(call("instanceProtoIsNull"), "instance → null").toBe(0);
  });

  it("gives the folded read and the host answer the same identity", () => {
    expect(call("foldedAndHostAgree")).toBe(1);
  });

  it("picks the most-derived class for a subclass instance", () => {
    expect(call("derivedInstanceProtoIsDerivedProto"), "derived → Derived.prototype").toBe(1);
    expect(call("derivedInstanceProtoIsBaseProto"), "derived → Base.prototype").toBe(0);
    expect(call("baseInstanceProtoIsBaseProto"), "base → Base.prototype").toBe(1);
  });

  it("makes redux's isPlainObject / isAction reject a class instance", () => {
    expect(call("plainForClassInstance"), "isPlainObject(new Action())").toBe(0);
    expect(call("plainForLiteral"), "isPlainObject({a:1})").toBe(1);
    expect(call("plainForNullProto"), "isPlainObject(Object.create(null))").toBe(1);
    expect(call("actionForLiteral")).toBe(1);
    expect(call("actionForLiteralWithExtra")).toBe(1);
    expect(call("actionForNumericType")).toBe(0);
    expect(call("actionForClassInstance")).toBe(0);
    expect(call("actionForString")).toBe(0);
    expect(call("actionForFunction")).toBe(0);
  });

  it("declines the class's own prototype singleton, so a chain walk terminates", () => {
    expect(call("classProtoProtoIsObjectProto"), "C.prototype → Object.prototype").toBe(1);
    expect(call("classProtoProtoIsItself"), "C.prototype → itself (self-loop)").toBe(0);
    // instance → C.prototype → %Object.prototype% → null. A dispatcher that
    // answered for the singleton would spin here instead of stopping at 2.
    expect(call("chainWalkTerminates")).toBe(2);
  });

  it("declines the class-object singleton (pinned residual)", () => {
    // NOT the spec answer — `getPrototypeOf(C)` is `%Function.prototype%`. But
    // the class object reuses the `$ClassName` struct type, so the dispatcher
    // must decline it by identity or a class passed as a value would report its
    // own `.prototype`. Unchanged from before this change.
    expect(call("classValueProtoIsClassProto")).toBe(0);
    expect(call("classValueProtoIsObjectProto")).toBe(1);
  });

  it("registers the method-name allowlist for a host-minted prototype singleton", () => {
    expect(call("greeterProtoOwnKeys")).toBe(1);
  });

  it("keeps every more specific prototype answer ahead of the class answer", () => {
    expect(call("explicitSetPrototypeOfStillWins"), "setPrototypeOf").toBe(1);
    expect(call("objectCreateFromClassProtoKeepsSource"), "Object.create(C.prototype)").toBe(1);
    expect(call("literalProtoIsObjectProto"), "object literal").toBe(1);
    expect(call("createNullProtoIsNull"), "Object.create(null)").toBe(1);
  });

  it("leaves #5325's built-in carriers untouched", () => {
    expect(call("dateProtoIsDateProto"), "Date").toBe(1);
    expect(call("arrayProtoIsArrayProto"), "Array").toBe(1);
    expect(call("fnProtoIsFunctionProto"), "function").toBe(1);
    expect(call("arrayTwoHopIsObjectProto"), "two hops off an array").toBe(1);
  });

  it("still pins the setPrototypeOf-on-array residual from #5325", () => {
    expect(call("setPrototypeOfOnArrayIsArrayProto")).toBe(1);
  });
});
