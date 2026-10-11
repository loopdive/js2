// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6646 (#5383 S68) — a SPREAD into a DYNAMIC callee, host-free.
//
// Measured against the S67 head with the three changed files file-copy
// reverted (2026-09-20, `.tmp/s68/probes/q1.js`):
//
// | expression | base | fix |
// | --- | --- | --- |
// | `O.fwd(1,"s",[2],fn)`, `fwd(...a){return this.echo(...a)}` | `undefined` | `number/string/object/function/4` |
// | `callSpread(echoF,[1,"s",[2]])`, `callSpread(f,a){return f(...a)}` | `arr3/UNDEF/UNDEF/1` | `number/string/object/3` |
// | `var g=O.echo; g(...[1,"s",[2],4])` | `object/UNDEF/UNDEF/UNDEF/1` | `number/string/object/number/4` |
//
// The last two base answers are the signature of the defect: `arguments.length`
// is 1 and formal ZERO holds the source ARRAY.
//
// The two CONTROLS at the bottom are the load-bearing half. A spread into a
// callee the compiler can RESOLVE was already exact, and the fix is gated so
// those keep their existing lowering — if a future change routes them through
// the new terminal too, these rows say so.
//
// Host-free (`target: "standalone"`, empty import object): every value crosses
// purely in Wasm, with no host decode step that could mask a boundary bug.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile `body` host-free and read back a string verdict.
 *
 * A standalone module cannot hand a string to the host, so the probe compares
 * its own answer against an expected literal and exports a numeric code:
 * 1 = matched, 0 = did not. The MISMATCH branch is what fails the test, which
 * is why each case carries its expected string rather than a boolean.
 */
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
  const result = await compile(source, { fileName: "issue-6646.ts", target: "standalone" });
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

describe("#6646 a spread into a dynamic callee expands at its runtime length", () => {
  it("expands a spread into a callee read off `this` into a LOCAL", async () => {
    expect(
      await matches(
        `
        var O = {
          echo(a: any, b: any, c: any): any {
            return [describe(a), describe(b), describe(c), arguments.length].join("/");
          },
          fwd(...args: any[]): any {
            var f: any = (this as any).echo;
            return f(...args);
          },
        };
        answer = O.fwd(1, "s", [2]);
        `,
        "number/string/arr1/3",
      ),
    ).toBe(true);
  });

  it("expands a spread into a callee held in a PARAMETER", async () => {
    expect(
      await matches(
        `
        function echoF(a: any, b: any, c: any): any {
          return [describe(a), describe(b), describe(c), arguments.length].join("/");
        }
        function callSpread(f: any, a: any[]): any { return f(...a); }
        answer = callSpread(echoF, [1, "s", [2]]);
        `,
        "number/string/arr1/3",
      ),
    ).toBe(true);
  });

  it("expands a spread into a callee held in a VARIABLE read off an object", async () => {
    expect(
      await matches(
        `
        var O = {
          echo(a: any, b: any, c: any, d: any): any {
            return [describe(a), describe(b), describe(c), describe(d), arguments.length].join("/");
          },
        };
        var g: any = O.echo;
        answer = g(...[1, "s", [2], 4]);
        `,
        "number/string/arr1/number/4",
      ),
    ).toBe(true);
  });

  it("mixes fixed arguments with a spread, in order", async () => {
    expect(
      await matches(
        `
        function echoF(a: any, b: any, c: any): any {
          return [describe(a), describe(b), describe(c), arguments.length].join("/");
        }
        function callMixed(f: any, a: any[]): any { return f(1, ...a); }
        answer = callMixed(echoF, ["s", [2]]);
        `,
        "number/string/arr1/3",
      ),
    ).toBe(true);
  });

  // ---- controls: shapes the fix must NOT change -------------------------

  it("control — a spread into a STATIC callee is unchanged", async () => {
    expect(
      await matches(
        `
        function echoF(a: any, b: any, c: any): any {
          return [describe(a), describe(b), describe(c), arguments.length].join("/");
        }
        answer = echoF(...[1, "s", [2]]);
        `,
        "number/string/arr1/3",
      ),
    ).toBe(true);
  });

  it("control — a rest forward into a STATIC callee is unchanged", async () => {
    expect(
      await matches(
        `
        function echoF(a: any, b: any, c: any): any {
          return [describe(a), describe(b), describe(c), arguments.length].join("/");
        }
        function fwdPlain(...args: any[]): any { return echoF(...args); }
        answer = fwdPlain(1, "s", [2]);
        `,
        "number/string/arr1/3",
      ),
    ).toBe(true);
  });

  it("control — a rest forward through `this.<m>(...args)` is unchanged", async () => {
    // Measured on the reverted base: this spelling was ALREADY exact, which is
    // why S67's residual 1 ("a rest-forwarded call does not happen at all")
    // is a MISATTRIBUTION — see the residual section of #6646. Pinned as a
    // control so the fix cannot silently take it over.
    expect(
      await matches(
        `
        var O = {
          fwd(...args: any[]): any { return (this as any).echo(...args); },
          echo(a: any, b: any, c: any, d: any): any {
            return [describe(a), describe(b), describe(c), describe(d)].join("/");
          },
        };
        answer = O.fwd(1, "s", [2], function () {});
        `,
        "number/string/arr1/function",
      ),
    ).toBe(true);
  });

  it("control — a dynamic callee with NO spread is unchanged", async () => {
    expect(
      await matches(
        `
        function echoF(a: any, b: any, c: any): any {
          return [describe(a), describe(b), describe(c), arguments.length].join("/");
        }
        function callPlain(f: any, a: any, b: any, c: any): any { return f(a, b, c); }
        answer = callPlain(echoF, 1, "s", [2]);
        `,
        "number/string/arr1/3",
      ),
    ).toBe(true);
  });
});
