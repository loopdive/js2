// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";

import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { generateModule, generateMultiModule } from "../src/codegen/index.js";
import { ProgramAbiExportRegistry } from "../src/codegen/program-abi-export-planning.js";
import { ProgramAbiModuleInitCallableRegistry } from "../src/codegen/program-abi-module-init-planning.js";
import { canonicalProgramAbiCallableTypeContract } from "../src/codegen/program-abi-signatures.js";
import { definedFuncAt, replaceDefinedFuncAt } from "../src/codegen/func-space.js";
import type { CodegenContext, CodegenOptions } from "../src/codegen/context/types.js";
import { compile, compileMulti, type CompileResult } from "../src/index.js";
import { irSupportFuncRef, irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrSourceId, type IrUnitInventory } from "../src/ir/identity.js";
import type { ProgramAbiPlanEntry } from "../src/ir/program-abi.js";
import type { WasmExport, WasmFunction } from "../src/ir/types.js";
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

const GRAPH_GLOBAL_USER_INIT_FILES = {
  ...GRAPH_GLOBAL_FILES,
  "entry.ts": `${GRAPH_GLOBAL_FILES["entry.ts"]}
        export function __module_init(): number { return 77; }
      `,
};

type GraphGlobalResult = ReturnType<typeof generateMultiModule>;
type ModuleInitObservation = { readonly ordinal: number; readonly funcIdx: number; readonly func: WasmFunction };
type GraphGlobalPolicy = "deferred-export" | "wasm-start" | "wasi-start-export";

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

function retargetObservedModuleInit(registry: ProgramAbiModuleInitCallableRegistry): void {
  const observations = moduleInitObservations(registry);
  const first = observations[0];
  if (!first) throw new Error("missing graph-global module-init observation");
  replaceDefinedFuncAt(registry.ctx, first.funcIdx, { ...first.func, body: [...first.func.body] });
}

function injectCompilerModuleInitAlias(ctx: CodegenContext): void {
  const passHandle = ctx.programAbiModuleInitCallables?.firstHandle();
  if (passHandle === undefined) throw new Error("missing exact graph-global pass handle");
  ctx.mod.exports.push({ name: "__module_init", desc: { kind: "func", index: passHandle } });
}

function graphGlobalOptions(policy: GraphGlobalPolicy): Pick<CodegenOptions, "deferTopLevelInit" | "wasi"> {
  switch (policy) {
    case "deferred-export":
      return { deferTopLevelInit: true };
    case "wasm-start":
      return {};
    case "wasi-start-export":
      return { wasi: true };
  }
}

function retargetWasiStartExport(ctx: CodegenContext): void {
  const start = ctx.mod.exports.find((entry) => entry.name === "_start");
  const other = ctx.mod.exports.find((entry) => entry.name === "score");
  if (!start || !other || start.desc.kind !== "func" || other.desc.kind !== "func") {
    throw new Error("missing exact _start/score function exports");
  }
  const adapter = definedFuncAt(ctx, start.desc.index);
  const target = definedFuncAt(ctx, other.desc.index);
  if (!adapter || !target) throw new Error("missing exact _start/score allocator functions");
  // Mutate the actual adapter's first call rather than only changing an
  // export label. This exercises the recorded target-object/call-path seam.
  const first = adapter.body.find((instruction) => instruction.op === "call");
  if (!first || first.op !== "call") throw new Error("missing _start direct call");
  first.funcIdx = other.desc.index;
}

/**
 * One real multi-source compile, optionally mutating production planning state
 * at the exact seam each invariant guards.
 */
