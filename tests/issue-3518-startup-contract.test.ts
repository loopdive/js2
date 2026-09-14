// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import {
  buildIrModuleInitPlan,
  IrModuleInitPlanInvariantError,
  reconcileIrModuleInitPlan,
  verifyIrModuleInitPlan,
} from "../src/ir/module-init-plan.js";
import type { IrModuleInitPlan, IrModuleInitTarget } from "../src/ir/program/startup.js";

const root = resolve(import.meta.dirname, "..");
const canonicalPath = "src/ir/program/startup.ts";
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const sourceFile = (path: string) => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
const emit = (source: string) =>
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

// Exact declaration text INCLUDING docs, pinned at the extraction source.
// No historical git object or worktree is needed to run these controls.
const declarationHashes = {
  IrModuleInitTarget: "1f40aa94a89bd5d8768ae1d902df0fa4c6000a45ac8292ba52598a565528c1f0",
  IrModuleInitInvocationKind: "9bc80e3a6113e23879ba7b2ecc103b77819adf22b595d28a3cfac60baa1caa98",
  IrModuleInitInvocationPolicy: "0a635d38f99deb089927e2d722155c1369fc88eec3283cdd817c81bd5a911ccb",
  IrModuleBindingDeclarationKind: "1a3d8caecabb77561384072ea74de0b93ef3b7e5334bab27e0febca35c5ff3ca",
  IrModuleInitBindingIntent: "81fd9d27beff749996b661c0fe5d109b04e54e53aef2442183e37af6044650ab",
  IrModuleInitLiveSeedIntent: "85dedcbf91c64f32592bce329bb27cd0577c0e2e863de2c47bb97a838265ed18",
  IrModuleInitEvaluationKind: "929a237c9cee925f2b2debe48d989b28ab77102a27b84d40d8e679eb0b231d8e",
  IrModuleInitEvaluationEntry: "2bdcdcce5eaf3c75bd013cc711e2caf5e48d4a112988844fef33955da962132f",
  IrModuleInitExportIntent: "935a3960489f2e61cd83cef06f71995f3383074f54b4e02783d8419af4830e53",
  IrModuleInitPlanGapCode: "cc09c6361f978393f6ba1b536bbca454727d9d7401a796a8238978ac96b77fb5",
  IrModuleInitPlanGap: "aa33dd3a0d4fe0a4931992f70b73fc8ca5b083f6c882891625283b399753cf47",
  IrModuleInitPlan: "b9efa8cfc0cadf954a4bce74ca2cb0ddb01435191680d655297a8adbbae19d49",
};
const names = Object.keys(declarationHashes);

function build(source: string, target: IrModuleInitTarget = "standalone", deferTopLevelInit = false) {
  const ast = analyzeSource(source, "startup-contract.ts");
  const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker });
  const identityContext = buildIrPlanningIdentityContext(inventory);
  const input = { sourceFile: ast.sourceFile, checker: ast.checker, identityContext, target, deferTopLevelInit };
  return { ast, inventory, identityContext, input, plan: buildIrModuleInitPlan(input) };
}

