// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S1c — the propagation lattice models a value-returning body that can
// FALL OUT (tail `switch` without `default`) as returning the dynamic carrier,
// exactly as the selector resolves it and legacy registers it
// (`(result externref)`). Before, the checker's non-strict seed collapsed
// `string | undefined` to `string`, so a caller's `var basic = fmt(v)` was
// seen as a string by the lattice and as dynamic by the selector, and the
// move-only scan rejected `return basic` (assert.js's `formatSimpleValue`).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports[name] as () => number)();
}

describe("#7106 — fall-out returns propagate as dynamic", () => {
  it("a caller returning the fall-out callee's result ships an IR body and sees undefined", async () => {
    const result = await compile(
      `
        function fmt(v) { switch (typeof v) { case "string": return "s:" + v; case "number": return "n"; } }
        function pick(v) { var basic = fmt(v); return basic; }
        export function ok() {
          var n = 0;
          if (pick("a") === "s:a") n += 1;
          if (pick(7) === "n") n += 2;
          if (pick({}) === undefined) n += 4;
          if (pick(undefined) === undefined) n += 8;
          return n;
        }
      `,
      {
        experimentalIR: true,
        skipSemanticDiagnostics: true,
        allowJs: true,
        target: "standalone",
        trackIrOutcomes: true,
        fileName: "issue-7106-fallout.js",
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const irBodies = (result.irOutcomes ?? [])
      .filter((o) => o.kind === "emitted" && o.irBodyEmitted)
      .map((o) => o.displayName);
    expect(irBodies, JSON.stringify(result.irOutcomes, null, 2)).toContain("fmt");
    expect(irBodies).toContain("pick");
    expect(await call(result.binary, "ok")).toBe(15);
  });
});