function generateGraphGlobal(
  policy: GraphGlobalPolicy = "deferred-export",
  mutateModuleInit?: (registry: ProgramAbiModuleInitCallableRegistry) => void,
  mutateAfterExports?: (ctx: CodegenContext) => void,
  files: typeof GRAPH_GLOBAL_FILES = GRAPH_GLOBAL_FILES,
): GraphGlobalResult {
  const ast = analyzeMultiSource(files, "entry.ts");
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
    const result = originalExports.call(this);
    // Apply policy mutations after the generic export registry has sealed its
    // denominator. This keeps duplicate/missing/retargeted cases from passing
    // vacuously through an earlier duplicate-name or unowned-target guard;
    // assertGraphGlobalInvocationPolicy must diagnose the corrupted wiring.
    mutateAfterExports?.(this.ctx);
    return result;
  });
  try {
    return generateMultiModule(ast, { experimentalIR: true, ...graphGlobalOptions(policy) });
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
          generateGraphGlobal("deferred-export", (registry) => {
            moduleInitObservations(registry).length = 0;
          }),
      },
      {
        name: "two observations",
        expected: /exactly one live pass at ordinal 0, found 2 raw and 2 live/,
        run: () =>
          generateGraphGlobal("deferred-export", (registry) => {
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
          generateGraphGlobal("deferred-export", (registry) => {
            const observations = moduleInitObservations(registry);
            const first = observations[0];
            if (!first) throw new Error("missing graph-global module-init observation");
            observations[0] = Object.freeze({ ...first, ordinal: 1 });
          }),
      },
      {
        name: "retargeted export",
        expected: /public __module_init is not the exact alias of graph-global pass zero/,
        run: () => generateGraphGlobal("deferred-export", undefined, retargetModuleInitExport),
      },
      {
        name: "retargeted observed allocator object",
        expected: /observation 0 handle .* was retargeted away from its exact observed allocator object/,
        run: () => generateGraphGlobal("deferred-export", retargetObservedModuleInit),
      },
    ];

    for (const testCase of cases) {
      const result = testCase.run();
      const messages = hardErrors(result).map((error) => error.message);
      expect(messages.join("\n"), testCase.name).toMatch(testCase.expected);
    }
  });

  it("authenticates graph-global startup wiring under every invocation policy", () => {
    const policies: readonly GraphGlobalPolicy[] = ["deferred-export", "wasm-start", "wasi-start-export"];
    const missingObservation = /exactly one live pass at ordinal 0, found 0 raw and 0 live at ordinals \[\]/;

    for (const policy of policies) {
      const positive = generateGraphGlobal(policy);
      expect(hardErrors(positive), `${policy} positive control`).toEqual([]);

      // The need for a graph-global pass is grounded in the independent
      // emitted-body fact, not this observation list: clearing observations
      // must fail identically under deferred, Wasm-start, and WASI policies.
      const cleared = generateGraphGlobal(policy, (registry) => {
        moduleInitObservations(registry).length = 0;
      });
      expect(
        hardErrors(cleared)
          .map((error) => error.message)
          .join("\n"),
        `${policy} cleared observation`,
      ).toMatch(missingObservation);
    }

    const noInitAst = analyzeMultiSource(
      {
        "leaf.ts": `export function leaf(): number { return 1; }`,
        "entry.ts": `import { leaf } from "./leaf.ts"; export function score(): number { return leaf(); }`,
      },
      "entry.ts",
    );
    const noInit = generateMultiModule(noInitAst, { experimentalIR: true });
    expect(hardErrors(noInit), "multi-source no-init positive control").toEqual([]);

    // A user function may legitimately use the compatibility spelling
    // `__module_init`; only the compiler's graph-global pass alias is
    // forbidden under the start and WASI policies. These are real source-owned
    // exports, so the policy check must authenticate and preserve their
    // Program-ABI export drafts rather than reject by name.
    for (const policy of ["wasm-start", "wasi-start-export"] as const) {
      const userInit = generateGraphGlobal(policy, undefined, undefined, GRAPH_GLOBAL_USER_INIT_FILES);
      expect(hardErrors(userInit), `${policy} legitimate source __module_init`).toEqual([]);
    }

    const deferredMissingAlias = generateGraphGlobal("deferred-export", undefined, (ctx) => {
      ctx.mod.exports = ctx.mod.exports.filter((entry) => entry.name !== "__module_init");
    });
    expect(
      hardErrors(deferredMissingAlias)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/expects exactly one public __module_init export, found 0/);
    const deferredRetargetedAlias = generateGraphGlobal("deferred-export", undefined, retargetModuleInitExport);
    expect(
      hardErrors(deferredRetargetedAlias)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/public __module_init is not the exact alias of graph-global pass zero/);
    const deferredDuplicateAlias = generateGraphGlobal("deferred-export", undefined, (ctx) => {
      const init = ctx.mod.exports.find((entry) => entry.name === "__module_init");
      if (!init) throw new Error("missing exact __module_init export");
      ctx.mod.exports.push({ name: init.name, desc: { ...init.desc } });
    });
    expect(
      hardErrors(deferredDuplicateAlias)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/expects exactly one public __module_init export, found 2/);

    const startMissingAdapter = generateGraphGlobal("wasm-start", undefined, (ctx) => {
      ctx.mod.startFuncIdx = undefined;
    });
    expect(
      hardErrors(startMissingAdapter)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/Wasm-start graph-global module-init must target pass zero/);
    const startRetargetedAdapter = generateGraphGlobal("wasm-start", undefined, (ctx) => {
      const score = ctx.mod.exports.find((entry) => entry.name === "score");
      if (!score || score.desc.kind !== "func") throw new Error("missing exact score export");
      ctx.mod.startFuncIdx = score.desc.index;
    });
    expect(
      hardErrors(startRetargetedAdapter)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/Wasm-start graph-global module-init must target pass zero/);
    const startInjectedAlias = generateGraphGlobal("wasm-start", undefined, (ctx) => {
      injectCompilerModuleInitAlias(ctx);
    });
    expect(
      hardErrors(startInjectedAlias)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/must not publish a compiler __module_init alias/);

    const wasiMissingAdapter = generateGraphGlobal("wasi-start-export", undefined, (ctx) => {
      ctx.mod.exports = ctx.mod.exports.filter((entry) => entry.name !== "_start");
    });
    expect(
      hardErrors(wasiMissingAdapter)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/expects exactly one observed _start adapter, found 0/);
    const wasiRetargetedAdapter = generateGraphGlobal("wasi-start-export", undefined, retargetWasiStartExport);
    expect(
      hardErrors(wasiRetargetedAdapter)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/_start adapter does not retain its exact selected entry call path/);
    const wasiDuplicateAdapter = generateGraphGlobal("wasi-start-export", undefined, (ctx) => {
      const start = ctx.mod.exports.find((entry) => entry.name === "_start");
      if (!start) throw new Error("missing exact _start export");
      ctx.mod.exports.push({ name: start.name, desc: { ...start.desc } });
    });
    expect(
      hardErrors(wasiDuplicateAdapter)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/expects exactly one observed _start adapter, found 2/);
    const wasiInjectedAlias = generateGraphGlobal("wasi-start-export", undefined, (ctx) => {
      injectCompilerModuleInitAlias(ctx);
    });
    expect(
      hardErrors(wasiInjectedAlias)
        .map((error) => error.message)
        .join("\n"),
    ).toMatch(/must not publish a compiler __module_init alias/);
  });
});
