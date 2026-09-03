// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { SINGLE_HOST_ENTRIES } from "../scripts/check-ir-only.js";
import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { stripHostBridgeExports } from "../src/codegen/host-bridge-exports.js";
import { generateModule } from "../src/codegen/index.js";
import {
  finalizeCtorClosureHostBridgeExports,
  isCompilerOwnedCtorClosureHostBridgeExport,
  isCoreCtorClosureHostBridgePublicName,
} from "../src/codegen/closure-exports.js";
import {
  planProgramAbiEntrySourceSupportCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
  resolveProgramAbiSupportCallableHandle,
} from "../src/codegen/program-abi-planning.js";
import { ProgramAbiCallableRegistry } from "../src/codegen/program-abi-callable-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { emitBinary } from "../src/emit/binary.js";
import { STABLE_FUNC_BASE } from "../src/emit/resolve-layout.js";
import { buildIrUnitInventory, createIrBindingId } from "../src/ir/identity.js";
import { nonExecutableOutcomeDefect } from "../src/ir/outcomes.js";
import {
  createEmptyModule,
  type FuncTypeDef,
  type Import,
  type WasmExport,
  type WasmFunction,
} from "../src/ir/types.js";
import { compile } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

// Register the expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const CLOSURE_HOST_BRIDGE_ROLE = "closure-host-bridge";

const REQUIRED_BRIDGES = Object.freeze([
  { name: "__call_fn_0", ordinal: 0 },
  { name: "__call_fn_1", ordinal: 1 },
  { name: "__call_fn_2", ordinal: 2 },
  { name: "__call_fn_3", ordinal: 3 },
  { name: "__call_fn_4", ordinal: 4 },
  { name: "__call_fn_method_0", ordinal: 5 },
  { name: "__call_fn_method_1", ordinal: 6 },
  { name: "__call_fn_method_2", ordinal: 7 },
  { name: "__call_fn_method_3", ordinal: 8 },
  { name: "__call_fn_method_4", ordinal: 9 },
  { name: "__call_fn_method_5", ordinal: 10 },
  { name: "__closure_arity", ordinal: 11 },
  { name: "__is_closure", ordinal: 12 },
] as const);

const CLOSURE_BRIDGES = Object.freeze([
  ...REQUIRED_BRIDGES,
  { name: "__closure_has_rest", ordinal: 13 },
  { name: "__is_ctor_closure", ordinal: 14 },
] as const);

const CLOSURE_PHYSICAL_BASES = [
  "$c0",
  "$c1",
  "$c2",
  "$c3",
  "$c4",
  "$c5",
  "$c6",
  "$c7",
  "$c8",
  "$c9",
  "$ca",
  "$cb",
  "$cc",
  "$cd",
  "$ce",
  "$cf",
  "$cg",
  "$ch",
] as const;

const CONSTRUCTIBLE_CLOSURE_SOURCE = `
  const ctor = function (value: number): number { return value + 1; };
  export function getCtor(): any { return ctor; }
  export function invokeCtor(): number { return ctor(41); }
`;

const CLOSURE_COLLISION_SOURCE = `
  export function __is_ctor_closure(): number { return 901; }
  export function $ch(): number { return 902; }
  export function $ch$$(): number { return 903; }
  const ctor = function (value: number): number { return value + 1; };
  export function getCtor(): any { return ctor; }
  export function invokeCtor(): number { return ctor(41); }
`;

const CLOSURE_CROSS_NAMESPACE_COLLISION_SOURCE = `
  export function $v0(): number { return 911; }
  const ctor = function (value: number): number { return value + 1; };
  export function getCtor(): any { return ctor; }
  export function invokeCtor(): number { return ctor(41); }
`;

const CLOSURE_FREE_SPOOF_SOURCE = `
  export function __is_ctor_closure(): number { return 801; }
  export function $ch(): number { return 802; }
  export function $ch$$(): number { return 803; }
  export function $ch0(): number { return 804; }
  export function $ch_extra(): number { return 805; }
  export function __is_ctor_closure_extra(): number { return 806; }
  export function add(): number { return 42; }
`;

const CLOSURE_STANDALONE_HELPER_EXPORTS = [
  "__\0js2_call_fn_method_argc_1",
  "__\0js2_call_fn_method_argc_2",
  "__\0js2_call_fn_method_argc_3",
  "__\0js2_call_fn_method_argc_4",
  "__\0js2_call_fn_method_argc_5",
  "__any_box_null",
  "__any_box_undefined",
  "__box_bigint",
  "__box_boolean",
  "__box_number",
  "__dynamic_boundary_tag",
  "__exn_tag",
  "__to_bigint",
  "__typeof_bigint",
  "__typeof_boolean",
  "__typeof_number",
  "__unbox_boolean",
  "__unbox_number",
] as const;

const ZERO_ARITY_SOURCE = `
  declare function hostTick(value: number): number;
  const zero = function (): number { return 17; };
  export function getZero(): any { return zero; }
  export function invoke(): number { return hostTick(zero()); }
`;

const COLLIDING_CLOSURE_SOURCE = `
  export function __call_fn_1(_closure: any, _value: any): number { return 701; }
  export function $c1(): number { return 702; }
  export function $cf(): number { return 703; }
  const addTwo = function (value: number): number { return value + 2; };
  export function getAddTwo(): any { return addTwo; }
`;

function trackedModule(source = ZERO_ARITY_SOURCE) {
  const ast = analyzeSource(source, "issue-3520-closure-host-bridge.ts");
  return generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
}

function entrySourceRecord(source = ZERO_ARITY_SOURCE) {
  const ast = analyzeSource(source, "issue-3520-closure-host-bridge.ts");
  return buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  }).sources.find((candidate) => candidate.kind === "entry")!;
}

function hardErrors(result: ReturnType<typeof generateModule>) {
  return result.errors.filter((error) => error.severity !== "warning");
}

