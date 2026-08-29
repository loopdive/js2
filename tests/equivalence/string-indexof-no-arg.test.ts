import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// §22.1.3.9 runs `ToString(searchString)`, so `indexOf()` with no argument
// searches for the string "undefined". In the gc (JS-host) lane the absent
// externref search slot used to be padded with `ref.null.extern`, so the host
// searched for "null" instead and `"aundefinedb".indexOf()` answered -1 rather
// than 1. `lastIndexOf` was already on the pad-as-undefined list and was
// therefore already correct — the asymmetry that identified the defect.
//
// Modelled on array-at-no-arg.test.ts (#5095) and array-indexof-no-arg.test.ts
// (#5121), the two sibling files for this same missing-argument-default shape.
//
// TypeScript types `indexOf` as requiring its argument, so the zero-argument
// form is only writable where the harness tolerates the diagnostic — return
// position. (test262 is plain JS and has no such constraint.)
describe("String.prototype.indexOf with no argument", () => {
  it('finds "undefined" in a receiver that contains it', async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        return s.indexOf();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('answers -1 when the receiver does not contain "undefined"', async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "abc";
        return s.indexOf();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('does not search for "null" — a receiver containing only "null" misses', async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "anullb";
        return s.indexOf();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("agrees with the indexOf(undefined) spelling", async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        return (s.indexOf() === s.indexOf(undefined) ? 100 : 0) + s.indexOf();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('agrees with the explicit "undefined" string spelling', async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        return (s.indexOf() === s.indexOf("undefined") ? 100 : 0) + s.indexOf();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("works on a string literal receiver", async () => {
    await assertEquivalent(
      `export function test(): number {
        return "aundefinedb".indexOf();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("finds a later occurrence when the receiver starts with it", async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "undefined";
        return s.indexOf();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("keeps lastIndexOf, already correct, agreeing with indexOf here", async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        return s.lastIndexOf() * 10 + s.indexOf();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("leaves an explicit search argument unchanged", async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        return s.indexOf("b") * 100 + s.indexOf("n", 5) * 10 + s.indexOf("zz");
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("keeps the omitted fromIndex spec-equivalent for a one-argument call", async () => {
    // ToIntegerOrInfinity(undefined) and ToIntegerOrInfinity(null) are both +0,
    // so padding indexOf's boxed fromIndex slot with `undefined` rather than
    // `null` must not move any value.
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        var needles: string[] = ["b", "n", "zz"];
        return s.indexOf(needles[0]) * 100 + s.indexOf(needles[1]) * 10 + s.indexOf(needles[2]);
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
