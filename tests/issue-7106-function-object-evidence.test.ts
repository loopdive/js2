// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

const OPTIONS = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

function outcome(result: CompileResult, name: string) {
  const rows = (result.irOutcomes ?? []).filter((row) => row.displayName === name);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function run(result: CompileResult): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as () => void)();
  return (instance.exports.run as () => number)();
}

function memberSource(declaration: string): string {
  return `${declaration}
    subject.equal = function (a, b) { return a === b; };
    export function run(): number { return subject.equal(1, 1) ? 1 : 0; }`;
}

describe("#7106 function-object receiver evidence before claim", () => {
  for (const [name, declaration] of [
    ["missing parameter and result", "function subject(value) { return arguments[0]; }"],
    ["missing parameter", "function subject(value): number { return arguments[0]; }"],
    ["missing result", "function subject(value: number) { return arguments[0]; }"],
  ]) {
    it(`keeps a legacy-owned receiver with ${name} evidence off the claimed path`, async () => {
      const result = await compile(memberSource(declaration!), OPTIONS);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      for (const name of ["run", "<module-init>"]) {
        const row = outcome(result, name);
        expect(row.irBodyEmitted).not.toBe(true);
        expect(row.preparedComponentId).toBeUndefined();
        expect(row).not.toHaveProperty("r2Withdrawal");
      }
      expect(await run(result)).toBe(1);
    });
  }

  it("keeps an unsupported property writer on the compatibility route", async () => {
    const result = await compile(
      `function subject(value) { return arguments[0]; }
       subject.extra = 0;
       function write(): void { subject.extra = 7; }
       export function run(): number { write(); return subject.extra === 7 ? 1 : 0; }`,
      OPTIONS,
    );
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(result, "write").irBodyEmitted).not.toBe(true);
    expect(outcome(result, "write").preparedComponentId).toBeUndefined();
    expect(outcome(result, "write")).not.toHaveProperty("r2Withdrawal");
    expect(await run(result)).toBe(1);
  });

  it("keeps inferred target signatures out of preclaim receiver evidence", async () => {
    // The target can own an IR body, but that later claim is not evidence
    // available to the selector. Keep the member caller on the compatibility
    // route until a prepared exact-signature contract crosses this boundary.
    const result = await compile(memberSource("function subject() { return 0; }"), OPTIONS);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(result, "subject").irBodyEmitted).toBe(true);
    expect(await run(result)).toBe(1);
    expect(outcome(result, "run").irBodyEmitted).not.toBe(true);
  });

  it("preserves the prepared call through an explicitly typed target", async () => {
    const result = await compile(memberSource("function subject(value: number): number { return value; }"), OPTIONS);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(result, "run")).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
      directBodyEmissions: 0,
      preparedComponentId: expect.any(String),
    });
    expect(await run(result)).toBe(1);
  });

  it("preserves JSDoc parameter and result evidence", async () => {
    const result = await compile(
      memberSource("/** @param {number} value @returns {number} */ function subject(value) { return value; }").replace(
        "export function run(): number",
        "/** @returns {number} */ export function run()",
      ),
      { ...OPTIONS, allowJs: true, fileName: "issue-7106-member-evidence.js" },
    );
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(result, "run")).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
      directBodyEmissions: 0,
      preparedComponentId: expect.any(String),
    });
    expect(outcome(result, "run")).not.toHaveProperty("r2Withdrawal");
    expect(await run(result)).toBe(1);
  });
});
