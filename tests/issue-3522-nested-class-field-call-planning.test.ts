// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  isIrNestedClassFieldCallProofCurrent,
  planIrNestedClassFieldCalls,
  type IrNestedClassFieldCallProof,
} from "../src/ir/class-field-call-planning.js";
import { buildIrUnitInventory, getIrNestedClassFieldCallInventoryCandidates } from "../src/ir/identity.js";
import { makeIrIdentityImportedFunctionResolver } from "../src/ir/imported-functions.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { planIrCompilationByIdentity } from "../src/ir/select-identity.js";
import { buildIrOverlayIdentityMaps, planIrOverlayByIdentity } from "../src/codegen/ir-overlay-identity.js";
import { ts } from "../src/ts-api.js";

const POSITIVE_SOURCE = `
  function seed(value: number): number { return value + 2; }
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

function decisionSnapshot(selection: ReturnType<typeof planIrCompilationByIdentity>) {
  return {
    funcs: [...selection.funcs.keys()].sort(),
    classMembers: [...(selection.classMembers?.keys() ?? [])].sort(),
    fallbacks: [...(selection.fallbacks ?? [])]
      .map(([unitId, fallback]) => [unitId, fallback.reason] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    moduleInit: selection.moduleInit,
  };
}

describe("#3522 dormant nested-class field-call planning", () => {
  it("mints immutable constructor-owned inventory markers without admitting the class", () => {
    const graph = positiveFixture();
    const candidates = getIrNestedClassFieldCallInventoryCandidates(graph.context.inventory);
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate).toBeDefined();
    expect(candidate!.inventory).toBe(graph.context.inventory);
    expect(candidate!.sourceFile).toBe(graph.entry);
    expect(candidate!.constructorRecord.kind).toBe("class-implicit-constructor");
    expect(candidate!.constructorRecord.terminal).toBe(true);
    expect(candidate!.constructorRecord.containingTerminalOwnerId).toBe(candidate!.containingTerminalRecord.id);
    expect(candidate!.fields).toHaveLength(1);
    expect(candidate!.fields[0]!.record.kind).toBe("class-instance-field-initializer");
    expect(candidate!.fields[0]!.record.terminalOwnerId).toBe(candidate!.constructorRecord.id);
    expect(candidate!.terminalMembers.map(({ record }) => record.kind).sort()).toEqual([
      "class-implicit-constructor",
      "class-instance-method",
    ]);
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate!.fields)).toBe(true);
    expect(Object.isFrozen(candidate!.terminalMembers)).toBe(true);

    const disabledProofs = planIrNestedClassFieldCalls({
      identityContext: graph.context,
      resolver: graph.resolver,
      enabled: false,
    });
    const selection = planIrCompilationByIdentity(graph.entry, graph.context, {
      experimentalIR: true,
      trackFallbacks: true,
      nestedClassFieldCallProofs: disabledProofs,
    });
    expect(selection.nestedClassFieldCallCandidates).toEqual(candidates);
    expect(selection.nestedClassFieldCallProofs).toBe(disabledProofs);
    expect(selection.classMembers?.size ?? 0).toBe(0);
    for (const { record } of candidate!.terminalMembers) {
      expect(selection.fallbacks?.get(record.id)?.reason).toBe("class-member-unsupported");
    }
    expect(selection.units.has(candidate!.fields[0]!.record.id)).toBe(false);
  });

  it("normalizes a field-call candidate's getter and setter terminals without claiming them", () => {
    const graph = fixture({
      "/repo/entry.ts": `
        function seed(value: number): number { return value + 2; }
        export function run(): number {
          class Box {
            value: number = seed(40);
            get current(): number { return this.value; }
            set current(value: number) { this.value = value; }
          }
          return new Box().current;
        }
      `,
    });
    const candidates = getIrNestedClassFieldCallInventoryCandidates(graph.context.inventory);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.terminalMembers.map(({ record }) => record.kind).sort()).toEqual([
      "class-implicit-constructor",
      "class-instance-getter",
      "class-instance-setter",
    ]);
    const proofs = planIrNestedClassFieldCalls({ identityContext: graph.context, resolver: graph.resolver });
    expect(proofs.entries).toHaveLength(1);
    const selection = planIrCompilationByIdentity(graph.entry, graph.context, {
      experimentalIR: true,
      trackFallbacks: true,
      nestedClassFieldCallProofs: proofs,
    });
    expect(selection.classMembers?.size ?? 0).toBe(0);
    for (const { record } of candidate.terminalMembers) {
      expect(selection.fallbacks?.get(record.id)?.reason).toBe("class-member-unsupported");
    }
  });

  it("retains the exact const class-expression candidate and proof without admitting it", () => {
    const graph = fixture({
      "/repo/entry.ts": `
        function seed(value: number): number { return value + 2; }
        export function run(): number {
          const Box = class {
            value: number = seed(40);
            read(): number { return this.value; }
          };
          return new Box().read();
        }
      `,
    });
    const candidates = getIrNestedClassFieldCallInventoryCandidates(graph.context.inventory);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(ts.isClassExpression(candidate.declaration)).toBe(true);
    expect(candidate.constructorRecord.kind).toBe("class-implicit-constructor");
    expect(candidate.fields[0]!.record.terminalOwnerId).toBe(candidate.constructorRecord.id);
    const proofs = planIrNestedClassFieldCalls({ identityContext: graph.context, resolver: graph.resolver });
    expect(proofs.entries).toHaveLength(1);
    expect(proofs.entries[0]!.candidate).toBe(candidate);
    const selection = planIrCompilationByIdentity(graph.entry, graph.context, {
      experimentalIR: true,
      trackFallbacks: true,
      nestedClassFieldCallProofs: proofs,
    });
    expect(selection.classMembers?.size ?? 0).toBe(0);
    for (const { record } of candidate.terminalMembers) {
      expect(selection.fallbacks?.get(record.id)?.reason).toBe("class-member-unsupported");
    }
  });

  it("retains one exact source-qualified proof and rejects stale joins", () => {
    const graph = positiveFixture();
    const input = { identityContext: graph.context, resolver: graph.resolver } as const;
    const sidecar = planIrNestedClassFieldCalls(input);
    expect(sidecar.entries).toHaveLength(1);
    const proof = sidecar.entries[0]!;
    expect(sidecar.get(proof.call)).toBe(proof);
    expect(proof.call).toBe(proof.fieldDeclaration.initializer);
    expect(proof.callee.text).toBe("seed");
    expect(proof.calleeDeclaration.name?.text).toBe("seed");
    expect(proof.fieldSupportUnitId).toBe(proof.fieldCandidate.record.id);
    expect(proof.constructorUnitId).toBe(proof.candidate.constructorRecord.id);
    expect(proof.target).toEqual(irUnitFuncRef({ unitId: proof.calleeUnitId, name: "seed" }));
    expect(proof.signature.params).toEqual([{ kind: "val", val: { kind: "f64" } }]);
    expect(proof.signature.returnType).toEqual({ kind: "val", val: { kind: "f64" } });
    expect(proof.argumentProjection.arity).toBe(1);
    expect(proof.argumentProjection.arguments[0]!.expression).toBe(proof.call.arguments[0]);
    expect(proof.argumentProjection.arguments[0]!.kind).toBe("number");
    expect(Object.isFrozen(sidecar)).toBe(true);
    expect(Object.isFrozen(sidecar.entries)).toBe(true);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.signature.params)).toBe(true);
    expect(Object.isFrozen(proof.signature.params[0])).toBe(true);
    expect(Object.isFrozen(proof.signature.returnType)).toBe(true);
    expect(Object.isFrozen(proof.argumentProjection.arguments)).toBe(true);
    expect(isIrNestedClassFieldCallProofCurrent(proof, input)).toBe(true);

    const wrongOwner = {
      ...proof,
      constructorUnitId: proof.containingTerminalUnitId,
    } as IrNestedClassFieldCallProof;
    const wrongTarget = {
      ...proof,
      target: irUnitFuncRef({ unitId: proof.containingTerminalUnitId, name: "seed" }),
    } as IrNestedClassFieldCallProof;
    const staleSignature = {
      ...proof,
      signature: { params: proof.signature.params, returnType: null },
    } as IrNestedClassFieldCallProof;
    const staleArguments = {
      ...proof,
      argumentProjection: { arity: 0, arguments: [] },
    } as IrNestedClassFieldCallProof;
    const copiedFieldCandidate = {
      ...proof,
      fieldCandidate: { ...proof.fieldCandidate },
    } as IrNestedClassFieldCallProof;
    expect(isIrNestedClassFieldCallProofCurrent(wrongOwner, input)).toBe(false);
    expect(isIrNestedClassFieldCallProofCurrent(wrongTarget, input)).toBe(false);
    expect(isIrNestedClassFieldCallProofCurrent(staleSignature, input)).toBe(false);
    expect(isIrNestedClassFieldCallProofCurrent(staleArguments, input)).toBe(false);
    expect(isIrNestedClassFieldCallProofCurrent(copiedFieldCandidate, input)).toBe(false);

    const copied = ts.createSourceFile(
      graph.entry.fileName,
      graph.entry.text,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    let copiedCall: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (
        !copiedCall &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "seed"
      ) {
        copiedCall = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(copied);
    expect(copiedCall).toBeDefined();
    expect(sidecar.get(copiedCall!)).toBeUndefined();

    const rebuilt = positiveFixture();
    expect(
      isIrNestedClassFieldCallProofCurrent(proof, {
        identityContext: rebuilt.context,
        resolver: rebuilt.resolver,
      }),
    ).toBe(false);
  });

  it("keeps proof-enabled and proof-disabled identity/overlay decisions identical", () => {
    const graph = positiveFixture();
    const enabled = planIrNestedClassFieldCalls({ identityContext: graph.context, resolver: graph.resolver });
    const disabled = planIrNestedClassFieldCalls({
      identityContext: graph.context,
      resolver: graph.resolver,
      enabled: false,
    });
    const maps = buildIrOverlayIdentityMaps(graph.entry, graph.checker, graph.context);
    const enabledPlan = planIrOverlayByIdentity(
      graph.entry,
      graph.context,
      { experimentalIR: true, trackFallbacks: true, nestedClassFieldCallProofs: enabled },
      maps,
    );
    const disabledPlan = planIrOverlayByIdentity(
      graph.entry,
      graph.context,
      { experimentalIR: true, trackFallbacks: true, nestedClassFieldCallProofs: disabled },
      maps,
    );
    expect(decisionSnapshot(enabledPlan.identitySelection)).toEqual(decisionSnapshot(disabledPlan.identitySelection));
    expect(enabledPlan.nestedClassFieldCallCandidates).toEqual(disabledPlan.nestedClassFieldCallCandidates);
    expect(enabledPlan.nestedClassFieldCallProofs).toBe(enabled);
    expect(disabledPlan.nestedClassFieldCallProofs).toBe(disabled);
    expect(enabled.entries).toHaveLength(1);
    expect(disabled.entries).toHaveLength(0);
  });

  it.each([
    ["optional", "value = seed?.(40);"],
    ["spread", "value = seed(...[40]);"],
    ["generic", "value = seed<number>(40);"],
    ["member", "value = Math.floor(40);"],
    ["mutable class expression", "", "let Box = class { value = seed(40); read() { return this.value; } };"],
  ])("rejects %s syntax before proof collection", (_label, field, customClass) => {
    const source = `
      function seed(value: number): number { return value; }
      export function run(): number {
        ${customClass ?? `class Box { ${field} read() { return this.value; } }`}
        return new Box().read();
      }
    `;
    const graph = fixture({ "/repo/entry.ts": source });
    expect(getIrNestedClassFieldCallInventoryCandidates(graph.context.inventory)).toHaveLength(0);
    expect(
      planIrNestedClassFieldCalls({ identityContext: graph.context, resolver: graph.resolver }).entries,
    ).toHaveLength(0);
  });

  it.each([
    [
      "unknown target",
      { "/repo/entry.ts": POSITIVE_SOURCE.replace("function seed(value: number): number { return value + 2; }", "") },
    ],
    [
      "enclosing-frame argument",
      {
        "/repo/entry.ts": POSITIVE_SOURCE.replace(
          "export function run(): number",
          "export function run(input: number): number",
        ).replace("seed(40)", "seed(input)"),
      },
    ],
    [
      "reassigned target",
      {
        "/repo/entry.ts": POSITIVE_SOURCE.replace(
          "export function run",
          "seed = (value: number) => value; export function run",
        ),
      },
    ],
    [
      // (#5300) A COMPATIBLE overload set is now an admissible target — see the
      // dedicated proof test below. A set whose signatures diverge still is not.
      "divergently overloaded target",
      {
        "/repo/entry.ts": POSITIVE_SOURCE.replace(
          "function seed(value: number): number { return value + 2; }",
          "function seed(value: number): number; function seed(value: number, extra: number): number;" +
            " function seed(value: number, extra?: number): number { return value + 2 + (extra ?? 0); }",
        ),
      },
    ],
    [
      "same-spelled foreign target",
      {
        "/repo/entry.ts": POSITIVE_SOURCE,
        "/repo/foreign.ts": "export function seed(value: number): number { return value - 1; }",
      },
    ],
    [
      "cross-source import",
      {
        "/repo/provider.ts": "export function seed(value: number): number { return value + 2; }",
        "/repo/entry.ts": POSITIVE_SOURCE.replace(
          "function seed(value: number): number { return value + 2; }",
          'import { seed } from "./provider";',
        ),
      },
    ],
  ])("retains the marker but rejects a %s proof", (_label, files) => {
    const graph = fixture(files);
    expect(getIrNestedClassFieldCallInventoryCandidates(graph.context.inventory)).toHaveLength(1);
    expect(
      planIrNestedClassFieldCalls({ identityContext: graph.context, resolver: graph.resolver }).entries,
    ).toHaveLength(0);
  });

  // (#5300) The resolver used to refuse EVERY overload set, so a compatible one
  // was listed above as a rejected proof. It is admissible now: the set has one
  // bodied implementation and every signature has the same lowering shape, so
  // the field call resolves to the same single physical callable a
  // non-overloaded `seed` would.
  it("proves a field call against a compatible overload set", () => {
    const graph = fixture({
      "/repo/entry.ts": POSITIVE_SOURCE.replace(
        "function seed(value: number): number",
        "function seed(value: number): number; function seed(value: number): number",
      ),
    });
    expect(getIrNestedClassFieldCallInventoryCandidates(graph.context.inventory)).toHaveLength(1);
    expect(
      planIrNestedClassFieldCalls({ identityContext: graph.context, resolver: graph.resolver }).entries,
    ).toHaveLength(1);
  });
});
