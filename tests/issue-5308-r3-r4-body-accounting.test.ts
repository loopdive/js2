// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5308 — R3 class-member and R4 module-init rows must CARRY their
 * `(prepareAttempts, directBodyEmissions, irBodyEmissions)` triple.
 *
 * Before this slice the reconciler computed the triple only for the R2
 * top-level free-function population; every class member and module init got
 * `bodyAccounting = undefined`. `hasMalformedBodyEmissionAccounting`
 * (`src/ir/outcomes.ts`) treats a wholly absent triple as well-formed, so those
 * rows stated nothing and dropped out of every compile-once ratio — 13 rows per
 * lane on the 35-case dogfood/playground corpus, measured 2026-09-03.
 *
 * Two measurements shaped what the receipts actually are, and both contradict
 * the obvious implementation:
 *
 * 1. **A class member's direct body is NOT a `compileFunctionBody` receipt.**
 *    `declarations.ts` calls that dispatcher only for top-level, runtime-
 *    namespace and CJS functions; member bodies run under `compileClassBodies`.
 *    Counting `compileFunctionBody` for class members would have counted zero,
 *    always — a census that can only ever agree with itself.
 * 2. **A module-init root is a PASS receipt, not a body receipt.**
 *    `compileModuleInitBody` is entered once for discovery and once for final
 *    emission ("intentionally compiled more than once", `declarations.ts`), and
 *    pass 2 replaces pass 1. Three gc corpus sources record two roots for one
 *    emitted body, so the R4 map is deliberately a 0/1 presence indicator.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { buildIrOverlayIdentityMaps, planIrOverlayByIdentity } from "../src/codegen/ir-overlay-identity.js";
import { reconcileIrOverlayOutcomes } from "../src/codegen/ir-overlay-outcomes.js";
import { IrBodyRouteAuditSession, type IrDirectFunctionBodyReceiptAudit } from "../src/codegen/legacy-body-audit.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import type { IrIntegrationReport, IrIntegrationTerminalEvidence } from "../src/ir/integration.js";
import type { IrObservedOutcome } from "../src/ir/outcomes.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

const IR_OWNED_CLASSES = "website/playground/examples/js/classes.ts";
const DIRECT_OWNED_CLASSES = "tests/dogfood/corpus/classes.js";
const IR_OWNED_MODULE_INIT = "website/playground/examples/dom/calendar.ts";
/** Two physical `compileModuleInitBody` roots, one emitted body (gc lane). */
const TWO_PASS_MODULE_INIT = "tests/dogfood/corpus/objects.js";
/** #5283 residual: an ambient-only module-init terminal with nothing to emit. */
const AMBIENT_ONLY_MODULE_INIT = "tests/fixtures/extern-demo.ts";

const DIRECT_MODULE_INIT = `export const total = 1 + 2;

export function get(): number {
  return total;
}
`;

const NO_MODULE_INIT = `export function only(): number {
  return 1;
}
`;

type Lane = { readonly label: string; readonly options: Parameters<typeof compile>[1] };

const LANES: readonly Lane[] = [
  { label: "gc", options: { trackIrOutcomes: true } },
  { label: "standalone", options: { trackIrOutcomes: true, target: "standalone" } },
];

type Triple = readonly [number | undefined, number | undefined, number | undefined];

const tripleOf = (row: IrObservedOutcome): Triple => [
  row.prepareAttempts,
  row.directBodyEmissions,
  row.irBodyEmissions,
];

const hasTriple = (row: IrObservedOutcome): boolean =>
  row.prepareAttempts !== undefined && row.directBodyEmissions !== undefined && row.irBodyEmissions !== undefined;

async function compileFor(fileName: string, lane: Lane, text?: string): Promise<CompileResult> {
  const result = await compile(text ?? readFileSync(fileName, "utf8"), { ...lane.options, fileName });
  expect(result.success, `${fileName} [${lane.label}] failed to compile`).toBe(true);
  expect(result.irOutcomes, `${fileName} [${lane.label}] recorded no outcomes`).toBeDefined();
  return result;
}

const rowsOfKind = (result: CompileResult, unitKind: "class-member" | "module-init"): readonly IrObservedOutcome[] =>
  (result.irOutcomes ?? []).filter((row) => row.unitKind === unitKind && row.unitId !== undefined);

const invariantRows = (result: CompileResult): readonly string[] =>
  (result.irOutcomes ?? [])
    .filter((row) => row.kind === "invariant")
    .map((row) => `${row.unitKind} ${row.displayName} [${row.code}] ${row.detail}`);

