// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 3b — `dyn || v` / `dyn && v` as a VALUE (the Test262Error
// constructor's `message || ""`) lowers through `dyn.truthy` + a dynamic-result
// `if` instead of demoting the function with `logical-value-unsupported`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

async function compileStandalone(source: string, fileName: string) {
  const result = await compile(source, { ...OPTIONS, fileName });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports[name] as () => number)();
}

function irBodies(result: Awaited<ReturnType<typeof compile>>): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

// Callers pass `undefined`/`null` alongside primitives so the parameter's
// propagated type is DYNAMIC; a union of primitives alone is #2135's shape and
// stays rejected pre-claim (`param-type-not-resolvable`), unchanged here.
describe("#7106 S3b — dynamic `||` / `&&` value", () => {
  it('`m || ""` (the Test262Error message default) selects the left carrier or the boxed literal', async () => {
    const result = await compileStandalone(
      `
        function orDefault(m) { return m || ""; }
        export function ok() {
          var n = 0;
          if (orDefault("x") === "x") n += 1;
          if (orDefault(0) === "") n += 2;
          if (orDefault(undefined) === "") n += 4;
          if (orDefault(5) === 5) n += 8;
          if (orDefault(null) === "") n += 16;
          return n;
        }
      `,
      "issue-7106-s3b-or.js",
    );
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("orDefault");
    expect(await call(result.binary, "ok")).toBe(31);
  });

  it("`a && b` with two dynamic parameters and a `var` alias", async () => {
    const result = await compileStandalone(
      `
        function andPick(a, b) { var v = a && b; return v; }
        export function ok() {
          var n = 0;
          if (andPick(0, 1) === 0) n += 1;
          if (andPick(1, "y") === "y") n += 2;
          if (andPick("", 7) === "") n += 4;
          if (andPick(true, false) === false) n += 8;
          if (andPick(undefined, 1) === undefined) n += 16;
          if (andPick(1, undefined) === undefined) n += 32;
          return n;
        }
      `,
      "issue-7106-s3b-and.js",
    );
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("andPick");
    expect(await call(result.binary, "ok")).toBe(63);
  });

  it("evaluates the right operand only when the left does not decide (short circuit)", async () => {
    const result = await compileStandalone(
      `
        var hits = 0;
        function bump() { hits = hits + 1; return 1; }
        function orCall(m) { return m || bump(); }
        export function ok() {
          orCall(1);
          orCall(0);
          return hits;
        }
      `,
      "issue-7106-s3b-short-circuit.js",
    );
    expect(await call(result.binary, "ok")).toBe(1);
  });

  it('keeps the boolean position working: `if (m || "")` in a numeric function', async () => {
    const result = await compileStandalone(
      `
        function pick(m) { var r = 2; if (m || "") r = 1; return r; }
        export function ok() { return pick(0) * 100 + pick("z") * 10 + pick(undefined); }
      `,
      "issue-7106-s3b-cond.js",
    );
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("pick");
    expect(await call(result.binary, "ok")).toBe(212);
  });
});
