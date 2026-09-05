// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import { mergeIrIntegrationReports } from "../src/codegen/ir-overlay-safety.js";
import { planCountedStringAppend } from "../src/ir/analysis/counted-string-append.js";
import type { IrCountedStringAppendLoweringPlan } from "../src/ir/ast-lowering-plans.js";
import { irIntrinsicFuncRef } from "../src/ir/callable-bindings.js";
import { createIrCountedStringAppendSiteId } from "../src/ir/counted-string-append-provenance.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { buildIrUnitInventory, createDerivedIrUnitId, type IrSourceId, type IrUnitId } from "../src/ir/identity.js";
import { buildIrIntegrationReport } from "../src/ir/integration-report.js";
import {
  buildIrLegacyUnitProjection,
  buildIrPlanningIdentityContext,
  requireIrPlanningSourceId,
} from "../src/ir/planning-identity.js";
import { planIrCompilationByIdentity } from "../src/ir/select-identity.js";
import { IR_STRING_REPEAT_FN } from "../src/ir/string-runtime.js";
import { ts } from "../src/ts-api.js";

const BUILDER_SWITCH = "JS2WASM_IR_STRING_BUILDER";
const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";

const MULTI_SOURCE_CONTROL = {
  "./dep.ts": `export interface Marker { readonly tag: "marker"; }`,
  "./entry.ts": `
    import type { Marker } from "./dep";
    export function test(): string {
      let value = "seed";
      for (let index = 0; index < 3; index++) value = value + "xy";
      return value;
    }
    export type KeepDependencyInProgram = Marker;
  `,
} as const;

function exactFunction(sourceFile: ts.SourceFile): ts.FunctionDeclaration {
  const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration?.body) throw new Error("counted-string fixture lost its bodyful function");
  return declaration;
}

