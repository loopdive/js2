import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const residue = [
  "language/expressions/assignment/S11.13.1_A7_T4.js",
  "language/expressions/compound-assignment/S11.13.2_A7.8_T4.js",
  "language/expressions/compound-assignment/S11.13.2_A7.9_T3.js",
] as const;

describe("#3628 legacy Test262 residue", () => {
  for (const relative of residue) {
    for (const lane of [undefined, "standalone"] as const) {
      const laneName = lane ?? "host";
      it(`${relative} passes in ${laneName}`, async () => {
        const result = await runTest262File(resolve("test262/test", relative), "issue-3628", 120_000, lane);
        expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
      }, 180_000);
    }
  }

  it("canonicalizes a computed key in the standalone IR member-store path", async () => {
    const result = await compile(
      `
var propertyKeyEvaluated = 0;

export function store(base: any, key: any): void {
  base[key] = "true";
}

export function makeBase(): any {
  return {};
}

export function makeKey(): any {
  return {
    toString: function() {
      propertyKeyEvaluated++;
      return "";
    }
  };
}

export function keyEvaluationCount(): number {
  return propertyKeyEvaluated;
}
`,
      {
        fileName: "issue-3628-standalone-ir-property-key.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("store");

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    const exports = instance.exports as {
      store: (base: unknown, key: unknown) => void;
      makeBase: () => unknown;
      makeKey: () => unknown;
      keyEvaluationCount: () => number;
    };
    exports.store(exports.makeBase(), exports.makeKey());
    expect(exports.keyEvaluationCount()).toBe(1);
  });
});
