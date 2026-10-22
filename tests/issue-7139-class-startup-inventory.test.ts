// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { buildIrUnitInventory, getIrInventoryScannerMetadata } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext, requireIrPlanningOwnerUnitId } from "../src/ir/planning-identity.js";
import { buildIrModuleInitPlan } from "../src/ir/module-init-plan.js";
import { collectModuleInitPopulation } from "../src/ir/module-init.js";
import { classStartupOccurrences } from "../src/ir/analysis/class-startup.js";
import { classDefinitionExpressions } from "../src/ir/analysis/class-definition-syntax.js";
import { prepareIrSourceDefinitionPopulation } from "../src/ir/program/source-class-definitions.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";

function population(source: string) {
  const input = sourceInput({ "./entry.ts": source });
  const { inventory, identity } = prepareIrSourceDefinitionPopulation(input);
  const plan = buildIrModuleInitPlan({
    sourceFile: input.entrySource,
    checker: input.checker,
    identityContext: identity,
    target: "standalone",
    deferTopLevelInit: false,
  });
  return { input, inventory, identity, plan };
}

for (const source of ["class C{}", "abstract class C{}", "export default class{}", "class C extends null{}"])
  it(`owns the actual startup evaluation of ${source}`, () => {
    const { input, inventory, identity, plan } = population(source);
    const declaration = input.entrySource.statements.find(ts.isClassDeclaration)!;
    const m0 = inventory.terminalUnits.find((unit) => unit.kind === "module-init")!;
    expect(m0).toBeDefined();
    expect(m0.declarationStart).toBe(declaration.getStart(input.entrySource));
    expect(plan.unitId).toBe(m0.id);
    expect(plan.executable).toBe(true);
    expect(plan.invocation.kind).toBe("wasm-start");
    expect(plan.evaluations).toEqual([
      expect.objectContaining({
        kind: "class-definition",
        classId: inventory.classes[0]!.id,
        start: declaration.getStart(input.entrySource),
        end: declaration.end,
        statementOrdinal: 0,
        nestedOrdinal: 0,
        sourceOrdinal: 0,
      }),
    ]);
    const ctorUnit = inventory.allUnits.find((unit) => unit.kind === "class-implicit-constructor")!;
    expect(ctorUnit.terminal).toBe(false);
    expect(ctorUnit.terminalOwnerId).toBe(m0.id);
    expect(requireIrPlanningOwnerUnitId(identity, declaration)).toBe(m0.id);
    expect(prepareWholeIrProgram(input)).toMatchObject({
      kind: "unsupported",
      code: "class-definition-execution-unsupported",
    });
  });

it("keeps the default legacy class population and implicit constructor unowned", () => {
  const { input, inventory } = population("class C{}");
  const legacy = buildIrUnitInventory(input.sourceFiles, { entrySource: input.entrySource, checker: input.checker });
  expect(collectModuleInitPopulation(input.entrySource)).toEqual([]);
  expect(legacy.terminalUnits).toEqual([]);
  expect(legacy.classes).toEqual(inventory.classes);
  expect(legacy.allUnits).toHaveLength(1);
  expect(legacy.allUnits[0]).toMatchObject({
    id: inventory.allUnits.find((unit) => !unit.terminal)!.id,
    terminal: false,
    terminalOwnerId: null,
    unownedReason: "no-r0-attempt-root",
  });
  expect(getIrInventoryScannerMetadata(legacy)?.moduleInitMode).toBe("legacy");
});

it("forces complete-source population after caller options", () => {
  const input = sourceInput({ "./entry.ts": "class C{}" });
  const { inventory, identity } = prepareIrSourceDefinitionPopulation({
    ...input,
    inventoryOptions: { moduleInitMode: "legacy" },
  });
  expect(getIrInventoryScannerMetadata(inventory)?.moduleInitMode).toBe("source-complete");
  expect(identity.moduleInitPopulationBySourceFile.get(input.entrySource)).toEqual([...input.entrySource.statements]);
  expect(inventory.terminalUnits.filter((unit) => unit.kind === "module-init")).toHaveLength(1);
});

