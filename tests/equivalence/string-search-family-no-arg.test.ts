import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #5160 — zero-argument `includes()`, `startsWith()` and `search()`. In the gc
// (JS-host) lane the absent externref search slot used to be padded with
// `ref.null.extern`, so the host searched for "null" (includes/startsWith) or
// built `RegExp(null)` = /null/ (search) instead of applying the spec default.
//
// includes/startsWith are §22.1.3.14/§22.1.3.23 ToString cases: an absent
// argument becomes the string "undefined". `search` is NOT — §22.1.3.19 routes
// it through `RegExp(undefined)`, the EMPTY regexp `/(?:)/`, which matches at 0
// for every receiver. Both behaviours are checked against real JS here.
//
// Sibling of string-indexof-no-arg.test.ts (#5155), which fixed `indexOf` from
// the same `padsUndefined` list.
//
// TypeScript types these methods as requiring their argument, so the
// zero-argument form is only writable where the harness tolerates the
// diagnostic — return position. (test262 is plain JS and has no such
// constraint.)
describe("String.prototype includes/startsWith/search with no argument", () => {
  it('includes() finds "undefined" in a receiver that contains it', async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        return s.includes() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('includes() is false when the receiver does not contain "undefined"', async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "abc";
        return s.includes() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('includes() does not search for "null"', async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "anullb";
        return s.includes() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("includes() agrees with the includes(undefined) spelling", async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        return (s.includes() === s.includes(undefined) ? 100 : 0) + (s.includes() ? 1 : 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('startsWith() matches a receiver that begins with "undefined"', async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "undefinedb";
        return s.startsWith() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('startsWith() is false when "undefined" is present but not at the start', async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        return s.startsWith() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('startsWith() does not search for "null"', async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "nullb";
        return s.startsWith() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it('startsWith() agrees with the explicit "undefined" string spelling', async () => {
    // The `startsWith(undefined)` spelling does not typecheck under this
    // harness (it does not set `skipSemanticDiagnostics`), so the byte-identity
    // pin against it lives in tests/issue-5160-padsundefined-siblings.test.ts.
    // Here the equivalent ToString target is asserted against real JS instead.
    await assertEquivalent(
      `export function test(): number {
        var s: string = "undefinedb";
        return (s.startsWith() === s.startsWith("undefined") ? 100 : 0) + (s.startsWith() ? 1 : 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("search() matches at 0 via the empty regexp, whatever the receiver holds", async () => {
    // The distinguishing property: not a "undefined" substring search. All
    // three receivers answer 0 — including one with no "undefined" in it and
    // one that is empty.
    await assertEquivalent(
      `export function test(): number {
        var a: string = "aundefinedb";
        var b: string = "abc";
        var c: string = "";
        return a.search() * 100 + b.search() * 10 + c.search();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("search() does not build RegExp(null)", async () => {
    // /null/ would match this receiver at 1; /(?:)/ matches at 0.
    await assertEquivalent(
      `export function test(): number {
        var s: string = "anullb";
        return s.search();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("search() agrees with the search(undefined) spelling", async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        return (s.search() === s.search(undefined) ? 100 : 0) + s.search();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("leaves explicit arguments unchanged across all three", async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        return (s.includes("b") ? 1000 : 0) + (s.startsWith("a") ? 100 : 0) + s.search(/b/);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("keeps the omitted position slot of a one-argument call unchanged", async () => {
    await assertEquivalent(
      `export function test(): number {
        var s: string = "aundefinedb";
        var needles: string[] = ["b", "zz", "a"];
        return (s.includes(needles[0]) ? 1000 : 0)
          + (s.includes(needles[1]) ? 100 : 0)
          + (s.startsWith(needles[2]) ? 10 : 0)
          + (s.startsWith(needles[1]) ? 1 : 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