/** Terminal-row `(1, d, i)` shapes, as a name-keyed map for readable failures. */
const triplesByName = (rows: readonly IrObservedOutcome[]): Record<string, Triple> =>
  Object.fromEntries(rows.map((row) => [row.displayName, tripleOf(row)]));

describe("#5308 R3/R4 rows carry a counted body-accounting triple", () => {
  for (const lane of LANES) {
    describe(lane.label, () => {
      it("(a) every IR-owned class member reads (1, 0, 1)", async () => {
        const result = await compileFor(IR_OWNED_CLASSES, lane);
        const rows = rowsOfKind(result, "class-member");
        // Anti-vacuity: the shape assertions below say nothing on an empty set.
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.kind === "emitted")).toBe(true);
        expect(triplesByName(rows)).toEqual(
          Object.fromEntries(rows.map((row) => [row.displayName, [1, 0, 1] as Triple])),
        );
        // The booleans are the counters' projection, never independent literals.
        expect(rows.every((row) => row.legacyBodyEmitted === false && row.irBodyEmitted === true)).toBe(true);
        expect(invariantRows(result)).toEqual([]);
      }, 120_000);

      it("(a) every direct-owned class member reads (1, 1, 0)", async () => {
        const result = await compileFor(DIRECT_OWNED_CLASSES, lane);
        const rows = rowsOfKind(result, "class-member");
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.kind === "unsupported")).toBe(true);
        expect(triplesByName(rows)).toEqual(
          Object.fromEntries(rows.map((row) => [row.displayName, [1, 1, 0] as Triple])),
        );
        expect(rows.every((row) => row.legacyBodyEmitted === true && row.irBodyEmitted === false)).toBe(true);
        expect(invariantRows(result)).toEqual([]);
      }, 120_000);

      it("(b) an IR-owned module-init row reads (1, 0, 1)", async () => {
        const result = await compileFor(IR_OWNED_MODULE_INIT, lane);
        const rows = rowsOfKind(result, "module-init");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.kind).toBe("emitted");
        expect(tripleOf(rows[0]!)).toEqual([1, 0, 1]);
        expect(invariantRows(result)).toEqual([]);
      }, 120_000);

      it("(b) a direct-owned module-init row reads (1, 1, 0)", async () => {
        const result = await compileFor("direct-module-init.ts", lane, DIRECT_MODULE_INIT);
        const rows = rowsOfKind(result, "module-init");
        expect(rows).toHaveLength(1);
        expect(tripleOf(rows[0]!)).toEqual([1, 1, 0]);
        expect(rows[0]!.legacyBodyEmitted).toBe(true);
        expect(invariantRows(result)).toEqual([]);
      }, 120_000);

      it("counts module-init PRESENCE, not passes, when the direct front end compiles it twice", async () => {
        // Two physical `compileModuleInitBody` roots, one emitted body. A count
        // would read 2 and fail as an impossible receipt; the source compiles
        // once and must say so.
        const result = await compileFor(TWO_PASS_MODULE_INIT, lane);
        const rows = rowsOfKind(result, "module-init");
        expect(rows).toHaveLength(1);
        expect(tripleOf(rows[0]!)).toEqual([1, 1, 0]);
        expect(invariantRows(result)).toEqual([]);
      }, 120_000);

      it("states (1, 0, 0) — not a defect — for an ambient-only module-init terminal", async () => {
        // The #5283 residual, pinned as a FACT: an ambient `declare namespace`
        // is still module-init population, so a terminal is minted for a source
        // with nothing to execute and no direct root is ever entered. #5283
        // decided that row states `legacyBodyEmitted: false` rather than a
        // defect; the R4 accounting must agree with that decision, not overturn
        // it. The follow-up that splits scan roots from the executable
        // population has to come here and say so.
        const result = await compileFor(AMBIENT_ONLY_MODULE_INIT, lane);
        const rows = rowsOfKind(result, "module-init");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.kind).toBe("unsupported");
        expect(tripleOf(rows[0]!)).toEqual([1, 0, 0]);
        expect(invariantRows(result)).toEqual([]);
      }, 120_000);

      it("(e) a non-executable module-init row still carries no triple", async () => {
        // No body was attempted and none was emitted; a fabricated `(1, 0, 0)`
        // here would be exactly the unmeasured claim this row set retires.
        const result = await compileFor("no-module-init.ts", lane, NO_MODULE_INIT);
        const rows = (result.irOutcomes ?? []).filter((row) => row.kind === "non-executable");
        expect(rows).toHaveLength(1);
        expect(rows.every((row) => hasTriple(row))).toBe(false);
        expect(tripleOf(rows[0]!)).toEqual([undefined, undefined, undefined]);
      }, 120_000);
    });
  }

  describe("direct receipt census", () => {
    const CLASS_SOURCE = `export class Implicit {
  m(): number {
    return 1;
  }
}

export function free(value: number): number {
  return value + 1;
}
`;

    const sessionFor = (text: string, fileName = "receipts.ts") => {
      const ast = analyzeSource(text, fileName);
      const identity = buildIrPlanningIdentityContext(
        buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker }),
      );
      const session = new IrBodyRouteAuditSession(identity, "wasm-gc", "compile");
      session.registerGenerator("single", "generateModule");
      return { ast, identity, session };
    };

    it("(d) a class member never enters the R2 free-function map", () => {
      const { ast, identity, session } = sessionFor(CLASS_SOURCE);
      const declaration = ast.sourceFile.statements.find(ts.isClassDeclaration)!;
      const method = declaration.members.find(ts.isMethodDeclaration)!;
      session.recordRoot("compileClassBodies", "Implicit_m", method);
      const audit = session.directFunctionBodyReceiptAudit(ast.sourceFile);
      const memberUnitId = identity.unitIdByDeclaration.get(method)!;

      expect(audit.classMemberCountsByUnitId).toEqual(new Map([[memberUnitId, 1]]));
      // `countsByUnitId` is `compileFunctionBody` receipts for top-level free
      // functions only, and `tests/issue-5283-*` / `issue-5262-*` pin that
      // width. Merging the two maps would silently widen a published contract.
      expect([...audit.countsByUnitId.keys()]).toEqual([]);
      expect(audit.violations).toEqual([]);
    });

    it("does not count the whole-class root as the implicit constructor's body", () => {
      // `compileClassBodies` records a root against the CLASS declaration
      // before any member is compiled, and on a class with an implicit
      // constructor that node resolves through `nearestInventoryUnit` to the
      // `class-implicit-constructor` unit. That unit is not terminal, which is
      // the only thing standing between this census and a compile-twice report
      // on a unit that compiled once.
      const { ast, identity, session } = sessionFor(CLASS_SOURCE);
      const declaration = ast.sourceFile.statements.find(ts.isClassDeclaration)!;
      session.recordRoot("compileClassBodies", "Implicit", declaration);
      const audit = session.directFunctionBodyReceiptAudit(ast.sourceFile);
      const classUnitId = identity.unitIdByDeclaration.get(declaration)!;

      expect(identity.unitByUnitId.get(classUnitId)?.terminal).toBe(false);
      expect(identity.unitByUnitId.get(classUnitId)?.kind).toBe("class-implicit-constructor");
      expect(audit.classMemberCountsByUnitId).toEqual(new Map());
      expect(audit.violations).toEqual([]);
    });

    it("records the module-init root once however many passes ran", () => {
      const { ast, identity, session } = sessionFor("export const x = 1 + 2;\n", "two-pass.ts");
      // Discovery pass, then final emission — the same physical call site.
      session.recordRoot("compileModuleInitBody", "__module_init", ast.sourceFile);
      session.recordRoot("compileModuleInitBody", "__module_init", ast.sourceFile);
      const audit = session.directFunctionBodyReceiptAudit(ast.sourceFile);
      const moduleInitUnitId = identity.moduleInitUnitIdBySourceFile.get(ast.sourceFile)!;

      expect(moduleInitUnitId).toBeDefined();
      expect(audit.moduleInitCountsByUnitId).toEqual(new Map([[moduleInitUnitId, 1]]));
      expect(audit.violations).toEqual([]);
    });
  });

  describe("(c) compile-twice fails closed for a class member", () => {
    const SOURCE = `export class Holder {
  value(): number {
    return 7;
  }
}
`;

    function plan() {
      const ast = analyzeSource(SOURCE, "holder.ts");
      const identityContext = buildIrPlanningIdentityContext(
        buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker }),
      );
      const maps = buildIrOverlayIdentityMaps(ast.sourceFile, ast.checker, identityContext);
      const identityPlan = planIrOverlayByIdentity(
        ast.sourceFile,
        identityContext,
        { experimentalIR: true, trackFallbacks: true },
        maps,
      );
      const method = ast.sourceFile.statements
        .filter(ts.isClassDeclaration)
        .flatMap((declaration) => declaration.members.filter(ts.isMethodDeclaration))[0]!;
      const unitId = identityContext.unitIdByDeclaration.get(method)!;
      const terminal = identityContext.terminalByUnitId.get(unitId)!;
      return { ast, identityContext, identityPlan, unitId, legacyName: terminal.legacyMatchName };
    }

    function reconcile(
      directBodyReceipts: number,
      options: { readonly skipped?: boolean; readonly patched?: boolean } = {},
    ) {
      const planned = plan();
      const skipped = options.skipped ?? true;
      const patched = options.patched ?? true;
      const evidence: IrIntegrationTerminalEvidence[] = patched
        ? [{ kind: "patched", unitId: planned.unitId, legacyName: planned.legacyName }]
        : [];
      const report: IrIntegrationReport = {
        compiled: patched ? [planned.legacyName] : [],
        errors: [],
        terminalEvidence: evidence,
      };
      const audit: IrDirectFunctionBodyReceiptAudit = {
        sourceId: planned.identityContext.sourceIdBySourceFile.get(planned.ast.sourceFile)!,
        countsByUnitId: new Map(),
        classMemberCountsByUnitId: new Map(
          directBodyReceipts === 0 ? [] : [[planned.unitId, directBodyReceipts] as const],
        ),
        moduleInitCountsByUnitId: new Map(),
        violations: [],
        // The coarse #5283 evidence: the unit physically entered SOME audited
        // direct-body root. Always present here, so the arms below distinguish
        // the exact receipt from it rather than from its absence.
        physicalRootUnitIds: new Set<IrUnitId>([planned.unitId]),
      };
      const result = reconcileIrOverlayOutcomes({
        sourceFile: planned.ast.sourceFile,
        identityPlan: planned.identityPlan,
        initialSelection: planned.identityPlan.selectionProjection.selection,
        preparedSelection: patched
          ? planned.identityPlan.selectionProjection.selection
          : { ...planned.identityPlan.selectionProjection.selection, classMembers: [], classMemberUnitIds: new Set() },
        preparationFailuresByUnitId: new Map(),
        // An IR-owned member is skipped out of the direct route by
        // construction; that is what makes a direct receipt on it a
        // contradiction rather than the ordinary R2 compile-twice shape.
        skippedBodyUnitIds: skipped ? new Set([planned.unitId]) : new Set(),
        directFunctionBodyReceiptAudit: audit,
        report,
        existingOutcomes: [],
        target: "gc",
      });
      return { planned, result };
    }

    it("accepts the clean (1, 0, 1) shape", () => {
      const { planned, result } = reconcile(0);
      const row = result.outcomes.find((outcome) => outcome.unitId === planned.unitId)!;

      expect(row).toMatchObject({ kind: "emitted", prepareAttempts: 1, directBodyEmissions: 0, irBodyEmissions: 1 });
      expect(result.diagnostics).toEqual([]);
    });

    it("raises body-emission-evidence when the member also holds a direct receipt", () => {
      const { planned, result } = reconcile(1);
      const row = result.outcomes.find((outcome) => outcome.unitId === planned.unitId)!;

      expect(row).toMatchObject({
        kind: "invariant",
        code: "body-emission-evidence",
        prepareAttempts: 1,
        directBodyEmissions: 1,
        irBodyEmissions: 1,
      });
      expect(row.detail).toContain("direct body receipts after an exact skip receipt");
      expect(result.diagnostics.join("\n")).toContain("body-emission-evidence");
    });

    it("keeps a direct-owned member benign on coarse root evidence alone", () => {
      // The regression guard for `coarseDirectBodyEvidence`. A class member the
      // IR did not take, with no EXACT receipt (its only root is the class
      // root, or an unattributable one) but a physical root and no skip, must
      // still read `legacyBodyEmitted: true`. Counting a conservative 0 here
      // would lower a claim the compiler already makes, and the
      // `evidence.kind === "failed"` arm turns a lowered claim into an
      // `unpatched-slot` invariant — measured 2026-09-03 as nine red
      // `tests/issue-3522-*` cases.
      const { planned, result } = reconcile(0, { skipped: false, patched: false });
      const row = result.outcomes.find((outcome) => outcome.unitId === planned.unitId)!;

      expect(row).toMatchObject({
        kind: "unsupported",
        prepareAttempts: 1,
        directBodyEmissions: 1,
        irBodyEmissions: 0,
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(result.diagnostics).toEqual([]);
    });
  });
});
