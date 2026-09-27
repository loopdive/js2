// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6651 cluster C, C2) A top-level `C.prototype.<name> = value` on a compiled
// class was SILENTLY DROPPED in `--target standalone`.
//
// The module-init keep analysis (`declarations.ts`) retains a top-level
// `C.<name> = …` static write on a class and an `F.prototype.m = …` write on a
// top-level FUNCTION (host lane), but had no arm for the class-prototype chain.
// The statement therefore never reached `compileAssignment` at all — verified
// by instrumentation — while the identical statement inside a function body did,
// and worked. The honest test262 harness compiles every test body at MODULE
// scope, where `A.prototype.fromA = 'a'` is one of the suite's commonest idioms.
//
// Three arms are pinned here because the fix needed all three and any one of
// them alone leaves the shape broken or trapping:
//   1. the keep itself (plain class — base answers 0 of 3);
//   2. declining the externref-backed own-field write arm for a `.prototype`
//      receiver — without it the newly-kept statement casts the PROTOTYPE to
//      `$Error_struct` and traps uncatchably with "illegal cast";
//   3. the statically-typed `err.message` read falling through to the prototype
//      chain when the instance has no own message (§20.5.1.1 step 3), which is
//      what makes the inherited value observable through a typed receiver.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect((result.errors ?? []).filter((e) => e.severity !== "warning")).toEqual([]);
  expect(result.imports ?? []).toEqual([]);
  const instance = await WebAssembly.instantiate(result.binary!, {});
  const exports = instance.instance.exports as { test?: () => number };
  expect(typeof exports.test).toBe("function");
  return exports.test!();
}

describe("#6651 cluster C2 — top-level `C.prototype.x = v` in standalone", () => {
  it("a top-level prototype write on a plain class is executed", async () => {
    // base 0, node 7. The other two statements in the module (`holder.k` and a
    // bare assignment) already landed on the base, so this is specifically the
    // prototype statement being dropped, not "module init did not run".
    expect(
      await runStandalone(`
class Plain {}
const holder: Record<string, unknown> = {};
holder.k = "H";
Plain.prototype.tagy = "Y";
let ran = 0;
ran = 5;
const ky = "tag" + "y";
const p = new Plain();
const a = (p as unknown as Record<string, unknown>)[ky] === "Y" ? 1 : 0;
const b = holder["k"] === "H" && ran === 5 ? 2 : 0;
const d = (Plain.prototype as unknown as Record<string, unknown>)[ky] === "Y" ? 4 : 0;
export function test(): number { return a + b + d; }`),
    ).toBe(7);
  });

  it("a top-level prototype write on a builtin-Error subclass does not trap", async () => {
    // base 0; with the keep but WITHOUT the `.prototype` decline in the
    // externref-backed own-field arm this traps ("illegal cast") instead of
    // answering. node 15.
    expect(
      await runStandalone(`
class Plain {}
Plain.prototype.tagy = "Y";
class Err extends TypeError {}
Err.prototype.tagx = "T";
const ky = "tag" + "y";
const kx = "tag" + "x";
const p = new Plain();
const a = (p as unknown as Record<string, unknown>)[ky] === "Y" ? 1 : 0;
const e = new Err();
const b = (e as unknown as Record<string, unknown>)[kx] === "T" ? 2 : 0;
const c = (Err.prototype as unknown as Record<string, unknown>)[kx] === "T" ? 4 : 0;
const d = (Plain.prototype as unknown as Record<string, unknown>)[ky] === "Y" ? 8 : 0;
export function test(): number { return a + b + c + d; }`),
    ).toBe(15);
  });

  it("a statically-typed `err.message` read reaches the class prototype", async () => {
    // base 1 (only the own-message read worked), node 3. This is the exact
    // `language/statements/class/subclass/builtin-objects/NativeError/*-message.js`
    // shape, and the receiver's static type is what routes it to the
    // unconditional struct field read.
    expect(
      await runStandalone(`
class Err extends TypeError {}
Err.prototype.message = "custom-type-error";
const err1 = new Err("foo 42");
const a = err1.message === "foo 42" ? 1 : 0;
const err2 = new Err();
const d = err2.message === "custom-type-error" ? 2 : 0;
export function test(): number { return a + d; }`),
    ).toBe(3);
  });

  it("a prototype write from INSIDE a function still works", async () => {
    // Regression guard: green on both sides. The in-function form resolves no
    // struct name and never reaches the arms above; it must stay that way.
    expect(
      await runStandalone(`
export function test(): number {
  class Err extends TypeError {}
  (Err.prototype as unknown as Record<string, unknown>).message = "custom";
  const km = "mess" + "age";
  let s = 0;
  if ((Err.prototype as unknown as Record<string, unknown>)[km] === "custom") s += 1;
  const e = new Err();
  if ((e as unknown as Record<string, unknown>)[km] === "custom") s += 2;
  return s;
}`),
    ).toBe(3);
  });
});
