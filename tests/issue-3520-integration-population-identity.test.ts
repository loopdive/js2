// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildIrUnitInventory, type IrTerminalUnitRecord, type IrUnitId } from "../src/ir/identity.js";
import { validateIrIntegrationPopulation } from "../src/ir/integration-identity.js";
import { IrInvariantError } from "../src/ir/outcomes.js";
import {
  buildIrLegacyUnitProjection,
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "../src/ir/planning-identity.js";
import { MODULE_INIT_UNIT_NAME, type IrSelection } from "../src/ir/select.js";
import { ts } from "../src/ts-api.js";

const SOURCE_TEXT = `
  let seed: number = 1;
  export function run(value: number): number { return value + seed; }
  class Box {
    constructor() {}
    read(): number { return seed; }
    static plus(value: number): number { return value + 1; }
  }
`;

type IdentityPlans = Parameters<typeof validateIrIntegrationPopulation>[2];

interface Fixture {
  readonly sourceFile: ts.SourceFile;
  readonly context: IrPlanningIdentityContext;
  readonly selection: Pick<IrSelection, "funcs" | "classMembers" | "moduleInit">;
  readonly plans: IdentityPlans;
  readonly terminalByName: ReadonlyMap<string, IrTerminalUnitRecord>;
}

function fixture(): Fixture {
  const sourceFile = ts.createSourceFile("/repo/main.ts", SOURCE_TEXT, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const context = buildIrPlanningIdentityContext(inventory);
  const terminalByName = new Map(inventory.terminalUnits.map((terminal) => [terminal.legacyMatchName, terminal]));
  const projectedNames = ["run", "Box_new", "Box_read", MODULE_INIT_UNIT_NAME] as const;
  const ownerProjection = buildIrLegacyUnitProjection(
    projectedNames.map((legacyName) => ({ unitId: terminalByName.get(legacyName)!.id, legacyName })),
  );
  const selection = {
    funcs: new Set(["run"]),
    classMembers: new Set(["Box_new", "Box_read", "Box_plus"]),
    moduleInit: { stmtCount: 1, reason: null },
  } satisfies Pick<IrSelection, "funcs" | "classMembers" | "moduleInit">;
  return {
    sourceFile,
    context,
    selection,
    terminalByName,
    plans: {
      identityContext: context,
      ownerProjection,
      ownerUnitIdByLegacyName: new Map(ownerProjection.entries.map(({ legacyName, unitId }) => [legacyName, unitId])),
    },
  };
}

function expectPlanningError(run: () => unknown, code: IrPlanningIdentityInvariantCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrPlanningIdentityInvariantError);
  expect(caught).toMatchObject({ code });
}

function replaceStatements(sourceFile: ts.SourceFile, statements: readonly ts.Statement[]): void {
  Reflect.set(sourceFile, "statements", ts.factory.createNodeArray(statements));
}

describe("#3520 integration AST population identity", () => {
  it("returns exact declaration owners and validates the complete module-init population", () => {
    const current = fixture();
    const validated = validateIrIntegrationPopulation(current.sourceFile, current.selection, current.plans);
    const declarations = new Map<string, ts.Node>();
    for (const statement of current.sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      for (const member of statement.members) {
        if (ts.isConstructorDeclaration(member)) declarations.set("Box_new", member);
        else if (member.name && ts.isIdentifier(member.name)) {
          declarations.set(`Box_${member.name.text}`, member);
        }
      }
    }

    for (const name of ["run", "Box_new", "Box_read", "Box_plus"]) {
      expect(validated.ownerUnitIdByDeclaration.get(declarations.get(name)!)).toBe(
        current.terminalByName.get(name)!.id,
      );
    }
    expect(validated.moduleInitUnitId).toBe(current.terminalByName.get(MODULE_INIT_UNIT_NAME)!.id);
    expect(validated.moduleInitPopulation).toEqual([current.sourceFile.statements[0]]);
    expect(current.plans.ownerProjection.getByLegacyName("Box_plus")).toBeUndefined();
  });

  it("rejects a cloned SourceFile even when its text and selected names are identical", () => {
    const current = fixture();
    const clone = ts.createSourceFile(
      current.sourceFile.fileName,
      current.sourceFile.text,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    expectPlanningError(
      () => validateIrIntegrationPopulation(clone, current.selection, current.plans),
      "source-record-mismatch",
    );
  });

  it("rejects a replaced selected declaration instead of reusing its old owner ID", () => {
    const current = fixture();
    const replacementSource = ts.createSourceFile(
      current.sourceFile.fileName,
      "export function run(value: number): number { return value * 2; }",
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const replacement = replacementSource.statements[0]!;
    Reflect.set(replacement, "parent", current.sourceFile);
    replaceStatements(current.sourceFile, [
      current.sourceFile.statements[0]!,
      replacement,
      ...current.sourceFile.statements.slice(2),
    ]);

    expectPlanningError(
      () => validateIrIntegrationPopulation(current.sourceFile, current.selection, current.plans),
      "missing-unit-declaration",
    );
  });

  it("rejects a changed module-init population before synthetic wrapping", () => {
    const current = fixture();
    const extraSource = ts.createSourceFile(
      current.sourceFile.fileName,
      "let added: number = 2;",
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const added = extraSource.statements[0]!;
    Reflect.set(added, "parent", current.sourceFile);
    replaceStatements(current.sourceFile, [added, ...current.sourceFile.statements]);

    expect(() => validateIrIntegrationPopulation(current.sourceFile, current.selection, current.plans)).toThrowError(
      expect.objectContaining<Partial<IrInvariantError>>({
        name: "IrInvariantError",
        code: "selection-preparation-mismatch",
      }),
    );
  });

  it("rejects a same-source module-init replacement when cardinality is unchanged", () => {
    const current = fixture();
    const replacementSource = ts.createSourceFile(
      current.sourceFile.fileName,
      "let replacement: number = 2;",
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const replacement = replacementSource.statements[0]!;
    Reflect.set(replacement, "parent", current.sourceFile);
    replaceStatements(current.sourceFile, [replacement, ...current.sourceFile.statements.slice(1)]);

    expectPlanningError(
      () => validateIrIntegrationPopulation(current.sourceFile, current.selection, current.plans),
      "invalid-module-init",
    );
  });

  it("rejects a foreign current module-init statement even when cardinality is unchanged", () => {
    const current = fixture();
    const foreignSource = ts.createSourceFile(
      "/repo/foreign.ts",
      "let foreign: number = 2;",
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    replaceStatements(current.sourceFile, [foreignSource.statements[0]!, ...current.sourceFile.statements.slice(1)]);

    expectPlanningError(
      () => validateIrIntegrationPopulation(current.sourceFile, current.selection, current.plans),
      "invalid-module-init",
    );
  });

  it("rejects a stale owner projection even when all selected names are present", () => {
    const current = fixture();
    const runId = current.terminalByName.get("run")!.id;
    const readId = current.terminalByName.get("Box_read")!.id;
    const staleProjection = buildIrLegacyUnitProjection(
      current.plans.ownerProjection.entries.map(({ legacyName, unitId }) => ({
        legacyName,
        unitId: legacyName === "run" ? readId : legacyName === "Box_read" ? runId : unitId,
      })),
    );
    const stalePlans: IdentityPlans = {
      ...current.plans,
      ownerProjection: staleProjection,
      ownerUnitIdByLegacyName: new Map(
        staleProjection.entries.map(({ legacyName, unitId }) => [legacyName, unitId] as [string, IrUnitId]),
      ),
    };

    expect(() => validateIrIntegrationPopulation(current.sourceFile, current.selection, stalePlans)).toThrowError(
      expect.objectContaining<Partial<IrInvariantError>>({
        name: "IrInvariantError",
        code: "selection-preparation-mismatch",
      }),
    );
  });
});
