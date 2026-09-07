// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { IrBodyRouteAuditSession } from "../src/codegen/legacy-body-audit.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import type { IrObservedOutcome } from "../src/ir/outcomes.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import type { IrBodyRouteAuditPipeline, IrCompileRoute } from "../src/ir/standalone-route-manifest.js";
import { ts } from "../src/ts-api.js";

const ROUTES = [
  ["compile", "single", "generateModule"],
  ["compileSourceSync", "single", "generateModule"],
  ["compileMulti", "multi", "generateMultiModule"],
  ["compileFiles", "multi", "generateMultiModule"],
  ["compileProject", "multi", "generateMultiModule"],
  ["incremental.compile", "single", "generateModule"],
  ["incremental.compileMulti", "multi", "generateMultiModule"],
] as const;

function sessionFor(route: IrCompileRoute = "compile", pipeline?: IrBodyRouteAuditPipeline) {
  const source = ts.createSourceFile(
    "route.ts",
    "export const seed = 1; export function add(x: number): number { return x + seed; }",
    ts.ScriptTarget.ES2022,
    true,
  );
  const identity = buildIrPlanningIdentityContext(buildIrUnitInventory([source], { entrySource: source }));
  const session = new IrBodyRouteAuditSession(identity, "gc", route, pipeline);
  const outcomes: readonly IrObservedOutcome[] = identity.inventory.terminalUnits.map((unit) => ({
    key: unit.legacyKey,
    sourceId: unit.sourceId,
    unitId: unit.id,
    file: source.fileName,
    unitKind: unit.observedKind,
    displayName: unit.displayName,
    ordinal: unit.legacyOrdinal,
    line: unit.line,
    column: unit.column,
    backend: "wasmgc",
    target: "gc",
    kind: "emitted",
    stage: "patch",
    legacyBodyEmitted: false,
    irBodyEmitted: true,
    prepareAttempts: 1,
    directBodyEmissions: 0,
    irBodyEmissions: 1,
  }));
  expect(outcomes).toHaveLength(2);
  return { source, identity, session, outcomes };
}

describe("whole-program generator route audit", () => {
  it.each(ROUTES)("binds %s to its exact %s graph and an immutable pipeline", (route, graph, legacyGenerator) => {
    const whole = sessionFor(route, "whole-program");
    whole.session.registerGenerator(graph, "generateWholeProgramModule");
    const audit = whole.session.snapshot(whole.outcomes);
    expect(audit).toMatchObject({ route, graph, generator: "generateWholeProgramModule", terminalUnitCount: 2 });
    expect(audit.violations).toEqual([]);
    expect(audit.structurallyComplete).toBe(true);
    expect(audit.dispositions.every((row) => row.disposition === "terminal-ir")).toBe(true);
    expect(() => whole.session.registerGenerator(graph, legacyGenerator)).toThrow("expected");
    expect(() =>
      whole.session.registerGenerator(graph === "single" ? "multi" : "single", "generateWholeProgramModule"),
    ).toThrow("expected");

    const legacy = sessionFor(route);
    legacy.session.registerGenerator(graph, legacyGenerator);
    expect(legacy.session.snapshot(legacy.outcomes).generator).toBe(legacyGenerator);
    expect(() => legacy.session.registerGenerator(graph, "generateWholeProgramModule")).toThrow("expected");
  });

  it("does not manufacture registration or terminal evidence from the new pipeline selection", () => {
    const { session, outcomes } = sessionFor("compile", "whole-program");
    expect(() => session.snapshot(outcomes)).toThrow("not registered");
    session.registerGenerator("single", "generateWholeProgramModule");
    const missing = session.snapshot();
    expect(missing.structurallyComplete).toBe(false);
    expect(missing.violations.map((row) => row.code)).toEqual([
      "missing-terminal-evidence",
      "missing-terminal-evidence",
    ]);
    const incomplete = session.snapshot(outcomes.slice(1));
    expect(incomplete.structurallyComplete).toBe(false);
    expect(incomplete.violations).toMatchObject([{ code: "missing-terminal-evidence", unitId: outcomes[0]!.unitId }]);
  });

  it("retains a physical direct-body root even beside an IR outcome under the new generator", () => {
    const { source, identity, session, outcomes } = sessionFor("compile", "whole-program");
    const declaration = source.statements.find(ts.isFunctionDeclaration)!;
    const unitId = identity.unitIdByDeclaration.get(declaration);
    expect(unitId).toBeDefined();
    session.registerGenerator("single", "generateWholeProgramModule");
    session.recordRoot("compileFunctionBody", "add", declaration);
    const audit = session.snapshot(outcomes);
    expect(audit.legacyEntries).toMatchObject([{ entryPoint: "compileFunctionBody", unitId, count: 1 }]);
    expect(audit.dispositions.find((row) => row.unitId === unitId)?.disposition).toBe("legacy-ast-entry");
    expect(session.directFunctionBodyReceiptAudit(source).countsByUnitId.get(unitId!)).toBe(1);
  });
});
