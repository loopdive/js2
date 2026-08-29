// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3522 F4) The proof-derived admitted-class marker, and its one-fact
// fail-closed mutations.
//
// F3 separated INVENTORY CANDIDACY (syntax-only, in `class-accessor-safety.ts`)
// from selector admission. F4 keeps that split: the syntax predicate
// `isBoundedPreparedNestedOrdinaryClass` is unchanged, `CallExpression` is
// still rejected by `boundedPreparedInstanceFieldInitializer`, and a candidate
// becomes claimable only through ONE immutable marker derived from the complete
// F3 proof and consumed — never recomputed — by every downstream owner.
//
// Every mutation below changes exactly one fact and must fail closed: either
// the marker is not minted at all, or the selector refuses it.

import { describe, expect, it } from "vitest";
import { planIrNestedClassFieldCalls } from "../src/ir/class-field-call-planning.js";
import {
  buildIrUnitInventory,
  createIrNestedClassFieldCallAdmission,
  getIrNestedClassFieldCallInventoryCandidates,
  irPreparedNestedOrdinaryClass,
  irPreparedNestedOrdinaryClassBindingName,
  isIrNestedClassFieldCallAdmissionForInventory,
  type IrNestedClassFieldCallAdmission,
  type IrNestedClassFieldCallAdmittedClass,
} from "../src/ir/identity.js";
import {
  boundedPreparedNestedOrdinaryClassBindingName,
  isBoundedPreparedNestedOrdinaryClass,
  isNestedOrdinaryClassFieldCallInventoryCandidate,
  nestedOrdinaryClassBodyHasNestedExecutable,
} from "../src/ir/class-accessor-safety.js";
import { makeIrIdentityImportedFunctionResolver } from "../src/ir/imported-functions.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { computeIrNestedClassFieldCallAdmission, planIrCompilationByIdentity } from "../src/ir/select-identity.js";
import { IrPlanningIdentityInvariantError } from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

const POSITIVE_SOURCE = `
  function seed(value: number): number { return value + 2; }
  function other(value: number): number { return value; }
  export function run(): number {
    class Box {
      value: number = seed(40);
      read(): number { return this.value; }
    }
    return new Box().read();
  }
`;

function fixture(files: Readonly<Record<string, string>>) {
  const textByName = new Map(Object.entries(files));
  const rootNames = Object.keys(files);
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noLib: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => textByName.has(fileName),
    readFile: (fileName) => textByName.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = textByName.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    directoryExists: (directoryName) => directoryName === "/repo",
    realpath: (path) => path,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(rootNames, options, host);
  const checker = program.getTypeChecker();
  const sourceFiles = rootNames.map((fileName) => program.getSourceFile(fileName)!);
  const byName = new Map(sourceFiles.map((sourceFile) => [sourceFile.fileName, sourceFile] as const));
  const entry = byName.get("/repo/entry.ts") ?? sourceFiles[0]!;
  const context = buildIrPlanningIdentityContext(buildIrUnitInventory(sourceFiles, { checker, entrySource: entry }));
  const resolver = makeIrIdentityImportedFunctionResolver(checker, sourceFiles, context);
  return { checker, sourceFiles, byName, entry, context, resolver };
}

function positiveFixture() {
  return fixture({ "/repo/entry.ts": POSITIVE_SOURCE });
}

function admissionFor(graph: ReturnType<typeof positiveFixture>): IrNestedClassFieldCallAdmission {
  const proofs = planIrNestedClassFieldCalls({ identityContext: graph.context, resolver: graph.resolver });
  return computeIrNestedClassFieldCallAdmission({
    identityContext: graph.context,
    resolver: graph.resolver,
    proofs,
  });
}

function selectWith(graph: ReturnType<typeof positiveFixture>, admission: IrNestedClassFieldCallAdmission | undefined) {
  return planIrCompilationByIdentity(graph.entry, graph.context, {
    experimentalIR: true,
    trackFallbacks: true,
    nestedClassFieldCallAdmission: admission,
  });
}

