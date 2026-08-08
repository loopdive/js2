// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4232) Wrapper `.constructor` leftovers on `--target standalone`.
//
// Two root causes are pinned here, and each has a failure mode that a naive
// assertion would MISS:
//
//   1. `new Object(<primitive>)` — #3133's static fold answered the `Object`
//      namespace singleton, so the assertion compared two REAL but different
//      objects. `x.constructor === String` being false is therefore not enough
//      evidence on its own; every identity check below is paired with a CROSS
//      check and with a positive check that #3133's own cases still fold.
//   2. `Object(null)` — a bare `$Object` whose `$proto` is null. The arm that
//      answers it must NOT answer for a `new F()` instance, which inherits its
//      own `constructor` from `F.prototype`. That negative is the whole safety
//      argument for the arm, so it is asserted directly.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<Record<string, unknown>> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  if (typeof exports._start === "function") exports._start();
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(exports)) {
    if (name !== "_start" && typeof fn === "function" && !name.startsWith("__")) out[name] = fn();
  }
  return out;
}

describe("#4232 — new Object(<primitive>).constructor (standalone)", () => {
  it("resolves the WRAPPER builtin through a bound var, not the Object namespace", async () => {
    // The binding is what defeated the receiver-expression-only fix: test262
    // writes `var n_obj = new Object(str); n_obj.constructor`, so the receiver
    // at the read site is a bare identifier.
    const out = await runStandalone(`
var str = "Obi-Wan Kenobi";
var num = 5;
var bool = true;
var s_obj = new Object(str);
var n_obj = new Object(num);
var b_obj = new Object(bool);
export function strOk(): boolean { return (s_obj as any).constructor === String; }
export function numOk(): boolean { return (n_obj as any).constructor === Number; }
export function boolOk(): boolean { return (b_obj as any).constructor === Boolean; }
// The bug's actual shape: the fold answered Object for all three.
export function strNotObject(): boolean { return (s_obj as any).constructor !== Object; }
export function numNotObject(): boolean { return (n_obj as any).constructor !== Object; }
export function boolNotObject(): boolean { return (b_obj as any).constructor !== Object; }
// Cross checks — a null/tautology answer would satisfy the positives above.
export function strCross(): boolean { return (s_obj as any).constructor === Number; }
export function numCross(): boolean { return (n_obj as any).constructor === String; }
`);
    expect(out).toEqual({
      strOk: 1,
      numOk: 1,
      boolOk: 1,
      strNotObject: 1,
      numNotObject: 1,
      boolNotObject: 1,
      strCross: 0,
      numCross: 0,
    });
  });

  it("covers the call form, a computed primitive argument, and extra arguments", async () => {
    // §20.1.1.1 ignores arguments after the first — `new Object(1, 2, 3)` is
    // S15.2.2.1_A6_T1 — and the argument is often an expression, not a literal.
    const out = await runStandalone(`
var a = Object("x");
var b = new Object("" + 1);
var c = new Object(2 * 3);
export function callForm(): boolean { return (a as any).constructor === String; }
export function computedStr(): boolean { return (b as any).constructor === String; }
export function computedNum(): boolean { return (c as any).constructor === Number; }
`);
    expect(out).toEqual({ callForm: 1, computedStr: 1, computedNum: 1 });
  });

  it("leaves #3133's own fold cases alone", async () => {
    // A non-primitive argument really does produce an ordinary object, and the
    // plain-object / array folds must keep answering the namespace singletons.
    // NOTE the casts are on the RESULT, never the receiver: an `as any`
    // receiver makes #3133 decline on its own, which would make this vacuous.
    const out = await runStandalone(`
var plain = {};
var arr = [1, 2];
var empty = new Object();
var wrapped = new Object(plain);
export function plainOk(): boolean { return (plain.constructor as any) === Object; }
export function arrOk(): boolean { return (arr.constructor as any) === Array; }
export function emptyOk(): boolean { return (empty.constructor as any) === Object; }
export function objArgOk(): boolean { return (wrapped.constructor as any) === Object; }
export function arrCross(): boolean { return (arr.constructor as any) === Object; }
`);
    expect(out).toEqual({ plainOk: 1, arrOk: 1, emptyOk: 1, objArgOk: 1, arrCross: 0 });
  });

  it("a REASSIGNED binding keeps the fold (the trace must refuse it)", async () => {
    // `o` is written twice, so the initializer no longer proves what `o` holds
    // at the read. Refusing means today's behavior — the Object fold — which is
    // the RIGHT answer here because the last write is a plain object.
    const out = await runStandalone(`
var o = new Object(5);
o = {};
export function foldKept(): boolean { return (o.constructor as any) === Object; }
`);
    expect(out).toEqual({ foldKept: 1 });
  });
});

describe("#4232 — Object(null)/Object(undefined) constructor (standalone)", () => {
  it("a bare $Object reads Object, and the proto-gate keeps user instances out", async () => {
    // The `$proto == null` gate is the whole safety argument: a `new F()`
    // instance is ALSO a `$Object`, and must keep inheriting
    // `F.prototype.constructor`. That negative is asserted directly, not
    // assumed.
    const out = await runStandalone(`
function F(): void {}
(F as any).prototype.tag = 7;
var inst: any = new (F as any)();
var fromNull: any = Object(null);
var fromUndef: any = Object(undefined);
var literal: any = {};
export function nullOk(): boolean { return fromNull.constructor === Object; }
export function undefOk(): boolean { return fromUndef.constructor === Object; }
export function literalOk(): boolean { return literal.constructor === Object; }
export function nullCross(): boolean { return fromNull.constructor === String; }
export function instNotObject(): boolean { return inst.constructor !== Object; }
export function instStillInherits(): boolean { return inst.tag === 7; }
`);
    expect(out).toEqual({
      nullOk: 1,
      undefOk: 1,
      literalOk: 1,
      nullCross: 0,
      instNotObject: 1,
      instStillInherits: 1,
    });
  });

  it("an OWN constructor still shadows the arm (§7.3.2)", async () => {
    const out = await runStandalone(`
var o: any = Object(null);
o.constructor = 42;
export function shadowed(): boolean { return o.constructor === 42; }
export function notObject(): boolean { return o.constructor !== Object; }
`);
    expect(out).toEqual({ shadowed: 1, notObject: 1 });
  });
});
