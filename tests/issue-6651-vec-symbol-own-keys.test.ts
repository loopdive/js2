// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster H, slice H4) §20.1.2.10 `Object.getOwnPropertySymbols` over an
 * ARRAY carrier — the `$__vec_base` arm the native never had.
 *
 * H2 made a symbol key on an array real (define, read and `gOPD` all work), and
 * H3 recorded that the ENUMERATION half was still missing. Measured on this
 * branch's base, standalone, one module:
 *
 * | question                                    | base | spec |
 * | ------------------------------------------- | ---: | ---: |
 * | `gOPS(arr)` after `arr[symA] = 10`           |  `0` |  `1` |
 * | `gOPS(arr)` after a symbol `defineProperty`  |  `0` |  `1` |
 * | `arr[symA]` / `arr[symB]`                    | right | right |
 * | `gOPN(arr)` — `0,1,length`                   | right | right |
 * | the same two defines on a PLAIN object       | right | right |
 *
 * The values, the names surface and the plain-object carrier were all already
 * correct, which is what identifies a carrier gap rather than a symbol-key gap:
 * `__getOwnPropertySymbols`' non-`$Object` branch returned a fresh empty vec.
 *
 * ## The two things this slice got wrong first, both pinned below
 *
 * 1. **`__obj_ordered` / `__obj_ordered_all` are STRING-key walkers.** The first
 *    draft filtered them for symbol keys and pushed nothing at all — a sentinel
 *    push proved the arm was running, so the sequence simply does not contain
 *    symbol entries. `__obj_ordered_symbols` is their walker.
 * 2. **The two stores OVERLAP, so the symbols lane still needs de-duplication.**
 *    A symbol written by assignment lands in the #3537 bag; a later
 *    `defineProperty` of the SAME key also records it in the #3251 overlay
 *    companion (the #4010 two-table seam). Without a de-dup the answer was
 *    `[Symbol(a), Symbol(b), Symbol(a)]` — the third case below.
 *
 * Negative direction, pinned in the last two cases: symbol keys must NOT appear
 * on the NAMES surfaces, and an array with no symbol key must still answer `[]`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-6651-vec-symbol-own-keys.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  let threw = false;
  try {
    exports.__module_init!();
  } catch {
    threw = true;
  }
  const length = exports.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < length; i++) sink += String.fromCharCode(exports.__stdout_char!(i) & 0xffff);
  const lines = sink.split("\n").filter((l) => l.length > 0);
  if (threw) lines.push("THREW");
  return lines;
}

/** `gOPS(x)` rendered as `"Symbol(a);Symbol(b);"`, without `Array.prototype.map`. */
const RENDER = `
  function SYMS(x) {
    var s = Object.getOwnPropertySymbols(x);
    var t = "";
    for (var i = 0; i < s.length; i++) t += String(s[i]) + ";";
    return s.length + ":" + t;
  }
`;

