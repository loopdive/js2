// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `class C {}
export function read(): any { return C; }
export function shadow(C: any): any { return C; }
`;

for (const target of ["standalone", "wasi"] as const) {
  describe(`class source binding outcomes: ${target}`, () => {
    let result: Awaited<ReturnType<typeof compile>>;
    beforeAll(async () => {
      result = await compile(SOURCE, {
        fileName: "class-binding-outcomes.ts",
        target,
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors).toEqual([]);
    });
    it("records the exact source class-value capability gap before construction", () => {
      const rows = result.irOutcomes?.filter((row) => row.displayName === "read" && row.unitKind === "function");
      expect(rows).toHaveLength(1);
      const row = rows![0];
      expect(row).toMatchObject({
        kind: "unsupported",
        stage: "select",
        code: "class-value-binding-unsupported",
        line: 2,
        column: 1,
        irBodyEmitted: false,
        legacyBodyEmitted: true,
      });
      expect(row.sourceId).toBeTruthy();
      expect(row.unitId).toBeTruthy();
    });
    it("keeps a same-spelled parameter on its own IR value binding", () => {
      const rows = result.irOutcomes?.filter((row) => row.displayName === "shadow" && row.unitKind === "function");
      expect(rows).toHaveLength(1);
      expect(rows![0]).toMatchObject({
        kind: "emitted",
        irBodyEmitted: true,
        legacyBodyEmitted: false,
        directBodyEmissions: 0,
      });
    });
  });
}
