// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource, type TypedAST } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import {
  buildIrModuleInitPlan,
  IrModuleInitPlanInvariantError,
  reconcileIrModuleInitPlan,
  verifyIrModuleInitPlan,
  type IrModuleInitPlan,
  type IrModuleInitTarget,
} from "../src/ir/module-init-plan.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";

// Register the statement/expression delegates used by generateModule.
import "../src/codegen/expressions.js";

function buildPlan(
  source: string,
  target: IrModuleInitTarget = "host",
  deferTopLevelInit = false,
): { readonly ast: TypedAST; readonly plan: IrModuleInitPlan } {
  const ast = analyzeSource(source, "module-init-plan.ts");
  const identityContext = buildIrPlanningIdentityContext(
    buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker }),
  );
  return {
    ast,
    plan: buildIrModuleInitPlan({
      sourceFile: ast.sourceFile,
      checker: ast.checker,
      identityContext,
      target,
      deferTopLevelInit,
    }),
  };
}

describe("#3523 source-ordered module-init planning", () => {
  it("builds exact binding, live-seed, export, static, and invocation intents", () => {
    const { plan } = buildPlan(
      `
        export let value: number = 1;
        function live(): number { return 1; }
        live = function replacement(): number { return 2; };
        value += live();
        class Box {
          static first: number = value++;
          static { value += 10; }
        }
        value += 100;
        export { value as alias };
      `,
      "host",
      true,
    );

    expect(plan.unitId).not.toBeNull();
    expect(plan.executable).toBe(true);
    expect(plan.invocation).toEqual({ target: "host", kind: "deferred-export", exactlyOnce: true });
    expect(plan.bindings).toEqual([
      expect.objectContaining({
        names: ["value"],
        declarationKind: "let",
        mutable: true,
        initialization: "tdz",
        globalBindingId: expect.stringContaining("ir-binding:v1:global:"),
        tdzBindingId: expect.stringContaining("ir-binding:v1:global:"),
      }),
    ]);
    expect(plan.liveSeeds).toEqual([
      expect.objectContaining({
        name: "live",
        callableBindingId: expect.stringContaining("ir-binding:v1:callable:"),
        liveGlobalBindingId: expect.stringContaining("ir-binding:v1:global:"),
      }),
    ]);
    expect(plan.evaluations.map((entry) => entry.kind)).toEqual([
      "variable-initializer",
      "statement",
      "statement",
      "class-static-field",
      "class-static-block",
      "statement",
    ]);
    expect(plan.evaluations.map((entry) => entry.sourceOrdinal)).toEqual([0, 1, 2, 3, 4, 5]);
    const valueExport = plan.exports.find((entry) => entry.externalName === "value");
    const aliasExport = plan.exports.find((entry) => entry.externalName === "alias");
    expect(valueExport?.targetBindingId).toBe(plan.bindings[0]!.globalBindingId);
    expect(aliasExport?.targetBindingId).toBe(valueExport?.targetBindingId);
    expect(plan.gaps).toEqual([]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.evaluations)).toBe(true);
  });

  it("makes empty modules explicit and derives each startup adapter before emission", () => {
    const empty = buildPlan(`export function read(): number { return 1; }`).plan;
    expect(empty).toMatchObject({ executable: false, unitId: null, invocation: { kind: "none" } });

    expect(buildPlan(`let x: number = 1;`, "host").plan.invocation.kind).toBe("wasm-start");
    expect(buildPlan(`let x: number = 1;`, "standalone", true).plan.invocation.kind).toBe("deferred-export");
    expect(buildPlan(`let x: number = 1;`, "wasi", true).plan.invocation.kind).toBe("wasi-start-export");
  });

  it("records capability gaps instead of dropping unmatched top-level semantics", () => {
    const destructuring = buildPlan(`let [first, second] = [1, 2];`).plan;
    expect(destructuring.gaps).toEqual([
      expect.objectContaining({ code: "destructuring-binding-abi", detail: expect.stringContaining("first, second") }),
    ]);
    expect(destructuring.evaluations).toHaveLength(1);

    const exportAssignment = buildPlan(`export default sideEffect();`).plan;
    expect(exportAssignment.evaluations.map((entry) => entry.kind)).toEqual(["export-assignment"]);
    expect(exportAssignment.gaps).toEqual([expect.objectContaining({ code: "missing-module-init-unit" })]);

    const forwardExport = buildPlan(`export { later }; function later(): number { return 1; }`).plan;
    expect(forwardExport.exports).toEqual([
      expect.objectContaining({
        externalName: "later",
        localName: "later",
        targetBindingId: expect.stringContaining("ir-binding:v1:callable:"),
      }),
    ]);
    expect(forwardExport.gaps).toEqual([]);
  });

  it("fails closed when a plan loses canonical order", () => {
    const { ast, plan } = buildPlan(`let x: number = 1; x += 2;`);
    const invalid = {
      ...plan,
      evaluations: [plan.evaluations[0]!, { ...plan.evaluations[1]!, sourceOrdinal: 0 }],
    } as IrModuleInitPlan;
    expect(() => verifyIrModuleInitPlan(invalid, ast.sourceFile)).toThrowError(
      expect.objectContaining<IrModuleInitPlanInvariantError>({ code: "non-canonical-order" }),
    );
  });
});

