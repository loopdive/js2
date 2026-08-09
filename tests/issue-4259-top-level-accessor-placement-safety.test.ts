// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildIrUnitInventory, type IrTerminalUnitRecord, type IrUnitId } from "../src/ir/identity.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

const CASES = [
  {
    label: "instance getter and static setter",
    expectedKinds: ["class-instance-getter", "class-static-setter"],
    source: `
      var sink;
      class MixedPlacement {
        get value() { return "instance"; }
        static set value(next) { sink = next; }
      }
      export function run(): number {
        const instance = new MixedPlacement();
        MixedPlacement["value"] = "static-set";
        return instance["value"] === "instance" && sink === "static-set" ? 1 : 0;
      }
    `,
  },
  {
    label: "static getter and instance setter",
    expectedKinds: ["class-static-getter", "class-instance-setter"],
    source: `
      var sink;
      class MixedPlacement {
        static get value() { return "static"; }
        set value(next) { sink = next; }
      }
      export function run(): number {
        const instance = new MixedPlacement();
        instance["value"] = "instance-set";
        return MixedPlacement["value"] === "static" && sink === "instance-set" ? 1 : 0;
      }
    `,
  },
] as const;

function exactAccessorUnits(source: string, fileName: string): readonly IrTerminalUnitRecord[] {
  const ast = analyzeSource(source, fileName);
  const inventory = buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  });
  return inventory.terminalUnits.filter(
    (unit) =>
      unit.observedKind === "class-member" &&
      (unit.kind === "class-instance-getter" ||
        unit.kind === "class-static-getter" ||
        unit.kind === "class-instance-setter" ||
        unit.kind === "class-static-setter"),
  );
}

function exactOutcome(result: CompileResult, unitId: IrUnitId): IrObservedOutcome {
  const outcomes = (result.irOutcomes ?? []).filter((candidate) => candidate.unitId === unitId);
  expect(outcomes, `outcome count for ${unitId}`).toHaveLength(1);
  return outcomes[0]!;
}

async function instantiateAndInitialize(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  exports.__module_init?.();
  return exports;
}

describe("#4259 top-level accessor placement safety", () => {
  for (const testCase of CASES) {
    it.each(TARGETS)(`atomically rejects ${testCase.label} in the %s lane`, async (target) => {
      const fileName = `issue-4259-placement-${testCase.label.replaceAll(" ", "-")}-${target}.ts`;
      const units = exactAccessorUnits(testCase.source, fileName);
      expect(units).toHaveLength(2);
      expect(units.map((unit) => unit.kind).sort()).toEqual([...testCase.expectedKinds].sort());

      const result = await compile(testCase.source, {
        fileName,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
        deferTopLevelInit: true,
        hostBridge: "always",
        skipSemanticDiagnostics: true,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      for (const unit of units) {
        const outcome = exactOutcome(result, unit.id);
        expect(outcome).toMatchObject({
          kind: "unsupported",
          code: "class-member-unsupported",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
        expect(outcome).not.toHaveProperty("preparedComponentId");
      }
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect((await instantiateAndInitialize(result)).run!()).toBe(1);
    });
  }
});
