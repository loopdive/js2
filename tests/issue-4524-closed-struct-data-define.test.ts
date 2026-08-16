// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4524 — `Object.defineProperty(o, k, {value})` was SILENTLY DROPPED on a
// closed-struct object literal under `--target standalone`.
//
// An object literal with a statically-inferred shape lowers to a closed WasmGC
// struct: one slot per shape name, no way to grow. An out-of-shape data define
// therefore had nowhere to write, and the write vanished — no trap, no
// diagnostic, the property simply was not there afterwards.
//
// The sibling cases were already covered: an ACCESSOR define poisons the var
// via `markStandaloneAccessorDefineTargets`, and a plain dynamic write poisons
// it via the #2837 growable pre-pass. The data define was the one hole — and
// the one real test262 code hits, because the corpus is plain JavaScript whose
// objects are never annotated `any` and so always take the closed-struct path.
//
// THE INSTRUMENT TRAP THAT HID THIS (worth stating, it cost real time):
// writing the receiver as `var o: any = {…}` in a probe routes it onto the
// open-`$Object` path and the bug disappears. An `: any` annotation is not
// neutral — it selects a different object lowering, so a probe that adds one
// to make the code compile has stopped testing the program under test. Several
// probes reported "spec-correct" against genuinely failing tests this way.
// Every case below is therefore deliberately UNANNOTATED except the explicit
// open-`$Object` controls.
//
// SCOPE: this is "the define lands", not "the descriptor semantics are right".
// Attribute fidelity (writable/enumerable/configurable, redefinition rules) is
// #4479 / #2668 / #739; write-persistence on dynamic shapes is #3475.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, {
    fileName: "issue-4524.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const stub = new Proxy({}, { get: () => () => 0 });
  const { instance } = await WebAssembly.instantiate(r.binary, { env: stub } as unknown as WebAssembly.Imports);
  return (instance.exports.test as () => number)();
}

describe("#4524 out-of-shape data define on a closed-struct literal", () => {
  // The regression matrix. Only the first row was broken; the other four
  // already worked and are pinned BECAUSE the fix changes the representation
  // of exactly these receivers — the escape transition is what could break them.
  it("data descriptor at a NEW key lands (the defect)", async () => {
    expect(
      await runStandalone(`
        var o = { a: 1 };
        Object.defineProperty(o, "b", { value: 42, enumerable: true, configurable: true });
        export function test(): number { return (o as any).b === 42 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("data descriptor at a NEW key on an open $Object still lands (control)", async () => {
    expect(
      await runStandalone(`
        var o: any = { a: 1 };
        Object.defineProperty(o, "b", { value: 42, enumerable: true, configurable: true });
        export function test(): number { return o.b === 42 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("accessor descriptor at a NEW key still lands", async () => {
    expect(
      await runStandalone(`
        var o = { a: 1 };
        Object.defineProperty(o, "b", { get: function () { return 42; }, configurable: true });
        export function test(): number { return (o as any).b === 42 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("accessor descriptor at an EXISTING key still lands", async () => {
    expect(
      await runStandalone(`
        var o = { a: 1 };
        Object.defineProperty(o, "a", { get: function () { return 42; }, configurable: true });
        export function test(): number { return (o as any).a === 42 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("plain dynamic write of a NEW key still lands", async () => {
    expect(
      await runStandalone(`
        var o = { a: 1 };
        (o as any).b = 42;
        export function test(): number { return (o as any).b === 42 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  // The defined property must be a real own property, not just readable —
  // a side-table read that satisfies `o.b` while `in` / Object.keys still see
  // a struct would be the failure this asserts against.
  it("the defined property is a real own property, not a read-only side effect", async () => {
    expect(
      await runStandalone(`
        var o = { a: 1 };
        Object.defineProperty(o, "b", { value: 42, enumerable: true, configurable: true });
        export function test(): number {
          const inOp = ("b" in (o as any)) ? 1 : 0;
          const own = Object.prototype.hasOwnProperty.call(o, "b") ? 2 : 0;
          const keys = Object.keys(o as any).length === 2 ? 4 : 0;
          return inOp + own + keys;
        }
      `),
    ).toBe(7);
  });

  // Numeric-string keys are the ES5 array-like shape: the
  // built-ins/Array/prototype/filter/15.4.4.20-9-b-* family installs its
  // indices exactly this way.
  it("numeric-string keys land too", async () => {
    expect(
      await runStandalone(`
        var o = { length: 2 };
        Object.defineProperty(o, "0", { value: 10, enumerable: true, configurable: true });
        Object.defineProperty(o, "1", { value: 20, enumerable: true, configurable: true });
        export function test(): number { return ((o as any)[0] as number) + ((o as any)[1] as number); }
      `),
    ).toBe(30);
  });

  it("Object.defineProperties with an out-of-shape data entry lands", async () => {
    expect(
      await runStandalone(`
        var o = { a: 1 };
        Object.defineProperties(o, { b: { value: 42, enumerable: true, configurable: true } });
        export function test(): number { return (o as any).b === 42 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  // NARROWNESS, the other direction: an IN-SHAPE data define must NOT change
  // representation. That slot already exists and the struct path serves it; the
  // #1897 episode (116 regressions, −45 on the standalone gate) is what happens
  // when literals get routed to `$Object` more eagerly than necessary.
  it("an in-shape data define still reads correctly", async () => {
    expect(
      await runStandalone(`
        var o = { a: 1 };
        Object.defineProperty(o, "a", { value: 42, enumerable: true, configurable: true });
        export function test(): number { return (o as any).a === 42 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  // A literal that is NOT a define receiver keeps its closed struct and its
  // ordinary typed reads — the fix must be per-receiver, not module-wide.
  it("an unrelated literal in the same module is unaffected", async () => {
    expect(
      await runStandalone(`
        var target = { a: 1 };
        Object.defineProperty(target, "b", { value: 42, configurable: true });
        var plain = { x: 3, y: 4 };
        export function test(): number { return plain.x + plain.y; }
      `),
    ).toBe(7);
  });
});
