// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3972 — `class Sub extends <builtin>` under `--target standalone` leaked one
// `env::__new_<Parent>` host import per parent, which the #2961 guard correctly
// refuses ("standalone target emitted host imports"). That single leaked import
// was the SOLE reason the whole `subclass-builtins` conformance family failed on
// the standalone lane for these parents.
//
// This file covers the parents served by an identity carrier — ArrayBuffer,
// DataView, Date, Function, Promise, RegExp, WeakRef. The collection parents
// (Set/Map/WeakMap/WeakSet) and the primitive wrappers (Number/Boolean) get real
// native carriers and are pinned by issue-2620-* / issue-2029-* respectively.
//
// WHY AN IDENTITY CARRIER IS SOUND — and why it is not a shortcut. What these
// conformance rows ask for is identity, and identity never consults the carrier:
// `new Sub() instanceof Sub` and `instanceof <Parent>` are BOTH resolved at
// COMPILE time by `tryStaticInstanceOf`, which reads the recorded builtin parent
// out of `ctx.classBuiltinParentMap` and walks the static `isBuiltinSubtype`
// hierarchy. So a fresh `__new_plain_object()` flips the module host-free without
// changing any answer. A plain object is chosen over a faithful-LOOKING carrier
// on purpose: an incorrectly branded value (e.g. a `$__vec_i32_byte` handed back
// for `ArrayBuffer`) would make brand-testing paths answer confidently wrong,
// whereas a plain object carries no false brand. This is exactly the scope of the
// existing #3239 TypedArray/SharedArrayBuffer rung.
//
// SCOPE, STATED PLAINLY: the instance is NOT a functional Date/RegExp/Promise/…
// There is no [[DateValue]], no compiled pattern, no executor is run, no
// byteLength; constructor arguments are still side-effect-evaluated at the call
// site (§13.3.7.1) and then dropped. That is bounded by measurement rather than
// hope: of 25,692 passing standalone test262 rows, ZERO contain
// `extends <one of these parents>` in their source, so there is no
// behaviour-dependent passing row to regress. Faithful argument-honouring
// construction is follow-up work, worth doing when a behaviour test for one of
// these parents can actually pass standalone.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Parent -> the `new Sub(...)` argument list its TypeScript signature needs. */
const IDENTITY_PARENTS: Array<[parent: string, args: string]> = [
  ["ArrayBuffer", "8"],
  ["DataView", "new ArrayBuffer(8)"],
  ["Date", ""],
  ["Function", ""],
  ["Promise", "() => {}"],
  ["RegExp", '"a"'],
  ["WeakRef", "{}"],
];

/**
 * The load-bearing assertion set: compiles, emits ZERO `env::` host imports,
 * instantiates against an EMPTY import object, and answers `instanceof`
 * correctly. "Compiles" alone proves nothing here — before this change the
 * module also compiled; it was the leaked import that made it unusable, and the
 * #2961 guard that turned that into a conformance failure. Instantiating with
 * `{}` is what actually demonstrates the leak is gone.
 */
