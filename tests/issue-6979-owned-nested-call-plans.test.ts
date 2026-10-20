// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext, requireIrPlanningOwnerUnitId } from "../src/ir/planning-identity.js";
import { buildIrProgramCallableBindingGraph } from "../src/ir/program-callable-bindings.js";

const SOURCE = `function helper(value: number): number { return value + 1; }
export function owner(seed: number): number {
  const closure = (value: number): number => helper(value + seed);
  function nested(value: number): number { return helper(value); }
  const object = { method(value: number): number { return helper(value); } };
  return helper(seed) + closure(seed) + nested(seed) + object.method(seed);
}`;
function fixture(text = SOURCE) {
  const input = sourceInput({ "./entry.ts": text });
  const inventory = buildIrUnitInventory(input.sourceFiles, { checker: input.checker, entrySource: input.entrySource });
  const identity = buildIrPlanningIdentityContext(inventory);
  const graph = (includeOwnedNestedCalls?: boolean) =>
    buildIrProgramCallableBindingGraph({
      checker: input.checker,
      sourceFiles: input.sourceFiles,
      identityContext: identity,
      includeOwnedNestedCalls,
    });
  return { input, inventory, identity, graph };
}

describe("exact owned nested source call planning", () => {
  it("keeps the legacy census unchanged and joins original arrow/nested sites only through their R0 owner", () => {
    const f = fixture(),
      legacy = f.graph(),
      selected = f.graph(true);
    expect(legacy.uses).toHaveLength(1);
    expect(selected.uses).toHaveLength(3);
    const owner = f.inventory.terminalUnits.find((row) => row.displayName === "owner")!;
    const helper = f.inventory.terminalUnits.find((row) => row.displayName === "helper")!;
    expect(owner).toBeDefined();
    expect(helper).toBeDefined();
    for (const use of selected.uses) {
      expect(use.ownerUnitId).toBe(owner.id);
      expect(use.targetUnitId).toBe(helper.id);
      expect(requireIrPlanningOwnerUnitId(f.identity, use.node)).toBe(owner.id);
      expect(use.node.getSourceFile()).toBe(f.input.entrySource);
      expect(selected.resolveCall(use.node, owner.id)).toBe(use);
      expect(selected.resolveCall(use.node, helper.id)).toBeUndefined();
    }
    const arrow = selected.uses.find((use) => ts.findAncestor(use.node.parent, ts.isArrowFunction) !== undefined);
    expect(arrow).toBeDefined();
    const methodSites: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node)) {
        const calls = (child: ts.Node): void => {
          if (ts.isCallExpression(child)) methodSites.push(child);
          ts.forEachChild(child, calls);
        };
        ts.forEachChild(node, calls);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(f.input.entrySource);
    expect(methodSites).toHaveLength(1);
    expect(selected.uses.some((use) => use.node === methodSites[0])).toBe(false);
  });

  it("does not authorize same-spelled parameter calls as a global fixed target", () => {
    const f = fixture(`function helper(value: number): number { return value + 1; }
      export function owner(helper: (value: number) => number, seed: number): (value: number) => number {
        return (value: number): number => helper(value + seed);
      }`);
    expect(f.graph(true).uses).toEqual([]);
    expect(f.graph().uses).toEqual([]);
  });

  it("keeps reassigned source functions out of fixed-target authority inside a closure", () => {
    const f = fixture(`function helper(value: number): number { return value + 1; }
      export function owner(seed: number): (value: number) => number {
        return (value: number): number => { helper = (other: number): number => other * 2; return helper(seed + value); };
      }`);
    expect(f.graph(true).uses).toEqual([]);
  });

  it("refuses a copied source population even with nested traversal selected", () => {
    const f = fixture();
    const copied = ts.createSourceFile(
      f.input.entrySource.fileName,
      SOURCE,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(() =>
      buildIrProgramCallableBindingGraph({
        checker: f.input.checker,
        sourceFiles: [copied],
        identityContext: f.identity,
        includeOwnedNestedCalls: true,
      }),
    ).toThrow();
  });
});
