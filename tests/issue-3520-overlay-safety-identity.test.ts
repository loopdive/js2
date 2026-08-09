// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  buildIrExactFunctionClaimIndex,
  buildIrRequestedFunctionSkipProjection,
  computeIrFirstSkipUnitIds,
  correlateIrSkippedFunctionNames,
  type IrExactFunctionClaim,
} from "../src/codegen/ir-overlay-safety.js";
import { collectLocalCallEdgesByIdentity } from "../src/codegen/ir-first-gate.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import { irVal } from "../src/ir/nodes.js";
import {
  buildIrPlanningIdentityContext,
  IrLegacyUnitProjectionInvariantError,
  type IrLegacyUnitProjectionInvariantCode,
  type IrPlanningIdentityContext,
} from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

function fixture(text: string): {
  readonly sourceFile: ts.SourceFile;
  readonly context: IrPlanningIdentityContext;
  readonly claims: readonly IrExactFunctionClaim[];
} {
  const sourceFile = ts.createSourceFile("/repo/main.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const context = buildIrPlanningIdentityContext(buildIrUnitInventory([sourceFile], { entrySource: sourceFile }));
  const claims = sourceFile.statements.filter(ts.isFunctionDeclaration).map((declaration) => ({
    unitId: context.unitIdByDeclaration.get(declaration)!,
    legacyName: declaration.name!.text,
    declaration,
  }));
  return { sourceFile, context, claims };
}

function expectProjectionError(run: () => unknown, code: IrLegacyUnitProjectionInvariantCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrLegacyUnitProjectionInvariantError);
  expect(caught).toMatchObject({ code });
}

describe("#3520 IR overlay safety projections", () => {
  it("rejects same-label exact skip owners instead of choosing one declaration", () => {
    const current = fixture(`function same(): number { return 1; } function same(): number { return 2; }`);
    const claimsById = buildIrExactFunctionClaimIndex(current.sourceFile, current.context, current.claims);
    const requested = new Set<IrUnitId>(current.claims.map((claim) => claim.unitId));

    expect(current.claims[0]!.unitId).not.toBe(current.claims[1]!.unitId);
    expect(claimsById.size).toBe(2);
    expectProjectionError(() => buildIrRequestedFunctionSkipProjection(requested, claimsById), "duplicate-legacy-name");
  });

  it("rejects a foreign returned name without consulting any global name map", () => {
    const current = fixture(`function requested(): number { return 1; } function foreign(): number { return 2; }`);
    const claimsById = buildIrExactFunctionClaimIndex(current.sourceFile, current.context, current.claims);
    const projection = buildIrRequestedFunctionSkipProjection(new Set([current.claims[0]!.unitId]), claimsById);

    expectProjectionError(() => correlateIrSkippedFunctionNames(projection, ["foreign"]), "foreign-result-correlation");
  });

  it("requires each requested result exactly once", () => {
    const current = fixture(`function one(): number { return 1; } function two(): number { return 2; }`);
    const claimsById = buildIrExactFunctionClaimIndex(current.sourceFile, current.context, current.claims);
    const projection = buildIrRequestedFunctionSkipProjection(
      new Set(current.claims.map((claim) => claim.unitId)),
      claimsById,
    );

    expectProjectionError(
      () => correlateIrSkippedFunctionNames(projection, ["one", "one"]),
      "duplicate-result-correlation",
    );
    expectProjectionError(() => correlateIrSkippedFunctionNames(projection, ["one"]), "unconsumed-result-correlation");
    expect(correlateIrSkippedFunctionNames(projection, ["two", "one"])).toEqual({
      unitIds: new Set(current.claims.map((claim) => claim.unitId)),
      legacyNames: ["two", "one"],
    });
  });

  it("rejects claims and call edges after the active source population goes stale", () => {
    const current = fixture(`function retained(): number { return 1; } retained();`);
    (current.sourceFile as unknown as { statements: ts.NodeArray<ts.Statement> }).statements =
      ts.factory.createNodeArray();

    expect(() => buildIrExactFunctionClaimIndex(current.sourceFile, current.context, current.claims)).toThrow(
      expect.objectContaining({ code: "unit-record-mismatch" }),
    );
    expect(() => collectLocalCallEdgesByIdentity(current.sourceFile, current.context)).toThrow(
      expect.objectContaining({ code: "missing-unit-declaration" }),
    );

    const moduleOnly = fixture(`const retained = 1;`);
    (moduleOnly.sourceFile as unknown as { statements: ts.NodeArray<ts.Statement> }).statements =
      ts.factory.createNodeArray();
    expect(() => collectLocalCallEdgesByIdentity(moduleOnly.sourceFile, moduleOnly.context)).toThrow(
      expect.objectContaining({ code: "invalid-module-init" }),
    );
  });

  it("closes late-feature blocks through selected functions outside the skip allowlist", () => {
    const current = fixture(`
      function blocked(value: number): number { return value + 1; }
      function middle(value: number): number { return Math.abs(blocked(value)); }
      function leaf(value: number): number { return middle(value); }
    `);
    const claimsById = buildIrExactFunctionClaimIndex(current.sourceFile, current.context, current.claims);
    const f64 = irVal({ kind: "f64" });
    const overridesByUnitId = new Map(
      current.claims.map(({ unitId }) => [unitId, { params: [f64], returnType: f64 }] as const),
    );
    const blockedId = current.claims.find(({ legacyName }) => legacyName === "blocked")!.unitId;

    expect(
      computeIrFirstSkipUnitIds({
        sourceFile: current.sourceFile,
        identityContext: current.context,
        safeFunctionUnitIds: new Set(current.claims.map(({ unitId }) => unitId)),
        claimsByUnitId: claimsById,
        overridesByUnitId,
        potentiallyBlockedOwnerUnitIds: new Set([blockedId]),
        generatorsSkippable: true,
      }),
    ).toEqual(new Set());
  });
});
