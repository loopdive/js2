// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";

import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { generateModule, generateMultiModule } from "../src/codegen/index.js";
import { ProgramAbiExportRegistry } from "../src/codegen/program-abi-export-planning.js";
import { ProgramAbiModuleInitCallableRegistry } from "../src/codegen/program-abi-module-init-planning.js";
import { canonicalProgramAbiCallableTypeContract } from "../src/codegen/program-abi-signatures.js";
import { compile, compileMulti, type CompileResult } from "../src/index.js";
import { irSupportFuncRef, irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrSourceId, type IrUnitInventory } from "../src/ir/identity.js";
import type { ProgramAbiPlanEntry } from "../src/ir/program-abi.js";
import type { WasmExport } from "../src/ir/types.js";
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

function graphGlobalModuleInitEntries(
  entries: readonly ProgramAbiPlanEntry[],
  entrySourceId: IrSourceId,
): { readonly pass: ProgramAbiPlanEntry; readonly publicInit: ProgramAbiPlanEntry } {
  const refs = [0, 1].map((ordinal) =>
    irSupportFuncRef(entrySourceId, "legacy-module-init-pass", "__module_init", ordinal),
  );
  if (refs.some((ref) => ref.binding.kind !== "support")) throw new Error("expected module-init support references");
  const passIds = refs.map((ref) => (ref.binding.kind === "support" ? ref.binding.bindingId : ""));
  const physical = entries.filter((entry) => entry.id === passIds[0] || entry.id === passIds[1]);
  if (physical.length !== 1 || physical[0]!.id !== passIds[0]) {
    throw new Error(
      `expected exactly legacy module-init pass zero, found ${physical.map((entry) => entry.id).join(",")}`,
    );
  }
  const pass = physical[0]!;
  if (
    pass.slotPolicy !== "required" ||
    pass.slotSpace !== "function" ||
    pass.displayName !== "__module_init" ||
    pass.intent.kind !== "callable" ||
    pass.intent.origin !== "support" ||
    pass.intent.sourceId !== entrySourceId
  ) {
    throw new Error("legacy module-init pass zero has the wrong exact callable contract");
  }
  const exports = entries.filter(
    (entry) => entry.intent.kind === "export" && entry.intent.externalName === "__module_init",
  );
  if (
    exports.length !== 1 ||
    exports[0]!.slotPolicy !== "alias" ||
    exports[0]!.aliasOf !== pass.id ||
    exports[0]!.intent.kind !== "export" ||
    exports[0]!.intent.targetId !== pass.id
  ) {
    throw new Error("public __module_init is not the exact alias of graph-global pass zero");
  }
  return { pass, publicInit: exports[0]! };
}

const GRAPH_GLOBAL_FILES = {
  "leaf.ts": `
        export var leafRuns: number = 0;
        leafRuns += 1;
      `,
  "dependency.ts": `
        import { leafRuns } from "./leaf.ts";
        export var dependencyRuns: number = 0;
        dependencyRuns += leafRuns;
      `,
  "entry.ts": `
        import { dependencyRuns } from "./dependency.ts";
        var entryRuns: number = 0;
        entryRuns += 1;
        export function score(): number { return dependencyRuns * 10 + entryRuns; }
      `,
};

type GraphGlobalResult = ReturnType<typeof generateMultiModule>;
type ModuleInitObservation = { readonly ordinal: number; readonly funcIdx: number };

function hardErrors(result: { readonly errors: readonly { readonly severity?: string }[] }) {
  return result.errors.filter((error) => error.severity !== "warning");
}

/** The registry's private observation list — the exact production state under test. */
function moduleInitObservations(registry: ProgramAbiModuleInitCallableRegistry): ModuleInitObservation[] {
  return (registry as unknown as { observations: ModuleInitObservation[] }).observations;
}

/**
 * Point the public `__module_init` export at another ALREADY-OWNED callable.
 *
 * A descriptor aimed at an unowned function is rejected by export planning's
 * own "no Program ABI owner" guard, which would prove nothing here. Reusing
 * `score`'s target keeps export planning happy and leaves exactly one thing
 * wrong: the public alias no longer names graph-global pass zero.
 */
function retargetModuleInitExport(ctx: { readonly mod: { readonly exports: readonly WasmExport[] } }): void {
  const init = ctx.mod.exports.find((entry) => entry.name === "__module_init");
  const other = ctx.mod.exports.find((entry) => entry.name === "score");
  if (!init || !other || init.desc.kind !== "func" || other.desc.kind !== "func") {
    throw new Error("missing exact __module_init/score function exports");
  }
  init.desc.index = other.desc.index;
}

/**
 * One real multi-source compile, optionally mutating production planning state
 * at the exact seam each invariant guards.
 */