/** Re-mint a marker with exactly one fact replaced. */
function mutate(
  admission: IrNestedClassFieldCallAdmission,
  patch: Partial<IrNestedClassFieldCallAdmittedClass>,
): IrNestedClassFieldCallAdmission {
  const [admitted] = admission.classes;
  expect(admitted).toBeDefined();
  return createIrNestedClassFieldCallAdmission(admission.inventory, [
    Object.freeze({ ...admitted!, ...patch }) as IrNestedClassFieldCallAdmittedClass,
  ]);
}

describe("#3522 F4 inventory candidacy is not selector admission", () => {
  it("keeps the strict predicate closed while the candidate predicate opens", () => {
    const graph = positiveFixture();
    const [candidate] = getIrNestedClassFieldCallInventoryCandidates(graph.context.inventory);
    expect(candidate).toBeDefined();
    const declaration = candidate!.declaration;
    // The syntax predicate that gates selection is UNCHANGED: it still refuses
    // the call-bearing field, and still yields no binding name for it.
    expect(isBoundedPreparedNestedOrdinaryClass(declaration)).toBe(false);
    expect(boundedPreparedNestedOrdinaryClassBindingName(declaration)).toBeUndefined();
    // Only the syntax-only INVENTORY predicate accepts it.
    expect(isNestedOrdinaryClassFieldCallInventoryCandidate(declaration)).toBe(true);
    // And only the proof-derived marker turns that into admission.
    expect(irPreparedNestedOrdinaryClass(declaration, undefined)).toBe(false);
    expect(irPreparedNestedOrdinaryClassBindingName(declaration, undefined)).toBeUndefined();
    const admission = admissionFor(graph);
    expect(irPreparedNestedOrdinaryClass(declaration, admission)).toBe(true);
    expect(irPreparedNestedOrdinaryClassBindingName(declaration, admission)).toBe("Box");
  });

  it("mints ONE immutable marker bound to the exact inventory, class and proof rows", () => {
    const graph = positiveFixture();
    const admission = admissionFor(graph);
    expect(isIrNestedClassFieldCallAdmissionForInventory(admission, graph.context.inventory)).toBe(true);
    expect(admission.classes).toHaveLength(1);
    const [admitted] = admission.classes;
    expect(Object.isFrozen(admission)).toBe(true);
    expect(Object.isFrozen(admission.classes)).toBe(true);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted!.fields)).toBe(true);
    expect(admitted!.sourceFile).toBe(graph.entry);
    expect(admitted!.declaration).toBe(admitted!.candidate.declaration);
    expect(admitted!.classId).toBe(admitted!.candidate.classRecord.id);
    expect(admitted!.constructorUnitId).toBe(admitted!.candidate.constructorRecord.id);
    expect(admitted!.containingTerminalUnitId).toBe(admitted!.candidate.containingTerminalRecord.id);
    expect(admitted!.bindingName).toBe("Box");
    expect(admitted!.fields).toHaveLength(1);
    expect(admitted!.fields[0]!.call).toBe(admitted!.candidate.fields[0]!.call);
    expect(admitted!.fields[0]!.fieldSupportUnitId).toBe(admitted!.candidate.fields[0]!.record.id);
    expect(admitted!.fields[0]!.calleeName).toBe("seed");
    expect(admission.get(admitted!.declaration)).toBe(admitted);
    expect(admission.getByClassId(admitted!.classId)).toBe(admitted);
  });

  it("carries the marker through selection while F3's closed contract is unchanged", () => {
    // Unit-level selection has no projected class-shape population, so neither
    // route can CLAIM here; that end-to-end proof lives in
    // `issue-3522-nested-class-field-call-admission` (poisoned direct emitters,
    // both lanes). What this pins is the seam: without a marker the F3
    // normalization arm still forces every candidate terminal to
    // `class-member-unsupported`, and the marker rides through the selection
    // object rather than being rebuilt by any consumer.
    const graph = positiveFixture();
    const [candidate] = getIrNestedClassFieldCallInventoryCandidates(graph.context.inventory);
    const withoutMarker = selectWith(graph, undefined);
    expect(withoutMarker.nestedClassFieldCallAdmission).toBeUndefined();
    expect(withoutMarker.classMembers?.size ?? 0).toBe(0);
    for (const { record } of candidate!.terminalMembers) {
      expect(withoutMarker.fallbacks?.get(record.id)?.reason).toBe("class-member-unsupported");
    }

    const admission = admissionFor(graph);
    const withMarker = selectWith(graph, admission);
    expect(withMarker.nestedClassFieldCallAdmission).toBe(admission);
    expect(withMarker.nestedClassFieldCallAdmission?.classes).toHaveLength(1);
  });

  it("refuses to mint a marker for a class body carrying a nested executable", () => {
    // Measured on `origin/main` 81e54a98e: the CALL-FREE bounded variant of this
    // shape is already a hard compile failure, so the admitted family excludes
    // it rather than adding instances of a known-broken shape.
    const graph = fixture({
      "/repo/entry.ts": `
        function seed(value: number): number { return value + 2; }
        export function run(): number {
          class Box {
            value: number = seed(40);
            read(): number { const f = (): number => this.value; return f(); }
          }
          return new Box().read();
        }
      `,
    });
    const [candidate] = getIrNestedClassFieldCallInventoryCandidates(graph.context.inventory);
    expect(candidate).toBeDefined();
    expect(nestedOrdinaryClassBodyHasNestedExecutable(candidate!.declaration)).toBe(true);
    expect(admissionFor(graph).classes).toHaveLength(0);
    expect(selectWith(graph, admissionFor(graph)).classMembers?.size ?? 0).toBe(0);
  });
});