function generateWithCapturedRegistry(
  source: string,
  fileName: string,
): {
  readonly registry: ProgramAbiCallableRegistry;
  readonly result: ReturnType<typeof generateModule>;
} {
  let registry: ProgramAbiCallableRegistry | undefined;
  const originalObserve = ProgramAbiCallableRegistry.prototype.observeEntrySourceSupports;
  const observe = vi
    .spyOn(ProgramAbiCallableRegistry.prototype, "observeEntrySourceSupports")
    .mockImplementation(function (observations) {
      registry = this;
      return originalObserve.call(this, observations);
    });
  let result: ReturnType<typeof generateModule>;
  try {
    // Keep a real vec support observation in this focused harness so the
    // generated context is available for direct provenance mutation checks.
    // The probe is unrelated to the constructor helper under test.
    const sourceWithRegistryProbe = `${source}
      export function __c38_registry_probe(): number {
        const values: any = [1];
        values.push(2);
        values.pop();
        return values[0];
      }
    `;
    const ast = analyzeSource(sourceWithRegistryProbe, fileName);
    result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
  } finally {
    observe.mockRestore();
  }
  if (!registry) throw new Error(`missing closure Program ABI session for ${fileName}`);
  return { registry, result: result! };
}

async function instantiate(sourceOrResult: string | Awaited<ReturnType<typeof compile>>): Promise<{
  readonly exports: Record<string, unknown>;
  readonly result: Awaited<ReturnType<typeof compile>>;
}> {
  const result =
    typeof sourceOrResult === "string"
      ? await compile(sourceOrResult, {
          fileName: "issue-3520-closure-host-runtime.ts",
          experimentalIR: true,
          trackIrOutcomes: true,
        })
      : sourceOrResult;
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown> & {
    env?: Record<string, unknown>;
    setInstance?: (value: WebAssembly.Instance) => void;
  };
  imports.env = imports.env ?? {};
  imports.env.hostTick = (value: number) => value;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return { exports: instance.exports as Record<string, unknown>, result };
}

