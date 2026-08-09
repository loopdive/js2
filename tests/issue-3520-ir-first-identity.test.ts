// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { collectLocalCallEdgesByIdentity, type IrIdentityLocalCallEdges } from "../src/codegen/ir-first-gate.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
} from "../src/ir/planning-identity.js";

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
}

function contextFor(
  sourceFiles: readonly ts.SourceFile[],
  entrySource: ts.SourceFile = sourceFiles[0]!,
): IrPlanningIdentityContext {
  return buildIrPlanningIdentityContext(buildIrUnitInventory(sourceFiles, { entrySource }));
}

function topLevelFunction(sourceFile: ts.SourceFile, name: string, ordinal = 0): ts.FunctionDeclaration {
  const matches = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  const declaration = matches[ordinal];
  if (!declaration) throw new Error(`missing function ${name}#${ordinal}`);
  return declaration;
}

function unitId(context: IrPlanningIdentityContext, declaration: ts.Node): IrUnitId {
  const id = context.unitIdByDeclaration.get(declaration);
  if (!id) throw new Error(`missing unit identity for ${ts.SyntaxKind[declaration.kind]}`);
  return id;
}

function targets(edges: IrIdentityLocalCallEdges, caller: IrUnitId): IrUnitId[] {
  return [...(edges.callees.get(caller) ?? [])].sort();
}

