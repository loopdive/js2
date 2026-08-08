// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4248) `Number.prototype` / `Boolean.prototype` / `String.prototype` as
// WRAPPER OBJECTS on `--target standalone`.
//
// What each half pins, and why both halves are load-bearing
// ---------------------------------------------------------
//  * OWN PROPERTIES — a builtin `.prototype` is a `$NativeProto`, not a
//    `$Object`, so `__hasOwnProperty`'s table walk answered `false` for every
//    method the prototype actually owns. Both spellings are exercised: the
//    direct `Number.prototype.hasOwnProperty("toString")` and the reflective
//    `Object.prototype.hasOwnProperty.call(...)` that `propertyHelper.js`
//    opens `verifyProperty` with — they route through different lowerings and
//    only the second is what the `prop-desc.js` family dies on.
//  * NEGATIVE CASES ARE THE TEST. A CSV token scan that answered `true` for
//    everything would satisfy every positive assertion here. So each family
//    carries a miss, a strict PREFIX of a real member (`"toStrin"`) and a
//    strict EXTENSION of one (`"toStringX"`) — the two ways a length-blind
//    substring match fails — plus a cross-brand miss (`Boolean.prototype`
//    must not own `toFixed`).
//  * The DEMAND GATE is pinned by `plainObjectsUnaffected`: an ordinary
//    object's own-property answers must be untouched, which is also what
//    fails if the arm ever stops being consult-only and starts answering 0
//    authoritatively.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<Record<string, unknown>> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // The dual-mode rule: this whole surface must be host-free.
  expect(r.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  if (typeof exports._start === "function") exports._start();
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(exports)) {
    // (#4232) Skip the compiler-reserved `__\0js2_call_fn_method_argc_<n>`
    // host-bridge exports — an exact-shape sweep that includes them breaks on
    // cost, not semantics.
    if (name !== "_start" && typeof fn === "function" && !name.includes("\0")) out[name] = fn();
  }
  return out;
}

// A tag-bearing user class is present in essentially every test262 program
// (the harness injects `class Test262Error`) and it changes which lowering
// fires, so keep one here too.
const PRELUDE = `
class Marker { x: number = 1; }
const marker = new Marker();
`;

describe("#4248 — builtin prototype OWN properties (standalone)", () => {
  it("Number.prototype owns its §21.1.3 methods and `constructor`", async () => {
    const out = await runStandalone(`${PRELUDE}
export function toStringOwn(): boolean { return Number.prototype.hasOwnProperty("toString"); }
export function valueOfOwn(): boolean { return Number.prototype.hasOwnProperty("valueOf"); }
export function toFixedOwn(): boolean { return Number.prototype.hasOwnProperty("toFixed"); }
export function toPrecisionOwn(): boolean { return Number.prototype.hasOwnProperty("toPrecision"); }
export function toExponentialOwn(): boolean { return Number.prototype.hasOwnProperty("toExponential"); }
export function toLocaleStringOwn(): boolean { return Number.prototype.hasOwnProperty("toLocaleString"); }
export function constructorOwn(): boolean { return Number.prototype.hasOwnProperty("constructor"); }
// Negative cases — see the header: a length-blind or always-true scan passes
// every assertion above and fails exactly these three.
export function unknownNotOwn(): boolean { return Number.prototype.hasOwnProperty("zzz"); }
export function prefixNotOwn(): boolean { return Number.prototype.hasOwnProperty("toStrin"); }
export function extensionNotOwn(): boolean { return Number.prototype.hasOwnProperty("toStringX"); }
`);
    expect(out).toEqual({
      toStringOwn: 1,
      valueOfOwn: 1,
      toFixedOwn: 1,
      toPrecisionOwn: 1,
      toExponentialOwn: 1,
      toLocaleStringOwn: 1,
      constructorOwn: 1,
      unknownNotOwn: 0,
      prefixNotOwn: 0,
      extensionNotOwn: 0,
    });
  });

  it("Boolean.prototype and String.prototype answer from their OWN member set", async () => {
    const out = await runStandalone(`${PRELUDE}
export function boolToString(): boolean { return Boolean.prototype.hasOwnProperty("toString"); }
export function boolValueOf(): boolean { return Boolean.prototype.hasOwnProperty("valueOf"); }
// Cross-brand miss: Number's member set must not leak into Boolean's.
export function boolNotToFixed(): boolean { return Boolean.prototype.hasOwnProperty("toFixed"); }
export function strCharAt(): boolean { return String.prototype.hasOwnProperty("charAt"); }
// A member at the END of a long CSV — the token scan must reach the last one.
export function strValueOf(): boolean { return String.prototype.hasOwnProperty("valueOf"); }
export function strNotToFixed(): boolean { return String.prototype.hasOwnProperty("toFixed"); }
`);
    expect(out).toEqual({
      boolToString: 1,
      boolValueOf: 1,
      boolNotToFixed: 0,
      strCharAt: 1,
      strValueOf: 1,
      strNotToFixed: 0,
    });
  });

  it("the REFLECTIVE spelling agrees — this is the one verifyProperty uses", async () => {
    const out = await runStandalone(`${PRELUDE}
export function reflectiveHit(): boolean { return Object.prototype.hasOwnProperty.call(Number.prototype, "valueOf"); }
export function reflectiveMiss(): boolean { return Object.prototype.hasOwnProperty.call(Number.prototype, "nope"); }
export function reflectiveCtor(): boolean { return Object.prototype.hasOwnProperty.call(Boolean.prototype, "constructor"); }
`);
    expect(out).toEqual({ reflectiveHit: 1, reflectiveMiss: 0, reflectiveCtor: 1 });
  });

  it("ordinary objects and wrapper INSTANCES are unaffected (consult-only)", async () => {
    const out = await runStandalone(`${PRELUDE}
export function plainObjectsUnaffected(): boolean {
  const o: any = { a: 1 };
  return o.hasOwnProperty("a") === true && o.hasOwnProperty("b") === false;
}
// §21.1.5 — a Number INSTANCE has no own properties beyond its slot; the
// prototype's members stay on the prototype.
export function instanceOwnsNothing(): boolean {
  const n: any = new Number(5);
  return n.hasOwnProperty("toString") === false;
}
`);
    expect(out).toEqual({ plainObjectsUnaffected: 1, instanceOwnsNothing: 1 });
  });
});
