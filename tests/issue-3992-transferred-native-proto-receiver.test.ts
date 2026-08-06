// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3992 — a TRANSFERRED native-proto method must receive its receiver.
//
// The test262 idiom for a generic receiver is a transfer, not `.call`:
//
//     var o = new Object(true);
//     o.toLowerCase = String.prototype.toLowerCase;
//     o.toLowerCase();            // "true"
//
// Native-proto method closures are lifted as `(self, thisValue, arg0 … )`, but
// `__call_fn_method_N`'s generic dispatch fills every closure param from the
// argument vector and publishes the receiver only via `__current_this`. So the
// arguments shifted one slot left and the call answered a silently wrong
// `null`. `charAt` and `substring` were the only members that worked, because
// each had its OWN hand-written correction arm; this test pins the generic
// behaviour so the next member does not need a third clone.
//
// Deliberate choices, each of which produced a wrong answer during the
// investigation:
//
//  1. **No `as any` casts on the receiver or the method value.** test262 has
//     none, and a cast can defeat the very type gate under test.
//  2. **Numeric return codes only.** A `string` returned from an exported
//     standalone function does not marshal across the JS boundary — it comes
//     back `undefined` for every case including the positive control. Every
//     assertion is therefore made INSIDE the module and reported as a number.
//  3. **Every expectation below is the value Node produces** for the same
//     source, so a failure means a compiler defect and not a wrong assertion.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile standalone and return the module's own numeric verdict. */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

/**
 * 3 = the spec value · 2 = `null` (the pre-#3992 silent-wrong answer) ·
 * 1 = undefined · 0 = threw · 4/5/6 = some other wrong value.
 *
 * Distinguishing 2 from 0 and 4 is the point: the bug was a silently WRONG
 * value, and a naive `!== expected` check cannot tell a fixed path from one
 * that merely changed which wrong answer it gives.
 */
const OUTCOME = `
  function outcome(thunk: () => any, want: any): number {
    let r: any;
    try { r = thunk(); } catch (e) { return 0; }
    if (r === want) return 3;
    if (r === undefined) return 1;
    if (r === null) return 2;
    if (typeof r === "string") return 4;
    if (typeof r === "number") return 5;
    return 6;
  }
`;

async function transferred(member: string, call: string, want: string): Promise<number> {
  return runStandalone(`
    ${OUTCOME}
    export function f(): number {
      const o = new Object(true);
      o.${member} = String.prototype.${member};
      return outcome(() => o.${call}, ${want});
    }
  `);
}

describe("#3992 transferred native-proto methods keep their receiver", () => {
  // The case-conversion family is the largest transferred-receiver group in
  // built-ins/String/prototype and had NO hand-written arm, so all four were
  // silently `null` before this fix.
  for (const m of ["toLowerCase", "toLocaleLowerCase"]) {
    it(`${m} ToStrings the transferred receiver`, async () => {
      expect(await transferred(m, `${m}()`, '"true"')).toBe(3);
    });
  }
  for (const m of ["toUpperCase", "toLocaleUpperCase"]) {
    it(`${m} ToStrings the transferred receiver`, async () => {
      expect(await transferred(m, `${m}()`, '"TRUE"')).toBe(3);
    });
  }

  it("charCodeAt reads the receiver, not the argument slot", async () => {
    // Regression pin for the SECOND defect: with only the dispatch repaired
    // this returned 91 — the char code of "[" from "[object Object]" — because
    // ToString(this) skipped ToPrimitive on an object receiver. 116 is "t".
    expect(await transferred("charCodeAt", "charCodeAt(0)", "116")).toBe(3);
  });

  it("indexOf works when the call UNDER-APPLIES the declared arg slots", async () => {
    // `indexOf` carries 2 param slots (the uncounted optional `position`) while
    // the ordinary call site passes 1, so the receiver arm must pad the missing
    // trailing slot rather than decline the closure.
    expect(await transferred("indexOf", 'indexOf("r")', "1")).toBe(3);
  });

  it("indexOf also works at its exact declared arity", async () => {
    expect(await transferred("indexOf", 'indexOf("r", 0)', "1")).toBe(3);
  });

  it("lastIndexOf keeps the receiver", async () => {
    expect(await transferred("lastIndexOf", 'lastIndexOf("u")', "2")).toBe(3);
  });

  // NOTE on a receiver shape this fix deliberately does NOT claim: an
  // OBJECT-LITERAL receiver carrying its own `toString`
  // (`{ toString: function () { return "AB"; } }`) still answers `null` for a
  // transferred member. That is a different route — the literal lowers to a
  // closed struct whose member call never reaches `__apply_closure` — and it is
  // equally broken on `upstream/main`, so it is a pre-existing gap, not a
  // regression. It is recorded as a follow-up in the issue file rather than
  // asserted here in either direction: pinning it as "still 2" would fail the
  // day someone fixes it, and asserting 3 would overclaim this change.
  //
  // ToPrimitive coverage is instead carried by the `charCodeAt` case above,
  // which is the decisive evidence: `new Object(true)` is a Boolean wrapper, so
  // `ToPrimitive(o, "string")` must run its inherited `toString` to reach
  // "true" (116 = "t"). Without the ToPrimitive step the receiver stringified
  // structurally to "[object Object]" and the same call returned 91 ("[").

  it("the two previously hand-wired members still work", async () => {
    // charAt and substring had bespoke arms that this change generalizes away
    // from; they must not regress.
    expect(await transferred("charAt", "charAt(1)", '"r"')).toBe(3);
    expect(await transferred("substring", "substring(1)", '"rue"')).toBe(3);
  });

  it("an unwired member refuses LOUDLY rather than answering null", async () => {
    // `slice` has no reflective body yet. The acceptance bar for this issue is
    // that no path silently answers `null`: an honest throw is a correct
    // outcome, `null` is not.
    expect(await transferred("slice", "slice(1)", '"rue"')).not.toBe(2);
  });
});
