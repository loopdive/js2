// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #5283 — `legacyBodyEmitted` is a RECEIPT, not a prediction.
 *
 * Before this slice the flag fell back to "a legacy body was available and we
 * did not skip it" for every non-R2 row, which read `true` on units where no
 * direct pass ran at all. Two sources produced such a row, by two different
 * mechanisms, and both are pinned here:
 *
 *  - path 1, an ambient `declare namespace` counted as module-init population;
 *  - path 2, the JSON-import rewrite's SYNTHESIZED `declare const data: any;`,
 *    which is why re-parsing that file's own text shows an empty population
 *    while the compile still minted a module-init terminal.
 *
 * The headline assertion is the compiler's own detector — the route audit's
 * `missing-legacy-entry-evidence` violation ("terminal reports a legacy body
 * without entering an audited direct-body root") — rather than a hand-rolled
 * `legacyBodyEmitted && directBodyEmissions === 0` filter, which counts unit
 * kinds whose accounting was never migrated to receipts and is a wrong proxy.
 *
 * What this slice does NOT do: both mechanisms put an AMBIENT statement in the
 * module-init population, so both sources still mint a module-init terminal
 * that has nothing to execute. Removing ambient statements from
 * `collectModuleInitPopulation` was measured and REVERTED — that population is
 * also the R1 inventory's SCAN list, and the import resolver's wrappers
 * (`declare namespace events { class EventEmitter … }`) are discovered through
 * it, so the narrow skip silently emptied `inventory.classes` of two synthetic
 * import-wrapper classes and turned two `tests/issue-3520-*` pins red.
 * Splitting "executable population" from "scan roots" belongs in
 * `src/ir/identity.ts`, outside this slice.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { IrBodyRouteAuditSession } from "../src/codegen/legacy-body-audit.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { collectModuleInitPopulation } from "../src/ir/module-init.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

const EXTERN_DEMO = "tests/fixtures/extern-demo.ts";
const IMPORT_ATTRIBUTES = "tests/dogfood/corpus/import-attributes.module.js";

/** A `declare namespace` beside one ordinary function: path 1, in miniature. */
const AMBIENT_NAMESPACE_ONLY = `declare namespace Host {
  class Box {
    constructor();
  }
}

export function k(): number {
  return 1;
}
`;

/**
 * A NON-ambient namespace: the over-correction guard. Its module init really
 * runs, the direct front end really emits it, and the audit really records a
 * `compileModuleInitBody` root for it — so a skip that dropped every
 * `ModuleDeclaration`, or a flag hardcoded to `false`, fails here.
 */
const RUNTIME_NAMESPACE = `namespace N {
  export const x = 1;
}

export function h(): number {
  return N.x;
}
`;

type Lane = { readonly label: string; readonly options: Parameters<typeof compile>[1] };

const LANES: readonly Lane[] = [
  { label: "gc", options: { trackIrOutcomes: true } },
  { label: "standalone", options: { trackIrOutcomes: true, target: "standalone" } },
];

async function compileFor(source: string, fileName: string, lane: Lane): Promise<CompileResult> {
  const result = await compile(source, { ...lane.options, fileName });
  expect(result.success, `${fileName} [${lane.label}] failed to compile`).toBe(true);
  expect(result.irOutcomes, `${fileName} [${lane.label}] recorded no outcomes`).toBeDefined();
  expect(result.irBodyRouteAudit, `${fileName} [${lane.label}] recorded no route audit`).toBeDefined();
  return result;
}

const missingLegacyEntryEvidence = (result: CompileResult): readonly string[] =>
  (result.irBodyRouteAudit?.violations ?? [])
    .filter((violation) => violation.code === "missing-legacy-entry-evidence")
    .map((violation) => violation.detail);

const moduleInitRows = (result: CompileResult) =>
  (result.irOutcomes ?? []).filter((outcome) => outcome.unitKind === "module-init");

const physicalRootUnitIds = (result: CompileResult): ReadonlySet<string> =>
  new Set(
    (result.irBodyRouteAudit?.legacyEntries ?? []).flatMap((entry) =>
      entry.unitId === undefined ? [] : [entry.unitId],
    ),
  );

/** Every row that claims a legacy body must name a unit that entered one. */
function expectEveryLegacyBodyHasAPhysicalRoot(result: CompileResult, label: string): void {
  const roots = physicalRootUnitIds(result);
  const unbacked = (result.irOutcomes ?? [])
    .filter((outcome) => outcome.legacyBodyEmitted)
    .filter((outcome) => outcome.unitId === undefined || !roots.has(outcome.unitId))
    .map((outcome) => `${outcome.key} (${outcome.unitKind}/${outcome.kind})`);
  expect(unbacked, `${label}: rows claiming a legacy body with no direct-body root`).toEqual([]);
}

describe("#5283 legacy-body receipt truth", () => {
  for (const lane of LANES) {
    describe(lane.label, () => {
      it("path 1 — a declare-namespace source claims no phantom module-init legacy body", async () => {
        const result = await compileFor(readFileSync(EXTERN_DEMO, "utf8"), EXTERN_DEMO, lane);
        expect(moduleInitRows(result).filter((row) => row.legacyBodyEmitted)).toEqual([]);
        expect(missingLegacyEntryEvidence(result)).toEqual([]);
        expectEveryLegacyBodyHasAPhysicalRoot(result, `${EXTERN_DEMO} [${lane.label}]`);
      });

      it("path 1 — an ambient-only module init claims no body it did not emit", async () => {
        const result = await compileFor(AMBIENT_NAMESPACE_ONLY, "ambient-namespace-only.ts", lane);
        const rows = moduleInitRows(result);
        // The terminal is still minted — the ambient `declare namespace` is
        // still module-init population (see the file header). What changed is
        // that its row no longer ASSERTS a legacy body nobody emitted.
        expect(rows).toHaveLength(1);
        expect(rows[0]!.legacyBodyEmitted).toBe(false);
        expect(missingLegacyEntryEvidence(result)).toEqual([]);
      });

      it("path 2 — the JSON-import rewrite's synthesized `declare const` is not module-init population", async () => {
        const result = await compileFor(readFileSync(IMPORT_ATTRIBUTES, "utf8"), IMPORT_ATTRIBUTES, lane);
        expect(moduleInitRows(result).filter((row) => row.legacyBodyEmitted)).toEqual([]);
        expect(missingLegacyEntryEvidence(result)).toEqual([]);
        expectEveryLegacyBodyHasAPhysicalRoot(result, `${IMPORT_ATTRIBUTES} [${lane.label}]`);
      });

      it("guard — a runtime namespace keeps its module-init terminal and its truthful legacy body", async () => {
        const result = await compileFor(RUNTIME_NAMESPACE, "runtime-namespace.ts", lane);
        const rows = moduleInitRows(result);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row.kind).not.toBe("non-executable");
        expect(row.legacyBodyEmitted).toBe(true);
        expect(row.unitId).toBeDefined();
        const moduleInitRoots = (result.irBodyRouteAudit?.legacyEntries ?? []).filter(
          (entry) => entry.entryPoint === "compileModuleInitBody" && entry.unitId === row.unitId,
        );
        expect(moduleInitRoots).toHaveLength(1);
        expect(missingLegacyEntryEvidence(result)).toEqual([]);
      });
    });
  }

  /**
   * The receipt itself. On the 34-case corpus the population fix above already
   * removes both phantom rows, so this is the only place the receipt change is
   * separately observable — and it is the part that generalises: a future path
   * that mints a terminal without a direct pass reads `false` here whatever
   * minted it.
   */
  describe("physicalRootUnitIds", () => {
    const ROOTS = `export function add(a: number, b: number): number {
  return a + b;
}

export function untouched(): number {
  return 0;
}

class C {
  m(): number {
    return 1;
  }
}
`;

    const sessionFor = (text: string) => {
      const ast = analyzeSource(text, "roots.ts");
      const identity = buildIrPlanningIdentityContext(
        buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker }),
      );
      const session = new IrBodyRouteAuditSession(identity, "wasm-gc", "compile");
      session.registerGenerator("single", "generateModule");
      return { ast, identity, session };
    };

    it("carries the units that entered a direct-body root, and only those", () => {
      const { ast, identity, session } = sessionFor(ROOTS);
      const functions = ast.sourceFile.statements.filter(ts.isFunctionDeclaration);
      const [add, untouched] = functions;
      session.recordRoot("compileFunctionBody", "add", add!);
      const audit = session.directFunctionBodyReceiptAudit(ast.sourceFile);
      const addUnitId = identity.unitIdByDeclaration.get(add!)!;
      const untouchedUnitId = identity.unitIdByDeclaration.get(untouched!)!;
      expect(addUnitId).toBeDefined();
      expect(untouchedUnitId).toBeDefined();
      expect(audit.physicalRootUnitIds.has(addUnitId)).toBe(true);
      expect(audit.physicalRootUnitIds.has(untouchedUnitId)).toBe(false);
    });

    it("is wider than the direct free-function receipts, which is the point", () => {
      const { ast, identity, session } = sessionFor(ROOTS);
      const declaration = ast.sourceFile.statements.find(ts.isClassDeclaration)!;
      session.recordRoot("compileClassBodies", "C", declaration);
      const audit = session.directFunctionBodyReceiptAudit(ast.sourceFile);
      const classUnitId = identity.unitIdByDeclaration.get(declaration)!;
      expect(audit.physicalRootUnitIds.has(classUnitId)).toBe(true);
      // `countsByUnitId` is `compileFunctionBody` receipts for top-level free
      // functions only — a class root is deliberately not one of them.
      expect([...audit.countsByUnitId.keys()]).toEqual([]);
    });
  });

  /**
   * The residual, pinned as a FACT rather than as a fix: an ambient statement
   * is still module-init population today, which is what mints a terminal for a
   * source with nothing to execute. This assertion exists so the follow-up that
   * splits the scan list from the executable list has to come here and say so.
   */
  describe("collectModuleInitPopulation (residual)", () => {
    const populationOf = (text: string): ts.SyntaxKind[] =>
      collectModuleInitPopulation(ts.createSourceFile("probe.ts", text, ts.ScriptTarget.ES2022, true)).map(
        (statement) => statement.kind,
      );

    it("still counts ambient declarations, which is why the terminal is still minted", () => {
      expect(populationOf("declare namespace Host {\n  class Box {}\n}\n")).toEqual([ts.SyntaxKind.ModuleDeclaration]);
      expect(populationOf("declare const data: any;\n")).toEqual([ts.SyntaxKind.VariableStatement]);
    });

    it("keeps statements that actually run, including a non-ambient namespace", () => {
      expect(populationOf("namespace N {\n  export const x = 1;\n}\n")).toEqual([ts.SyntaxKind.ModuleDeclaration]);
      expect(populationOf("const x = 1;\n")).toEqual([ts.SyntaxKind.VariableStatement]);
      expect(populationOf("console.log(1);\n")).toEqual([ts.SyntaxKind.ExpressionStatement]);
    });
  });
});
