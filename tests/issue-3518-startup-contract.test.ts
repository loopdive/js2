// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import {
  buildIrModuleInitPlan,
  IrModuleInitPlanInvariantError,
  reconcileIrModuleInitPlan,
  verifyIrModuleInitPlan,
} from "../src/ir/module-init-plan.js";
import type { IrModuleInitPlan, IrModuleInitTarget } from "../src/ir/program/startup.js";

function build(source: string, target: IrModuleInitTarget = "standalone", deferTopLevelInit = false) {
  const ast = analyzeSource(source, "startup-contract.ts");
  const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker });
  const identityContext = buildIrPlanningIdentityContext(inventory);
  const input = {
    sourceFile: ast.sourceFile,
    checker: ast.checker,
    identityContext,
    target,
    deferTopLevelInit,
    scriptVarModel: "statement-and-for-heads" as const,
  };
  return { ast, inventory, identityContext, input, plan: buildIrModuleInitPlan(input) };
}

describe("startup data contract separation", () => {
  it("builds nonempty bindings, seeds, exports, ranges and source-ordered evaluations with the existing producer", () => {
    const source = [
      "export let count: number = 1;",
      "function live(): number { return 1; }",
      "live = function replacement(): number { return 2; };",
      "count += live();",
      "class Box { static first: number = count++; static { count += 10; } }",
      "count += 100;",
      "export { count as alias };",
      "export default count;",
    ].join("\n");
    const { plan, identityContext, ast } = build(source);
    expect(plan.sourceId).toBe(identityContext.sourceIdBySourceFile.get(ast.sourceFile));
    expect(plan.unitId).toBe(identityContext.moduleInitUnitIdBySourceFile.get(ast.sourceFile));
    expect(plan.unitId).not.toBeNull();
    expect(plan.bindings).toHaveLength(1);
    expect(plan.liveSeeds).toHaveLength(1);
    expect(plan.liveSeeds[0]).toMatchObject({ name: "live", legacyKey: "live:live" });
    expect(plan.evaluations.map((entry) => entry.kind)).toEqual([
      "variable-initializer",
      "statement",
      "statement",
      "class-static-field",
      "class-static-block",
      "statement",
      "export-assignment",
    ]);
    expect(plan.evaluations.map((entry) => entry.sourceOrdinal)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(plan.evaluations.map((entry) => source.slice(entry.start, entry.end))).toEqual([
      "export let count: number = 1;",
      "live = function replacement(): number { return 2; };",
      "count += live();",
      "count++",
      "static { count += 10; }",
      "count += 100;",
      "export default count;",
    ]);
    for (const entry of plan.evaluations) {
      expect(entry.key).toBe(plan.sourceId + ":eval:" + entry.sourceOrdinal);
      expect(entry.legacyKey).toBe(
        (entry.kind.startsWith("class-static") ? "static:" : "statement:") + entry.start + ":" + entry.end,
      );
    }
    expect(plan.evaluations[3].classId).not.toBeNull();
    expect(plan.evaluations[4].classId).toBe(plan.evaluations[3].classId);
    expect(plan.exports.map((entry) => entry.externalName)).toEqual(["count", "alias", "default"]);
    expect(plan.exports[0].targetBindingId).toBe(plan.bindings[0].globalBindingId);
    expect(plan.exports[1].targetBindingId).toBe(plan.exports[0].targetBindingId);
    expect(plan.gaps).toEqual([]);
    expect(Object.isFrozen(plan)).toBe(true);
    for (const entries of [plan.bindings, plan.liveSeeds, plan.evaluations, plan.exports, plan.gaps]) {
      expect(Object.isFrozen(entries)).toBe(true);
      for (const entry of entries) expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it.each([
    ["host", false, "wasm-start"],
    ["host", true, "deferred-export"],
    ["standalone", false, "wasm-start"],
    ["standalone", true, "deferred-export"],
    ["wasi", false, "wasi-start-export"],
    ["wasi", true, "wasi-start-export"],
  ] as const)("preserves exactly-once policy for %s deferred=%s", (target, deferred, kind) => {
    const { plan } = build("let count = 0; count += 1;", target, deferred);
    expect(plan.evaluations).toHaveLength(2);
    expect(plan.invocation).toEqual({ target, kind, exactlyOnce: true });
    expect(Object.isFrozen(plan.invocation)).toBe(true);
  });

  it("retains empty and type-only sources in the original three-source census", () => {
    const ast = analyzeMultiSource(
      {
        "./empty.ts": "",
        "./types.ts": "export interface Marker { readonly tag: 'types'; }",
        "./entry.ts": "export let value = 42;",
      },
      "./entry.ts",
    );
    const inventory = buildIrUnitInventory(ast.sourceFiles, { entrySource: ast.entryFile, checker: ast.checker });
    const identityContext = buildIrPlanningIdentityContext(inventory);
    const plans: IrModuleInitPlan[] = ast.sourceFiles.map((file) =>
      buildIrModuleInitPlan({
        sourceFile: file,
        checker: ast.checker,
        identityContext,
        target: "standalone",
        deferTopLevelInit: false,
        scriptVarModel: "statement-and-for-heads",
      }),
    );
    expect(ast.sourceFiles).toHaveLength(3);
    expect(inventory.sources).toHaveLength(3);
    expect(plans).toHaveLength(3);
    expect(plans.map((plan) => plan.sourceId)).toEqual(
      ast.sourceFiles.map((file) => identityContext.sourceIdBySourceFile.get(file)),
    );
    expect(new Set(plans.map((plan) => plan.sourceId)).size).toBe(3);
    expect(plans.filter((plan) => plan.executable)).toHaveLength(1);
    expect(plans.reduce((count, plan) => count + plan.evaluations.length, 0)).toBe(1);
    for (const fileName of ["empty.ts", "types.ts"]) {
      const index = ast.sourceFiles.findIndex((file) => file.fileName === fileName);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(plans[index]).toMatchObject({
        unitId: null,
        executable: false,
        bindings: [],
        liveSeeds: [],
        evaluations: [],
        gaps: [],
        invocation: { target: "standalone", kind: "none", exactlyOnce: true },
      });
    }
  });

  it("rejects a foreign source AST, noncanonical order, invalid ranges and lost invocation policy", () => {
    const { input, ast, plan } = build("let count = 0; count += 1;");
    const foreign = analyzeSource(ast.sourceFile.text, ast.sourceFile.fileName);
    expect(() => buildIrModuleInitPlan({ ...input, sourceFile: foreign.sourceFile })).toThrow(
      expect.objectContaining({ code: "source-record-mismatch" }),
    );
    const badOrder = { ...plan, evaluations: [...plan.evaluations].reverse() };
    const badRange = {
      ...plan,
      evaluations: [{ ...plan.evaluations[0], end: ast.sourceFile.end + 1 }, plan.evaluations[1]],
    };
    const badInvocation = { ...plan, invocation: { ...plan.invocation, kind: "none" as const } };
    for (const [candidate, code] of [
      [badOrder, "non-canonical-order"],
      [badRange, "invalid-source-range"],
      [badInvocation, "invalid-invocation"],
    ] as const) {
      expect(() => verifyIrModuleInitPlan(candidate, ast.sourceFile)).toThrow(
        expect.objectContaining({ name: "IrModuleInitPlanInvariantError", code }),
      );
    }
    expect(IrModuleInitPlanInvariantError.prototype).toBeInstanceOf(Error);
  });

  it("keeps nonempty legacy-order observation and duplicate queue evidence visible", () => {
    const { ast, plan } = build("let count = 0; count += 1;");
    const legacy = { liveFunctionNames: [], staticEntries: [], moduleStatements: [...ast.sourceFile.statements] };
    expect(reconcileIrModuleInitPlan(plan, ast.sourceFile, legacy)).toMatchObject({
      aligned: true,
      plannedEntryCount: 2,
      legacyEntryCount: 2,
    });
    const repeated = reconcileIrModuleInitPlan(plan, ast.sourceFile, {
      ...legacy,
      moduleStatements: [...legacy.moduleStatements, legacy.moduleStatements[1]],
    });
    expect(repeated).toMatchObject({ aligned: false, plannedEntryCount: 2, legacyEntryCount: 3 });
    expect(repeated.extraInLegacy).toEqual([plan.evaluations[1].legacyKey]);
    expect(plan.evaluations).toHaveLength(2);
  });
});
