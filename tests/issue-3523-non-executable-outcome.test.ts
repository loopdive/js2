// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #3523 R4 gap 4 — a non-executable module records a truthful outcome row.
 *
 * Before this slice a source whose module-init plan is `executable: false`
 * recorded NO outcome row at all, so the ledger under-counted by omission and
 * AC 7 ("counters reconcile for executable and empty modules") stayed open.
 */

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { IrBodyRouteAuditSession } from "../src/codegen/legacy-body-audit.js";
import { compile, compileMulti, type CompileResult } from "../src/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { evaluateIrOutcomePolicy, nonExecutableOutcomeDefect, type IrObservedOutcome } from "../src/ir/outcomes.js";

const FUNCTION_ONLY = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
const TYPE_ONLY = `export type Alias = number;\nexport interface Shape {\n  x: number;\n}\n`;
const TRULY_EMPTY = `\n`;
const EXECUTABLE = `${FUNCTION_ONLY}export const seed: number = add(1, 2);\n`;

type Lane = { readonly label: string; readonly options: Parameters<typeof compile>[1] };

const LANES: readonly Lane[] = [
  { label: "gc", options: { trackIrOutcomes: true } },
  { label: "standalone", options: { trackIrOutcomes: true, target: "standalone" } },
];

async function outcomesFor(source: string, fileName: string, lane: Lane): Promise<readonly IrObservedOutcome[]> {
  const result: CompileResult = await compile(source, { ...lane.options, fileName });
  expect(result.success, `${fileName} [${lane.label}] failed to compile`).toBe(true);
  return result.irOutcomes ?? [];
}

const nonExecutableRows = (outcomes: readonly IrObservedOutcome[]): readonly IrObservedOutcome[] =>
  outcomes.filter((outcome) => outcome.kind === "non-executable");

/** A well-formed row, built the way the compiler builds one. */
function wellFormedRow(overrides: Partial<IrObservedOutcome> = {}): IrObservedOutcome {
  return {
    key: "probe.ts::module-init::<module-init>#0",
    sourceId: "ir-source:v1:probe",
    file: "probe.ts",
    unitKind: "module-init",
    displayName: "<module-init>",
    ordinal: 0,
    line: 1,
    column: 1,
    backend: "wasmgc",
    target: "gc",
    kind: "non-executable",
    stage: "select",
    legacyBodyEmitted: false,
    irBodyEmitted: false,
    ...overrides,
  } as IrObservedOutcome;
}

const EMITTED_CONTROL: IrObservedOutcome = {
  key: "probe.ts::top-level-function::add#0",
  sourceId: "ir-source:v1:probe",
  unitId: "ir-unit:v1:probe:root:top-level-function:0",
  file: "probe.ts",
  unitKind: "function",
  displayName: "add",
  ordinal: 0,
  line: 1,
  column: 1,
  backend: "wasmgc",
  target: "gc",
  kind: "emitted",
  stage: "patch",
  legacyBodyEmitted: false,
  irBodyEmitted: true,
} as IrObservedOutcome;

