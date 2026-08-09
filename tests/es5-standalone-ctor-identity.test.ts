// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4223) Primitive-WRAPPER `.constructor` identity on `--target standalone`.
//
// What this pins, and why each half is load-bearing
// -------------------------------------------------
// `Object(5).constructor === Number` was false for TWO independent reasons, and
// a test that only checked the comparison would pass vacuously if either half
// regressed into a null≡null tautology:
//
//   * RHS — the bare `Number` / `String` / `Boolean` identifier had no carrier
//     in standalone and read `null` (#3006 excluded them; #4200 recorded the
//     omission). So the assertions below check the RHS is a real object FIRST.
//   * LHS — a wrapper is a `$Object` whose [[Prototype]] is a `$NativeProto`,
//     so `__extern_get`'s proto-walk could never reach a `constructor`.
//
// Every identity assertion is therefore paired with a CROSS check
// (`Object(5).constructor === String` must stay false). Two nulls compare
// equal, so without the cross check a fully-broken build reads as green.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

async function runStandalone(source: string): Promise<Record<string, unknown>> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  if (typeof exports._start === "function") exports._start();
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(exports)) {
    // (#4232) Skip COMPILER-RESERVED exports. `closure-exports.ts` emits the
    // JS-host method-closure bridge as `__\0js2_call_fn_method_argc_<n>` — the
    // NUL is deliberate, precisely so the name cannot collide with a
    // source-level identifier. A sweep that asserts an exact object shape must
    // therefore exclude them, or the assertion silently doubles as a "did any
    // unrelated change arm the host bridge?" check and breaks on a cost
    // regression rather than a semantic one. That is what happened when the
    // #4232 plain-`Object` carrier first landed: all five failures here had
    // every asserted VALUE correct and only the extra keys differed.
    if (name !== "_start" && typeof fn === "function" && !name.includes("\0")) out[name] = fn();
  }
  return out;
}

// A tag-bearing user class is present in essentially every test262 program (the
// harness injects `class Test262Error`) and it changes which `.constructor`
// lowering fires, so keep one here too.
const PRELUDE = `
class Marker { x: number = 1; }
const marker = new Marker();
`;