describe("#3520 C31 closure host bridge Program ABI ownership", () => {
  it("classifies only exact constructor-closure logical and physical names", () => {
    expect(isCoreCtorClosureHostBridgePublicName("__is_ctor_closure")).toBe(true);
    expect(["$ch", "$ch$", "$ch$$", "$ch$$$$"].every(isCoreCtorClosureHostBridgePublicName)).toBe(true);
    expect(
      ["$ch0", "$chi", "$ch_extra", "__is_ctor_closure_extra", "__is_ctor_closure$"].some(
        isCoreCtorClosureHostBridgePublicName,
      ),
    ).toBe(false);
  });

  it("publishes the bit-17 classifier under ordinal 14 and binds its exact allocator", async () => {
    const result = trackedModule(CONSTRUCTIBLE_CLOSURE_SOURCE);
    expect(
      hardErrors(result),
      hardErrors(result)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    const entrySource = entrySourceRecord(CONSTRUCTIBLE_CLOSURE_SOURCE);
    const expectedId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: CLOSURE_HOST_BRIDGE_ROLE,
      ordinal: 14,
    });
    expect(result.programAbi!.abi.get(expectedId)).toMatchObject({
      id: expectedId,
      displayName: "__is_ctor_closure",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "support",
        sourceId: entrySource.id,
      },
    });

    const exportsByName = new Map(result.module.exports.map((entry) => [entry.name, entry]));
    const logical = exportsByName.get("__is_ctor_closure");
    const physical = exportsByName.get("$ch");
    expect(logical?.desc).toEqual(physical?.desc);
    if (!logical || logical.desc.kind !== "func") throw new Error("missing logical constructor classifier");
    const importCount = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
    expect(result.module.functions[logical.desc.index - importCount]?.name).toBe("__is_ctor_closure");
    const finalSlot = result.programAbi!.abi.resolveFinalIndex(expectedId);
    expect(finalSlot).toEqual({ space: "function", index: logical.desc.index });

    for (const [label, options] of [
      ["default", {}],
      ["always", { hostBridge: "always" as const }],
    ] as const) {
      const compiled = await compile(CONSTRUCTIBLE_CLOSURE_SOURCE, {
        fileName: `issue-3520-closure-ctor-${label}.ts`,
        experimentalIR: true,
        ...options,
      });
      const { exports: rawExports } = await instantiate(compiled);
      expect(rawExports.__is_ctor_closure, label).toBe(rawExports.$ch);
      expect(rawExports.__is_ctor_closure, label).toEqual(expect.any(Function));
      const manifest = rawExports.$cm;
      expect(manifest).toBeInstanceOf(WebAssembly.Global);
      expect((manifest as WebAssembly.Global).value & (1 << 17), label).not.toBe(0);
      const ctor = (rawExports.getCtor as () => unknown)();
      expect((rawExports.__is_ctor_closure as (value: unknown) => number)(ctor), label).toBe(1);
      expect((rawExports.invokeCtor as () => number)(), label).toBe(42);
    }
  });

  it("strips compiler constructor-closure exports in standalone and WASI with exact parity", async () => {
    const expectedNames = [...CLOSURE_STANDALONE_HELPER_EXPORTS, "getCtor", "invokeCtor"];
    for (const target of ["standalone", "wasi"] as const) {
      const options = {
        fileName: `issue-3520-closure-ctor-${target}.ts`,
        experimentalIR: true,
        target,
      } as const;
      const untracked = await compile(CONSTRUCTIBLE_CLOSURE_SOURCE, options);
      const tracked = await compile(CONSTRUCTIBLE_CLOSURE_SOURCE, { ...options, trackIrOutcomes: true });
      expect(untracked.success, `${target} untracked`).toBe(true);
      expect(tracked.success, `${target} tracked`).toBe(true);
      expect(untracked.imports, `${target} untracked imports`).toEqual([]);
      expect(tracked.imports, `${target} tracked imports`).toEqual([]);
      expect(tracked.binary, `${target} tracked/untracked bytes`).toEqual(untracked.binary);

      const targetExpectedNames = [...expectedNames, ...(target === "wasi" ? ["_start", "memory"] : [])].sort();
      for (const [label, result] of [
        ["untracked", untracked],
        ["tracked", tracked],
      ] as const) {
        const { exports: rawExports } = await instantiate(result);
        expect(Object.keys(rawExports).sort(), `${target} ${label} public names`).toEqual(targetExpectedNames);
        expect(
          Object.keys(rawExports).filter((name) => name.startsWith("$ch")),
          `${target} ${label} constructor physical names`,
        ).toEqual([]);
        expect(rawExports.__is_ctor_closure, `${target} ${label} logical classifier`).toBeUndefined();
        expect((rawExports.invokeCtor as () => number)(), `${target} ${label} runtime value`).toBe(42);
      }
    }
  });

  it("preserves exact constructor-closure collisions while publishing only free host aliases", async () => {
    const userValues = [
      ["__is_ctor_closure", 901],
      ["$ch", 902],
      ["$ch$$", 903],
    ] as const;
    const expectedNames = [
      ...CLOSURE_STANDALONE_HELPER_EXPORTS,
      ...userValues.map(([name]) => name),
      "getCtor",
      "invokeCtor",
    ];
    for (const target of ["standalone", "wasi"] as const) {
      const options = {
        fileName: `issue-3520-closure-collisions-${target}.ts`,
        experimentalIR: true,
        target,
      } as const;
      const untracked = await compile(CLOSURE_COLLISION_SOURCE, options);
      const tracked = await compile(CLOSURE_COLLISION_SOURCE, { ...options, trackIrOutcomes: true });
      expect(untracked.success, `${target} untracked`).toBe(true);
      expect(tracked.success, `${target} tracked`).toBe(true);
      expect(untracked.imports, `${target} untracked imports`).toEqual([]);
      expect(tracked.imports, `${target} tracked imports`).toEqual([]);
      expect(tracked.binary, `${target} tracked/untracked bytes`).toEqual(untracked.binary);
      const targetExpectedNames = [...expectedNames, ...(target === "wasi" ? ["_start", "memory"] : [])].sort();
      for (const [label, result] of [
        ["untracked", untracked],
        ["tracked", tracked],
      ] as const) {
        const { exports: rawExports } = await instantiate(result);
        expect(Object.keys(rawExports).sort(), `${target} ${label} public names`).toEqual(targetExpectedNames);
        expect(
          Object.keys(rawExports).filter((name) => name.startsWith("$ch")),
          `${target} ${label} physical names`,
        ).toEqual(["$ch", "$ch$$"]);
        for (const [name, value] of userValues) {
          expect(rawExports[name], `${target} ${label} ${name}`).toEqual(expect.any(Function));
          expect((rawExports[name] as () => number)(), `${target} ${label} ${name}`).toBe(value);
        }
        expect(rawExports["$ch$"], `${target} ${label} generated gap`).toBeUndefined();
        expect(rawExports["$ch$$$"], `${target} ${label} generated terminal`).toBeUndefined();
        expect((rawExports.invokeCtor as () => number)(), `${target} ${label} runtime value`).toBe(42);
      }
    }

    for (const [label, options] of [
      ["default", {}],
      ["always", { hostBridge: "always" as const }],
    ] as const) {
      const compiled = await compile(CLOSURE_COLLISION_SOURCE, {
        fileName: `issue-3520-closure-collisions-${label}.ts`,
        experimentalIR: true,
        ...options,
      });
      const { exports: rawExports } = await instantiate(compiled);
      expect(
        Object.keys(rawExports)
          .filter((name) => name.startsWith("$ch"))
          .sort(),
        label,
      ).toEqual(["$ch", "$ch$", "$ch$$", "$ch$$$"]);
      expect(rawExports["$ch$"], label).toBe(rawExports["$ch$$$"]);
      expect(rawExports["$ch$"], label).not.toBe(rawExports.$ch);
      expect(rawExports["$ch$"], label).not.toBe(rawExports["$ch$$"]);
      for (const [name, value] of userValues) {
        expect((rawExports[name] as () => number)(), `${label} ${name}`).toBe(value);
      }
    }
  });

  it("keeps exact constructor-closure spoof names public without creating a classifier", async () => {
    const spoofValues = [
      ["__is_ctor_closure", 801],
      ["$ch", 802],
      ["$ch$$", 803],
      ["$ch0", 804],
      ["$ch_extra", 805],
      ["__is_ctor_closure_extra", 806],
    ] as const;
    const generated = trackedModule(CLOSURE_FREE_SPOOF_SOURCE);
    expect(
      generated
        .programAbi!.abi.entries()
        .filter(
          (entry) =>
            entry.displayName === "__is_ctor_closure" &&
            entry.slotPolicy === "required" &&
            entry.intent.kind === "callable" &&
            entry.intent.origin === "support",
        ),
    ).toEqual([]);
    for (const target of ["standalone", "wasi"] as const) {
      const options = {
        fileName: `issue-3520-closure-spoof-${target}.ts`,
        experimentalIR: true,
        target,
      } as const;
      const untracked = await compile(CLOSURE_FREE_SPOOF_SOURCE, options);
      const tracked = await compile(CLOSURE_FREE_SPOOF_SOURCE, { ...options, trackIrOutcomes: true });
      expect(untracked.success, `${target} untracked`).toBe(true);
      expect(tracked.success, `${target} tracked`).toBe(true);
      expect(untracked.imports, `${target} imports`).toEqual([]);
      expect(tracked.imports, `${target} tracked imports`).toEqual([]);
      expect(tracked.binary, `${target} tracked/untracked bytes`).toEqual(untracked.binary);
      const expectedNames = [
        ...spoofValues.map(([name]) => name),
        "add",
        ...(target === "wasi" ? ["memory"] : []),
      ].sort();
      const { exports: rawExports } = await instantiate(tracked);
      expect(Object.keys(rawExports).sort(), `${target} public names`).toEqual(expectedNames);
      for (const [name, value] of spoofValues) {
        expect((rawExports[name] as () => number)(), `${target} ${name}`).toBe(value);
      }
      expect(Object.keys(rawExports).filter((name) => name.startsWith("$ch"))).toEqual([
        "$ch",
        "$ch$$",
        "$ch0",
        "$ch_extra",
      ]);
    }
  });
  it("plans fixed entry-source IDs and publishes each exact final helper slot", () => {
    const result = trackedModule();
    expect(
      hardErrors(result),
      hardErrors(result)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const entrySource = entrySourceRecord();
    const imports = result.module.imports.filter((entry) => entry.desc.kind === "func");
    expect(imports.length).toBeGreaterThan(0);
    const exportsByName = new Map(result.module.exports.map((entry) => [entry.name, entry]));
    const abiEntries = result.programAbi!.abi.entries();
    const closureEntries = abiEntries.filter(
      (entry) =>
        entry.intent.kind === "callable" &&
        entry.intent.origin === "support" &&
        entry.intent.sourceId === entrySource!.id &&
        REQUIRED_BRIDGES.some((bridge) => bridge.name === entry.displayName),
    );

    expect(closureEntries).toHaveLength(REQUIRED_BRIDGES.length);
    for (const bridge of REQUIRED_BRIDGES) {
      const expectedId = createIrBindingId({
        ownerId: entrySource!.id,
        domain: "support",
        role: CLOSURE_HOST_BRIDGE_ROLE,
        ordinal: bridge.ordinal,
      });
      const entry = closureEntries.find((candidate) => candidate.id === expectedId);
      expect(entry).toMatchObject({
        id: expectedId,
        displayName: bridge.name,
        intent: {
          kind: "callable",
          origin: "support",
          sourceId: entrySource!.id,
        },
      });
      const finalSlot = result.programAbi!.abi.resolveFinalIndex(expectedId);
      expect(finalSlot).toEqual({ space: "function", index: exportsByName.get(bridge.name)?.desc.index });
      if (!finalSlot || finalSlot.space !== "function") throw new Error(`missing ${bridge.name} final slot`);
      const exactFinalObject = result.module.functions[finalSlot.index - imports.length];
      expect(exactFinalObject).toBeDefined();
      expect(exactFinalObject?.name).toBe(bridge.name);
    }

    const allHelperEntries = abiEntries.filter(
      (entry) =>
        entry.intent.kind === "callable" && REQUIRED_BRIDGES.some((bridge) => bridge.name === entry.displayName),
    );
    expect(allHelperEntries.map((entry) => entry.id).sort()).toEqual(closureEntries.map((entry) => entry.id).sort());
  });

  it("re-resolves one exact allocator after a late import and dead-slot compaction", () => {
    const sourceFile = ts.createSourceFile(
      "/repo/entry.ts",
      "export function entry(): number { return 1; }",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
    const entrySource = inventory.sources.find((source) => source.kind === "entry")!;
    const module = createEmptyModule();
    const signature: FuncTypeDef = { kind: "func", params: [{ kind: "externref" }], results: [{ kind: "i32" }] };
    module.types.push(signature);
    const helper: WasmFunction = {
      name: "__is_closure",
      typeIdx: 0,
      locals: [],
      body: [{ op: "i32.const", value: 0 }],
      exported: true,
    };
    const dead: WasmFunction = { name: "dead", typeIdx: 0, locals: [], body: [{ op: "i32.const", value: 0 }] };
    module.functions.push(helper, dead);
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const ref = planProgramAbiEntrySourceSupportCallable(ctx, {
      role: CLOSURE_HOST_BRIDGE_ROLE,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.closureHostBridge,
      derivedOrdinal: 12,
      displayName: helper.name,
      func: helper,
    });
    expect(ref?.binding).toEqual({
      kind: "support",
      bindingId: createIrBindingId({
        ownerId: entrySource.id,
        domain: "support",
        role: CLOSURE_HOST_BRIDGE_ROLE,
        ordinal: 12,
      }),
    });
    expect(session.getDraft(ref!.binding.bindingId)?.structuralOrder).toMatchObject({
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.closureHostBridge,
      derivedOrdinal: 12,
    });
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper)).toBe(0);

    const lateImport: Import = { module: "env", name: "late", desc: { kind: "func", typeIdx: 0 } };
    module.imports.push(lateImport);
    module.functions.splice(module.functions.indexOf(dead), 1);
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper)).toBe(1);

    const publication = session.publish(module);
    expect(publication.abi.resolveFinalIndex(ref!.binding.bindingId)).toEqual({ space: "function", index: 1 });
    expect(module.functions[0]).toBe(helper);
  });

  it("emits no closure bridge rows or exports for a closure-free module", () => {
    const result = trackedModule(`export function add(a: number, b: number): number { return a + b; }`);
    expect(
      hardErrors(result),
      hardErrors(result)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    expect(
      result
        .programAbi!.abi.entries()
        .filter((entry) => REQUIRED_BRIDGES.some((bridge) => bridge.name === entry.displayName)),
    ).toEqual([]);
    const exportNames = result.module.exports.map((entry) => entry.name);
    for (const bridge of REQUIRED_BRIDGES) expect(exportNames).not.toContain(bridge.name);
  });

  it("keeps tracked and untracked closure modules byte-identical", async () => {
    const baseOptions = {
      fileName: "issue-3520-closure-host-byte-parity.ts",
      experimentalIR: true,
    } as const;
    const untracked = await compile(ZERO_ARITY_SOURCE, baseOptions);
    const tracked = await compile(ZERO_ARITY_SOURCE, { ...baseOptions, trackIrOutcomes: true });
    expect(untracked.success, untracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.success, tracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.binary).toEqual(untracked.binary);
  });

  it("derives the exact five-entry census from terminal and allocator ownership", () => {
    expect([...SINGLE_HOST_ENTRIES]).toEqual([
      "website/playground/examples/dom/calendar.ts",
      "website/playground/examples/js/algorithms.ts",
      "website/playground/examples/js/async.ts",
      "website/playground/examples/js/builtins.ts",
      "website/playground/examples/js/classes.ts",
    ]);

    let corpusOwnedFunctions = 0;
    let corpusRetainedFallbacks = 0;
    for (const entry of SINGLE_HOST_ENTRIES) {
      const source = readFileSync(resolve(entry), "utf8");
      const trackedAst = analyzeSource(source, entry);
      const untrackedAst = analyzeSource(source, entry);
      const tracked = generateModule(trackedAst, { experimentalIR: true, trackIrOutcomes: true });
      const untracked = generateModule(untrackedAst, { experimentalIR: true, trackIrOutcomes: false });
      const trackedErrors = hardErrors(tracked);
      const untrackedErrors = hardErrors(untracked);
      expect(trackedErrors, `${entry}\n${trackedErrors.map((error) => error.message).join("\n")}`).toEqual([]);
      expect(untrackedErrors, `${entry}\n${untrackedErrors.map((error) => error.message).join("\n")}`).toEqual([]);
      expect(emitBinary(tracked.module), `${entry} binary`).toEqual(emitBinary(untracked.module));
      expect(tracked.module.functions.length, `${entry} function population`).toBe(untracked.module.functions.length);
      expect(tracked.irCompiledFuncs, `${entry} routing`).toEqual(untracked.irCompiledFuncs);
      expect(
        tracked.module.exports.map(({ name, desc }) => ({ name, kind: desc.kind, index: desc.index })),
        `${entry} public exports`,
      ).toEqual(untracked.module.exports.map(({ name, desc }) => ({ name, kind: desc.kind, index: desc.index })));
      expect(untracked.irOutcomes, `${entry} untracked outcomes`).toBeUndefined();

      const inventory = buildIrUnitInventory([trackedAst.sourceFile], {
        entrySource: trackedAst.sourceFile,
        checker: trackedAst.checker,
      });
      const outcomes = tracked.irOutcomes ?? [];
      // Partition the ledger the way `scripts/check-ir-only.ts:403-416` does.
      // A `non-executable` row (#3523 R4 gap 4) is OBSERVATIONAL: the inventory
      // mints no module-init unit for an empty population, so the row carries
      // no `unitId` by design and belongs to neither side of the ownership
      // closure below. Its well-formedness is asserted right after, so
      // excluding it here cannot green-wash a row that lies.
      const ownershipOutcomes = outcomes.filter((outcome) => outcome.kind !== "non-executable");
      const observationalOutcomes = outcomes.filter((outcome) => outcome.kind === "non-executable");
      const ownershipIds = ownershipOutcomes.map((outcome) => outcome.unitId);
      expect(
        ownershipIds.every((id) => id !== undefined),
        `${entry} structural outcome ids`,
      ).toBe(true);
      expect(new Set(ownershipIds).size, `${entry} unique outcome ids`).toBe(ownershipOutcomes.length);
      expect([...ownershipIds].sort(), `${entry} terminal outcome closure`).toEqual(
        inventory.terminalUnits.map((unit) => unit.id).sort(),
      );
      for (const outcome of observationalOutcomes) {
        expect(outcome.unitId, `${entry} ${outcome.key} observational unit id`).toBeUndefined();
        expect(outcome.unitKind, `${entry} ${outcome.key} observational unit kind`).toBe("module-init");
        expect(nonExecutableOutcomeDefect(outcome), `${entry} ${outcome.key}`).toBeUndefined();
      }
      for (const outcome of outcomes) {
        expect(outcome.kind === "emitted" ? outcome.irBodyEmitted : !outcome.irBodyEmitted, outcome.key).toBe(true);
        if (outcome.kind === "unsupported") expect(outcome.legacyBodyEmitted, outcome.key).toBe(true);
        expect(outcome.kind, outcome.key).not.toBe("invariant");
      }

      const entrySource = inventory.sources.find((candidate) => candidate.kind === "entry");
      if (!entrySource) throw new Error(`missing entry source for ${entry}`);
      const abiEntries = tracked.programAbi!.abi.entries();
      const familyEntries = abiEntries.filter(
        (candidate) => candidate.intent.kind === "callable" && candidate.id.includes(`:${CLOSURE_HOST_BRIDGE_ROLE}:`),
      );
      const retainedFallbacks = abiEntries.filter(
        (candidate) =>
          candidate.intent.kind === "callable" &&
          candidate.id.includes(":retained-module-function:") &&
          CLOSURE_BRIDGES.some((bridge) => bridge.name === candidate.displayName),
      );
      expect(retainedFallbacks, `${entry} closure retained-module-function fallbacks`).toEqual([]);
      corpusRetainedFallbacks += retainedFallbacks.length;
      const ownedFunctions = new Set<WasmFunction>();
      for (const bridge of CLOSURE_BRIDGES) {
        const id = createIrBindingId({
          ownerId: entrySource.id,
          domain: "support",
          role: CLOSURE_HOST_BRIDGE_ROLE,
          ordinal: bridge.ordinal,
        });
        const matchingEntries = familyEntries.filter((candidate) => candidate.id === id);
        const helperFunctions = tracked.module.functions.filter((candidate) => candidate.name === bridge.name);
        expect(matchingEntries.length, `${entry} ${bridge.name} owner count`).toBe(helperFunctions.length);
        if (matchingEntries.length === 0) continue;
        expect(matchingEntries).toHaveLength(1);
        const row = matchingEntries[0]!;
        expect(row).toMatchObject({
          slotPolicy: "required",
          slotSpace: "function",
          intent: { kind: "callable", origin: "support", sourceId: entrySource.id },
        });
        const slot = tracked.programAbi!.abi.resolveFinalIndex(row.id);
        if (!slot || slot.space !== "function") throw new Error(`missing ${entry} ${bridge.name} final locator`);
        const importCount = tracked.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
        const helper = tracked.module.functions[slot.index - importCount];
        expect(helper, `${entry} ${bridge.name} exact helper`).toBe(helperFunctions[0]);
        if (!helper) throw new Error(`missing ${entry} ${bridge.name} helper allocation`);
        expect(ownedFunctions.has(helper), `${entry} duplicate closure helper owner`).toBe(false);
        ownedFunctions.add(helper);
      }
      expect(familyEntries, `${entry} unbounded closure family rows`).toHaveLength(ownedFunctions.size);
      corpusOwnedFunctions += ownedFunctions.size;
    }
    expect(corpusOwnedFunctions, "five-entry closure ownership anti-vacuity").toBeGreaterThan(0);
    expect(corpusRetainedFallbacks, "five-entry closure retained-module-function fallback census").toBe(0);
  });

  it("preserves public labels, closure identity, direct calls, and method receivers", async () => {
    const { exports } = await instantiate(`
      declare function hostTick(value: number): number;
      const direct = function (value: number): number { return value + 2; };
      const receiver = function (): any { return this; };
      export function getDirect(): any { return direct; }
      export function getReceiver(): any { return receiver; }
      export function test(): number { return hostTick(direct(1)); }
    `);
    for (const bridge of REQUIRED_BRIDGES) expect(exports[bridge.name]).toBeTypeOf("function");

    const direct = (exports.getDirect as () => unknown)();
    expect((exports.__is_closure as (value: unknown) => number)(direct)).toBe(1);
    expect((exports.__closure_arity as (value: unknown) => number)(direct)).toBe(1);
    expect((exports.__call_fn_1 as (fn: unknown, value: unknown) => unknown)(direct, 40)).toBe(42);

    const receiver = (exports.getReceiver as () => unknown)();
    const hostReceiver = { marker: 7 };
    expect((exports.__call_fn_method_0 as (self: unknown, fn: unknown) => unknown)(hostReceiver, receiver)).toBe(
      hostReceiver,
    );
  });

  it("preserves user logical and physical names while runtime dispatch finds the exact closure helper", async () => {
    const tracked = trackedModule(COLLIDING_CLOSURE_SOURCE);
    expect(
      hardErrors(tracked),
      hardErrors(tracked)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    const exportsByName = new Map(tracked.module.exports.map((entry) => [entry.name, entry]));
    expect(exportsByName.get("__call_fn_1")?.desc.index).not.toBe(exportsByName.get("$c1$")?.desc.index);
    expect(exportsByName.get("$c1")?.desc.index).not.toBe(exportsByName.get("$c1$")?.desc.index);
    expect(exportsByName.get("$cf")?.desc.index).not.toBe(exportsByName.get("$cf$")?.desc.index);

    const entrySource = entrySourceRecord(COLLIDING_CLOSURE_SOURCE);
    const directOneId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: CLOSURE_HOST_BRIDGE_ROLE,
      ordinal: 1,
    });
    expect(tracked.programAbi!.abi.resolveFinalIndex(directOneId)).toEqual({
      space: "function",
      index: exportsByName.get("$c1$")?.desc.index,
    });

    const { exports } = await instantiate(COLLIDING_CLOSURE_SOURCE);
    expect((exports.__call_fn_1 as (_closure: unknown, _value: unknown) => number)(null, null)).toBe(701);
    expect((exports.$c1 as () => number)()).toBe(702);
    expect((exports.$cf as () => number)()).toBe(703);
    const closure = (exports.getAddTwo as () => unknown)();
    expect((exports["$c1$"] as (fn: unknown, value: unknown) => unknown)(closure, 40)).toBe(42);
    expect((exports["$cf$"] as (value: unknown) => number)(closure)).toBe(1);

    const wrapped = wrapExports(exports as WebAssembly.Exports);
    const addTwo = wrapped.getAddTwo();
    expect(addTwo).toBeTypeOf("function");
    expect(addTwo(40)).toBe(42);
  });

  it("composes vec and closure collision projections for setExports and wrapExports", async () => {
    const source = `
      export function __vec_len(_value: any): number { return 801; }
      export function $v0(_value: any): number { return 802; }
      export function __vec_get(_value: any, _index: number): number { return 803; }
      export function $v1(_value: any, _index: number): number { return 804; }
      export function __call_fn_1(_closure: any, _value: any): number { return 805; }
      export function $c1(): number { return 806; }
      export function __is_closure(_value: any): number { return 1; }
      export function $cf(): number { return 807; }
      export function $cm(): number { return 808; }
      export function $ct(): number { return 809; }
      const addTwo = function (value: number): number { return value + 2; };
      export function getAddTwo(): any { return addTwo; }
      export function getArray(): number[] { return [3, 4]; }
      export function runPromise(): Promise<number> {
        return Promise.resolve(40).then(addTwo);
      }
    `;
    const { exports } = await instantiate(source);

    expect((exports.__vec_len as (value: unknown) => number)(null)).toBe(801);
    expect((exports.$v0 as (value: unknown) => number)(null)).toBe(802);
    expect((exports.__vec_get as (value: unknown, index: number) => number)(null, 0)).toBe(803);
    expect((exports.$v1 as (value: unknown, index: number) => number)(null, 0)).toBe(804);
    expect((exports.__call_fn_1 as (fn: unknown, value: unknown) => number)(null, null)).toBe(805);
    expect((exports.$c1 as () => number)()).toBe(806);
    expect((exports.__is_closure as (value: unknown) => number)(null)).toBe(1);
    expect((exports.$cf as () => number)()).toBe(807);
    expect((exports.$cm as () => number)()).toBe(808);
    expect((exports.$ct as () => number)()).toBe(809);
    expect(exports["$cm$"]).toBeInstanceOf(WebAssembly.Global);
    expect(exports["$ct$"]).toBeInstanceOf(WebAssembly.Table);

    await expect((exports.runPromise as () => Promise<number>)()).resolves.toBe(42);

    const wrapped = wrapExports(exports as WebAssembly.Exports);
    expect(wrapped.getAddTwo()(40)).toBe(42);
    expect(wrapped.getArray()).toEqual([3, 4]);
  });

  it("does not discover closure helpers from a forged closure-free name family", async () => {
    const source = `
      export function __is_closure(_value: any): number { return 1; }
      export function __call_fn_0(_value: any): number { return 709; }
      export function $cf(): number { return 704; }
      class Empty { ping(): number { return 1; } }
      export function makeEmpty(): Empty { return new Empty(); }
    `;
    const tracked = trackedModule(source);
    expect(tracked.programAbi!.abi.entries().filter((entry) => entry.id.includes(":closure-host-bridge:"))).toEqual([]);

    const { exports } = await instantiate(source);
    expect((exports.__is_closure as (value: unknown) => number)(null)).toBe(1);
    expect((exports.__call_fn_0 as (value: unknown) => number)(null)).toBe(709);
    expect((exports.$cf as () => number)()).toBe(704);
    expect(exports["$cf$"]).toBeUndefined();
    expect(exports["__\0js2_closure_host_bridge"]).toBeUndefined();
    expect(exports["__\0js2_closure_host_bridge_marker"]).toBeUndefined();

    const wrapped = wrapExports(exports as WebAssembly.Exports);
    const instance = wrapped.makeEmpty();
    expect(instance).toEqual({});
    expect(instance).not.toBeTypeOf("function");
  });

  it("fails closed for malformed marker, manifest, binding, and physical helper metadata", async () => {
    const source = `
      export function __is_closure(_value: any): number { return 1; }
      export function $cf(): number { return 901; }
      export function $cm(): number { return 902; }
      export function $ct(): number { return 903; }
      export function $cu(): number { return 904; }
      const identity = function (value: number): number { return value; };
      class Boxed {
        value: number = 7;
        ping(): number { return 1; }
      }
      export function getIdentity(): any { return identity; }
      export function makeBoxed(): Boxed { return new Boxed(); }
    `;
    const { exports } = await instantiate(source);
    expect(exports["$cf$"]).toBeTypeOf("function");
    expect(exports["$cm$"]).toBeInstanceOf(WebAssembly.Global);
    expect(exports["$ct$"]).toBeInstanceOf(WebAssembly.Table);
    expect(exports["$cu$"]).toBeInstanceOf(WebAssembly.Table);
    expect(wrapExports(exports as WebAssembly.Exports).makeBoxed()).toMatchObject({ value: 7 });

    const clone = (): Record<string, unknown> => Object.assign(Object.create(null), exports);
    const assertBoxedObject = (tampered: Record<string, unknown>): void => {
      const value = wrapExports(tampered as WebAssembly.Exports).makeBoxed();
      expect(value).toMatchObject({ value: 7 });
      expect(value).not.toBeTypeOf("function");
    };

    const missingClassifier = Object.assign(
      Object.create(null),
      Object.fromEntries(Object.entries(exports).filter(([name]) => name !== "$cf$")),
    ) as Record<string, unknown>;
    assertBoxedObject(missingClassifier);

    const nonEmptyMarker = clone();
    nonEmptyMarker["$ct$"] = new WebAssembly.Table({ element: "anyfunc", initial: 1, maximum: 1 });
    assertBoxedObject(nonEmptyMarker);

    const manifestValue = (exports["$cm$"] as WebAssembly.Global).value as number;
    const mutableManifest = clone();
    mutableManifest["$cm$"] = new WebAssembly.Global({ value: "i32", mutable: true }, manifestValue);
    assertBoxedObject(mutableManifest);

    const reservedBitManifest = clone();
    reservedBitManifest["$cm$"] = new WebAssembly.Global({ value: "i32", mutable: false }, manifestValue | (1 << 18));
    assertBoxedObject(reservedBitManifest);

    const f64Manifest = clone();
    f64Manifest["$cm$"] = new WebAssembly.Global({ value: "f64", mutable: false }, manifestValue);
    assertBoxedObject(f64Manifest);

    const externrefBindings = new WebAssembly.Table({ element: "externref", initial: 18, maximum: 18 });
    const externrefForge = clone();
    const availabilityBits = manifestValue & 0x0003ffff;
    for (let bit = 0; bit < CLOSURE_PHYSICAL_BASES.length; bit++) {
      externrefBindings.set(bit, null);
    }
    for (let bit = 0; bit < CLOSURE_PHYSICAL_BASES.length; bit++) {
      if ((availabilityBits & (1 << bit)) === 0) continue;
      const forgedHelper = bit === 15 ? () => 1 : () => undefined;
      externrefBindings.set(bit, forgedHelper);
      let physicalName = CLOSURE_PHYSICAL_BASES[bit]!;
      let terminalName: string | undefined;
      while (Object.prototype.hasOwnProperty.call(externrefForge, physicalName)) {
        terminalName = physicalName;
        physicalName += "$";
      }
      expect(terminalName).toBeDefined();
      externrefForge[terminalName!] = forgedHelper;
    }
    externrefForge["$cu$"] = externrefBindings;
    assertBoxedObject(externrefForge);
  });

  it("does not grant post-freeze replacement copies constructor provenance", () => {
    const { registry, result } = generateWithCapturedRegistry(
      CONSTRUCTIBLE_CLOSURE_SOURCE,
      "closure-ctor-cloned-descriptor.ts",
    );
    const entryIndex = result.module.exports.findIndex(
      (candidate) => candidate.name === "__is_ctor_closure" && candidate.desc.kind === "func",
    );
    if (entryIndex < 0) throw new Error("missing compiler-owned constructor classifier descriptor");
    const entry = result.module.exports[entryIndex]!;
    if (entry.desc.kind !== "func") throw new Error("constructor classifier descriptor changed export kind");
    expect(registry.ctx.indexSpaceFrozen).toBe(true);
    const clone: WasmExport = { name: entry.name, desc: { kind: "func", index: entry.desc.index } };
    result.module.exports[entryIndex] = clone;
    const originalEmitHostBridge = registry.ctx.emitHostBridge;
    try {
      registry.ctx.emitHostBridge = false;
      expect(isCompilerOwnedCtorClosureHostBridgeExport(registry.ctx, clone)).toBe(false);
      expect(stripHostBridgeExports(registry.ctx)).toBeGreaterThan(0);
      expect(result.module.exports).toContain(clone);
    } finally {
      registry.ctx.emitHostBridge = originalEmitHostBridge;
    }
  });

  it("retains same-spelled user and near-prefix descriptors without constructor provenance", () => {
    const collision = generateWithCapturedRegistry(CLOSURE_COLLISION_SOURCE, "closure-ctor-user-collision.ts");
    const userLogical = collision.result.module.exports.find(
      (candidate) => candidate.name === "__is_ctor_closure" && candidate.desc.kind === "func",
    );
    if (!userLogical) throw new Error("missing user constructor-classifier collision");
    expect(isCompilerOwnedCtorClosureHostBridgeExport(collision.registry.ctx, userLogical)).toBe(false);

    const compilerPhysical = collision.result.module.exports.find(
      (candidate) => candidate.name === "$ch$" && candidate.desc.kind === "func",
    );
    if (!compilerPhysical || compilerPhysical.desc.kind !== "func") {
      throw new Error("missing compiler constructor-classifier physical descriptor");
    }
    const nearPrefix: WasmExport = { name: "$ch0", desc: { kind: "func", index: compilerPhysical.desc.index } };
    collision.result.module.exports.push(nearPrefix);
    expect(isCompilerOwnedCtorClosureHostBridgeExport(collision.registry.ctx, nearPrefix)).toBe(false);

    const originalEmitHostBridge = collision.registry.ctx.emitHostBridge;
    try {
      collision.registry.ctx.emitHostBridge = false;
      stripHostBridgeExports(collision.registry.ctx);
      expect(collision.result.module.exports).toContain(userLogical);
      expect(collision.result.module.exports).toContain(nearPrefix);
    } finally {
      collision.registry.ctx.emitHostBridge = originalEmitHostBridge;
    }
  });

  it("strips recorded constructor provenance before retaining a cross-namespace user collision", () => {
    const { registry, result } = generateWithCapturedRegistry(
      CLOSURE_CROSS_NAMESPACE_COLLISION_SOURCE,
      "closure-ctor-cross-namespace-collision.ts",
    );
    const recorded = result.module.exports.find(
      (candidate) =>
        candidate.name === "__is_ctor_closure" && isCompilerOwnedCtorClosureHostBridgeExport(registry.ctx, candidate),
    );
    if (!recorded) throw new Error("missing recorded constructor classifier descriptor");
    const user = result.module.exports.find((candidate) => candidate.name === "$v0" && candidate !== recorded);
    if (!user) throw new Error("missing user vec-namespace collision descriptor");
    expect(isCompilerOwnedCtorClosureHostBridgeExport(registry.ctx, user)).toBe(false);

    recorded.name = "$v0";
    expect(isCompilerOwnedCtorClosureHostBridgeExport(registry.ctx, recorded)).toBe(true);
    const originalEmitHostBridge = registry.ctx.emitHostBridge;
    try {
      registry.ctx.emitHostBridge = false;
      expect(stripHostBridgeExports(registry.ctx)).toBeGreaterThan(0);
      expect(result.module.exports).toContain(user);
      expect(result.module.exports).not.toContain(recorded);
    } finally {
      registry.ctx.emitHostBridge = originalEmitHostBridge;
    }
  });

  it("fails closed for recorded constructor descriptor mutations before manifest publication", () => {
    const cases: readonly {
      readonly name: string;
      readonly mutate: (
        registry: ProgramAbiCallableRegistry,
        result: ReturnType<typeof generateModule>,
        entry: WasmExport,
      ) => void;
      readonly expected: RegExp;
    }[] = [
      {
        name: "replaced",
        mutate: (_registry, result, entry) => {
          const index = result.module.exports.indexOf(entry);
          result.module.exports[index] = { name: entry.name, desc: { ...entry.desc } };
        },
        expected: /disappeared before finalization/,
      },
      {
        name: "duplicated",
        mutate: (_registry, result, entry) => {
          result.module.exports.push(entry);
        },
        expected: /appears more than once in the module/,
      },
      {
        name: "cloned-extra",
        mutate: (registry, result, entry) => {
          const clone: WasmExport = { name: entry.name, desc: { ...entry.desc } };
          result.module.exports.push(clone);
          expect(isCompilerOwnedCtorClosureHostBridgeExport(registry.ctx, clone)).toBe(false);
        },
        expected:
          /unrecorded constructor-closure host bridge export descriptor .* resolves to a recorded allocator function/,
      },
      {
        name: "foreign-context-donor",
        mutate: (registry, result, entry) => {
          const donor = generateWithCapturedRegistry(
            CONSTRUCTIBLE_CLOSURE_SOURCE,
            "closure-ctor-identically-laid-out-donor.ts",
          );
          const donorEntry = donor.result.module.exports.find(
            (candidate) => candidate.name === "__is_ctor_closure" && candidate.desc.kind === "func",
          );
          if (!donorEntry || donorEntry.desc.kind !== "func" || entry.desc.kind !== "func") {
            throw new Error("missing function descriptor for constructor classifier donor mutation");
          }
          expect(donorEntry).not.toBe(entry);
          expect(donorEntry.desc.index).toBe(entry.desc.index);
          expect(isCompilerOwnedCtorClosureHostBridgeExport(donor.registry.ctx, donorEntry)).toBe(true);
          expect(isCompilerOwnedCtorClosureHostBridgeExport(registry.ctx, donorEntry)).toBe(false);
          result.module.exports.push(donorEntry);
        },
        expected:
          /unrecorded constructor-closure host bridge export descriptor .* resolves to a recorded allocator function/,
      },
      {
        name: "name-changed",
        mutate: (_registry, _result, entry) => {
          entry.name = "$ch0";
        },
        expected: /changed its published name to \$ch0/,
      },
      {
        name: "retargeted",
        mutate: (_registry, result, entry) => {
          const other = result.module.exports.find(
            (candidate) => candidate.name === "__is_closure" && candidate.desc.kind === "func",
          );
          if (!other || other.desc.kind !== "func") throw new Error("missing alternate closure helper export");
          entry.desc.index = other.desc.index;
        },
        expected: /resolves to a different allocator function/,
      },
      {
        name: "one-past-defined-functions",
        mutate: (_registry, result, entry) => {
          const liveImportCount = result.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
          entry.desc.index = liveImportCount + result.module.functions.length;
          expect(entry.desc.index).toBeLessThan(STABLE_FUNC_BASE);
        },
        expected: /resolves to a different allocator function/,
      },
      {
        name: "kind-changed",
        mutate: (_registry, _result, entry) => {
          entry.desc = { kind: "global", index: entry.desc.index };
        },
        expected: /changed kind to global/,
      },
      {
        name: "allocator-removed",
        mutate: (_registry, result, entry) => {
          if (entry.desc.kind !== "func") throw new Error("constructor classifier descriptor changed export kind");
          const func = result.module.functions.find((candidate) => candidate.name === "__is_ctor_closure");
          if (!func) throw new Error("missing constructor classifier allocator");
          result.module.functions.splice(result.module.functions.indexOf(func), 1);
        },
        expected: /lost its allocator function/,
      },
    ];

    for (const mutation of cases) {
      const { registry, result } = generateWithCapturedRegistry(
        CONSTRUCTIBLE_CLOSURE_SOURCE,
        `closure-ctor-${mutation.name}.ts`,
      );
      const entry = result.module.exports.find(
        (candidate) => candidate.name === "__is_ctor_closure" && candidate.desc.kind === "func",
      );
      if (!entry) throw new Error(`missing compiler-owned constructor classifier for ${mutation.name}`);
      mutation.mutate(registry, result, entry);
      expect(() => finalizeCtorClosureHostBridgeExports(registry.ctx), mutation.name).toThrow(mutation.expected);
    }
  });

  it("owns closure_has_rest at ordinal 13 only when that helper is emitted", async () => {
    const source = `
      const rest = function (...values: any[]): number { return values.length; };
      export function getRest(): any { return rest; }
      export function test(): number { return rest(1, 2, 3); }
    `;
    const result = trackedModule(source);
    expect(
      hardErrors(result),
      hardErrors(result)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    const entrySource = entrySourceRecord(source);
    const expectedId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: CLOSURE_HOST_BRIDGE_ROLE,
      ordinal: 13,
    });
    expect(result.programAbi!.abi.get(expectedId)).toMatchObject({
      displayName: "__closure_has_rest",
    });

    const { exports } = await instantiate(source);
    const rest = (exports.getRest as () => unknown)();
    expect((exports.__closure_has_rest as (value: unknown) => number)(rest)).toBe(1);

    const noRest = trackedModule();
    expect(noRest.programAbi!.abi.get(expectedId)).toBeUndefined();
    expect(noRest.module.exports.map((candidate) => candidate.name)).not.toContain("__closure_has_rest");
  });
});
