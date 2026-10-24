// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S1c — assert.js's `formatSimpleValue` ships an IR body: a dynamic local
// returned into a string-registered result recovers its carrier through
// `dyn.string_carrier` (legacy's `coerceType(externref → $AnyString)` ladder),
// and `err.name === 'TypeError'` on the catch binding is admitted in a
// value-used function (the thrown payload is never a callback-boundary carrier).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports[name] as () => number)();
}

function irBodies(result: Awaited<ReturnType<typeof compile>>): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

describe("#7106 S1c — formatSimpleValue through dyn.string_carrier", () => {
  it("the verbatim assert.js formatSimpleValue, value-used like the harness, ships an IR body and runs", async () => {
    const result = await compile(
      `
        function isNegativeZero(v) { return v === 0 && 1 / v === -Infinity; }
        function formatIdentityFreeValue(value) {
          switch (value === null ? 'null' : typeof value) {
            case 'string':
              return typeof JSON !== "undefined" ? JSON.stringify(value) : '"' + value + '"';
            case 'number':
              if (isNegativeZero(value)) return '-0';
            case 'boolean':
            case 'undefined':
            case 'null':
              return String(value);
          }
        }
        function formatSimpleValue(value) {
          var basic = formatIdentityFreeValue(value);
          if (basic) return basic;
          try {
            return String(value);
          } catch (err) {
            if (err.name === 'TypeError') {
              return Object.prototype.toString.call(value);
            }
            throw err;
          }
        }
        var holder = {};
        holder.fmt = formatSimpleValue;
        export function ok() {
          var n = 0;
          if (formatSimpleValue("a") === '"a"') n += 1;
          if (formatSimpleValue(5) === "5") n += 2;
          if (formatSimpleValue(undefined) === "undefined") n += 4;
          if (formatSimpleValue(null) === "null") n += 8;
          if (formatSimpleValue({ toString: function () { throw new TypeError("no"); } }) === "[object Object]") n += 16;
          if (holder.fmt(true) === "true") n += 32;
          return n;
        }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1c-format-simple-value.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("formatSimpleValue");
    expect(await call(result.binary, "ok")).toBe(63);
  });

  it("a dynamic value that is not a string returns the null carrier like legacy", async () => {
    // Legacy registers `pick` as string-returning and its ladder yields null
    // for a non-string carrier; the IR takes the same ladder.
    const result = await compile(
      `
        function fmt(v) { switch (typeof v) { case "string": return "s:" + v; } }
        function pick(v) { var b = fmt(v); if (b) return b; return "z"; }
        export function ok() { return pick("a") === "s:a" && pick(1) === "z" && pick(undefined) === "z" ? 1 : 0; }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1c-carrier-null.js" },
    );
    expect(result.success).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("pick");
    expect(await call(result.binary, "ok")).toBe(1);
  });
});
