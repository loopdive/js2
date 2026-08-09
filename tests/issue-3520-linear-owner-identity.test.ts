// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import {
  buildLinearIrLegacySlotAdapters,
  getLastLinearIrReport,
  indexLinearIrSourceOwners,
} from "../src/ir/backend/linear-integration.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
} from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

const LINEAR_IR_FLAG = "JS2WASM_LINEAR_IR";
const savedLinearIrFlag = process.env[LINEAR_IR_FLAG];

afterEach(() => {
  if (savedLinearIrFlag === undefined) delete process.env[LINEAR_IR_FLAG];
  else process.env[LINEAR_IR_FLAG] = savedLinearIrFlag;
});

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function context(files: readonly ts.SourceFile[], entry = files[0]!): IrPlanningIdentityContext {
  return buildIrPlanningIdentityContext(buildIrUnitInventory(files, { entrySource: entry }));
}

describe("#3520 linear integration owner identity", () => {
  it("keeps same-named source owners distinct and rejects a cross-context population", () => {
    const a = source("/repo/a.ts", `export function same(value: number): number { return value + 1; }`);
    const b = source("/repo/b.ts", `export function same(value: number): number { return value + 2; }`);
    const identityContext = context([a, b], a);
    const aIndex = indexLinearIrSourceOwners(a, identityContext);
    const bIndex = indexLinearIrSourceOwners(b, identityContext);

    expect(aIndex.owners).toHaveLength(1);
    expect(bIndex.owners).toHaveLength(1);
    expect(aIndex.owners[0]!.legacyName).toBe("same");
    expect(bIndex.owners[0]!.legacyName).toBe("same");
    expect(aIndex.owners[0]!.ownerUnitId).not.toBe(bIndex.owners[0]!.ownerUnitId);
    expect(aIndex.owners[0]!.declaration.getSourceFile()).toBe(a);
    expect(bIndex.owners[0]!.declaration.getSourceFile()).toBe(b);

    expect(() => indexLinearIrSourceOwners(b, context([a]))).toThrowError(
      expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "source-record-mismatch" }),
    );
  });

  it("keeps duplicate labels distinct and rejects a shared concrete slot", () => {
    const file = source(
      "/repo/ambiguous.ts",
      `
        function same(value: number): number { return value + 1; }
        function same(value: number): number { return value + 2; }
      `,
    );
    const identityContext = context([file]);
    const ownerIndex = indexLinearIrSourceOwners(file, identityContext);

    expect(ownerIndex.owners).toHaveLength(2);
    expect(ownerIndex.owners.map((owner) => owner.legacyName)).toEqual(["same", "same"]);
    expect(new Set(ownerIndex.owners.map((owner) => owner.ownerUnitId)).size).toBe(2);

    const distinct = buildLinearIrLegacySlotAdapters(
      ownerIndex,
      ownerIndex.owners.map((owner, index) => ({
        declaration: owner.declaration,
        legacyName: "same",
        funcIdx: 40 + index,
      })),
    );
    expect(
      distinct.map(({ ownerUnitId, legacyName, slotName, funcIdx }) => ({
        ownerUnitId,
        legacyName,
        slotName,
        funcIdx,
      })),
    ).toEqual([
      { ownerUnitId: ownerIndex.owners[0]!.ownerUnitId, legacyName: "same", slotName: "same", funcIdx: 40 },
      { ownerUnitId: ownerIndex.owners[1]!.ownerUnitId, legacyName: "same", slotName: "same", funcIdx: 41 },
    ]);

    expect(() =>
      buildLinearIrLegacySlotAdapters(
        ownerIndex,
        ownerIndex.owners.map((owner) => ({
          declaration: owner.declaration,
          legacyName: "same",
          funcIdx: 40,
        })),
      ),
    ).toThrowError(expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "unit-record-mismatch" }));
    expect(() =>
      buildLinearIrLegacySlotAdapters(ownerIndex, [{ declaration: file, legacyName: "unowned", funcIdx: 42 }]),
    ).toThrowError(expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "unit-record-mismatch" }));
  });

  it("retains exact owners for compiled and rejected public name telemetry", async () => {
    delete process.env[LINEAR_IR_FLAG];
    const result = await compile(
      `
        export function accepted(value: number): number { return value + 1; }
        export function withDefault(value: number = 1): number { return value + 2; }
      `,
      { target: "linear", fileName: "linear-owner.ts" },
    );
    expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);

    const report = getLastLinearIrReport();
    expect(report?.compiled).toContain("accepted");
    const rejection = report?.rejected.find((candidate) => candidate.func === "withDefault");
    expect(rejection).toMatchObject({ reason: "select:param-shape-rejected" });

    const compiledOwner = report?.ownerEvidence.find(
      (evidence) => evidence.outcome === "compiled" && evidence.legacyName === "accepted",
    );
    const rejectedOwner = report?.ownerEvidence.find(
      (evidence) => evidence.outcome === "rejected" && evidence.legacyName === "withDefault",
    );
    expect(compiledOwner).toMatchObject({ outcome: "compiled", legacyName: "accepted" });
    expect(rejectedOwner).toMatchObject({ outcome: "rejected", legacyName: "withDefault", rejection });
    expect(compiledOwner?.ownerUnitId).toBeTruthy();
    expect(rejectedOwner?.ownerUnitId).toBeTruthy();
    expect(compiledOwner?.ownerUnitId).not.toBe(rejectedOwner?.ownerUnitId);
    expect([...report!.funcs.keys()]).toEqual([compiledOwner!.ownerUnitId]);
    expect(report!.legacySlots.find((slot) => slot.ownerUnitId === compiledOwner!.ownerUnitId)).toMatchObject({
      legacyName: "accepted",
      slotName: "accepted",
    });
  });
});
