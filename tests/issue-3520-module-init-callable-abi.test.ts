// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { generateModule, generateMultiModule } from "../src/codegen/index.js";
import { canonicalProgramAbiCallableTypeContract } from "../src/codegen/program-abi-signatures.js";
import { compile, compileMulti, type CompileResult } from "../src/index.js";
import { irSupportFuncRef, irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrUnitInventory } from "../src/ir/identity.js";
import type { ProgramAbiPlanEntry } from "../src/ir/program-abi.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const COLLISION_SOURCE = `
  let total: number = 1;
  total += 2;

  function __module_init(): number {
    return 99;
  }

  export function callUserInitializer(): number {
    return __module_init();
  }

  export function readTotal(): number {
    return total;
  }
`;

function exactUnit(inventory: IrUnitInventory, kind: string, displayName: string) {
  const matches = inventory.allUnits.filter((unit) => unit.kind === kind && unit.displayName === displayName);
  if (matches.length !== 1) {
    throw new Error(`expected one ${kind} ${displayName}, found ${matches.length}`);
  }
  return matches[0]!;
}

function requiredCallable(entries: readonly ProgramAbiPlanEntry[], bindingId: string): ProgramAbiPlanEntry {
  const entry = entries.find((candidate) => candidate.id === bindingId);
  if (!entry) throw new Error(`missing callable ABI entry ${bindingId}`);
  expect(entry).toMatchObject({
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable" },
  });
  return entry;
}

async function instantiate(result: CompileResult): Promise<Record<string, WebAssembly.ExportValue>> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, WebAssembly.ExportValue>;
}

describe("#3520 module-init callable Program ABI ownership", () => {
  it("keeps a same-named user function distinct from the exact IR-patched initializer", async () => {
    const ast = analyzeSource(COLLISION_SOURCE, "module-init-collision.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const moduleInit = exactUnit(inventory, "module-init", "<module-init>");
    const userInit = exactUnit(inventory, "top-level-function", "__module_init");
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });

    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(generated.irPostClaimErrors).toEqual([]);
    expect(generated.irCompiledFuncs).toContain("<module-init>");
    expect(generated.irOutcomes?.find((outcome) => outcome.unitId === moduleInit.id)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect(generated.programAbi).toBeDefined();

    const entries = generated.programAbi!.abi.entries();
    const moduleBindingId = irUnitCallableBindingId(moduleInit.id);
    const userBindingId = irUnitCallableBindingId(userInit.id);
    const moduleEntry = requiredCallable(entries, moduleBindingId);
    const userEntry = requiredCallable(entries, userBindingId);
    expect(moduleEntry).toMatchObject({
      displayName: "__module_init",
      intent: { kind: "callable", origin: "source", unitId: moduleInit.id },
    });
    expect(userEntry).toMatchObject({
      displayName: "__module_init",
      intent: { kind: "callable", origin: "source", unitId: userInit.id },
    });

    const moduleSlot = generated.programAbi!.abi.resolveFinalIndex(moduleBindingId);
    const userSlot = generated.programAbi!.abi.resolveFinalIndex(userBindingId);
    expect(moduleSlot).toEqual(expect.objectContaining({ space: "function" }));
    expect(userSlot).toEqual(expect.objectContaining({ space: "function" }));
    expect(moduleSlot).not.toEqual(userSlot);

    if (!moduleSlot || moduleSlot.space !== "function") throw new Error("missing module-init function slot");
    const importCount = generated.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
    const moduleFunction = generated.module.functions[moduleSlot.index - importCount];
    const signature = moduleFunction ? generated.module.types[moduleFunction.typeIdx] : undefined;
    if (!moduleFunction || !signature || signature.kind !== "func") {
      throw new Error("missing exact module-init function");
    }
    expect(moduleEntry.intent).toMatchObject({
      kind: "callable",
      signature: canonicalProgramAbiCallableTypeContract(signature),
    });

    const publicInit = entries.find(
      (entry) => entry.intent.kind === "export" && entry.intent.externalName === "__module_init",
    );
    expect(publicInit).toMatchObject({ slotPolicy: "alias", aliasOf: moduleBindingId });
    expect(generated.programAbi!.abi.resolveFinalIndex(publicInit!.id)).toEqual(moduleSlot);

    const runtime = await compile(COLLISION_SOURCE, {
      fileName: "module-init-collision.ts",
      experimentalIR: true,
      deferTopLevelInit: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.callUserInitializer as () => number)()).toBe(99);
    (exports.__module_init as () => void)();
    expect((exports.readTotal as () => number)()).toBe(3);
    expect((exports.callUserInitializer as () => number)()).toBe(99);
  });

  it("owns the exact retained direct initializer when IR reports Unsupported", async () => {
    const source = `
      let greeting: string = "hi";
      greeting = greeting + "!";
      function __module_init(): number { return 41; }
      export function callUserInitializer(): number { return __module_init(); }
      export function readGreeting(): string { return greeting; }
    `;
    const ast = analyzeSource(source, "module-init-direct-collision.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const moduleInit = exactUnit(inventory, "module-init", "<module-init>");
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(generated.irOutcomes?.find((outcome) => outcome.unitId === moduleInit.id)).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });

    const bindingId = irUnitCallableBindingId(moduleInit.id);
    const entry = requiredCallable(generated.programAbi!.abi.entries(), bindingId);
    expect(entry).toMatchObject({
      displayName: "__module_init",
      intent: { kind: "callable", origin: "source", unitId: moduleInit.id },
    });

    const runtime = await compile(source, {
      fileName: "module-init-direct-collision.ts",
      experimentalIR: true,
      deferTopLevelInit: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.callUserInitializer as () => number)()).toBe(41);
    (exports.__module_init as () => void)();
    expect((exports.readGreeting as () => string)()).toBe("hi!");
    expect((exports.callUserInitializer as () => number)()).toBe(41);
  });

  it("classifies cumulative multi-source initializer passes without inventing one source owner", async () => {
    const files = {
      "dependency.ts": `
        export var dependencyRuns: number = 0;
        dependencyRuns += 1;
      `,
      "entry.ts": `
        import { dependencyRuns } from "./dependency.ts";
        var entryRuns: number = 0;
        entryRuns += 1;
        export function score(): number { return dependencyRuns * 10 + entryRuns; }
      `,
    };
    const ast = analyzeMultiSource(files, "entry.ts");
    const inventory = buildIrUnitInventory(ast.sourceFiles, {
      entrySource: ast.entryFile,
      checker: ast.checker,
    });
    expect([...inventory.terminalUnits].filter((unit) => unit.kind === "module-init")).toHaveLength(2);
    const entrySourceId = inventory.sources.find((source) => source.kind === "entry")!.id;
    const generated = generateMultiModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);

    const entries = generated.programAbi!.abi.entries();
    const passEntries = [0, 1].map((ordinal) => {
      const ref = irSupportFuncRef(entrySourceId, "legacy-module-init-pass", "__module_init", ordinal);
      if (ref.binding.kind !== "support") throw new Error("expected module-init support reference");
      return requiredCallable(entries, ref.binding.bindingId);
    });
    expect(passEntries).toEqual([
      expect.objectContaining({
        displayName: "__module_init",
        intent: expect.objectContaining({ kind: "callable", origin: "support", sourceId: entrySourceId }),
      }),
      expect.objectContaining({
        displayName: "__module_init",
        intent: expect.objectContaining({ kind: "callable", origin: "support", sourceId: entrySourceId }),
      }),
    ]);
    expect(passEntries.map((entry) => generated.programAbi!.abi.resolveFinalIndex(entry.id))).toEqual([
      expect.objectContaining({ space: "function" }),
      expect.objectContaining({ space: "function" }),
    ]);

    const publicInit = entries.find(
      (entry) => entry.intent.kind === "export" && entry.intent.externalName === "__module_init",
    );
    expect(generated.programAbi!.abi.resolveFinalIndex(publicInit!.id)).toEqual(
      generated.programAbi!.abi.resolveFinalIndex(passEntries[1]!.id),
    );

    const runtime = await compileMulti(files, "entry.ts", {
      experimentalIR: true,
      deferTopLevelInit: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.score as () => number)()).toBe(0);
    (exports.__module_init as () => void)();
    expect((exports.score as () => number)()).toBe(11);
  });
});