describe("#4223 — standalone wrapper constructor identity", () => {
  it("the bare Number/String/Boolean identifier is a real object, not null", async () => {
    const out = await runStandalone(`${PRELUDE}
export function numberIsObject(): boolean { return (Number as any) !== null && (Number as any) !== undefined; }
export function stringIsObject(): boolean { return (String as any) !== null && (String as any) !== undefined; }
export function booleanIsObject(): boolean { return (Boolean as any) !== null && (Boolean as any) !== undefined; }
export function stable(): boolean { return (Number as any) === (Number as any); }
export function distinct(): boolean { return (Number as any) !== (String as any); }
export function markerLives(): boolean { return marker.x === 1; }
`);
    expect(out).toEqual({
      numberIsObject: 1,
      stringIsObject: 1,
      booleanIsObject: 1,
      stable: 1,
      distinct: 1,
      markerLives: 1,
    });
  });

  it("Object(primitive).constructor is the matching builtin — and only that one", async () => {
    const out = await runStandalone(`${PRELUDE}
const n: any = Object(5);
const s: any = Object("zz");
const b: any = Object(true);
export function numOk(): boolean { return n.constructor === (Number as any); }
export function strOk(): boolean { return s.constructor === (String as any); }
export function boolOk(): boolean { return b.constructor === (Boolean as any); }
// Cross checks — a null≡null tautology would make these true too.
export function numCross(): boolean { return n.constructor === (String as any); }
export function strCross(): boolean { return s.constructor === (Boolean as any); }
export function boolCross(): boolean { return b.constructor === (Number as any); }
`);
    expect(out).toEqual({ numOk: 1, strOk: 1, boolOk: 1, numCross: 0, strCross: 0, boolCross: 0 });
  });

  it("new Number/String/Boolean instances resolve .constructor through a runtime receiver", async () => {
    const out = await runStandalone(`${PRELUDE}
function readCtor(x: any): any { return x.constructor; }
const n: any = new Number(7);
const s: any = new String("ab");
const b: any = new Boolean(true);
export function numOk(): boolean { return readCtor(n) === (Number as any); }
export function strOk(): boolean { return readCtor(s) === (String as any); }
export function boolOk(): boolean { return readCtor(b) === (Boolean as any); }
export function numCross(): boolean { return readCtor(n) === (Boolean as any); }
`);
    expect(out).toEqual({ numOk: 1, strOk: 1, boolOk: 1, numCross: 0 });
  });

  it("<Builtin>.prototype.constructor is the SAME object as the bare identifier", async () => {
    const out = await runStandalone(`${PRELUDE}
export function num(): boolean { return (Number.prototype.constructor as any) === (Number as any); }
export function str(): boolean { return (String.prototype.constructor as any) === (String as any); }
export function bool(): boolean { return (Boolean.prototype.constructor as any) === (Boolean as any); }
export function cross(): boolean { return (Number.prototype.constructor as any) === (String as any); }
`);
    expect(out).toEqual({ num: 1, str: 1, bool: 1, cross: 0 });
  });

  it("an OWN constructor expando shadows the inherited carrier (§7.3.2)", async () => {
    const out = await runStandalone(`${PRELUDE}
const w: any = new Number(3);
w.constructor = 42;
export function shadowed(): boolean { return w.constructor !== (Number as any); }
export function readsBack(): boolean { return w.constructor === 42; }
`);
    expect(out).toEqual({ shadowed: 1, readsBack: 1 });
  });

  it("the carrier read works when it is the module's FIRST demand for the builtin", async () => {
    // Argument order of `assert.sameValue(o.constructor, Number)`: the wrapper
    // read is compiled and evaluated BEFORE the bare identifier, so a bare
    // `global.get` of the lazily-materialized singleton would answer null.
    const out = await runStandalone(`${PRELUDE}
const o: any = Object(5);
const first: any = o.constructor;
export function ok(): boolean { return first === (Number as any); }
`);
    expect(out).toEqual({ ok: 1 });
  });

  it("a module that never reads .constructor mints no carrier (demand gate)", async () => {
    const src = `${PRELUDE}
export function add(): number { const o: any = Object(5); return marker.x + 1; }
`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success).toBe(true);
    // `__wrap_ctor_` appears in the name section only when the accessors were
    // minted. Byte-scan rather than a WAT dump so the check is cheap.
    expect(Buffer.from(r.binary).includes(Buffer.from("__wrap_ctor_"))).toBe(false);
  });

  it("the gc (js-host) lane keeps its own constructor resolution", async () => {
    const r = await compile(
      `${PRELUDE}
const o: any = Object(5);
export function ok(): boolean { return o.constructor === (Number as any); }
`,
      {},
    );
    expect(r.success).toBe(true);
    // The gc lane routes through the host `Object_get_constructor` read; this
    // test only pins that the #4223 standalone-only arm did not leak into it.
    expect(Buffer.from(r.binary).includes(Buffer.from("__wrap_ctor_"))).toBe(false);
  });
});

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

describe.skipIf(!TEST262)("#4223 — test262 files that flip", () => {
  const files = [
    "built-ins/Object/S15.2.1.1_A2_T2.js", // Object(number).constructor === Number
    "built-ins/Object/S15.2.1.1_A2_T3.js", // Object(string).constructor === String
    "built-ins/Object/S15.2.1.1_A2_T1.js", // Object(boolean).constructor === Boolean
    "built-ins/Object/S15.2.1.1_A2_T13.js", // Object(boolean literal)
    "built-ins/String/S15.5.2.1_A1_T1.js", // new String(x).constructor === String
  ];
  for (const rel of files) {
    it(`${rel} passes on the standalone lane`, { timeout: 60_000 }, async () => {
      const abs = join(__dirname, "..", "test262", "test", rel);
      const r = await runTest262File(abs, "es5-ctor-identity", 30_000, "standalone");
      expect(`${r.status}: ${r.reason ?? ""}`).toBe("pass: ");
    });
  }
});
