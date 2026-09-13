// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6447 — `Array.prototype.concat` / `.sort` on an `any`-typed receiver under
// `--target standalone`.
//
// WHY THIS REDUCTION EXISTS. The defect was found through the compiled
// `@js-temporal/polyfill` provider (#5383 S10), where EVERY property-bag entry
// point — `PlainDate.from(bag)`, `PlainDate.compare(bag, ·)`,
// `ZonedDateTime.equals(bag)`, `plainDate.with(bag)` — died with
// `TypeError: Cannot read properties of undefined (reading 'sort')`. The
// provider is a 3.3 MB compile, so it is not the regression test; this is. The
// polyfill statement behind all four is one line of `PrepareCalendarFields`:
//
//     const i = Xt(e).extraFields(n), a = n.concat(r, i);  …  a.sort();
//
// `n` is an untyped parameter, so `n.concat(...)` was lowered through the
// closed-method dispatcher `__call_m_concat_2`, which had no `$__vec_base`
// brand arm for the producer methods and fell to `__extern_method_call` — a
// helper whose own comment records that it "return[s] undefined here for now"
// for every non-`$Object` brand. Hence `a === undefined` and the `.sort()` read
// raised.
//
// The three-line shape at the bottom of this file is the whole bug. It is
// asserted for BOTH members because they compose: fixing `concat` alone moves
// the failure one statement later onto a `sort` that is broken the same way.
//
// NOT covered here, on purpose: `slice`, `reverse`, `includes`, `splice` and
// `flat` share the identical root cause and are still wrong on an `any`
// receiver. They are named in #6447 with this same reduction; each needs its
// own species / hole-semantics review and none of them is on the attributed
// path, so widening the arm to them was deliberately left out of this slice
// rather than forgotten. The `it` at the end PINS that residual, so the day
// someone fixes them the stale expectation fails loudly instead of rotting.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const STANDALONE = {
  target: "standalone" as const,
  hostBridge: "off" as const,
  fileName: "/p.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
};

/**
 * Compile `source` standalone, instantiate with an EMPTY import object (so a
 * leaked host import fails the test rather than being papered over), and run
 * the exported `run`.
 */
async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, STANDALONE);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message}`);
  const binary = result.binary as Uint8Array;
  const module = await WebAssembly.compile(binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return Number((instance.exports as { run: () => number }).run());
}

describe("#6447 — Array producer methods on an `any` receiver, standalone", () => {
  it("concat through an untyped parameter keeps every element", async () => {
    // Base tree: 0 (an object that is neither the concatenation nor an Array).
    await expect(
      runStandalone(
        `export function run() { function f(n, r) { const i = []; const a = n.concat(r, i); return a.length; }
         return f(["a", "b"], ["c"]); }`,
      ),
    ).resolves.toBe(3);
  });

  it("concat through an untyped parameter keeps element IDENTITY, not just the count", async () => {
    // A length-only assertion would pass on an empty-but-right-sized carrier.
    await expect(
      runStandalone(
        `export function run() { function f(n, r) { const a = n.concat(r); return (a[0] === "a" && a[1] === "b" && a[2] === "c") ? 1 : 0; }
         return f(["a", "b"], ["c"]); }`,
      ),
    ).resolves.toBe(1);
  });

  it("concat spreads array arguments and appends non-array ones (§23.1.3.1)", async () => {
    await expect(
      runStandalone(
        `export function run() { function f(n, r, x) { const a = n.concat(r, x); return (a.length === 4 && a[2] === "c" && a[3] === "z") ? 1 : 0; }
         return f(["a", "b"], ["c"], "z"); }`,
      ),
    ).resolves.toBe(1);
  });

  it("sort through an untyped parameter orders by ToString and returns the receiver", async () => {
    // Base tree: the sort was a no-op and answered `undefined`.
    await expect(
      runStandalone(
        `export function run() { function f(n) { const a = n.sort(); return (a[0] === "a" && a[1] === "b" && a[2] === "c") ? 1 : 0; }
         return f(["c", "a", "b"]); }`,
      ),
    ).resolves.toBe(1);
  });

  it("sort honours a comparator on an untyped receiver", async () => {
    await expect(
      runStandalone(
        `export function run() { function f(n) { const a = n.sort((x, y) => y - x); return (a[0] === 30 && a[1] === 20 && a[2] === 10) ? 1 : 0; }
         return f([10, 30, 20]); }`,
      ),
    ).resolves.toBe(1);
  });

  it("sort moves `undefined` elements to the end (§23.1.3.30 steps 1–3)", async () => {
    await expect(
      runStandalone(
        `export function run() { function f(n) { const a = n.sort(); return (a[0] === "a" && a[1] === "b" && a[2] === undefined) ? 1 : 0; }
         return f(["b", undefined, "a"]); }`,
      ),
    ).resolves.toBe(1);
  });

  it("the exact polyfill shape — `concat` then `sort` then an indexed walk", async () => {
    // `PrepareCalendarFields`, reduced. On the base tree this threw
    // `Cannot read properties of undefined (reading 'sort')`, which is the
    // literal text 24 rows of the S9 linked Temporal sample reported.
    await expect(
      runStandalone(
        `export function run() {
           const tt = { year: 0, month: 1, day: 1 };
           function prepare(bag, names, extra) {
             const i = [];
             const a = names.concat(extra, i);
             const out = Object.create(null);
             a.sort();
             let seen = 0;
             for (let e = 0; e < a.length; e++) {
               const k = a[e];
               const v = bag[k];
               if (v !== undefined) { seen++; out[k] = v; } else { out[k] = tt[k]; }
             }
             return seen * 10 + a.length;
           }
           return prepare({ year: 1976, month: 11, day: 18 }, ["day", "month"], ["year"]);
         }`,
      ),
    ).resolves.toBe(33);
  });

  it("a user object with its OWN concat still wins over the vec arm", async () => {
    // The arm sits UNDER the closed-struct arms; this is what proves it.
    await expect(
      runStandalone(
        `export function run() { const o = { concat(x) { return 7; } }; function f(n, r) { return n.concat(r); }
         return f(o, [1]); }`,
      ),
    ).resolves.toBe(7);
  });

  it("PINS the residual: slice/reverse/splice/flat on an `any` receiver are still WRONG", async () => {
    // Deliberately out of this slice (#6447 "Implementation Plan" step 2). When
    // one of these is fixed this assertion fails and must be updated — that is
    // the point: the residual is recorded as an executable claim, not a note.
    await expect(
      runStandalone(
        `export function run() {
           function f(n) {
             let wrong = 0;
             try { if (n.slice().length !== 2) wrong += 1; } catch (e) { wrong += 1; }
             try { if (n.reverse()[0] !== "a") wrong += 2; } catch (e) { wrong += 2; }
             try { if (n.flat().length !== 2) wrong += 4; } catch (e) { wrong += 4; }
             return wrong;
           }
           return f(["b", "a"]);
         }`,
      ),
    ).resolves.toBe(7);
  });
});