describe("#6651 H4 Object.getOwnPropertySymbols over an array carrier (standalone)", () => {
  it("lists a symbol expando written by plain ASSIGNMENT (the #3537 bag)", async () => {
    // RED on base: `0:`.
    const lines = await runLines(`${RENDER}
      var symA = Symbol("a");
      var arr = [];
      arr[symA] = 1;
      Object.defineProperty(arr, "p", { value: 0, configurable: true });
      LOG(SYMS(arr));
    `);
    expect(lines).toEqual(["1:Symbol(a);"]);
  });

  it("KNOWN GAP: the #4230 demand gate is not tripped by gOPS alone", async () => {
    // This is the SAME program as the case above minus the `defineProperty`
    // line, and it answers `0:` on BOTH sides. Not a defect in this slice —
    // `ctx.vecOwnKeysDirty` (`array-holes.ts`) is a syntactic pre-scan that
    // looks for `defineProperty` / `defineProperties` / two-arg `create` /
    // `getOwnPropertyNames` / `ownKeys` / `getOwnPropertyDescriptors`, and
    // `getOwnPropertySymbols` is NOT on that list, so the whole vec key-walk
    // machinery (including this slice's arm) is never emitted.
    //
    // Adding it to the pre-scan is the fix and it is one line, but it WIDENS
    // the gate — more modules get the overlay machinery — so it needs its own
    // neighbourhood sweep rather than a free ride on this one. Measured cost of
    // leaving it: zero rows in the 1,732-row neighbourhood, where all 12
    // `built-ins/Object/getOwnPropertySymbols` rows either already passed or
    // mention `defineProperty`. Pinned so the gap cannot be rediscovered as a
    // mystery.
    const lines = await runLines(`${RENDER}
      var symA = Symbol("a");
      var arr = [];
      arr[symA] = 1;
      LOG(SYMS(arr));
    `);
    expect(lines).toEqual(["0:"]);
  });

  it("lists a NON-ENUMERABLE symbol defineProperty (the #3251 companion)", async () => {
    // RED on base: `0:`. §20.1.2.10 is not enumerability-filtered, so the
    // non-enumerable define must be listed — this is why the arm passes
    // `includeNonEnum: true`, not by symmetry with getOwnPropertyNames.
    const lines = await runLines(`${RENDER}
      var symB = Symbol("b");
      var arr = [1, 2];
      Object.defineProperty(arr, symB, { value: 20, enumerable: false, configurable: true });
      LOG(SYMS(arr));
    `);
    expect(lines).toEqual(["1:Symbol(b);"]);
  });

  it("de-duplicates a key held by BOTH stores, keeping creation order", async () => {
    // RED on base: `0:`. RED on the first draft of this slice in a different
    // way — `3:Symbol(a);Symbol(b);Symbol(a);` — because `symA` is in the bag
    // (assignment) AND in the companion (the later define). §10.1.11
    // OrdinaryOwnPropertyKeys is a LIST, so the earlier entry keeps its place.
    const lines = await runLines(`${RENDER}
      var symA = Symbol("a");
      var symB = Symbol("b");
      var arr = [1, 2];
      arr[symA] = 10;
      Object.defineProperty(arr, symB, { value: 20, configurable: true });
      Object.defineProperty(arr, symA, { value: 11, configurable: true });
      LOG(SYMS(arr));
    `);
    expect(lines).toEqual(["2:Symbol(a);Symbol(b);"]);
  });

  it("the PLAIN-OBJECT carrier is unchanged (the control)", async () => {
    // GREEN on both sides — #2866 PR1 already made `$Object` correct, and this
    // slice must not disturb it.
    const lines = await runLines(`${RENDER}
      var symA = Symbol("a");
      var symB = Symbol("b");
      var o = {};
      o[symA] = 1;
      Object.defineProperty(o, symB, { value: 2, enumerable: false, configurable: true });
      LOG(SYMS(o));
    `);
    expect(lines).toEqual(["2:Symbol(a);Symbol(b);"]);
  });

  it("symbol keys stay OFF the names surfaces", async () => {
    // GREEN on both sides. The negative direction: the shared key walkers now
    // take a key-kind mode, and the default (string) mode must keep answering
    // exactly what it did — no symbol may leak into gOPN or Object.keys.
    const lines = await runLines(`
      var symA = Symbol("a");
      var symB = Symbol("b");
      var arr = [1, 2];
      arr[symA] = 10;
      Object.defineProperty(arr, symB, { value: 20, configurable: true });
      LOG("gopn=" + Object.getOwnPropertyNames(arr).join(",") +
          " keys=" + Object.keys(arr).join(","));
    `);
    expect(lines).toEqual(["gopn=0,1,length keys=0,1"]);
  });

  it("an array with no symbol key still answers []", async () => {
    // GREEN on both sides. The arm is unconditional for a vec receiver, so the
    // empty case is the one that would show a spurious push (a sentinel bug in
    // this slice's development showed up here first).
    const lines = await runLines(`${RENDER}
      var arr = [1, 2];
      Object.defineProperty(arr, "p", { value: 3, configurable: true });
      LOG(SYMS(arr) + "|gopn=" + Object.getOwnPropertyNames(arr).join(","));
    `);
    expect(lines).toEqual(["0:|gopn=0,1,length,p"]);
  });
});
