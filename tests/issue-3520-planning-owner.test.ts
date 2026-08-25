// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildIrUnitInventory, type IrSourceId, type IrUnitId } from "../src/ir/identity.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  requireIrPlanningOwnerUnitId,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function contextFor(
  sourceFiles: readonly ts.SourceFile[],
  entrySource: ts.SourceFile = sourceFiles[0]!,
): IrPlanningIdentityContext {
  return buildIrPlanningIdentityContext(buildIrUnitInventory(sourceFiles, { entrySource }));
}

function functionDeclaration(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing function ${name}`);
  return declaration;
}

function unitId(context: IrPlanningIdentityContext, declaration: ts.Node): IrUnitId {
  const id = context.unitIdByDeclaration.get(declaration);
  if (!id) throw new Error(`missing unit for ${ts.SyntaxKind[declaration.kind]}`);
  return id;
}

function collectNodes<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const nodes: T[] = [];
  const visit = (node: ts.Node): void => {
    if (guard(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
}

function expectPlanningInvariant(fn: () => unknown, code: IrPlanningIdentityInvariantCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrPlanningIdentityInvariantError);
  expect(caught).toMatchObject({ code });
}

describe("#3520 exact planning owner identity", () => {
  it("prefers enclosing function/member terminals and resolves source-owned support to module init", () => {
    const fixture = source(
      "/repo/owners.ts",
      `
        const moduleValue = 1;
        function owner() { return moduleValue; }
        class Box {
          static { const initialized = moduleValue; }
          constructor() { this.value = 0; }
          method() { return this.value; }
          get current() { return this.value; }
          set current(value: number) { this.value = value; }
          value = 0;
        }
      `,
    );
    const context = contextFor([fixture]);
    const owner = functionDeclaration(fixture, "owner");
    const box = fixture.statements.find(ts.isClassDeclaration)!;
    const constructorMember = box.members.find(ts.isConstructorDeclaration)!;
    const method = box.members.find(ts.isMethodDeclaration)!;
    const getter = box.members.find(ts.isGetAccessorDeclaration)!;
    const setter = box.members.find(ts.isSetAccessorDeclaration)!;
    const staticBlock = box.members.find(ts.isClassStaticBlockDeclaration)!;
    const moduleStatement = fixture.statements.find(ts.isVariableStatement)!;
    const moduleInitId = context.moduleInitUnitIdBySourceFile.get(fixture)!;

    const expectedByBody = [owner, constructorMember, method, getter, setter].map((declaration) => [
      declaration.body!,
      unitId(context, declaration),
    ]) as readonly (readonly [ts.Node, IrUnitId])[];
    expect(new Set(expectedByBody.map(([, id]) => id)).size).toBe(expectedByBody.length);
    for (const [body, expectedOwner] of expectedByBody) {
      expect(requireIrPlanningOwnerUnitId(context, body)).toBe(expectedOwner);
    }

    expect(requireIrPlanningOwnerUnitId(context, staticBlock.body)).toBe(moduleInitId);
    expect(requireIrPlanningOwnerUnitId(context, moduleStatement)).toBe(moduleInitId);
    expect(moduleInitId).not.toBe(unitId(context, owner));

    const before = {
      units: [...context.unitIdByDeclaration],
      unitRecords: [...context.unitByUnitId],
      terminals: [...context.terminalByUnitId],
      moduleInits: [...context.moduleInitUnitIdBySourceFile],
    };
    expect(Object.isFrozen(context)).toBe(true);
    expect(context.unitByUnitId.size).toBe(context.inventory.allUnits.length);
    for (const record of context.inventory.allUnits) {
      expect(context.unitByUnitId.get(record.id)).toBe(record);
    }
    expect(Reflect.get(context.unitIdByDeclaration, "set")).toBeUndefined();
    expect(Reflect.get(context.unitByUnitId, "set")).toBeUndefined();
    expect(Reflect.get(context.terminalByUnitId, "set")).toBeUndefined();
    requireIrPlanningOwnerUnitId(context, owner.body!);
    expect([...context.unitIdByDeclaration]).toEqual(before.units);
    expect([...context.unitByUnitId]).toEqual(before.unitRecords);
    expect([...context.terminalByUnitId]).toEqual(before.terminals);
    expect([...context.moduleInitUnitIdBySourceFile]).toEqual(before.moduleInits);
  });

  it("returns the outer terminal for nested, arrow, object-method, and Promise-like support units", () => {
    const fixture = source(
      "/repo/callbacks.ts",
      `
        function outer(factory = () => 0) {
          function nested() { return factory(); }
          const arrow = () => nested();
          const object = { method() { return arrow(); } };
          return new Promise((resolve) => { resolve(object.method()); });
        }
      `,
    );
    const context = contextFor([fixture]);
    const outer = functionDeclaration(fixture, "outer");
    const outerId = unitId(context, outer);
    const nested = collectNodes(outer.body!, ts.isFunctionDeclaration);
    const arrows = collectNodes(outer, ts.isArrowFunction);
    const objectMethods = collectNodes(
      outer,
      (node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent),
    );
    const supportDeclarations: readonly (ts.FunctionDeclaration | ts.ArrowFunction | ts.MethodDeclaration)[] = [
      ...nested,
      ...arrows,
      ...objectMethods,
    ];

    expect(nested).toHaveLength(1);
    expect(arrows).toHaveLength(3);
    expect(arrows.some((arrow) => ts.isNewExpression(arrow.parent))).toBe(true);
    expect(objectMethods).toHaveLength(1);
    for (const declaration of supportDeclarations) {
      expect(unitId(context, declaration)).not.toBe(outerId);
      expect(requireIrPlanningOwnerUnitId(context, declaration.body!)).toBe(outerId);
    }
  });

  it("keeps same-named units distinct and stable when source input order reverses", () => {
    const a = source("/repo/a.ts", `export function same() { return 1; }`);
    const b = source("/repo/b.ts", `export function same() { return 2; }`);
    const sameA = functionDeclaration(a, "same");
    const sameB = functionDeclaration(b, "same");
    const ownerRows = (context: IrPlanningIdentityContext): readonly [IrUnitId, IrUnitId] => [
      requireIrPlanningOwnerUnitId(context, sameA.body!),
      requireIrPlanningOwnerUnitId(context, sameB.body!),
    ];

    const forward = ownerRows(contextFor([a, b], a));
    const reversed = ownerRows(contextFor([b, a], a));
    expect(forward[0]).not.toBe(forward[1]);
    expect(reversed).toEqual(forward);
  });

  it("rejects a same-filename SourceFile clone before attempting an ancestry join", () => {
    const original = source("/repo/exact.ts", `function owner() { return 1; }`);
    const clone = source(original.fileName, original.text);
    const context = contextFor([original]);

    expectPlanningInvariant(
      () => requireIrPlanningOwnerUnitId(context, functionDeclaration(clone, "owner").body!),
      "source-record-mismatch",
    );
  });

  it("uses the exact compiler timer terminal as its own planning owner", () => {
    const fixture = source(
      "/repo/timer.ts",
      `
        const moduleValue = 1;
        function setTimeout(callback: () => void) { callback(); }
        export function user() { return moduleValue; }
      `,
    );
    const timer = functionDeclaration(fixture, "setTimeout");
    const inventory = buildIrUnitInventory([fixture], {
      entrySource: fixture,
      compilerOriginAt: (_sourceFile, offset) =>
        offset === timer.getStart(fixture) ? { producer: "timer-shim", role: "set-timeout" } : undefined,
    });
    const context = buildIrPlanningIdentityContext(inventory);

    expect(context.moduleInitUnitIdBySourceFile.has(fixture)).toBe(true);
    const timerId = unitId(context, timer);
    expect(context.unitByUnitId.get(timerId)).toMatchObject({
      terminal: true,
      terminalOwnerId: timerId,
      kind: "synthetic-support",
      syntheticRole: "compiler-unit:timer-shim:set-timeout",
    });
    expect(requireIrPlanningOwnerUnitId(context, timer.body!)).toBe(timerId);
  });

  it("rejects declaration-only nodes instead of inventing a module owner", () => {
    const declarations = source("/repo/types.d.ts", `declare function only(): void;`);
    const context = contextFor([declarations]);
    const declaration = functionDeclaration(declarations, "only");

    expect(declarations.isDeclarationFile).toBe(true);
    expect(context.unitIdByDeclaration.has(declaration)).toBe(false);
    expect(context.moduleInitUnitIdBySourceFile.has(declarations)).toBe(false);
    expectPlanningInvariant(() => requireIrPlanningOwnerUnitId(context, declaration), "missing-planning-owner");
  });

  it("fails closed for missing inventory, terminal-owner, and required module-init records", () => {
    const fixture = source("/repo/fail-closed.ts", `const boot = 1; function owner() { return boot; }`);
    const context = contextFor([fixture]);
    const owner = functionDeclaration(fixture, "owner");
    const ownerId = unitId(context, owner);
    const moduleStatement = fixture.statements.find(ts.isVariableStatement)!;

    const missingInventoryContext: IrPlanningIdentityContext = Object.freeze({
      ...context,
      unitByUnitId: new Map([...context.unitByUnitId].filter(([id]) => id !== ownerId)),
    });
    expectPlanningInvariant(
      () => requireIrPlanningOwnerUnitId(missingInventoryContext, owner.body!),
      "missing-planning-owner",
    );

    const missingTerminalContext: IrPlanningIdentityContext = Object.freeze({
      ...context,
      terminalByUnitId: new Map([...context.terminalByUnitId].filter(([id]) => id !== ownerId)),
    });
    expectPlanningInvariant(
      () => requireIrPlanningOwnerUnitId(missingTerminalContext, owner.body!),
      "missing-planning-owner",
    );

    const missingModuleContext: IrPlanningIdentityContext = Object.freeze({
      ...context,
      moduleInitUnitIdBySourceId: new Map<IrSourceId, IrUnitId>(),
      moduleInitUnitIdBySourceFile: new Map<ts.SourceFile, IrUnitId>(),
    });
    expectPlanningInvariant(
      () => requireIrPlanningOwnerUnitId(missingModuleContext, moduleStatement),
      "missing-planning-owner",
    );
  });
});
