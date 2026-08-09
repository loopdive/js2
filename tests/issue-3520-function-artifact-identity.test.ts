// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { buildIrUnitInventory, createDerivedIrUnitId, type IrUnitId } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

function source(fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    `
      export function same(): number {
        const add = (value: number): number => value + 1;
        return add(2);
      }
    `,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
}

function nestedSource(fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    `
      export function nested(): number {
        const outer = (value: number): number => {
          const inner = (input: number): number => input + 1;
          return inner(value);
        };
        return outer(2);
      }
    `,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
}

function declaration(sourceFile: ts.SourceFile): ts.FunctionDeclaration {
  const found = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!found) throw new Error(`missing function declaration in ${sourceFile.fileName}`);
  return found;
}

describe("#3520 IR function artifact identity", () => {
  it("derives equal-label lifted artifacts from their distinct exact parents", () => {
    const firstSource = source("/project/a.ts");
    const secondSource = source("/project/b.ts");
    const firstDeclaration = declaration(firstSource);
    const secondDeclaration = declaration(secondSource);
    const context = buildIrPlanningIdentityContext(
      buildIrUnitInventory([firstSource, secondSource], { entrySource: firstSource }),
    );
    const firstOwner = context.unitIdByDeclaration.get(firstDeclaration);
    const secondOwner = context.unitIdByDeclaration.get(secondDeclaration);
    if (!firstOwner || !secondOwner) throw new Error("missing exact owner identities");

    const first = lowerFunctionAstToIr(firstDeclaration, { ownerUnitId: firstOwner, exported: true });
    const second = lowerFunctionAstToIr(secondDeclaration, { ownerUnitId: secondOwner, exported: true });
    const firstLifted = first.lifted[0];
    const secondLifted = second.lifted[0];
    if (!firstLifted || !secondLifted) throw new Error("expected one lifted closure per owner");

    expect(first.main.unitId).toBe(firstOwner);
    expect(second.main.unitId).toBe(secondOwner);
    expect(firstLifted.name).toBe("same__closure_0");
    expect(secondLifted.name).toBe(firstLifted.name);
    expect(firstLifted.unitId).toBe(
      createDerivedIrUnitId({ parentId: firstOwner, role: "lifted-closure", ordinal: 0 }),
    );
    expect(secondLifted.unitId).toBe(
      createDerivedIrUnitId({ parentId: secondOwner, role: "lifted-closure", ordinal: 0 }),
    );
    expect(secondLifted.unitId).not.toBe(firstLifted.unitId);
    expect(first.liftedUnitProvenance).toEqual([
      {
        id: firstLifted.unitId,
        parentId: firstOwner,
        role: "lifted-closure",
        ordinal: 0,
      },
    ]);
    expect(second.liftedUnitProvenance).toEqual([
      {
        id: secondLifted.unitId,
        parentId: secondOwner,
        role: "lifted-closure",
        ordinal: 0,
      },
    ]);

    const firstClosureNew = first.main.blocks
      .flatMap((block) => block.instrs)
      .find((instr) => instr.kind === "closure.new");
    const secondClosureNew = second.main.blocks
      .flatMap((block) => block.instrs)
      .find((instr) => instr.kind === "closure.new");
    expect(firstClosureNew).toMatchObject({
      liftedFunc: { kind: "func", name: firstLifted.name, binding: { kind: "unit", unitId: firstLifted.unitId } },
    });
    expect(secondClosureNew).toMatchObject({
      liftedFunc: { kind: "func", name: secondLifted.name, binding: { kind: "unit", unitId: secondLifted.unitId } },
    });

    const artifacts = new Map<IrUnitId, string>([
      [firstLifted.unitId, firstLifted.name],
      [secondLifted.unitId, secondLifted.name],
    ]);
    expect(artifacts.size).toBe(2);
  });

  it("preserves allocation provenance when nested lifting reverses artifact output order", () => {
    const sourceFile = nestedSource("/project/nested.ts");
    const fn = declaration(sourceFile);
    const context = buildIrPlanningIdentityContext(buildIrUnitInventory([sourceFile], { entrySource: sourceFile }));
    const ownerUnitId = context.unitIdByDeclaration.get(fn);
    if (!ownerUnitId) throw new Error("missing exact owner identity");

    const lowered = lowerFunctionAstToIr(fn, { ownerUnitId, exported: true });
    const outerUnitId = createDerivedIrUnitId({
      parentId: ownerUnitId,
      role: "lifted-closure",
      ordinal: 0,
    });
    const innerUnitId = createDerivedIrUnitId({
      parentId: ownerUnitId,
      role: "lifted-closure",
      ordinal: 1,
    });

    // The outer identity is allocated first, but its body recursively emits
    // the inner artifact before the outer artifact is appended.
    expect(lowered.liftedUnitProvenance).toEqual([
      {
        id: outerUnitId,
        parentId: ownerUnitId,
        role: "lifted-closure",
        ordinal: 0,
      },
      {
        id: innerUnitId,
        parentId: ownerUnitId,
        role: "lifted-closure",
        ordinal: 1,
      },
    ]);
    expect(lowered.lifted.map((lifted) => lifted.unitId)).toEqual([innerUnitId, outerUnitId]);

    const provenanceById = new Map(lowered.liftedUnitProvenance.map((record) => [record.id, record] as const));
    expect(lowered.lifted.map((lifted) => provenanceById.get(lifted.unitId)?.ordinal)).toEqual([1, 0]);
  });
});