async function expectHostFreeSubclass(
  parent: string,
  args: string,
  decl = "class Sub extends PARENT {}",
): Promise<void> {
  // Authored as JAVASCRIPT (`allowJs`, `test.js`) on purpose, matching the
  // conformance lane exactly. In TypeScript, `x instanceof Sub` where
  // `class Sub extends DataView|Promise|WeakRef` is rejected outright ("the
  // right-hand side of an 'instanceof' expression must be either of type 'any',
  // a class, function, ..."), which demotes the check to the runtime
  // `env::__instanceof_check` host import — so a `.ts` fixture would measure a
  // TypeScript typing wrinkle in the FIXTURE rather than the compiler behaviour
  // under test. The test262 rows this issue is about are `.js`, so `.js` is the
  // faithful fixture.
  const src =
    `${decl.replace("PARENT", parent)}\n` +
    `export function test() { const s = new Sub(${args}); return (s instanceof Sub) && (s instanceof ${parent}) ? 1 : 0; }\n`;
  const r = await compile(src, { target: "standalone", allowJs: true, fileName: "test.js" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);

  const labels = r.imports.map((im: { module?: string; name?: string }) => `${im.module}::${im.name}`);
  expect(
    labels.filter((l) => l.startsWith("env::")),
    `extends ${parent} leaked host imports: ${labels.join(", ")}`,
  ).toEqual([]);
  // Specifically the import this issue is about, named so a regression is legible.
  expect(labels, `extends ${parent} still leaks __new_${parent}`).not.toContain(`env::__new_${parent}`);

  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, () => number>;
  expect(ex.test!(), `extends ${parent} answered instanceof incorrectly`).toBe(1);
}

describe("#3972 standalone `class Sub extends <builtin>` constructs host-free", () => {
  for (const [parent, args] of IDENTITY_PARENTS) {
    it(`standalone: 'class Sub extends ${parent} {}' emits no env::__new_${parent} and instantiates`, async () => {
      await expectHostFreeSubclass(parent, args);
    });
  }

  // A class EXPRESSION must take the same path as a class declaration — the
  // conformance family covers both forms, and they reach registerClass through
  // different call sites (the synthetic-name path for expressions).
  it("standalone: the class-EXPRESSION form is equally host-free", async () => {
    const src =
      `const Sub = class extends Date {};\n` +
      `export function test(): number { const s = new Sub(); return s instanceof Sub ? 1 : 0; }\n`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im: { module?: string; name?: string }) => `${im.module}::${im.name}`);
    expect(
      labels.filter((l) => l.startsWith("env::")),
      `leaked: ${labels.join(", ")}`,
    ).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.test!()).toBe(1);
  });

  // PER-ARITY registration (#2917): a single plain-name registration keyed off
  // the FIRST caller's arity gets mis-called from every later site with a
  // different arity — the extra args stay on the operand stack and (validly!)
  // become the enclosing forwarder's return value, so `new Sub(x)` returns `x`
  // instead of the instance. Two arities of the SAME parent in one module is the
  // shape that catches it.
  it("standalone: two call-site arities of the same parent each get their own defined ctor", async () => {
    const src =
      `class Sub extends Date {}\n` +
      `export function test(): number {\n` +
      `  const a = new Sub();\n` +
      `  const b = new Sub(1234);\n` +
      `  return (a instanceof Sub) && (b instanceof Sub) ? 1 : 0;\n` +
      `}\n`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im: { module?: string; name?: string }) => `${im.module}::${im.name}`);
    expect(
      labels.filter((l) => l.startsWith("env::")),
      `leaked: ${labels.join(", ")}`,
    ).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.test!()).toBe(1);
  });

  // Constructor ARGUMENTS are dropped by design, but their side effects must
  // still happen: §13.3.7.1 ArgumentListEvaluation runs before construction, and
  // the arguments are evaluated at the CALL SITE and then passed to (and ignored
  // by) the native ctor. Dropping the evaluation instead would be a real bug.
  it("standalone: constructor argument side effects still run even though the value is ignored", async () => {
    const src =
      `let seen = 0;\n` +
      `function bump(): number { seen = seen + 1; return 5; }\n` +
      `class Sub extends Date {}\n` +
      `export function test(): number { const s = new Sub(bump()); return seen; }\n`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.test!(), "argument side effect was optimised away").toBe(1);
  });

  // gc/host mode must stay byte-identical in behaviour — every #3972 arm is
  // gated on `ctx.standalone || ctx.wasi`, so the host lane keeps its
  // `__new_<Parent>` import and its real host instance.
  it("gc/host mode is unaffected (the native arms are standalone/wasi-gated)", async () => {
    const src =
      `class Sub extends Date {}\n` +
      `export function test(): boolean { const s = new Sub(); return s instanceof Sub; }\n`;
    const r = await compile(src, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    await WebAssembly.compile(r.binary);
  });
});