describe("#3522 F4 one-fact fail-closed marker mutations", () => {
  it("rejects a fabricated marker that no planner minted", () => {
    const graph = positiveFixture();
    const authentic = admissionFor(graph);
    const forged = Object.freeze({
      inventory: graph.context.inventory,
      classes: authentic.classes,
      get: (declaration: ts.ClassDeclaration | ts.ClassExpression) => authentic.get(declaration),
      getByClassId: (classId: never) => authentic.getByClassId(classId),
      admits: (declaration: ts.ClassDeclaration | ts.ClassExpression) => authentic.admits(declaration),
    }) as unknown as IrNestedClassFieldCallAdmission;
    expect(isIrNestedClassFieldCallAdmissionForInventory(forged, graph.context.inventory)).toBe(false);
    expect(() => selectWith(graph, forged)).toThrow(IrPlanningIdentityInvariantError);
  });

  it("rejects a marker minted against a different inventory", () => {
    const graph = positiveFixture();
    const rebuilt = positiveFixture();
    expect(() => selectWith(graph, admissionFor(rebuilt))).toThrow(IrPlanningIdentityInvariantError);
  });

  it.each([
    ["class id", "classId"],
    ["constructor unit id", "constructorUnitId"],
    ["containing terminal id", "containingTerminalUnitId"],
    ["source id", "sourceId"],
  ] as const)("rejects a replaced %s", (_label, key) => {
    const graph = positiveFixture();
    const admission = admissionFor(graph);
    const [admitted] = admission.classes;
    // Substitute the OUTER function's own identity for the class-owned one:
    // exactly one fact changes, and it is the ownership fact F1/F2 fixed.
    const wrongValue: Record<string, unknown> = {
      classId: admitted!.containingTerminalUnitId,
      constructorUnitId: admitted!.containingTerminalUnitId,
      containingTerminalUnitId: admitted!.constructorUnitId,
      sourceId: "ir-source:v1:forged",
    };
    const swapped = mutate(admission, {
      [key]: wrongValue[key] as never,
    } as Partial<IrNestedClassFieldCallAdmittedClass>);
    expect(() => selectWith(graph, swapped)).toThrow(IrPlanningIdentityInvariantError);
  });

  it("rejects a replaced class DECLARATION object", () => {
    const graph = positiveFixture();
    const admission = admissionFor(graph);
    const [admitted] = admission.classes;
    const copiedDeclaration = { ...admitted!.declaration } as ts.ClassDeclaration;
    expect(() => selectWith(graph, mutate(admission, { declaration: copiedDeclaration }))).toThrow(
      IrPlanningIdentityInvariantError,
    );
  });

  it("rejects a replaced inventory CANDIDATE object", () => {
    const graph = positiveFixture();
    const admission = admissionFor(graph);
    const [admitted] = admission.classes;
    const copiedCandidate = { ...admitted!.candidate };
    expect(() => selectWith(graph, mutate(admission, { candidate: copiedCandidate }))).toThrow(
      IrPlanningIdentityInvariantError,
    );
  });

  it("rejects a mismatched SOURCE FILE", () => {
    const graph = positiveFixture();
    const admission = admissionFor(graph);
    const copied = ts.createSourceFile(
      graph.entry.fileName,
      graph.entry.text,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    // A marker for another SourceFile object is simply not this source's
    // business: the selector skips it, and the class stays unadmitted.
    const foreign = mutate(admission, { sourceFile: copied });
    const selection = selectWith(graph, foreign);
    expect(selection.classMembers?.size ?? 0).toBe(0);
  });

  it.each([
    ["field declaration", "declaration"],
    ["field initializer call", "call"],
    ["field support unit id", "fieldSupportUnitId"],
    ["callee unit id", "calleeUnitId"],
    ["callee compatibility name", "calleeName"],
  ] as const)("rejects a replaced %s", (_label, key) => {
    const graph = positiveFixture();
    const admission = admissionFor(graph);
    const [admitted] = admission.classes;
    const field = admitted!.fields[0]!;
    const replacement: Record<string, unknown> = {
      declaration: { ...field.declaration },
      call: { ...field.call },
      fieldSupportUnitId: admitted!.constructorUnitId,
      // A REAL same-source top-level function that is not the proved target.
      calleeUnitId: [...graph.context.inventory.terminalUnits].find(
        (record) =>
          record.kind === "top-level-function" &&
          graph.context.declarationByUnitId.get(record.id)?.getSourceFile() === graph.entry &&
          record.id !== field.calleeUnitId,
      )?.id,
      calleeName: "other",
    };
    expect(replacement[key], `no replacement available for ${key}`).toBeDefined();
    const mutated = mutate(admission, {
      fields: Object.freeze([Object.freeze({ ...field, [key]: replacement[key] })]) as typeof admitted.fields,
    });
    expect(() => selectWith(graph, mutated)).toThrow(IrPlanningIdentityInvariantError);
  });

  it("rejects a DUPLICATED admitted row for one class", () => {
    const graph = positiveFixture();
    const admission = admissionFor(graph);
    const [admitted] = admission.classes;
    expect(() => createIrNestedClassFieldCallAdmission(admission.inventory, [admitted!, admitted!])).toThrow(
      /more than one admission/,
    );
  });

  it("rejects a MISSING field row", () => {
    const graph = positiveFixture();
    const admission = admissionFor(graph);
    const [admitted] = admission.classes;
    const mutated = mutate(admission, { fields: Object.freeze([]) as typeof admitted.fields });
    expect(() => selectWith(graph, mutated)).toThrow(IrPlanningIdentityInvariantError);
  });

  it("refuses to construct a marker without planner authority", () => {
    const graph = positiveFixture();
    const admission = admissionFor(graph);
    const Ctor = admission.constructor as new (
      inventory: unknown,
      classes: unknown,
      authority: unknown,
    ) => IrNestedClassFieldCallAdmission;
    expect(() => new Ctor(graph.context.inventory, admission.classes, {})).toThrow(/planner authority/);
  });
});