describe("#3523 R4 gap 4 — non-executable module-init outcome rows", () => {
  describe.each(LANES)("lane $label", (lane) => {
    it.each([
      ["function-only", FUNCTION_ONLY],
      ["type-only", TYPE_ONLY],
      ["truly-empty", TRULY_EMPTY],
    ])("records exactly one well-formed non-executable row for a %s source", async (label, source) => {
      const outcomes = await outcomesFor(source, `${label}.ts`, lane);
      const rows = nonExecutableRows(outcomes);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(nonExecutableOutcomeDefect(row!)).toBeUndefined();
      expect(row!.unitKind).toBe("module-init");
      // P1 (2026-08-31): the identity inventory mints NO module-init unit for an
      // empty population, so the row's identity is the SOURCE. A unit id here
      // would be borrowed, not observed.
      expect(row!.unitId).toBeUndefined();
      expect(row!.sourceId).toBeDefined();
      expect(row!.legacyBodyEmitted).toBe(false);
      expect(row!.irBodyEmitted).toBe(false);
      expect(row!.prepareAttempts).toBeUndefined();
      expect(row!.directBodyEmissions).toBeUndefined();
      expect(row!.irBodyEmissions).toBeUndefined();
    });

    it("records the executable control's module-init row and NO non-executable row", async () => {
      const outcomes = await outcomesFor(EXECUTABLE, "executable.ts", lane);
      expect(nonExecutableRows(outcomes)).toHaveLength(0);
      const moduleInit = outcomes.filter((outcome) => outcome.unitKind === "module-init");
      expect(moduleInit).toHaveLength(1);
      expect(moduleInit[0]!.unitId).toBeDefined();
      expect(moduleInit[0]!.kind).not.toBe("non-executable");
    });

    it("leaves the body-route audit free of new violations", async () => {
      const result = await compile(FUNCTION_ONLY, { ...lane.options, fileName: "audited.ts" });
      expect(result.irBodyRouteAudit?.violations ?? []).toEqual([]);
    });
  });

  describe("multi-source attribution", () => {
    it("attributes one non-executable row to an empty dependency beside an executable entry", async () => {
      const result = await compileMulti(
        {
          "/dep.ts": TYPE_ONLY,
          "/main.ts": `import type { Alias } from "./dep.js";\n${EXECUTABLE}`,
        },
        "/main.ts",
        { trackIrOutcomes: true },
      );
      expect(result.success).toBe(true);
      const rows = nonExecutableRows(result.irOutcomes ?? []);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.file).toContain("dep.ts");
      // The executable entry keeps its own unit-identified module-init row.
      const entryModuleInit = (result.irOutcomes ?? []).filter(
        (outcome) => outcome.unitKind === "module-init" && outcome.kind !== "non-executable",
      );
      expect(entryModuleInit).toHaveLength(1);
      expect(entryModuleInit[0]!.file).toContain("main.ts");
    });

    it("gives two empty sources two rows with distinct source ids", async () => {
      const result = await compileMulti(
        {
          "/dep.ts": `export function helper(x: number): number {\n  return x + 1;\n}\n`,
          "/main.ts": `import { helper } from "./dep.js";\nexport function add(a: number): number {\n  return helper(a);\n}\n`,
        },
        "/main.ts",
        { trackIrOutcomes: true },
      );
      expect(result.success).toBe(true);
      const rows = nonExecutableRows(result.irOutcomes ?? []);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.sourceId)).size).toBe(2);
      expect(new Set(rows.map((row) => row.key)).size).toBe(2);
      expect(result.irBodyRouteAudit?.violations ?? []).toEqual([]);
    });
  });

  describe("policy", () => {
    it("is ready under ir-only when a well-formed row sits beside emitted rows", () => {
      const ledger = [EMITTED_CONTROL, wellFormedRow()];
      for (const policy of ["hybrid", "ir-only"] as const) {
        const verdict = evaluateIrOutcomePolicy(ledger, policy);
        expect(verdict.blockers, `policy ${policy}`).toEqual([]);
        expect(verdict.ready, `policy ${policy}`).toBe(true);
      }
    });

    // The mutation matrix. Each row is a way of lying that the arm exists to
    // prevent; every one must be a blocker under BOTH policies.
    const MUTATIONS: readonly (readonly [string, Partial<IrObservedOutcome>])[] = [
      ["a borrowed terminal unit id", { unitId: "ir-unit:v1:probe:root:module-init:0" }],
      ["a claimed legacy body", { legacyBodyEmitted: true }],
      ["a claimed IR body", { irBodyEmitted: true }],
      ["emission counters", { prepareAttempts: 1, directBodyEmissions: 0, irBodyEmissions: 0 }],
      ["a partial counter", { prepareAttempts: 1 }],
      ["a non-module-init unit kind", { unitKind: "function" }],
      ["a class-member unit kind", { unitKind: "class-member" }],
      ["a stage other than select", { stage: "patch" }],
      ["a prepared component claim", { preparedComponentId: "component:probe" }],
    ];

    it.each(MUTATIONS)("rejects %s under both policies", (_label, overrides) => {
      const mutated = wellFormedRow(overrides);
      expect(nonExecutableOutcomeDefect(mutated)).toBeDefined();
      for (const policy of ["hybrid", "ir-only"] as const) {
        const verdict = evaluateIrOutcomePolicy([EMITTED_CONTROL, mutated], policy);
        expect(verdict.ready, `policy ${policy}`).toBe(false);
        expect(
          verdict.blockers.map((blocker) => blocker.key),
          `policy ${policy}`,
        ).toContain(mutated.key);
      }
    });

    it("leaves nonExecutableOutcomeDefect silent on rows of every other kind", () => {
      expect(nonExecutableOutcomeDefect(EMITTED_CONTROL)).toBeUndefined();
    });
  });

  /**
   * The audit join is the surface that used to reject an injected row outright
   * (`unknown-outcome-unit`, measured on the unmodified tree 2026-08-31). It now
   * ADMITS a well-formed row and still names every way of getting it wrong.
   */
  describe("body-route audit join", () => {
    const auditFor = (outcomes: readonly IrObservedOutcome[]) => {
      const ast = analyzeSource(FUNCTION_ONLY, "joined.ts");
      const identity = buildIrPlanningIdentityContext(
        buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker }),
      );
      const session = new IrBodyRouteAuditSession(identity, "wasm-gc", "compile");
      session.registerGenerator("single", "generateModule");
      const sourceId = identity.sourceIdBySourceFile.get(ast.sourceFile)!;
      const rows = outcomes.map((outcome) => ({ ...outcome, sourceId }) as IrObservedOutcome);
      return { audit: session.snapshot(rows), sourceId };
    };

    it("admits exactly one well-formed row without a violation", () => {
      const { audit } = auditFor([wellFormedRow()]);
      expect(audit.violations.filter((v) => v.code === "unjoined-non-executable-outcome")).toEqual([]);
      expect(audit.violations.filter((v) => v.code === "unknown-outcome-unit")).toEqual([]);
    });

    it("names a second row for the same source instead of accepting it", () => {
      const { audit } = auditFor([wellFormedRow(), wellFormedRow({ key: "joined.ts::module-init::second#0" })]);
      const violations = audit.violations.filter((v) => v.code === "unjoined-non-executable-outcome");
      expect(violations).toHaveLength(1);
      expect(violations[0]!.detail).toContain("second non-executable row");
    });

    it("names a row that claims a source owning a module-init terminal", () => {
      const ast = analyzeSource(EXECUTABLE, "owns-terminal.ts");
      const identity = buildIrPlanningIdentityContext(
        buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker }),
      );
      const session = new IrBodyRouteAuditSession(identity, "wasm-gc", "compile");
      session.registerGenerator("single", "generateModule");
      const sourceId = identity.sourceIdBySourceFile.get(ast.sourceFile)!;
      const audit = session.snapshot([{ ...wellFormedRow(), sourceId } as IrObservedOutcome]);
      const violations = audit.violations.filter((v) => v.code === "unjoined-non-executable-outcome");
      expect(violations).toHaveLength(1);
      expect(violations[0]!.detail).toContain("owns a module-init terminal");
    });

    it("names a malformed row rather than joining it", () => {
      const { audit } = auditFor([wellFormedRow({ irBodyEmitted: true })]);
      const violations = audit.violations.filter((v) => v.code === "unjoined-non-executable-outcome");
      expect(violations).toHaveLength(1);
      expect(violations[0]!.detail).toContain("claims body emission evidence");
    });
  });
});