it("records a definition once in source order, including its static work", () => {
  const source = "let n=1;class C{static a=2;static{n=3;}[(n=4,'x')]:number;}n=5;class D{}";
  const { input, inventory, identity, plan } = population(source);
  expect(plan.evaluations.map((entry) => entry.kind)).toEqual([
    "variable-initializer",
    "class-definition",
    "statement",
    "class-definition",
  ]);
  expect(plan.evaluations.map((entry) => entry.statementOrdinal)).toEqual([0, 1, 2, 3]);
  expect(plan.evaluations.filter((entry) => entry.classId).map((entry) => entry.classId)).toEqual(
    inventory.classes.map((entry) => entry.id),
  );
  expect(plan.gaps).toEqual([]);
  const legacy = buildIrPlanningIdentityContext(buildIrUnitInventory(input.sourceFiles, { checker: input.checker }));
  const declaration = input.entrySource.statements.find(ts.isClassDeclaration)!;
  expect(classStartupOccurrences(legacy, declaration).map((entry) => entry.kind)).toEqual([
    "class-static-field",
    "class-static-block",
  ]);
  expect(classStartupOccurrences(identity, declaration).map((entry) => entry.kind)).toEqual(["class-definition"]);
});

it("owns definition-time closures with M0 and discovers all member source exactly once", () => {
  const { inventory, identity } = population(`class C extends (()=>null)(){
    [(()=>"method")()](){return 1;}
    [(()=>"field")()]:number;
    static x=(()=>2)();
    static {(()=>3)();}
    y=(()=>4)();
  }`);
  const m0 = inventory.terminalUnits.find((unit) => unit.kind === "module-init")!;
  const ctorUnit = inventory.terminalUnits.find((unit) => unit.kind === "class-implicit-constructor")!;
  const arrows = inventory.allUnits.filter((unit) => unit.kind === "arrow-function");
  expect(arrows).toHaveLength(6);
  expect(arrows.filter((unit) => unit.terminalOwnerId === m0.id)).toHaveLength(5);
  expect(arrows.filter((unit) => unit.terminalOwnerId === ctorUnit.id)).toHaveLength(1);
  expect(new Set(inventory.allUnits.map((unit) => unit.id)).size).toBe(inventory.allUnits.length);
  for (const unit of arrows)
    expect(requireIrPlanningOwnerUnitId(identity, identity.declarationByUnitId.get(unit.id)!)).toBe(
      unit.terminalOwnerId,
    );
});

it("keeps nested declarations owned by their actual containing function", () => {
  const { input, inventory, identity, plan } = population(
    "export function make(){class C extends (()=>null)(){}return C;}",
  );
  expect(plan.evaluations).toEqual([]);
  expect(inventory.terminalUnits.some((unit) => unit.kind === "module-init")).toBe(false);
  const declaration = input.entrySource.statements.find(ts.isFunctionDeclaration)!;
  const owner = identity.unitIdByDeclaration.get(declaration)!;
  expect(inventory.allUnits.find((unit) => unit.kind === "arrow-function")?.terminalOwnerId).toBe(owner);
  expect(prepareWholeIrProgram(input)).toMatchObject({
    kind: "unsupported",
    code: "class-definition-execution-unsupported",
  });
});

for (const nested of [false, true])
  it(`resolves definition expressions before callable boundaries, nested=${nested}`, () => {
    const declaration = `@decorate class C extends (read(),null){
      @decorate [(read(),"m")](@decorate x:number){}
      get [(read(),"g")](){return 1;}
      set [(read(),"s")](x:number){}
      x=1;
    }`;
    const { input, inventory, identity } = population(nested ? `function make(){${declaration}}` : declaration);
    const outer = nested
      ? inventory.terminalUnits.find((unit) => unit.kind === "top-level-function")!
      : inventory.terminalUnits.find((unit) => unit.kind === "module-init")!;
    const cls = identity.declarationByClassId.get(inventory.classes[0]!.id)!;
    const expressions = classDefinitionExpressions(cls);
    expect(expressions).toHaveLength(7);
    for (const expression of expressions) {
      expect(identity.definitionOwnerByExpression.get(expression)).toBe(outer.id);
      expect(requireIrPlanningOwnerUnitId(identity, expression)).toBe(outer.id);
      ts.forEachChild(expression, (child) => expect(requireIrPlanningOwnerUnitId(identity, child)).toBe(outer.id));
    }
    if (!nested) {
      const method = cls.members.find(ts.isMethodDeclaration)!;
      expect(requireIrPlanningOwnerUnitId(identity, method.body!)).toBe(identity.unitIdByDeclaration.get(method));
      expect(requireIrPlanningOwnerUnitId(identity, method.body!)).not.toBe(outer.id);
    }
    expect(prepareWholeIrProgram(input)).toMatchObject({
      kind: "unsupported",
      code: "class-definition-execution-unsupported",
    });
  });

it("erases ambient classes without creating class startup work", () => {
  const { input, inventory, plan } = population("declare class C{};declare abstract class D{}");
  expect(inventory.classes).toHaveLength(2);
  expect(inventory.terminalUnits).toEqual([]);
  expect(collectModuleInitPopulation(input.entrySource, "source-complete")).toEqual([]);
  expect(plan.evaluations).toEqual([]);
  expect(plan.executable).toBe(false);
});