function generateGraphGlobal(
  mutateModuleInit?: (registry: ProgramAbiModuleInitCallableRegistry) => void,
  mutateBeforeExports?: (ctx: { readonly mod: { readonly exports: readonly WasmExport[] } }) => void,
): GraphGlobalResult {
  const ast = analyzeMultiSource(GRAPH_GLOBAL_FILES, "entry.ts");
  const originalPlan = ProgramAbiModuleInitCallableRegistry.prototype.planRetained;
  const originalExports = ProgramAbiExportRegistry.prototype.planRetained;
  const planSpy = vi.spyOn(ProgramAbiModuleInitCallableRegistry.prototype, "planRetained").mockImplementation(function (
    this: ProgramAbiModuleInitCallableRegistry,
  ) {
    mutateModuleInit?.(this);
    return originalPlan.call(this);
  });
  const exportSpy = vi.spyOn(ProgramAbiExportRegistry.prototype, "planRetained").mockImplementation(function (
    this: ProgramAbiExportRegistry,
  ) {
    mutateBeforeExports?.(this.ctx);
    return originalExports.call(this);
  });
  try {
    return generateMultiModule(ast, { experimentalIR: true, deferTopLevelInit: true });
  } finally {
    planSpy.mockRestore();
    exportSpy.mockRestore();
  }
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

  it("owns one graph-global initializer while retaining every source module-init identity", async () => {
    const files = {
      "leaf.ts": `
        export var leafRuns: number = 0;
        leafRuns += 1;
      `,
      "dependency.ts": `
        import { leafRuns } from "./leaf.ts";
        export var dependencyRuns: number = 0;
        dependencyRuns += leafRuns;
      `,
      "entry.ts": `
        import { dependencyRuns } from "./dependency.ts";
        var entryRuns: number = 0;
        entryRuns += 1;
        export function score(): number { return dependencyRuns * 10 + entryRuns; }
      `,
    };
    const reversedFiles = {
      "entry.ts": files["entry.ts"],
      "dependency.ts": files["dependency.ts"],
      "leaf.ts": files["leaf.ts"],
    };
    const ast = analyzeMultiSource(files, "entry.ts");
    const inventory = buildIrUnitInventory(ast.sourceFiles, {
      entrySource: ast.entryFile,
      checker: ast.checker,
    });
    const moduleInitUnits = inventory.terminalUnits.filter((unit) => unit.kind === "module-init");
    expect(moduleInitUnits).toHaveLength(3);
    expect(new Set(moduleInitUnits.map((unit) => unit.sourceId))).toEqual(
      new Set(inventory.sources.map((source) => source.id)),
    );
    expect(moduleInitUnits.every((unit) => unit.terminalOwnerId === unit.id)).toBe(true);
    const entrySourceId = inventory.sources.find((source) => source.kind === "entry")!.id;
    const generated = generateMultiModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);

    const entries = generated.programAbi!.abi.entries();
    const { pass, publicInit } = graphGlobalModuleInitEntries(entries, entrySourceId);
    expect(generated.programAbi!.abi.resolveFinalIndex(pass.id)).toEqual(
      expect.objectContaining({ space: "function" }),
    );
    expect(generated.programAbi!.abi.resolveFinalIndex(publicInit.id)).toEqual(
      generated.programAbi!.abi.resolveFinalIndex(pass.id),
    );

    const ordinalOne = irSupportFuncRef(entrySourceId, "legacy-module-init-pass", "__module_init", 1);
    if (ordinalOne.binding.kind !== "support") throw new Error("expected ordinal-one support mutation");
    const missing = entries.filter((entry) => entry.id !== pass.id);
    const duplicated = [...entries, pass];
    const withOrdinalOne = [
      ...entries,
      { ...pass, id: ordinalOne.binding.bindingId },
    ] as readonly ProgramAbiPlanEntry[];
    const wrongAlias = entries.map((entry) =>
      entry.id === publicInit.id && entry.slotPolicy === "alias" && entry.intent.kind === "export"
        ? {
            ...entry,
            aliasOf: ordinalOne.binding.bindingId,
            intent: { ...entry.intent, targetId: ordinalOne.binding.bindingId },
          }
        : entry,
    ) as readonly ProgramAbiPlanEntry[];
    for (const mutation of [missing, duplicated, withOrdinalOne, wrongAlias]) {
      expect(() => graphGlobalModuleInitEntries(mutation, entrySourceId)).toThrow();
    }

    const runtime = await compileMulti(files, "entry.ts", {
      experimentalIR: true,
      deferTopLevelInit: true,
    });
    const reversedRuntime = await compileMulti(reversedFiles, "entry.ts", {
      experimentalIR: true,
      deferTopLevelInit: true,
    });
    expect(reversedRuntime.success, reversedRuntime.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(reversedRuntime.binary).toEqual(runtime.binary);
    const exports = await instantiate(runtime);
    expect((exports.score as () => number)()).toBe(0);
    (exports.__module_init as () => void)();
    expect((exports.score as () => number)()).toBe(11);
    const reversedExports = await instantiate(reversedRuntime);
    expect((reversedExports.score as () => number)()).toBe(0);
    (reversedExports.__module_init as () => void)();
    expect((reversedExports.score as () => number)()).toBe(11);
  });

  it("accepts the start-section and WASI invocation policies, which publish no __module_init", async () => {
    // Regression guard for the graph-global invariant. Keying it on the public
    // export SURFACE rather than the invocation POLICY rejected every
    // `--target wasi` build with "expects exactly one public __module_init
    // export, found 0" — caught by examples/native-messaging/smoke-test.sh.
    // `declarations.ts` publishes the export only under
    // `deferTopLevelInit && !wasi`; the Wasm `start` section and WASI's `_start`
    // adapter reach the same body without publishing any name, so zero public
    // `__module_init` exports is the CORRECT shape for both.
    // Must be MULTI-source: a single source has one module-init unit, which the
    // exact-unit path claims, so the graph-global branch is never entered and a
    // single-source WASI compile cannot reproduce this at all.
    const policies = [
      { name: "wasm start section", options: {} as Record<string, unknown> },
      { name: "wasi _start adapter", options: { target: "wasi" } as Record<string, unknown> },
    ];
    for (const policy of policies) {
      const result = await compileMulti(GRAPH_GLOBAL_FILES, "entry.ts", {
        experimentalIR: true,
        ...policy.options,
      });
      expect(result.success, `${policy.name}: ${result.errors.map((error) => error.message).join("\n")}`).toBe(true);
      const module = await WebAssembly.compile(result.binary);
      expect(
        WebAssembly.Module.exports(module).filter((entry) => entry.name === "__module_init"),
        `${policy.name} publishes no __module_init`,
      ).toEqual([]);
    }

    // The deferred-export policy is the one that DOES publish it — proving the
    // two shapes above are a real distinction and not a blanket exemption.
    const deferred = await compileMulti(GRAPH_GLOBAL_FILES, "entry.ts", {
      experimentalIR: true,
      deferTopLevelInit: true,
    });
    expect(deferred.success, deferred.errors.map((error) => error.message).join("\n")).toBe(true);
    const deferredModule = await WebAssembly.compile(deferred.binary);
    expect(WebAssembly.Module.exports(deferredModule).filter((entry) => entry.name === "__module_init")).toHaveLength(
      1,
    );
  });

  it("fails closed on zero, duplicate, ordinal-one, and retargeted graph-global module-init", () => {
    // These mutate PRODUCTION planning state during a real multi-source
    // compile, not a copy of the published entry list: each one is a shape the
    // graph-global invariant must reject before publication.
    const unmutated = generateGraphGlobal();
    expect(hardErrors(unmutated), unmutated.errors.map((error) => error.message).join("\n")).toEqual([]);

    const cases: readonly {
      readonly name: string;
      readonly expected: RegExp;
      readonly run: () => GraphGlobalResult;
    }[] = [
      {
        name: "zero observations",
        expected: /exactly one live pass at ordinal 0, found 0 raw and 0 live/,
        run: () =>
          generateGraphGlobal((registry) => {
            moduleInitObservations(registry).length = 0;
          }),
      },
      {
        name: "two observations",
        expected: /exactly one live pass at ordinal 0, found 2 raw and 2 live/,
        run: () =>
          generateGraphGlobal((registry) => {
            const observations = moduleInitObservations(registry);
            const first = observations[0];
            if (!first) throw new Error("missing graph-global module-init observation");
            observations.push(Object.freeze({ ...first, ordinal: 1 }));
          }),
      },
      {
        name: "ordinal one",
        expected: /exactly one live pass at ordinal 0, found 1 raw and 1 live at ordinals \[1\]/,
        run: () =>
          generateGraphGlobal((registry) => {
            const observations = moduleInitObservations(registry);
            const first = observations[0];
            if (!first) throw new Error("missing graph-global module-init observation");
            observations[0] = Object.freeze({ ...first, ordinal: 1 });
          }),
      },
      {
        name: "retargeted export",
        expected: /public __module_init is not the exact alias of graph-global pass zero/,
        run: () => generateGraphGlobal(undefined, retargetModuleInitExport),
      },
    ];

    for (const testCase of cases) {
      const result = testCase.run();
      const messages = hardErrors(result).map((error) => error.message);
      expect(messages.join("\n"), testCase.name).toMatch(testCase.expected);
    }
  });
});