describe("startup data contract separation", () => {
  it.each(Object.entries(declarationHashes))("preserves the complete %s declaration and docs", (name, hash) => {
    const file = sourceFile(canonicalPath);
    const declarations = file.statements.filter(
      (node) => (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name.text === name,
    );
    expect(declarations).toHaveLength(1);
    expect(createHash("sha256").update(declarations[0].getFullText(file).trim()).digest("hex")).toBe(hash);
  });

  it("has exactly twelve canonical declarations and explicit type-only compatibility imports/exports", () => {
    const canonical = sourceFile(canonicalPath);
    expect(canonical.statements.filter(ts.isImportDeclaration)).toHaveLength(1);
    const declarations = canonical.statements.filter(
      (node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node),
    );
    expect(declarations.map((node) => node.name.text)).toEqual(names);
    expect(canonical.statements).toHaveLength(13);
    const old = sourceFile("src/ir/module-init-plan.ts");
    expect(
      old.statements.some(
        (node) =>
          (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && names.includes(node.name.text),
      ),
    ).toBe(false);
    const imports = old.statements
      .filter(ts.isImportDeclaration)
      .filter(
        (node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./program/startup.js",
      );
    const exports = old.statements
      .filter(ts.isExportDeclaration)
      .filter(
        (node) =>
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === "./program/startup.js",
      );
    expect(imports).toHaveLength(1);
    expect(imports[0].importClause?.isTypeOnly).toBe(true);
    const bindings = imports[0].importClause?.namedBindings;
    expect(bindings && ts.isNamedImports(bindings) && bindings.elements.map((node) => node.name.text)).toEqual(names);
    expect(exports).toHaveLength(1);
    expect(exports[0].isTypeOnly).toBe(true);
    const clause = exports[0].exportClause;
    expect(clause && ts.isNamedExports(clause) && clause.elements.map((node) => node.name.text)).toEqual(names);
  });

  it("uses only the three canonical type-only closure modules and emits no runtime declarations", () => {
    const paths = [canonicalPath, "src/shared/contracts/ir-identity.ts", "src/shared/contracts/source-origin.ts"];
    const edges: string[][] = [];
    for (const path of paths) {
      const file = sourceFile(path);
      for (const declaration of file.statements.filter(ts.isImportDeclaration)) {
        expect(declaration.importClause?.isTypeOnly).toBe(true);
        expect(ts.isStringLiteral(declaration.moduleSpecifier)).toBe(true);
        edges.push([path, (declaration.moduleSpecifier as ts.StringLiteral).text]);
      }
      const javascript = ts.createSourceFile(
        path + ".js",
        emit(read(path)),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      expect(javascript.statements.map((statement) => statement.getText(javascript))).toEqual(["export {};"]);
    }
    expect(edges).toEqual([
      [canonicalPath, "../../shared/contracts/ir-identity.js"],
      ["src/shared/contracts/ir-identity.ts", "./source-origin.js"],
    ]);
    const brands = sourceFile(canonicalPath).statements.filter(ts.isImportDeclaration)[0].importClause?.namedBindings;
    expect(brands && ts.isNamedImports(brands) && brands.elements.map((node) => node.name.text)).toEqual([
      "IrBindingId",
      "IrClassId",
      "IrSourceId",
      "IrUnitId",
    ]);
  });

  it("keeps the real program's complete startup population on the canonical type", () => {
    const file = sourceFile("src/ir/program.ts");
    const startupImports = file.statements.filter(ts.isImportDeclaration).filter((node) => {
      const bindings = node.importClause?.namedBindings;
      return (
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some((entry) => entry.name.text === "IrModuleInitPlan")
      );
    });
    expect(startupImports).toHaveLength(1);
    expect(startupImports[0].importClause?.isTypeOnly).toBe(true);
    expect((startupImports[0].moduleSpecifier as ts.StringLiteral).text).toBe("./program/startup.js");
    const program = file.statements.find(
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === "PreparedIrProgram",
    );
    const startup = program?.members.filter((node) => node.name?.getText(file) === "startup");
    expect(startup).toHaveLength(1);
    expect(startup![0].getText(file)).toBe("readonly startup: readonly IrModuleInitPlan[];");
    expect(startup![0].getFullText(file)).toContain(
      "Includes empty sources and preserves semantic module evaluation order.",
    );
  });

  it("builds nonempty bindings, seeds, exports, ranges and source-ordered evaluations with the existing producer", () => {
    const source = [
      "export let count: number = 1;",
      "function live(): number { return 1; }",
      "live = function replacement(): number { return 2; };",
      "count += live();",
      "class Box { static first: number = count++; static { count += 10; } }",
      "count += 100;",
      "export { count as alias };",
      "export default count;",
    ].join("\n");
    const { plan, identityContext, ast } = build(source);
    expect(plan.sourceId).toBe(identityContext.sourceIdBySourceFile.get(ast.sourceFile));
    expect(plan.unitId).toBe(identityContext.moduleInitUnitIdBySourceFile.get(ast.sourceFile));
    expect(plan.unitId).not.toBeNull();
    expect(plan.bindings).toHaveLength(1);
    expect(plan.liveSeeds).toHaveLength(1);
    expect(plan.liveSeeds[0]).toMatchObject({ name: "live", legacyKey: "live:live" });
    expect(plan.evaluations.map((entry) => entry.kind)).toEqual([
      "variable-initializer",
      "statement",
      "statement",
      "class-static-field",
      "class-static-block",
      "statement",
      "export-assignment",
    ]);
    expect(plan.evaluations.map((entry) => entry.sourceOrdinal)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(plan.evaluations.map((entry) => source.slice(entry.start, entry.end))).toEqual([
      "export let count: number = 1;",
      "live = function replacement(): number { return 2; };",
      "count += live();",
      "count++",
      "static { count += 10; }",
      "count += 100;",
      "export default count;",
    ]);
    for (const entry of plan.evaluations) {
      expect(entry.key).toBe(plan.sourceId + ":eval:" + entry.sourceOrdinal);
      expect(entry.legacyKey).toBe(
        (entry.kind.startsWith("class-static") ? "static:" : "statement:") + entry.start + ":" + entry.end,
      );
    }
    expect(plan.evaluations[3].classId).not.toBeNull();
    expect(plan.evaluations[4].classId).toBe(plan.evaluations[3].classId);
    expect(plan.exports.map((entry) => entry.externalName)).toEqual(["count", "alias", "default"]);
    expect(plan.exports[0].targetBindingId).toBe(plan.bindings[0].globalBindingId);
    expect(plan.exports[1].targetBindingId).toBe(plan.exports[0].targetBindingId);
    expect(plan.gaps).toEqual([]);
    expect(Object.isFrozen(plan)).toBe(true);
    for (const entries of [plan.bindings, plan.liveSeeds, plan.evaluations, plan.exports, plan.gaps]) {
      expect(Object.isFrozen(entries)).toBe(true);
      for (const entry of entries) expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it.each([
    ["host", false, "wasm-start"],
    ["host", true, "deferred-export"],
    ["standalone", false, "wasm-start"],
    ["standalone", true, "deferred-export"],
    ["wasi", false, "wasi-start-export"],
    ["wasi", true, "wasi-start-export"],
  ] as const)("preserves exactly-once policy for %s deferred=%s", (target, deferred, kind) => {
    const { plan } = build("let count = 0; count += 1;", target, deferred);
    expect(plan.evaluations).toHaveLength(2);
    expect(plan.invocation).toEqual({ target, kind, exactlyOnce: true });
    expect(Object.isFrozen(plan.invocation)).toBe(true);
  });

  it("retains empty and type-only sources in the original three-source census", () => {
    const ast = analyzeMultiSource(
      {
        "./empty.ts": "",
        "./types.ts": "export interface Marker { readonly tag: 'types'; }",
        "./entry.ts": "export let value = 42;",
      },
      "./entry.ts",
    );
    const inventory = buildIrUnitInventory(ast.sourceFiles, { entrySource: ast.entryFile, checker: ast.checker });
    const identityContext = buildIrPlanningIdentityContext(inventory);
    const plans: IrModuleInitPlan[] = ast.sourceFiles.map((file) =>
      buildIrModuleInitPlan({
        sourceFile: file,
        checker: ast.checker,
        identityContext,
        target: "standalone",
        deferTopLevelInit: false,
      }),
    );
    expect(ast.sourceFiles).toHaveLength(3);
    expect(inventory.sources).toHaveLength(3);
    expect(plans).toHaveLength(3);
    expect(plans.map((plan) => plan.sourceId)).toEqual(
      ast.sourceFiles.map((file) => identityContext.sourceIdBySourceFile.get(file)),
    );
    expect(new Set(plans.map((plan) => plan.sourceId)).size).toBe(3);
    expect(plans.filter((plan) => plan.executable)).toHaveLength(1);
    expect(plans.reduce((count, plan) => count + plan.evaluations.length, 0)).toBe(1);
    for (const fileName of ["empty.ts", "types.ts"]) {
      const index = ast.sourceFiles.findIndex((file) => file.fileName === fileName);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(plans[index]).toMatchObject({
        unitId: null,
        executable: false,
        bindings: [],
        liveSeeds: [],
        evaluations: [],
        gaps: [],
        invocation: { target: "standalone", kind: "none", exactlyOnce: true },
      });
    }
  });

  it("rejects a foreign source AST, noncanonical order, invalid ranges and lost invocation policy", () => {
    const { input, ast, plan } = build("let count = 0; count += 1;");
    const foreign = analyzeSource(ast.sourceFile.text, ast.sourceFile.fileName);
    expect(() => buildIrModuleInitPlan({ ...input, sourceFile: foreign.sourceFile })).toThrow(
      expect.objectContaining({ code: "source-record-mismatch" }),
    );
    const badOrder = { ...plan, evaluations: [...plan.evaluations].reverse() };
    const badRange = {
      ...plan,
      evaluations: [{ ...plan.evaluations[0], end: ast.sourceFile.end + 1 }, plan.evaluations[1]],
    };
    const badInvocation = { ...plan, invocation: { ...plan.invocation, kind: "none" as const } };
    for (const [candidate, code] of [
      [badOrder, "non-canonical-order"],
      [badRange, "invalid-source-range"],
      [badInvocation, "invalid-invocation"],
    ] as const) {
      expect(() => verifyIrModuleInitPlan(candidate, ast.sourceFile)).toThrow(
        expect.objectContaining({ name: "IrModuleInitPlanInvariantError", code }),
      );
    }
    expect(IrModuleInitPlanInvariantError.prototype).toBeInstanceOf(Error);
  });

  it("keeps nonempty legacy-order observation and duplicate queue evidence visible", () => {
    const { ast, plan } = build("let count = 0; count += 1;");
    const legacy = { liveFunctionNames: [], staticEntries: [], moduleStatements: [...ast.sourceFile.statements] };
    expect(reconcileIrModuleInitPlan(plan, ast.sourceFile, legacy)).toMatchObject({
      aligned: true,
      plannedEntryCount: 2,
      legacyEntryCount: 2,
    });
    const repeated = reconcileIrModuleInitPlan(plan, ast.sourceFile, {
      ...legacy,
      moduleStatements: [...legacy.moduleStatements, legacy.moduleStatements[1]],
    });
    expect(repeated).toMatchObject({ aligned: false, plannedEntryCount: 2, legacyEntryCount: 3 });
    expect(repeated.extraInLegacy).toEqual([plan.evaluations[1].legacyKey]);
    expect(plan.evaluations).toHaveLength(2);
  });
});