describe("#3523 direct-queue parity inventory", () => {
  it("aligns for an ordered statement-only module", () => {
    const { ast, plan } = buildPlan(`let x: number = 1; x += 2;`);
    const report = reconcileIrModuleInitPlan(plan, ast.sourceFile, {
      liveFunctionNames: [],
      staticEntries: [],
      moduleStatements: [...ast.sourceFile.statements],
    });
    expect(report).toMatchObject({
      aligned: true,
      plannedEntryCount: 2,
      legacyEntryCount: 2,
      missingFromLegacy: [],
      extraInLegacy: [],
      reordered: [],
    });
  });

  it("reports repeated legacy queue identities as extra work instead of failing compilation", () => {
    const { ast, plan } = buildPlan(`let x: number = 1;`);
    const statement = ast.sourceFile.statements[0]!;
    const report = reconcileIrModuleInitPlan(plan, ast.sourceFile, {
      liveFunctionNames: [],
      staticEntries: [],
      moduleStatements: [statement, statement],
    });
    expect(report).toMatchObject({
      aligned: false,
      plannedEntryCount: 1,
      legacyEntryCount: 2,
      missingFromLegacy: [],
      extraInLegacy: [report.plannedOrder[0]],
      reordered: [],
    });
  });

  it("keeps duplicated class-expression static queues observational", () => {
    const ast = analyzeSource(
      `var C = class { static #a = 1; static #b = 2; m() { return 42; } };`,
      "module-init-class-expression-duplicate.js",
    );
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    const evidence = generated.moduleInitPlanning;
    expect(evidence).toBeDefined();
    expect(evidence!.parity).toMatchObject({
      aligned: false,
      plannedEntryCount: 1,
      legacyEntryCount: 4,
      missingFromLegacy: [expect.stringMatching(/^statement:/)],
      reordered: [],
    });
    expect(evidence!.parity.extraInLegacy).toHaveLength(4);
    expect(new Set(evidence!.parity.extraInLegacy).size).toBe(2);
  });

  it("detects the legacy all-statics-before-statements reordering in production", () => {
    const ast = analyzeSource(
      `
        let value: number = 1;
        class Box {
          static first: number = value++;
          static { value += 10; }
        }
        value += 100;
      `,
      "module-init-production-plan.ts",
    );
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    const evidence = generated.moduleInitPlanning;
    expect(evidence).toBeDefined();
    expect(evidence!.plan).toMatchObject({
      executable: true,
      invocation: { target: "host", kind: "deferred-export", exactlyOnce: true },
    });
    expect(evidence!.parity.missingFromLegacy).toEqual([]);
    expect(evidence!.parity.extraInLegacy).toEqual([]);
    expect(evidence!.parity.aligned).toBe(false);
    expect(evidence!.parity.reordered.length).toBeGreaterThan(0);
    expect(evidence!.parity.plannedOrder[0]).toMatch(/^statement:/);
    expect(evidence!.parity.legacyOrder[0]).toMatch(/^static:/);
  });
});