function firstNode<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (guard(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error("missing expected AST node");
  return found;
}

describe("#3520 identity-keyed IR-first local-call edges", () => {
  it("keeps same-named callers and targets source-local and input-order stable", () => {
    const a = source("/repo/a.ts", `export function same() { return 1; } export function owner() { return same(); }`);
    const b = source("/repo/b.ts", `export function same() { return 2; } export function owner() { return same(); }`);

    const rows = (context: IrPlanningIdentityContext) => {
      const ownerA = unitId(context, topLevelFunction(a, "owner"));
      const ownerB = unitId(context, topLevelFunction(b, "owner"));
      const sameA = unitId(context, topLevelFunction(a, "same"));
      const sameB = unitId(context, topLevelFunction(b, "same"));
      const edgesA = collectLocalCallEdgesByIdentity(a, context);
      const edgesB = collectLocalCallEdgesByIdentity(b, context);
      return {
        ownerA,
        ownerB,
        sameA,
        sameB,
        targetsA: targets(edgesA, ownerA),
        targetsB: targets(edgesB, ownerB),
      };
    };

    const forward = rows(contextFor([a, b], a));
    const reversed = rows(contextFor([b, a], a));
    expect(forward.sameA).not.toBe(forward.sameB);
    expect(forward.targetsA).toEqual([forward.sameA]);
    expect(forward.targetsB).toEqual([forward.sameB]);
    expect(reversed).toEqual(forward);
  });

  it("rejects an exact-text SourceFile clone outside the authoritative context", () => {
    const original = source("/repo/exact.ts", `function target() {} target();`);
    const context = contextFor([original]);
    const clone = source(original.fileName, original.text);

    try {
      collectLocalCallEdgesByIdentity(clone, context);
      throw new Error("expected source identity rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(IrPlanningIdentityInvariantError);
      expect((error as IrPlanningIdentityInvariantError).code).toBe("source-record-mismatch");
    }
  });

  it("uses exact function, class-member, and module-init owners for nested calls", () => {
    const fixture = source(
      "/repo/owners.ts",
      `
        function topTarget() { return 1; }
        function callbackTarget() { return 2; }
        function owner() {
          topTarget();
          const callback = () => callbackTarget();
          return callback();
        }
        function destructureOwner({ value = callbackTarget() } = {}) { return value; }
        class Box {
          constructor() { topTarget(); }
          method() {
            const callback = () => callbackTarget();
            return callback();
          }
          get value() { return topTarget(); }
        }
        topTarget();
      `,
    );
    const context = contextFor([fixture]);
    const edges = collectLocalCallEdgesByIdentity(fixture, context);
    const topTarget = unitId(context, topLevelFunction(fixture, "topTarget"));
    const callbackTarget = unitId(context, topLevelFunction(fixture, "callbackTarget"));
    const owner = unitId(context, topLevelFunction(fixture, "owner"));
    const destructureOwner = unitId(context, topLevelFunction(fixture, "destructureOwner"));
    const box = fixture.statements.find(ts.isClassDeclaration)!;
    const constructorMember = box.members.find(ts.isConstructorDeclaration)!;
    const method = box.members.find(
      (member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "method",
    )!;
    const getter = box.members.find(ts.isGetAccessorDeclaration)!;
    const constructorId = unitId(context, constructorMember);
    const methodId = unitId(context, method);
    const getterId = unitId(context, getter);
    const moduleInitId = context.moduleInitUnitIdBySourceFile.get(fixture)!;
    const methodArrowId = unitId(context, firstNode(method, ts.isArrowFunction));

    expect(targets(edges, owner)).toEqual([callbackTarget, topTarget].sort());
    expect(targets(edges, destructureOwner)).toEqual([callbackTarget]);
    expect(targets(edges, constructorId)).toEqual([topTarget]);
    expect(targets(edges, methodId)).toEqual([callbackTarget]);
    expect(targets(edges, getterId)).toEqual([topTarget]);
    expect(targets(edges, moduleInitId)).toEqual([topTarget]);
    expect(edges.callees.has(methodArrowId)).toBe(false);
    expect([...edges.calleesFromUnownedCallers]).toEqual([]);
  });

  it("attributes class field initializer calls through their property unit anchors", () => {
    const fixture = source(
      "/repo/field-owners.ts",
      `
        function target() { return 1; }
        class Fields {
          static definition = target();
          instance = target();
          nested = class { value = target(); };
        }
      `,
    );
    const context = contextFor([fixture]);
    const declaration = fixture.statements.find(ts.isClassDeclaration)!;
    const constructorId = unitId(context, declaration);
    const moduleInitId = context.moduleInitUnitIdBySourceFile.get(fixture)!;
    const targetId = unitId(context, topLevelFunction(fixture, "target"));
    const edges = collectLocalCallEdgesByIdentity(fixture, context);

    expect(targets(edges, moduleInitId)).toEqual([targetId]);
    expect(targets(edges, constructorId)).toEqual([targetId]);
    expect([...edges.calleesFromUnownedCallers]).toEqual([]);
  });

  it("retains every duplicate same-source target instead of choosing by insertion order", () => {
    const fixture = source(
      "/repo/duplicates.ts",
      `
        function same() { return 1; }
        function same() { return 2; }
        function owner() { return same(); }
      `,
    );
    const context = contextFor([fixture]);
    const edges = collectLocalCallEdgesByIdentity(fixture, context);
    const duplicateIds = [
      unitId(context, topLevelFunction(fixture, "same", 0)),
      unitId(context, topLevelFunction(fixture, "same", 1)),
    ].sort();
    const ownerId = unitId(context, topLevelFunction(fixture, "owner"));

    expect(duplicateIds[0]).not.toBe(duplicateIds[1]);
    expect(targets(edges, ownerId)).toEqual(duplicateIds);
    expect([...edges.calleesFromUnownedCallers]).toEqual([]);
  });

  it("reports local callees from source regions with no executable owner", () => {
    const fixture = source("/repo/unowned.ts", `function target() { return 1; } export default target();`);
    const context = contextFor([fixture]);
    const targetId = unitId(context, topLevelFunction(fixture, "target"));
    const edges = collectLocalCallEdgesByIdentity(fixture, context);

    expect(context.moduleInitUnitIdBySourceFile.has(fixture)).toBe(false);
    expect([...edges.calleesFromUnownedCallers]).toEqual([targetId]);
    expect(edges.callees.size).toBe(0);
  });

  it("does not invent a module-init caller for a declaration-only source", () => {
    const declarations = source("/repo/types.d.ts", `declare function only(): void;`);
    const context = contextFor([declarations]);
    const edges = collectLocalCallEdgesByIdentity(declarations, context);

    expect(declarations.isDeclarationFile).toBe(true);
    expect(context.moduleInitUnitIdBySourceFile.has(declarations)).toBe(false);
    expect(edges.callees.size).toBe(0);
    expect(edges.calleesFromUnownedCallers.size).toBe(0);
  });

  it("rejects a nonempty module population whose structural owner is missing", () => {
    const fixture = source("/repo/missing-module-owner.ts", `function target() {} target();`);
    const context = contextFor([fixture]);
    const invalidContext: IrPlanningIdentityContext = {
      ...context,
      moduleInitUnitIdBySourceFile: new Map(),
    };

    expect(() => collectLocalCallEdgesByIdentity(fixture, invalidContext)).toThrow(
      expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "invalid-module-init" }),
    );
  });
});