function exactLoop(declaration: ts.FunctionDeclaration): ts.ForStatement {
  let loop: ts.ForStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (loop || (node !== declaration && ts.isFunctionLike(node))) return;
    if (ts.isForStatement(node)) {
      loop = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  if (!loop) throw new Error("counted-string fixture lost its loop");
  return loop;
}

function fixture(
  tripCount: number,
  fragmentExpression = '"xy"',
  declarations = "",
): {
  readonly checker: ts.TypeChecker;
  readonly oracle: TsCheckerOracle;
  readonly declaration: ts.FunctionDeclaration;
  readonly ownerUnitId: IrUnitId;
  readonly identityContext: ReturnType<typeof buildIrPlanningIdentityContext>;
  readonly loweringPlan: IrCountedStringAppendLoweringPlan;
} {
  const { sourceFile, checker } = analyzeSource(
    `
      export function test(): string {
        let value = "seed";
        ${declarations}
        for (let index = 0; index < ${tripCount}; index++) value = value + ${fragmentExpression};
        return value;
      }
    `,
    `issue-3518-counted-string-${tripCount}.ts`,
  );
  const oracle = new TsCheckerOracle(checker);
  const declaration = exactFunction(sourceFile);
  const loop = exactLoop(declaration);
  const syntaxPlan = planCountedStringAppend({ checker, oracle }, loop);
  if (!syntaxPlan || syntaxPlan.tripCount !== tripCount) throw new Error("fixture lost its exact counted proof");
  const identityContext = buildIrPlanningIdentityContext(
    buildIrUnitInventory([sourceFile], { entrySource: sourceFile }),
  );
  const ownerUnitId = identityContext.unitIdByDeclaration.get(declaration);
  if (!ownerUnitId) throw new Error("fixture lost its exact owner UnitId");
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  const loweringPlan = Object.freeze({
    ownerUnitId,
    sourceId,
    siteId: createIrCountedStringAppendSiteId({
      sourceId,
      ownerUnitId,
      loopStart: loop.getStart(sourceFile),
      loopEnd: loop.getEnd(),
    }),
    sourceFile,
    syntaxPlan,
    provider: irIntrinsicFuncRef(IR_STRING_REPEAT_FN),
  });
  return { checker, oracle, declaration, ownerUnitId, identityContext, loweringPlan };
}

function lowerCounted(tripCount: number, fragmentExpression?: string, declarations?: string) {
  const exact = fixture(tripCount, fragmentExpression, declarations);
  const lowered = lowerFunctionAstToIr(exact.declaration, {
    ownerUnitId: exact.ownerUnitId,
    exported: true,
    checker: exact.checker,
    oracle: exact.oracle,
    identityContext: exact.identityContext,
    resolver: { resolveString: () => ({ kind: "externref" }) },
    returnTypeOverride: { kind: "string" },
    countedStringAppends: new Map([[exact.loweringPlan.syntaxPlan.loop, exact.loweringPlan]]),
  });
  return {
    exact,
    lowered,
    instructions: lowered.main.blocks.flatMap((block) => block.instrs),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#3518 Transaction B2 counted-string Prepared cutover", () => {
  it("claims only with the exact checker proof and retains builder-off rollback", () => {
    const exact = fixture(3);
    const sourceFile = exact.declaration.getSourceFile();
    const withoutProof = planIrCompilationByIdentity(sourceFile, exact.identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
    });
    expect(withoutProof.funcs.has(exact.ownerUnitId)).toBe(false);

    let plannedProof = null as ReturnType<typeof planCountedStringAppend>;
    let proofCalls = 0;
    const withProof = planIrCompilationByIdentity(sourceFile, exact.identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
      planCountedStringAppend: (loop) => {
        proofCalls++;
        plannedProof = planCountedStringAppend({ checker: exact.checker, oracle: exact.oracle }, loop);
        return plannedProof;
      },
    });
    expect(withProof.funcs.has(exact.ownerUnitId)).toBe(true);
    expect(proofCalls).toBe(1);
    expect(withProof.countedStringAppendPlans?.get(exact.ownerUnitId)).toEqual([exact.loweringPlan.syntaxPlan]);
    expect(withProof.countedStringAppendPlans?.get(exact.ownerUnitId)?.[0]).toBe(plannedProof);

    vi.stubEnv(BUILDER_SWITCH, "0");
    const rolledBack = planIrCompilationByIdentity(sourceFile, exact.identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
      planCountedStringAppend: (loop) =>
        planCountedStringAppend({ checker: exact.checker, oracle: exact.oracle }, loop),
    });
    expect(rolledBack.funcs.has(exact.ownerUnitId)).toBe(false);

    const rolledBackWithoutProof = planIrCompilationByIdentity(sourceFile, exact.identityContext, {
      experimentalIR: true,
      trackFallbacks: true,
      planCountedStringAppend: () => null,
    });
    expect(rolledBackWithoutProof.funcs.has(exact.ownerUnitId)).toBe(false);
  });

  it("emits the exact zero, one, and aggregate instruction shapes", () => {
    const zero = lowerCounted(0);
    expect(zero.instructions.filter((instruction) => instruction.kind === "string.repeat")).toHaveLength(0);
    expect(zero.instructions.filter((instruction) => instruction.kind === "string.concat")).toHaveLength(0);
    expect(zero.lowered.countedStringAppendPlans).toEqual([zero.exact.loweringPlan]);
    expect(zero.exact.loweringPlan.siteId).toMatch(/^ir-counted-string-append-site:v1:/);

    const one = lowerCounted(1);
    expect(one.instructions.filter((instruction) => instruction.kind === "string.repeat")).toHaveLength(0);
    expect(one.instructions.filter((instruction) => instruction.kind === "string.concat")).toHaveLength(1);
    expect(one.lowered.countedStringAppendPlans).toEqual([one.exact.loweringPlan]);
    expect(one.exact.loweringPlan.siteId).toMatch(/^ir-counted-string-append-site:v1:/);

    const aggregate = lowerCounted(3);
    expect(aggregate.instructions.filter((instruction) => instruction.kind === "string.repeat")).toHaveLength(1);
    expect(aggregate.instructions.filter((instruction) => instruction.kind === "string.concat")).toHaveLength(1);
    expect(
      aggregate.instructions.find((instruction) => instruction.kind === "string.repeat")?.countedStringAppendSite,
    ).toBe(aggregate.exact.loweringPlan.siteId);
    expect(
      aggregate.instructions.find((instruction) => instruction.kind === "string.repeat")?.countedStringAppendTripCount,
    ).toBe(3);
    expect(aggregate.lowered.main.blocks).toHaveLength(1);
    expect(aggregate.lowered.countedStringAppendPlans).toEqual([aggregate.exact.loweringPlan]);
  });

  it("canonicalizes const aliases to a bounded literal proof and keeps oversized results generic", () => {
    const alias = lowerCounted(3, "fragment", 'const fragment = "xy";');
    const repeat = alias.instructions.find((instruction) => instruction.kind === "string.repeat");
    expect(repeat?.countedStringAppendTripCount).toBe(3);
    const fragment = alias.instructions.find((instruction) => instruction.result === repeat?.value);
    expect(fragment).toMatchObject({ kind: "string.const", value: "xy" });
    expect(alias.exact.loweringPlan.syntaxPlan.fragmentValue).toBe("xy");

    const oversized = lowerCounted(0x2000_0001);
    expect(
      oversized.instructions.find((instruction) => instruction.kind === "string.repeat")?.countedStringAppendTripCount,
    ).toBeUndefined();
  });

  it("fails closed on provider, owner, and consumption drift", () => {
    const exact = fixture(3);
    const lower = (plan: IrCountedStringAppendLoweringPlan, extra = false) => {
      const countedStringAppends = new Map<ts.ForStatement, IrCountedStringAppendLoweringPlan>([
        [exact.loweringPlan.syntaxPlan.loop, plan],
      ]);
      if (extra) {
        countedStringAppends.set(
          ts.factory.createForStatement(undefined, undefined, undefined, ts.factory.createEmptyStatement()),
          plan,
        );
      }
      return lowerFunctionAstToIr(exact.declaration, {
        ownerUnitId: exact.ownerUnitId,
        exported: true,
        checker: exact.checker,
        oracle: exact.oracle,
        identityContext: exact.identityContext,
        resolver: { resolveString: () => ({ kind: "externref" }) },
        returnTypeOverride: { kind: "string" },
        countedStringAppends,
      });
    };

    expect(() => lower({ ...exact.loweringPlan, provider: irIntrinsicFuncRef("__tampered_repeat_provider") })).toThrow(
      /counted-string plan identity drift/,
    );
    expect(() => lower({ ...exact.loweringPlan, ownerUnitId: "ir-unit:v1:stale" as IrUnitId })).toThrow(
      /stale counted string append plan owner/,
    );
    expect(() => lower({ ...exact.loweringPlan, sourceId: "ir-source:v1:stale" as IrSourceId })).toThrow(
      /counted-string plan identity drift/,
    );
    expect(() =>
      lower({
        ...exact.loweringPlan,
        siteId: `${exact.loweringPlan.siteId}:stale` as typeof exact.loweringPlan.siteId,
      }),
    ).toThrow(/counted-string plan identity drift/);
    expect(() => lower(exact.loweringPlan, true)).toThrow(/counted-string plan census drift/);
  });

  it("preserves exact receipts across split reports and rejects duplicate consumption", () => {
    const exact = fixture(3);
    const receipt = Object.freeze({
      siteId: exact.loweringPlan.siteId,
      plan: exact.loweringPlan,
      finalInstructionDigest: "0123456789abcdef",
    });
    const empty = { compiled: [], errors: [], terminalEvidence: [] } as const;
    const ownerProjection = buildIrLegacyUnitProjection([{ unitId: exact.ownerUnitId, legacyName: "test" }]);
    const terminalReport = buildIrIntegrationReport(
      ["test"],
      [],
      ownerProjection,
      ["test"],
      [],
      [
        {
          artifactUnitId: exact.ownerUnitId,
          terminalOwnerUnitId: exact.ownerUnitId,
          name: "test",
        },
      ],
      [receipt],
    );
    const merged = mergeIrIntegrationReports(terminalReport, empty);
    expect(merged.preparedCountedStringAppendReceipts).toEqual([receipt]);
    expect(Object.isFrozen(merged.preparedCountedStringAppendReceipts)).toBe(true);
    expect(() => mergeIrIntegrationReports(terminalReport, terminalReport)).toThrow(/duplicate counted-string site/);

    const reparsed = fixture(3);
    expect(reparsed.loweringPlan.syntaxPlan.loop).not.toBe(exact.loweringPlan.syntaxPlan.loop);
    expect(reparsed.loweringPlan.siteId).toBe(exact.loweringPlan.siteId);
    const reparsedReceipt = Object.freeze({
      siteId: reparsed.loweringPlan.siteId,
      plan: reparsed.loweringPlan,
      finalInstructionDigest: "0123456789abcdef",
    });
    const reparsedReport = buildIrIntegrationReport(
      ["test"],
      [],
      buildIrLegacyUnitProjection([{ unitId: reparsed.ownerUnitId, legacyName: "test" }]),
      ["test"],
      [],
      [{ artifactUnitId: reparsed.ownerUnitId, terminalOwnerUnitId: reparsed.ownerUnitId, name: "test" }],
      [reparsedReceipt],
    );
    expect(() => mergeIrIntegrationReports(terminalReport, reparsedReport)).toThrow(/duplicate counted-string site/);
    expect(() =>
      mergeIrIntegrationReports(
        { ...empty, compiledArtifactEvidence: [], preparedCountedStringAppendReceipts: [receipt] },
        empty,
      ),
    ).toThrow(/first split IR report has a counted-string receipt without an exact terminal patch/);

    const syntheticUnitId = createDerivedIrUnitId({
      parentId: exact.ownerUnitId,
      role: "lifted-closure",
      ordinal: 0,
    });
    expect(() =>
      buildIrIntegrationReport(
        ["test$synthetic"],
        [],
        ownerProjection,
        [],
        [],
        [
          {
            artifactUnitId: syntheticUnitId,
            terminalOwnerUnitId: exact.ownerUnitId,
            name: "test$synthetic",
          },
        ],
        [receipt],
      ),
    ).toThrow(/prepared counted-string receipt site is duplicated or has no exact compiled terminal artifact/);
  });

  it("keeps the multi-source counted loop on direct ownership until Transaction C", async () => {
    // Load the public compiler only after the leaf proof graph above has
    // settled; eager co-import recreates the repository's collections cycle.
    const { compileMulti } = await import("../src/index.js");
    const control = await compileMulti(MULTI_SOURCE_CONTROL, "./entry.ts", {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(control.success, control.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")).toBe(true);
    expect(control.irOutcomes?.find((outcome) => outcome.displayName === "test")).toMatchObject({
      kind: "unsupported",
      code: "string-builder-candidate",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(
      control.irBodyRouteAudit?.legacyEntries
        .filter((entry) => entry.bodyName === "test")
        .map((entry) => entry.entryPoint),
    ).toEqual(["compileFunctionBody", "compileStatement"]);

    vi.stubEnv(DIRECT_POISON, "test");
    const poisoned = await compileMulti(MULTI_SOURCE_CONTROL, "./entry.ts", {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(poisoned.success).toBe(false);
    expect(poisoned.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: test",
    );
  });
});