it("does not publish a constructor body callable as the evaluated class export", () => {
  const { plan } = population("export class C{x=1;}");
  expect(plan.exports).toEqual([expect.objectContaining({ externalName: "C", targetBindingId: null })]);
});

it("preserves the ordinary complete-source inventory ordering", () => {
  const { input, inventory } = population("let n=3;export function run():number{return n;}");
  const legacy = buildIrUnitInventory(input.sourceFiles, { entrySource: input.entrySource, checker: input.checker });
  expect(inventory).toEqual(legacy);
});

it("keeps source, class, and startup identities deterministic under dependency insertion order", () => {
  const input = sourceInput({ "./entry.ts": "import './dep';class Entry{}", "./dep.ts": "class Dependency{}" });
  const forward = prepareIrSourceDefinitionPopulation(input);
  const reverse = prepareIrSourceDefinitionPopulation({ ...input, sourceFiles: [...input.sourceFiles].reverse() });
  expect(reverse.inventory).toEqual(forward.inventory);
  for (const source of forward.inventory.sources) {
    const file = forward.identity.sourceFileBySourceId.get(source.id)!;
    const plan = buildIrModuleInitPlan({
      sourceFile: file,
      checker: input.checker,
      identityContext: forward.identity,
      target: "standalone",
      deferTopLevelInit: false,
    });
    expect(plan.evaluations).toHaveLength(1);
    expect(plan.evaluations[0]?.classId).toBe(forward.inventory.classes.find((row) => row.sourceId === source.id)!.id);
  }
});

it("rejects an expression added to a previously expression-free scanned class", () => {
  const { inventory, identity } = population("class C{}");
  const declaration = identity.declarationByClassId.get(inventory.classes[0]!.id)!;
  Reflect.set(
    declaration,
    "heritageClauses",
    ts.factory.createNodeArray([
      ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
        ts.factory.createExpressionWithTypeArguments(ts.factory.createIdentifier("Base"), undefined),
      ]),
    ]),
  );
  expect(() => buildIrPlanningIdentityContext(inventory)).toThrow(/expression census changed/);
});

it("rejects a definition expression removed from its actual scanned class", () => {
  const { inventory, identity } = population("class C extends Base{}");
  const declaration = identity.declarationByClassId.get(inventory.classes[0]!.id)!;
  Reflect.set(declaration, "heritageClauses", undefined);
  expect(() => buildIrPlanningIdentityContext(inventory)).toThrow(/exact scanner execution owner/);
});

for (const source of [
  "export default (class C extends (()=>null)(){});",
  "export = class C extends (()=>null)(){};",
  "export default take(class C extends (()=>null)(){});",
  "export default flag ? class C extends (()=>null)(){} : class D{};",
  "export default ()=>class C extends (()=>null)(){};",
  "class First{};export default (class C extends (()=>null)(){});",
])
  it(`owns class work in export expression ${source}`, () => {
    const { inventory, identity, input, plan } = population(source);
    const m0 = inventory.terminalUnits.find((unit) => unit.kind === "module-init")!;
    expect(m0).toBeDefined();
    expect(plan.unitId).toBe(m0.id);
    expect(inventory.allUnits.filter((unit) => unit.kind === "export-assignment")).toEqual([
      expect.objectContaining({ terminalOwnerId: m0.id }),
    ]);
    for (const unit of inventory.allUnits.filter(
      (unit) => unit.kind === "arrow-function" || unit.kind === "class-implicit-constructor",
    ))
      expect(unit.terminalOwnerId).toBe(m0.id);
    for (const record of inventory.classes) {
      const declaration = identity.declarationByClassId.get(record.id)!;
      for (const expression of classDefinitionExpressions(declaration))
        expect(requireIrPlanningOwnerUnitId(identity, expression)).toBe(m0.id);
    }
    expect(prepareWholeIrProgram(input)).toMatchObject({
      kind: "unsupported",
      code: "class-definition-execution-unsupported",
    });
  });

it("keeps original export assignment UnitIDs while assigning actual source execution ownership", () => {
  const { input, inventory } = population("export default 7;");
  const legacy = buildIrUnitInventory(input.sourceFiles, { entrySource: input.entrySource, checker: input.checker });
  expect(new Set(inventory.allUnits.map((unit) => unit.id))).toEqual(new Set(legacy.allUnits.map((unit) => unit.id)));
  expect(legacy.allUnits.find((unit) => unit.kind === "export-assignment")?.terminalOwnerId).toBeNull();
  expect(inventory.allUnits.find((unit) => unit.kind === "export-assignment")?.terminalOwnerId).toBe(
    inventory.terminalUnits[0]!.id,
  );
});
