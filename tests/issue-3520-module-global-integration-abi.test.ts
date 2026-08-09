// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { compileDeclarations, collectDeclarations } from "../src/codegen/declarations.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { compileIrPathFunctions } from "../src/ir/integration.js";
import { buildIrLegacyUnitProjection, buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { planIrCompilationByIdentity, projectIrSelectionToLegacy } from "../src/ir/select-identity.js";
import { createEmptyModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

describe("#3520 production module-global integration ABI", () => {
  it("resolves value and TDZ globals after both physical name registries are unavailable", () => {
    const ast = analyzeSource(
      `
        let state: number = 1;
        export function read(): number {
          return state;
        }
      `,
      "exact-module-global-integration.ts",
    );
    const declaration = ast.sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "state");
    expect(declaration).toBeDefined();

    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const identityContext = buildIrPlanningIdentityContext(inventory);
    const mod = createEmptyModule();
    const session = new ProgramAbiSession(inventory, mod);
    const ctx = createCodegenContext(mod, ast.checker, { experimentalIR: true }, session, identityContext);
    collectDeclarations(ctx, ast.sourceFile);
    compileDeclarations(ctx, ast.sourceFile);

    const observation = ctx.programAbiGlobals?.moduleBinding(declaration!);
    expect(observation?.value.name).toBe("__mod_state");
    expect(observation?.tdz?.name).toBe("__tdz_state");
    expect(ctx.moduleGlobals.delete("state")).toBe(true);
    expect(ctx.tdzGlobals.delete("state")).toBe(true);

    const structuralSelection = planIrCompilationByIdentity(ast.sourceFile, identityContext, {
      experimentalIR: true,
    });
    const { selection } = projectIrSelectionToLegacy(structuralSelection);
    const selectedOwnerIds = new Set([
      ...structuralSelection.funcs.keys(),
      ...(structuralSelection.classMembers?.keys() ?? []),
      ...(structuralSelection.moduleInit?.reason === null ? [structuralSelection.moduleInit.unitId] : []),
    ]);
    const ownerProjection = buildIrLegacyUnitProjection(
      inventory.terminalUnits
        .filter((unit) => selectedOwnerIds.has(unit.id))
        .map((unit) => ({
          unitId: unit.id,
          legacyName: unit.legacyMatchName,
        })),
    );
    const report = compileIrPathFunctions(ctx, ast.sourceFile, selection, undefined, undefined, {
      identityContext,
      ownerProjection,
      ownerUnitIdByLegacyName: new Map(ownerProjection.entries.map(({ legacyName, unitId }) => [legacyName, unitId])),
      signaturesByUnitId: new Map(),
      directCalls: new Map(),
      importedCalls: new Map(),
      topLevelFunctionValues: new Map(),
      hostVoidCallbacks: new Map(),
      promiseDelays: {
        constructions: new Map(),
        timers: new Map(),
        resolves: new Map(),
      },
    });

    expect(report.errors).toEqual([]);
    expect(report.compiled).toContain("<module-init>");
    expect(ctx.moduleGlobals.has("state")).toBe(false);
    expect(ctx.tdzGlobals.has("state")).toBe(false);

    for (const global of [observation!.value, observation!.tdz!]) {
      const bindingId = session.locatorBindingId(global);
      expect(bindingId).toBeDefined();
      expect(session.hasPlan(bindingId!)).toBe(true);
      expect(session.hasLocator(bindingId!, global)).toBe(true);
    }
  });
});
