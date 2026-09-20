// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6645 (#5383 S68) — a SPREAD into a member-expression callee, host-free.
//
// Two distinct arms mis-bind, and the four test262 rows need both:
//
//  1. **A positional argument AFTER a spread** — `o.m(a, ...src, b)`. The
//     resolved-method arm IS spread-aware (#6616) but binds formals by
//     `compileSpreadCallArgs`'s static accounting, which assumes the spread
//     covers exactly the slots left over once the trailing positionals are
//     reserved. `src.length` is a RUNTIME number, so the trailing argument is
//     bound to the WRONG formal. Measured against the real provider
//     (`.tmp/s68/probes/e2.js`): `TemporalHelpers.assertPlainDate(D, ...EXP,
//     "desc")` failed as `year result: SameValue(«2000», «"desc"»)` — the
//     `year` formal received the trailing string.
//  2. **A spread into a callable PROPERTY** — the arm that claims a method the
//     compiler cannot resolve to a struct function. Both of its paths marshal
//     one local per AST node, so the source array arrives as formal ZERO.
//     Measured (`.tmp/s68/probes/ea.js`):
//     `TemporalHelpers.checkStaticInvalidReceiver(...[Ctor,"from",["x"],fn])`
//     threw `Cannot read properties of undefined (reading 'apply')` —
//     `construct[method]` evaluated on the ARRAY — while the same call with
//     the four arguments written out ran both `Ctor.from` and the callback.
//
// The row symptom was `Test262Error: Expected SameValue(«null», «undefined»)`,
// which is `canonicalizeCalendarEra`'s `assert.sameValue(eraName, undefined)`
// (defect 1, a misbound `era`) and `assert.sameValue(Object.getPrototypeOf(
// result), construct.prototype)` (defect 2, `construct` being the array). The
// provider's OWN `.era` read was never wrong: measured through eight different
// routes — `from`, `from.apply`, `C["from"](...)`, a subclass, a property
// descriptor — it answered `undefined` every time (`.tmp/s68/probes/e4.js`).
//
// **Residual, measured and NOT fixed**: a spread with NO trailing argument
// into a resolved method whose remaining formal has a DEFAULT does not apply
// that default. `NS.take(1, ...[2000, 5])` with `take(a, b, c, e = "DEF")`
// answers `number/2000/5/NULL` on BOTH trees (`.tmp/s68/r/t2.mts`) — the
// unfilled formal gets a typed null instead of `"DEF"`. It is the same
// null-for-undefined family as the row symptom, in the arm this slice
// deliberately does not claim, and it is recorded in #6645 for the next lane.
//
// Host-free (`target: "standalone"`, empty import object) so every value
// crosses purely in Wasm.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` host-free and report whether `answer` matched `expected`. */
async function matches(body: string, expected: string): Promise<boolean> {
  const source = `
    function describe(v: any): string {
      if (v === null) return "NULL";
      if (v === undefined) return "UNDEF";
      if (Array.isArray(v)) return "arr" + v.length;
      return typeof v;
    }
    var answer: any = "<not run>";
    ${body}
    export function test(): number {
      return String(answer) === ${JSON.stringify(expected)} ? 1 : 0;
    }
  `;
  const result = await compile(source, { fileName: "issue-6645.ts", target: "standalone" });
  expect(
    result.success,
    result.errors
      .filter((error) => error.severity !== "warning")
      .map((error) => `L${error.line}: ${error.message}`)
      .join("\n"),
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test() === 1;
}

describe("#6645 a spread into a member callee binds the right formals", () => {
  it("binds a positional argument that FOLLOWS a spread", async () => {
    expect(
      await matches(
        `
        var NS = {
          take(a: any, b: any, c: any, e: any, f: any = "DEF", g: any = undefined): any {
            return [describe(a), b, c, e, describe(f), describe(g)].join("/");
          },
        };
        var SRC: any[] = [2000, 5, "M05"];
        answer = NS.take(1, ...SRC, "desc");
        `,
        "number/2000/5/M05/string/UNDEF",
      ),
    ).toBe(true);
  });

  it("leaves the DEFAULTED formals after a trailing-spread call undefined", async () => {
    // The row symptom: the misbound formal was `era`, whose default is
    // `undefined`; it arrived holding the trailing argument instead.
    expect(
      await matches(
        `
        var NS = {
          take(a: any, b: any, c: any, d: any = undefined, e: any = undefined): any {
            return [describe(a), describe(b), describe(c), describe(d), describe(e)].join("/");
          },
        };
        var SRC: any[] = [7];
        answer = NS.take(1, ...SRC, "desc");
        `,
        "number/number/string/UNDEF/UNDEF",
      ),
    ).toBe(true);
  });

  it("control — a spread into a callable PROPERTY of an object is unchanged", async () => {
    // The callable-property arm's OWN defect needed the real provider to
    // reproduce (`.tmp/s68/probes/ea.js`; the row evidence is
    // `PlainDate|Duration/from/subclassing-ignored.js`, which flip to pass with
    // that splice alone). This synthetic passes on both trees and is kept as a
    // control over the splice that was added there.
    expect(
      await matches(
        `
        function impl(a: any, b: any, c: any): any {
          return [describe(a), describe(b), describe(c)].join("/");
        }
        var NS: any = {};
        NS.run = impl;
        var SRC: any[] = [1, "s", [2]];
        answer = NS.run(...SRC);
        `,
        "number/string/arr1",
      ),
    ).toBe(true);
  });

  it("control — the same call written out is unchanged", async () => {
    expect(
      await matches(
        `
        var NS = {
          take(a: any, b: any, c: any, e: any, f: any = "DEF", g: any = undefined): any {
            return [describe(a), b, c, e, describe(f), describe(g)].join("/");
          },
        };
        answer = NS.take(1, 2000, 5, "M05", "desc");
        `,
        "number/2000/5/M05/string/UNDEF",
      ),
    ).toBe(true);
  });
});
