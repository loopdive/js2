// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
} from "../src/ir/planning-identity.js";
import { planIrCompilationByIdentity, projectIrSelectionToLegacy } from "../src/ir/select-identity.js";
import type { IrUnitTypeMap } from "../src/ir/propagate.js";
import { planIrCompilation } from "../src/ir/select.js";
import type { IrRecursiveTypeEvidence } from "../src/ir/type-evidence.js";
import type { IrClassShape } from "../src/ir/from-ast.js";
import { ts } from "../src/ts-api.js";

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function context(files: readonly ts.SourceFile[], entry = files[0]!): IrPlanningIdentityContext {
  return buildIrPlanningIdentityContext(buildIrUnitInventory(files, { entrySource: entry }));
}

function functions(file: ts.SourceFile, name?: string): ts.FunctionDeclaration[] {
  return file.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && (name === undefined || statement.name?.text === name),
  );
}

function classDeclaration(file: ts.SourceFile, name: string): ts.ClassDeclaration {
  return file.statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === name,
  )!;
}

function unitId(context: IrPlanningIdentityContext, declaration: ts.Node): IrUnitId {
  return context.unitIdByDeclaration.get(declaration)!;
}

describe("#3520 structural selector identity", () => {
  it("keeps same-labeled source decisions exact and inventory-order independent", () => {
    const a = source(
      "/repo/a.ts",
      `
        export function same(value) { return value + 1; }
        export class C { value(): number { return 1; } }
      `,
    );
    const b = source(
      "/repo/b.ts",
      `
        export function same(value) { return value + 1; }
        export class C { value(): number { return 2; } }
      `,
    );
    const forward = context([a, b], a);
    const reversed = context([b, a], a);

    const aId = unitId(forward, functions(a, "same")[0]!);
    const bId = unitId(forward, functions(b, "same")[0]!);
    const typeMap: IrUnitTypeMap = new Map([
      [aId, { params: [{ kind: "f64" }], returnType: { kind: "f64" } }],
      [bId, { params: [{ kind: "dynamic" }], returnType: { kind: "f64" } }],
    ]);
    const selectionOptions = { experimentalIR: true, trackFallbacks: true } as const;
    const aForward = planIrCompilationByIdentity(a, forward, selectionOptions, typeMap);
    const bForward = planIrCompilationByIdentity(b, forward, selectionOptions, typeMap);
    const aReversed = planIrCompilationByIdentity(a, reversed, selectionOptions, typeMap);
    const bReversed = planIrCompilationByIdentity(b, reversed, selectionOptions, typeMap);

    expect(aId).not.toBe(bId);
    expect(aForward.funcs.has(aId)).toBe(true);
    expect(bForward.funcs.has(bId)).toBe(false);
    expect(bForward.fallbacks?.get(bId)?.reason).toBe("param-type-not-resolvable");
    expect(aForward.funcs.get(aId)?.displayName).toBe("same");
    expect(bForward.fallbacks?.get(bId)?.displayName).toBe("same");
    expect([...aReversed.funcs.keys()]).toEqual([...aForward.funcs.keys()]);
    expect([...bReversed.fallbacks!.keys()]).toEqual([...bForward.fallbacks!.keys()]);

    const aClassId = forward.classIdByDeclaration.get(classDeclaration(a, "C"))!;
    const bClassId = forward.classIdByDeclaration.get(classDeclaration(b, "C"))!;
    expect(aClassId).not.toBe(bClassId);
    expect([...aForward.classMembers!.values()].every((claim) => claim.classId === aClassId)).toBe(true);
    expect([...bForward.classMembers!.values()].every((claim) => claim.classId === bClassId)).toBe(true);
  });

  it("rejects a cloned SourceFile even when its filename and text match", () => {
    const original = source("/repo/exact.ts", `export function exact(): number { return 1; }`);
    const identityContext = context([original]);
    const clone = source(original.fileName, original.text);

    try {
      planIrCompilationByIdentity(clone, identityContext, { experimentalIR: true });
      throw new Error("expected structural source rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(IrPlanningIdentityInvariantError);
      expect((error as IrPlanningIdentityInvariantError).code).toBe("source-record-mismatch");
    }
  });

  it("attaches structural recursive evidence to its exact unit", () => {
    const file = source("/repo/recursive.ts", `function loop(value: number): number { return value; }`);
    const identityContext = context([file]);
    const id = unitId(identityContext, functions(file, "loop")[0]!);
    const recursiveTypeEvidence: IrRecursiveTypeEvidence = {
      typeMap: new Map(),
      decisions: new Map([
        [id, { accepted: false, component: [id], reason: "unsupported", detail: "exact recursive decision" }],
      ]),
      checkerTypeOverrides: new Map(),
    };
    const selection = planIrCompilationByIdentity(file, identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
      recursiveTypeEvidence,
    });

    expect(selection.funcs.has(id)).toBe(false);
    expect(selection.fallbacks?.get(id)).toMatchObject({
      unitId: id,
      reason: "recursive-type-evidence",
      detail: "exact recursive decision",
    });
  });

  it("uses the authoritative unnamed/default terminal label", () => {
    const file = source("/repo/default.ts", `export default function (): number { return 1; }`);
    const identityContext = context([file]);
    const declaration = functions(file)[0]!;
    const id = unitId(identityContext, declaration);
    const terminal = identityContext.terminalByUnitId.get(id)!;
    const selection = planIrCompilationByIdentity(file, identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
    });
    const fallback = selection.fallbacks!.get(id)!;

    expect(terminal.legacyMatchName).toBe("<unnamed:0>");
    expect(fallback).toMatchObject({
      unitId: id,
      displayName: terminal.displayName,
      legacyMatchName: terminal.legacyMatchName,
      reason: "unnamed",
    });
    expect(projectIrSelectionToLegacy(selection).selection.fallbacks).toContainEqual({
      name: terminal.legacyMatchName,
      reason: "unnamed",
      detail: undefined,
    });
  });

  it("keeps static, instance, accessor, and repeated computed members distinct", () => {
    const file = source(
      "/repo/members.ts",
      `
        export class C {
          value(): number { return 1; }
          static value(): number { return 2; }
          get x(): number { return 3; }
          set x(value: number) { return; }
          ["repeat"](): number { return 4; }
          ["repeat"](): number { return 5; }
        }
      `,
    );
    const identityContext = context([file]);
    const declaration = classDeclaration(file, "C");
    const classId = identityContext.classIdByDeclaration.get(declaration)!;
    const selection = planIrCompilationByIdentity(file, identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
    });
    const memberIds = declaration.members
      .filter(
        (member) =>
          ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member),
      )
      .map((member) => unitId(identityContext, member));
    const records = memberIds.map((id) => identityContext.terminalByUnitId.get(id)!);

    expect(new Set(memberIds).size).toBe(6);
    expect(records.map((record) => record.kind)).toEqual([
      "class-instance-method",
      "class-static-method",
      "class-instance-getter",
      "class-instance-setter",
      "class-instance-method",
      "class-instance-method",
    ]);
    expect(selection.classMembers?.size).toBe(4);
    expect(selection.fallbacks?.size).toBe(2);
    expect(
      [...selection.units.values()].every((unit) => unit.kind !== "class-member" || unit.classId === classId),
    ).toBe(true);
    const computed = records.filter((record) => record.legacyMatchName === "C_<computed>");
    expect(computed).toHaveLength(2);
    expect(computed.every((record) => selection.fallbacks?.get(record.id)?.reason === "class-method")).toBe(true);

    const projected = projectIrSelectionToLegacy(selection);
    const collidingValueIds = records
      .filter((record) => record.legacyMatchName === "C_value")
      .map((record) => record.id);
    expect(collidingValueIds).toHaveLength(2);
    expect(collidingValueIds.every((id) => projected.omittedUnitIds.has(id))).toBe(true);
    expect(computed.every((record) => projected.omittedUnitIds.has(record.id))).toBe(true);
    expect(projected.selection.classMembers).toEqual(new Set(["C_get_x", "C_set_x"]));
    expect(projected.selection.fallbacks).toContainEqual({ name: "C_value", reason: "class-member-unsupported" });
    expect(projected.selection.fallbacks).toContainEqual({ name: "C_<computed>", reason: "class-method" });
  });

  it("retains every duplicate checker-free call target and blocks unsafe projection", () => {
    const file = source(
      "/repo/duplicates.ts",
      `
        function same(value: number): number { return value + 1; }
        function same(value?: number): number { return 0; }
        export function owner(value: number): number { return same(value); }
      `,
    );
    const identityContext = context([file]);
    const sameDeclarations = functions(file, "same");
    const owner = functions(file, "owner")[0]!;
    const sameIds = sameDeclarations.map((declaration) => unitId(identityContext, declaration));
    const ownerId = unitId(identityContext, owner);
    const selection = planIrCompilationByIdentity(file, identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
      jsHostExterns: true,
    });

    expect(selection.localCallees?.get(ownerId)).toEqual(new Set(sameIds));
    expect(selection.funcs.has(ownerId)).toBe(false);
    expect(["external-call", "call-graph-closure"]).toContain(selection.fallbacks?.get(ownerId)?.reason);
    const projected = projectIrSelectionToLegacy(selection);
    expect(sameIds.every((id) => projected.omittedUnitIds.has(id))).toBe(true);
    expect(projected.omittedUnitIds.has(ownerId)).toBe(true);
    expect(projected.selection.funcs.has("same")).toBe(false);
    expect(projected.selection.funcs.has("owner")).toBe(false);
  });

  it("re-closes standalone legacy projection after an ambiguous caller is omitted", () => {
    const file = source(
      "/repo/duplicate-callers.ts",
      `
        function dup(value: number): number { return leaf(value); }
        function dup(value: number): number { return leaf(value); }
        function leaf(value: number): number { return value + 1; }
      `,
    );
    const identityContext = context([file]);
    const duplicateIds = functions(file, "dup").map((declaration) => unitId(identityContext, declaration));
    const leafId = unitId(identityContext, functions(file, "leaf")[0]!);

    const standalone = planIrCompilationByIdentity(file, identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
    });
    expect(standalone.funcs.has(leafId)).toBe(true);
    const standaloneProjection = projectIrSelectionToLegacy(standalone);
    expect(duplicateIds.every((id) => standaloneProjection.omittedUnitIds.has(id))).toBe(true);
    expect(standaloneProjection.omittedUnitIds.has(leafId)).toBe(true);
    expect(standaloneProjection.selection.funcs.has("leaf")).toBe(false);

    const host = planIrCompilationByIdentity(file, identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
      jsHostExterns: true,
    });
    const hostProjection = projectIrSelectionToLegacy(host);
    expect(hostProjection.omittedUnitIds.has(leafId)).toBe(false);
    expect(hostProjection.selection.funcs.has("leaf")).toBe(true);
  });

  it("keeps anonymous and implicit-constructor terminals in the structural population", () => {
    const file = source(
      "/repo/anonymous-class.ts",
      `export default class { value = 1; read(): number { return this.value; } }`,
    );
    const identityContext = context([file]);
    const selection = planIrCompilationByIdentity(file, identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
    });
    const sourceId = identityContext.sourceIdBySourceFile.get(file)!;
    const memberTerminals = identityContext.inventory.terminalUnits.filter(
      (terminal) => terminal.sourceId === sourceId && terminal.observedKind === "class-member",
    );

    expect(memberTerminals.map((terminal) => terminal.kind).sort()).toEqual(
      ["class-implicit-constructor", "class-instance-method"].sort(),
    );
    expect(memberTerminals.every((terminal) => selection.units.has(terminal.id))).toBe(true);
    expect(selection.classMembers).toBeUndefined();
  });

  it("rejects ambiguous class and projected-member name evidence", () => {
    const duplicateClasses = source(
      "/repo/duplicate-classes.ts",
      `class C { a(): number { return 1; } } class C { b(): number { return 2; } }`,
    );
    const duplicateContext = context([duplicateClasses]);
    const duplicateSelection = planIrCompilationByIdentity(duplicateClasses, duplicateContext, {
      experimentalIR: true,
      trackFallbacks: true,
    });
    expect(duplicateSelection.classMembers).toBeUndefined();
    expect([...duplicateSelection.fallbacks!.values()].map(({ reason }) => reason)).toEqual([
      "class-member-unsupported",
      "class-member-unsupported",
    ]);

    const repeatedDescriptor = source("/repo/repeated-descriptor.ts", `class C { m(): number { return 1; } }`);
    const repeatedContext = context([repeatedDescriptor]);
    const repeatedClassId = repeatedContext.classIdByDeclaration.get(classDeclaration(repeatedDescriptor, "C"))!;
    const shape: IrClassShape = {
      classId: repeatedClassId,
      className: "C",
      fields: [],
      methods: [
        { name: "m", params: [], returnType: { kind: "f64" }, memberKind: "method" },
        { name: "m", params: [], returnType: { kind: "f64" }, memberKind: "method" },
      ],
      constructorParams: [],
    };
    const repeatedSelection = planIrCompilationByIdentity(repeatedDescriptor, repeatedContext, {
      experimentalIR: true,
      trackFallbacks: true,
      projectedClassShapes: new Map([["C", shape]]),
    });
    expect(repeatedSelection.classMembers).toBeUndefined();
    expect([...repeatedSelection.fallbacks!.values()][0]?.reason).toBe("class-member-unsupported");
  });

  it("fails closed when exact terminal or module ownership is missing", () => {
    const functionFile = source("/repo/broken-function.ts", `function f(): number { return 1; }`);
    const functionContext = context([functionFile]);
    const functionId = unitId(functionContext, functions(functionFile, "f")[0]!);
    const brokenFunctionContext: IrPlanningIdentityContext = {
      ...functionContext,
      terminalByUnitId: new Map(
        [...functionContext.terminalByUnitId].filter(([candidate]) => candidate !== functionId),
      ),
    };
    expect(() => planIrCompilationByIdentity(functionFile, brokenFunctionContext, { experimentalIR: true })).toThrow(
      expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "terminal-record-mismatch" }),
    );

    const moduleFile = source("/repo/broken-module.ts", `const value = 1;`);
    const moduleContext = context([moduleFile]);
    const brokenModuleContext: IrPlanningIdentityContext = {
      ...moduleContext,
      moduleInitUnitIdBySourceFile: new Map(),
    };
    expect(() => planIrCompilationByIdentity(moduleFile, brokenModuleContext, { experimentalIR: true })).toThrow(
      expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "invalid-module-init" }),
    );

    const staleFile = source("/repo/stale-source.ts", `function retained(): number { return 1; }`);
    const staleContext = context([staleFile]);
    (staleFile as unknown as { statements: ts.NodeArray<ts.Statement> }).statements = ts.factory.createNodeArray();
    expect(() => planIrCompilationByIdentity(staleFile, staleContext, { experimentalIR: true })).toThrow(
      expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "missing-unit-declaration" }),
    );

    const staleModuleFile = source("/repo/stale-module.ts", `const retained = 1;`);
    const staleModuleContext = context([staleModuleFile]);
    (staleModuleFile as unknown as { statements: ts.NodeArray<ts.Statement> }).statements =
      ts.factory.createNodeArray();
    expect(() => planIrCompilationByIdentity(staleModuleFile, staleModuleContext, { experimentalIR: true })).toThrow(
      expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "invalid-module-init" }),
    );

    const projectedFile = source("/repo/corrupt-projection.ts", `function retained(): number { return 1; }`);
    const projectedSelection = planIrCompilationByIdentity(projectedFile, context([projectedFile]), {
      experimentalIR: true,
    });
    expect(() => projectIrSelectionToLegacy({ ...projectedSelection, units: new Map() })).toThrow(
      expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "terminal-record-mismatch" }),
    );
  });

  it("matches the legacy selector after an unambiguous projection", () => {
    const file = source(
      "/repo/parity.ts",
      `
        function good(value: number): number { return value + 1; }
        function bad(...values: number[]): number { return values.length; }
        class C { read(): number { return 1; } }
        const moduleValue = 1;
      `,
    );
    const options = { experimentalIR: true, trackFallbacks: true, jsHostExterns: true } as const;
    const legacy = planIrCompilation(file, options);
    const projected = projectIrSelectionToLegacy(planIrCompilationByIdentity(file, context([file]), options)).selection;

    expect(projected.funcs).toEqual(legacy.funcs);
    expect(projected.classMembers).toEqual(legacy.classMembers);
    expect(projected.localCallees).toEqual(legacy.localCallees);
    expect(projected.moduleInit).toEqual(legacy.moduleInit);
    expect(projected.fallbacks).toEqual(legacy.fallbacks);
  });

  it("owns module init by source and omits declaration-only sources", () => {
    const a = source("/repo/module-a.ts", `const value = 1;`);
    const b = source("/repo/module-b.ts", `const value = 2;`);
    const declarations = source(
      "/repo/declarations.ts",
      `export function value(input: number): number { return input; }`,
    );
    const identityContext = context([b, declarations, a], a);
    const aSelection = planIrCompilationByIdentity(a, identityContext, { experimentalIR: true });
    const bSelection = planIrCompilationByIdentity(b, identityContext, { experimentalIR: true });
    const declarationSelection = planIrCompilationByIdentity(declarations, identityContext, {
      experimentalIR: true,
    });
    const aId = identityContext.moduleInitUnitIdBySourceFile.get(a)!;
    const bId = identityContext.moduleInitUnitIdBySourceFile.get(b)!;

    expect(aId).not.toBe(bId);
    expect(aSelection.moduleInit).toMatchObject({ unitId: aId, legacyMatchName: "<module-init>", reason: null });
    expect(bSelection.moduleInit).toMatchObject({ unitId: bId, legacyMatchName: "<module-init>", reason: null });
    expect(identityContext.moduleInitUnitIdBySourceFile.has(declarations)).toBe(false);
    expect(declarationSelection.moduleInit).toBeUndefined();
    expect(projectIrSelectionToLegacy(declarationSelection).selection.moduleInit).toEqual({
      stmtCount: 0,
      reason: null,
    });
  });
});
