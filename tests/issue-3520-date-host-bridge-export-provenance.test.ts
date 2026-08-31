// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// C39 — Date carrier host-bridge export provenance. Date bridge names are a
// shared public namespace, not ownership authority: only the exact descriptor
// object recorded by the publishing CodegenContext may be stripped.

import { describe, expect, it } from "vitest";

import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  emitDateHostBridge,
  finalizeDateHostBridgeExports,
  isCompilerOwnedDateHostBridgeExport,
  isCoreDateHostBridgePublicName,
} from "../src/codegen/date-host-bridge.js";
import { definedFuncAt } from "../src/codegen/func-space.js";
import { stripHostBridgeExports } from "../src/codegen/host-bridge-exports.js";
import { type GeneratedCodegenModule, generateModule, generateMultiModule } from "../src/codegen/index.js";
import { emitBinary } from "../src/emit/binary.js";
import { STABLE_FUNC_BASE } from "../src/emit/resolve-layout.js";
import { type CompileOptions, compile, compileMulti } from "../src/index.js";
import { type WasmExport, type WasmFunction, createEmptyModule } from "../src/ir/types.js";
import { buildImports, buildWasiPolyfill } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const DATE_BRIDGE_NAMES = Object.freeze(["__\0js2_is_date", "__\0js2_date_value", "__\0js2_date_set_value"] as const);

const HOST_DATE_HOST_BRIDGE_EXPORTS = Object.freeze([
  "__is_data_struct",
  "__\0js2_data_struct_host_bridge",
  "__\0js2_data_struct_host_bridge_bindings",
  "__\0js2_data_struct_host_bridge_marker",
  "__\0js2_data_struct_host_bridge_token",
  ...DATE_BRIDGE_NAMES,
  "__sget_timestamp",
  "__struct_field_names",
  "$d0",
  "$d1",
  "$dm",
  "$dt",
  "$du",
  "$dv",
] as const);

const TARGET_DATE_HOST_BRIDGE_EXPORTS = Object.freeze([
  "__is_data_struct",
  "__\0js2_data_struct_host_bridge",
  "__\0js2_data_struct_host_bridge_bindings",
  "__\0js2_data_struct_host_bridge_marker",
  ...DATE_BRIDGE_NAMES,
  "__sget_byteOffset",
  "__sget_data",
  "__sget_length",
  "__sget_timestamp",
  "__sset_length",
  "$d0",
  "$dm",
  "$dt",
  "$du",
] as const);

const MULTI_TARGET_DATE_HOST_BRIDGE_EXPORTS = Object.freeze([
  "__is_data_struct",
  "__\0js2_data_struct_host_bridge",
  "__\0js2_data_struct_host_bridge_bindings",
  "__\0js2_data_struct_host_bridge_marker",
  ...DATE_BRIDGE_NAMES,
  "__sget_timestamp",
  "$d0",
  "$dm",
  "$dt",
  "$du",
] as const);

const DATE_FREE_TARGET_HOST_BRIDGE_EXPORTS = Object.freeze([
  "__is_data_struct",
  "__\0js2_data_struct_host_bridge",
  "__\0js2_data_struct_host_bridge_bindings",
  "__\0js2_data_struct_host_bridge_marker",
  "__sget_byteOffset",
  "__sget_data",
  "__sget_length",
  "__sset_length",
  "$d0",
  "$dm",
  "$dt",
  "$du",
] as const);

const MULTI_HOST_IMPORT_CENSUS = Object.freeze([
  {
    module: "string_constants",
    name: "./provider.ts",
    desc: { kind: "global", type: { kind: "externref" }, mutable: false },
  },
  {
    module: "string_constants",
    name: "dateValue",
    desc: { kind: "global", type: { kind: "externref" }, mutable: false },
  },
  {
    module: "string_constants",
    name: "",
    desc: { kind: "global", type: { kind: "externref" }, mutable: false },
  },
  {
    module: "string_constants",
    name: "timestamp",
    desc: { kind: "global", type: { kind: "externref" }, mutable: false },
  },
  {
    module: "string_constants",
    name: "\0js2_data_struct_host_bridge_token",
    desc: { kind: "global", type: { kind: "externref" }, mutable: false },
  },
  // (#5239-family) The provider mints its Date carrier DURING module init
  // (`providedDateValue` is a top-level `new Date(...)` read), so the #5202
  // init-window channel registers the carrier's decoder exports before
  // `getExports()` resolves. The name-list global + registration import are
  // that channel, not Date-descriptor provenance.
  {
    module: "string_constants",
    name: "__is_data_struct,__sget_timestamp,__struct_field_names",
    desc: { kind: "global", type: { kind: "externref" }, mutable: false },
  },
  {
    module: "env",
    name: "__register_init_class_export",
    desc: { kind: "func", typeIdx: 7 },
  },
] as const);

const DATE_SOURCE = `
  export function dateValue(): number {
    return new Date(5).getTime();
  }
`;

const DATE_FREE_SOURCE = `
  export function dateValue(): number {
    return 5;
  }
`;

const DATE_PROVIDER_SOURCE = `
  export const providedDateValue: number = new Date(5).getTime();
`;

const DATE_ENTRY_SOURCE = `
  import { providedDateValue } from "./provider.ts";
  export function dateValue(): number {
    return providedDateValue;
  }
`;

const DATE_MULTI_SOURCE_ORDERS = [
  {
    label: "provider-before-entry",
    files: {
      "./provider.ts": DATE_PROVIDER_SOURCE,
      "./entry.ts": DATE_ENTRY_SOURCE,
    },
  },
  {
    label: "entry-before-provider",
    files: {
      "./entry.ts": DATE_ENTRY_SOURCE,
      "./provider.ts": DATE_PROVIDER_SOURCE,
    },
  },
] as const;

type BridgePolicy = "auto" | "off" | "always";
type OutputTarget = "host" | "standalone" | "wasi";
type CompileResult = Awaited<ReturnType<typeof compile>>;
type GeneratedResult = ReturnType<typeof generateModule>;
type ErrorCarrier = {
  readonly errors: readonly {
    readonly severity: string;
    readonly message: string;
  }[];
};
type Context = ReturnType<typeof makeDateContext>;

function generatedOptions({
  target,
  hostBridge,
  trackIrOutcomes,
}: {
  readonly target: OutputTarget;
  readonly hostBridge: BridgePolicy;
  readonly trackIrOutcomes?: boolean;
}) {
  return {
    experimentalIR: true,
    hostBridge,
    trackIrOutcomes,
    standalone: target === "standalone",
    wasi: target === "wasi",
  };
}

function compileOptions(
  fileName: string,
  target: OutputTarget,
  hostBridge: BridgePolicy,
  trackIrOutcomes = false,
): CompileOptions {
  const common = {
    fileName,
    experimentalIR: true,
    hostBridge,
    trackIrOutcomes,
  } as const;
  if (target === "host") return common;
  return { ...common, target };
}

function generateSingle(
  source: string,
  fileName: string,
  target: OutputTarget,
  hostBridge: BridgePolicy,
  trackIrOutcomes = false,
): GeneratedResult {
  return generateModule(analyzeSource(source, fileName), generatedOptions({ target, hostBridge, trackIrOutcomes }));
}

function generateGraph(
  files: Record<string, string>,
  entryFile: string,
  target: OutputTarget,
  hostBridge: BridgePolicy,
  trackIrOutcomes = false,
): GeneratedCodegenModule {
  return generateMultiModule(
    analyzeMultiSource(files, entryFile),
    generatedOptions({ target, hostBridge, trackIrOutcomes }),
  );
}

function hardErrors(result: ErrorCarrier): string[] {
  return result.errors.filter((error) => error.severity !== "warning").map((error) => error.message);
}

function isDateBridgeName(name: string): name is (typeof DATE_BRIDGE_NAMES)[number] {
  return DATE_BRIDGE_NAMES.includes(name as (typeof DATE_BRIDGE_NAMES)[number]);
}

function dateEntries(result: GeneratedResult): WasmExport[] {
  return result.module.exports.filter((entry) => isDateBridgeName(entry.name));
}

function importFunctionCount(result: Pick<GeneratedResult, "module">): number {
  return result.module.imports.filter((entry) => entry.desc.kind === "func").length;
}

function functionForExport(result: Pick<GeneratedResult, "module">, entry: WasmExport): WasmFunction {
  if (entry.desc.kind !== "func") throw new Error(`export ${entry.name} is not a function`);
  const position =
    entry.desc.index < STABLE_FUNC_BASE
      ? entry.desc.index - importFunctionCount(result)
      : result.module.funcOrdinalToPosition[entry.desc.index - STABLE_FUNC_BASE];
  if (!Number.isInteger(position) || position < 0) {
    throw new Error(`export ${entry.name} has no defined function target`);
  }
  const func = result.module.functions[position];
  if (!func) throw new Error(`export ${entry.name} has no defined function target`);
  return func;
}

function expectedPublicNames(
  target: OutputTarget,
  hostBridge: BridgePolicy,
  hostBridgeExports: readonly string[],
): string[] {
  const emitsHostBridge = target === "host" ? hostBridge !== "off" : hostBridge === "always";
  return [...(target === "wasi" ? ["memory"] : []), "dateValue", ...(emitsHostBridge ? hostBridgeExports : [])].sort();
}

function dateHostBridgeExportsFor(target: OutputTarget): readonly string[] {
  return target === "host" ? HOST_DATE_HOST_BRIDGE_EXPORTS : TARGET_DATE_HOST_BRIDGE_EXPORTS;
}

function multiDateHostBridgeExportsFor(target: OutputTarget): readonly string[] {
  return target === "host" ? HOST_DATE_HOST_BRIDGE_EXPORTS : MULTI_TARGET_DATE_HOST_BRIDGE_EXPORTS;
}

function importDescriptorCensus(result: Pick<GeneratedResult, "module">) {
  return result.module.imports.map((entry) => ({ module: entry.module, name: entry.name, desc: entry.desc }));
}

function assertExactMultiImportCensus(result: GeneratedResult, target: OutputTarget, label: string): void {
  expect(importDescriptorCensus(result), `${label} generated imports`).toEqual(
    target === "host" ? MULTI_HOST_IMPORT_CENSUS : [],
  );
}

function exportDescriptorCensus(result: Pick<GeneratedResult, "module">) {
  return result.module.exports
    .map((entry) => {
      if (entry.desc.kind !== "func") return { name: entry.name, desc: entry.desc };
      const func = functionForExport(result, entry);
      return {
        name: entry.name,
        desc: entry.desc,
        target: {
          name: func.name,
          typeIdx: func.typeIdx,
          locals: func.locals,
          body: func.body,
        },
      };
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function assertExactPublicSurface(
  result: GeneratedResult,
  label: string,
  target: OutputTarget,
  hostBridge: BridgePolicy,
  hostBridgeExports: readonly string[],
  retainedNames: readonly string[] = [],
): void {
  expect(hardErrors(result), `${label} diagnostics`).toEqual([]);
  const expectedNames = [...expectedPublicNames(target, hostBridge, hostBridgeExports), ...retainedNames].sort();
  const census = exportDescriptorCensus(result);
  expect(
    census.map((entry) => entry.name),
    `${label} complete export names`,
  ).toEqual(expectedNames);
  expect(new Set(census.map((entry) => entry.name)).size, `${label} duplicate export names`).toBe(census.length);
  const dateValue = census.find((entry) => entry.name === "dateValue");
  expect(dateValue, `${label} user export descriptor`).toMatchObject({
    name: "dateValue",
    target: { name: "dateValue" },
  });
}

function assertExactDateCensus(result: GeneratedResult, label: string, allowInitializationPreamble = false): void {
  expect(hardErrors(result), `${label} diagnostics`).toEqual([]);
  const entries = dateEntries(result);
  expect(entries.map((entry) => entry.name).sort(), `${label} Date names`).toEqual([...DATE_BRIDGE_NAMES].sort());
  const handles = entries.map((entry) => {
    if (entry.desc.kind !== "func") throw new Error(`${label} Date export ${entry.name} is not a function`);
    return entry.desc.index;
  });
  expect(new Set(handles).size, `${label} distinct Date handles`).toBe(DATE_BRIDGE_NAMES.length);
  const funcs = entries.map((entry) => functionForExport(result, entry));
  expect(new Set(funcs).size, `${label} distinct Date allocator objects`).toBe(DATE_BRIDGE_NAMES.length);

  const dateTypeIdx = result.module.types.findIndex((type) => type.kind === "struct" && type.name === "__Date");
  expect(dateTypeIdx, `${label} Date carrier type`).toBeGreaterThanOrEqual(0);
  const expected = new Map<
    (typeof DATE_BRIDGE_NAMES)[number],
    {
      readonly params: readonly unknown[];
      readonly results: readonly unknown[];
      readonly body: readonly unknown[];
    }
  >([
    [
      "__\0js2_is_date",
      {
        params: [{ kind: "externref" }],
        results: [{ kind: "i32" }],
        body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: dateTypeIdx }],
      },
    ],
    [
      "__\0js2_date_value",
      {
        params: [{ kind: "externref" }],
        results: [{ kind: "i64" }],
        body: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: dateTypeIdx },
          { op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 },
        ],
      },
    ],
    [
      "__\0js2_date_set_value",
      {
        params: [{ kind: "ref", typeIdx: dateTypeIdx }, { kind: "i64" }],
        results: [],
        body: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 },
        ],
      },
    ],
  ]);

  for (const name of DATE_BRIDGE_NAMES) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`${label} missing Date export ${name}`);
    const func = functionForExport(result, entry);
    const type = result.module.types[func.typeIdx];
    expect(func.name, `${label} ${name} allocator name`).toBe(name);
    expect(func.exported, `${label} ${name} allocator exported`).toBe(true);
    expect(func.locals, `${label} ${name} locals`).toEqual([]);
    expect(type?.kind, `${label} ${name} function type`).toBe("func");
    if (type?.kind !== "func") continue;
    const expectation = expected.get(name);
    if (!expectation) throw new Error(`${label} missing Date expectation ${name}`);
    expect(type.params, `${label} ${name} parameters`).toEqual(expectation.params);
    expect(type.results, `${label} ${name} results`).toEqual(expectation.results);
    if (!allowInitializationPreamble) {
      expect(func.body, `${label} ${name} body`).toEqual(expectation.body);
      continue;
    }
    const preambleLength = func.body.length - expectation.body.length;
    expect(preambleLength, `${label} ${name} initialization preamble length`).toBeGreaterThanOrEqual(0);
    const preamble = func.body.slice(0, preambleLength);
    expect(func.body.slice(preambleLength), `${label} ${name} Date helper body suffix`).toEqual(expectation.body);
    for (const instr of preamble) {
      expect(instr, `${label} ${name} initialization preamble`).toMatchObject({ op: "call" });
    }
  }
}

function assertGeneratedParity(untracked: GeneratedResult, tracked: GeneratedResult, label: string): void {
  expect(tracked.module.imports, `${label} generated import census`).toEqual(untracked.module.imports);
  expect(exportDescriptorCensus(tracked), `${label} generated descriptor census`).toEqual(
    exportDescriptorCensus(untracked),
  );
  expect(emitBinary(tracked.module), `${label} generated binary parity`).toEqual(emitBinary(untracked.module));
}

function assertCompiledParity(untracked: CompileResult, tracked: CompileResult, label: string): void {
  expect(untracked.success, `${label} untracked diagnostics: ${hardErrors(untracked).join("\n")}`).toBe(true);
  expect(tracked.success, `${label} tracked diagnostics: ${hardErrors(tracked).join("\n")}`).toBe(true);
  expect(tracked.imports, `${label} compiled import census`).toEqual(untracked.imports);
  expect(tracked.binary, `${label} compiled binary parity`).toEqual(untracked.binary);
}

async function instantiate(result: CompileResult, target: OutputTarget): Promise<Record<string, unknown>> {
  expect(result.success, hardErrors(result).join("\n")).toBe(true);
  if (target === "wasi") {
    const wasi = buildWasiPolyfill();
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {
      wasi_snapshot_preview1: wasi,
    });
    const memory = instance.exports.memory;
    if (memory instanceof WebAssembly.Memory) wasi.setMemory(memory);
    return instance.exports as Record<string, unknown>;
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return instance.exports as Record<string, unknown>;
}

async function assertDateRuntime(result: CompileResult, target: OutputTarget, label: string): Promise<void> {
  const exports = await instantiate(result, target);
  expect(exports.dateValue, `${label} dateValue export`).toEqual(expect.any(Function));
  expect((exports.dateValue as () => number)(), `${label} runtime`).toBe(5);
}

function makeDateContext() {
  const module = createEmptyModule();
  const ctx = createCodegenContext(module, {} as ts.TypeChecker, {
    target: "standalone",
    hostBridge: "off",
  });
  const dateTypeIdx = module.types.length;
  module.types.push({
    kind: "struct",
    name: "__Date",
    fields: [{ name: "timestamp", type: { kind: "i64" }, mutable: true }],
  });
  ctx.structMap.set("__Date", dateTypeIdx);
  ctx.typeIdxToStructName.set(dateTypeIdx, "__Date");
  ctx.structFields.set("__Date", [{ name: "timestamp", type: { kind: "i64" }, mutable: true }]);
  emitDateHostBridge(ctx);
  return ctx;
}

function dateEntry(ctx: Context, name = DATE_BRIDGE_NAMES[0]): WasmExport {
  const entry = ctx.mod.exports.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`missing Date export ${name}`);
  return entry;
}

function contextFunctionForExport(ctx: Context, entry: WasmExport): WasmFunction {
  if (entry.desc.kind !== "func") throw new Error(`Date export ${entry.name} is not a function`);
  const func =
    entry.desc.index < STABLE_FUNC_BASE
      ? ctx.mod.functions[
          entry.desc.index - ctx.mod.imports.filter((candidate) => candidate.desc.kind === "func").length
        ]
      : definedFuncAt(ctx, entry.desc.index);
  if (!func) throw new Error(`Date export ${entry.name} has no defined function target`);
  return func;
}

function cloneExport(entry: WasmExport, name = entry.name): WasmExport {
  return {
    name,
    desc: entry.desc.kind === "func" ? { kind: "func", index: entry.desc.index } : { ...entry.desc },
  };
}

function appendDistinctUserExport(ctx: Context, name: string): WasmExport {
  const dateFunc = contextFunctionForExport(ctx, dateEntry(ctx));
  const index = ctx.mod.imports.filter((candidate) => candidate.desc.kind === "func").length + ctx.mod.functions.length;
  const func: WasmFunction = {
    name: `user-${name}`,
    typeIdx: dateFunc.typeIdx,
    locals: [],
    body: [{ op: "i32.const", value: 7 }],
    exported: true,
  };
  const entry: WasmExport = { name, desc: { kind: "func", index } };
  ctx.mod.functions.push(func);
  ctx.mod.exports.push(entry);
  return entry;
}

type ExportSnapshot = {
  readonly array: readonly WasmExport[];
  readonly entries: readonly {
    readonly entry: WasmExport;
    readonly name: string;
    readonly desc: WasmExport["desc"];
    readonly descValue: WasmExport["desc"];
  }[];
};

function snapshotExports(ctx: Context): ExportSnapshot {
  return {
    array: ctx.mod.exports,
    entries: ctx.mod.exports.map((entry) => ({
      entry,
      name: entry.name,
      desc: entry.desc,
      descValue: { ...entry.desc },
    })),
  };
}

function expectExportsUnchanged(ctx: Context, snapshot: ExportSnapshot, label: string): void {
  expect(ctx.mod.exports, `${label} export-array identity`).toBe(snapshot.array);
  expect(ctx.mod.exports).toHaveLength(snapshot.entries.length);
  snapshot.entries.forEach((before, index) => {
    const after = ctx.mod.exports[index];
    expect(after, `${label} export ${index} identity`).toBe(before.entry);
    expect(after?.name, `${label} export ${index} name`).toBe(before.name);
    expect(after?.desc, `${label} export ${index} descriptor identity`).toBe(before.desc);
    expect(after?.desc, `${label} export ${index} descriptor value`).toEqual(before.descValue);
  });
}

function expectPreFreezeRejection(ctx: Context, expected: RegExp, label: string): void {
  ctx.emitHostBridge = false;
  const before = snapshotExports(ctx);
  expect(() => stripHostBridgeExports(ctx), label).toThrow(expected);
  expectExportsUnchanged(ctx, before, label);
}

function multiSourcePolicySurvivors(target: OutputTarget, hostBridge: BridgePolicy): readonly string[] {
  // `$dv` is the existing data-struct token alias, deliberately outside #4035's
  // legacy alias table. It is not a Date export and remains public in host/off.
  if (target === "wasi") return ["_start"];
  return target === "host" && hostBridge === "off" ? ["$dv"] : [];
}

describe("#3520 C39 Date carrier host-bridge export provenance", () => {
  it("accepts only the exact three Date public names", () => {
    expect(DATE_BRIDGE_NAMES.every(isCoreDateHostBridgePublicName)).toBe(true);
    expect(
      [
        "prefix__\0js2_is_date",
        "__\0js2_is_date$",
        "__\0js2_date_value_extra",
        "__\0js2_date_set_value0",
        "__\0js2_date-set-value",
        "$d0",
        "$d0$",
      ].some(isCoreDateHostBridgePublicName),
    ).toBe(false);
  });

  it.each(["auto", "always"] as const)(
    "publishes exact Date descriptors, allocators, types, bodies, and runtime behavior for host %s",
    async (hostBridge) => {
      const fileName = `issue-3520-c39-date-host-${hostBridge}.ts`;
      const generated = generateSingle(DATE_SOURCE, fileName, "host", hostBridge);
      assertExactPublicSurface(generated, `host/${hostBridge}`, "host", hostBridge, dateHostBridgeExportsFor("host"));
      assertExactDateCensus(generated, `host/${hostBridge}`);

      const compiled = await compile(DATE_SOURCE, compileOptions(fileName, "host", hostBridge));
      expect(compiled.success, hardErrors(compiled).join("\n")).toBe(true);
      await assertDateRuntime(compiled, "host", `host/${hostBridge}`);
    },
  );

  it.each(["standalone", "wasi"] as const)(
    "strips Date bridge exports for %s auto/off with exact tracked parity",
    async (target) => {
      for (const hostBridge of ["auto", "off"] as const) {
        const label = `${target}/${hostBridge}`;
        const fileName = `issue-3520-c39-date-${target}-${hostBridge}.ts`;
        const untrackedGenerated = generateSingle(DATE_SOURCE, fileName, target, hostBridge);
        const trackedGenerated = generateSingle(DATE_SOURCE, fileName, target, hostBridge, true);
        assertExactPublicSurface(
          untrackedGenerated,
          `${label}/untracked`,
          target,
          hostBridge,
          dateHostBridgeExportsFor(target),
        );
        assertExactPublicSurface(
          trackedGenerated,
          `${label}/tracked`,
          target,
          hostBridge,
          dateHostBridgeExportsFor(target),
        );
        expect(untrackedGenerated.module.imports, `${label} untracked generated imports`).toEqual([]);
        expect(trackedGenerated.module.imports, `${label} tracked generated imports`).toEqual([]);
        expect(dateEntries(untrackedGenerated), `${label} untracked Date exports`).toEqual([]);
        expect(dateEntries(trackedGenerated), `${label} tracked Date exports`).toEqual([]);
        assertGeneratedParity(untrackedGenerated, trackedGenerated, label);

        const untracked = await compile(DATE_SOURCE, compileOptions(fileName, target, hostBridge));
        const tracked = await compile(DATE_SOURCE, compileOptions(fileName, target, hostBridge, true));
        assertCompiledParity(untracked, tracked, label);
        expect(untracked.imports, `${label} untracked compiled imports`).toEqual([]);
        expect(tracked.imports, `${label} tracked compiled imports`).toEqual([]);
        await assertDateRuntime(tracked, target, label);
      }
    },
  );

  it.each(["standalone", "wasi"] as const)(
    "retains all exact Date descriptors for %s hostBridge always with tracked parity",
    async (target) => {
      const label = `${target}/always`;
      const fileName = `issue-3520-c39-date-${target}-always.ts`;
      const untrackedGenerated = generateSingle(DATE_SOURCE, fileName, target, "always");
      const trackedGenerated = generateSingle(DATE_SOURCE, fileName, target, "always", true);
      assertExactPublicSurface(
        untrackedGenerated,
        `${label}/untracked`,
        target,
        "always",
        dateHostBridgeExportsFor(target),
      );
      assertExactPublicSurface(
        trackedGenerated,
        `${label}/tracked`,
        target,
        "always",
        dateHostBridgeExportsFor(target),
      );
      assertExactDateCensus(untrackedGenerated, `${label}/untracked`);
      assertExactDateCensus(trackedGenerated, `${label}/tracked`);
      assertGeneratedParity(untrackedGenerated, trackedGenerated, label);

      const untracked = await compile(DATE_SOURCE, compileOptions(fileName, target, "always"));
      const tracked = await compile(DATE_SOURCE, compileOptions(fileName, target, "always", true));
      assertCompiledParity(untracked, tracked, label);
      await assertDateRuntime(tracked, target, label);
    },
  );

  it("keeps a Date-free source and context free of Date records, exports, functions, and carrier types", () => {
    const generated = generateSingle(DATE_FREE_SOURCE, "issue-3520-c39-date-free.ts", "standalone", "always", true);
    assertExactPublicSurface(
      generated,
      "Date-free standalone/always",
      "standalone",
      "always",
      DATE_FREE_TARGET_HOST_BRIDGE_EXPORTS,
    );
    expect(dateEntries(generated), "Date-free exports").toEqual([]);
    expect(
      generated.module.functions.some((func) => isDateBridgeName(func.name)),
      "Date-free functions",
    ).toBe(false);
    expect(
      generated.module.types.some((type) => type.kind === "struct" && type.name === "__Date"),
      "Date-free carrier type",
    ).toBe(false);

    for (const emitHostBridge of [true, false]) {
      const module = createEmptyModule();
      const ctx = createCodegenContext(module, {} as ts.TypeChecker, { target: "standalone", hostBridge: "off" });
      emitDateHostBridge(ctx);
      const probe: WasmExport = { name: DATE_BRIDGE_NAMES[0], desc: { kind: "func", index: 0 } };
      expect(isCompilerOwnedDateHostBridgeExport(ctx, probe), `Date-free ownership ${emitHostBridge}`).toBe(false);
      const before = snapshotExports(ctx as Context);
      expect(() => finalizeDateHostBridgeExports(ctx), `Date-free finalizer ${emitHostBridge}`).not.toThrow();
      ctx.emitHostBridge = emitHostBridge;
      expect(stripHostBridgeExports(ctx), `Date-free policy ${emitHostBridge}`).toBe(0);
      expect(ctx.mod.exports, `Date-free policy ${emitHostBridge} export contents`).toEqual(before.array);
    }
  });

  it("keeps provider-created Date publication policy, descriptors, import census, binary parity, and runtime independent of source order", async () => {
    const orderBaselines = new Map<
      string,
      {
        readonly generated: ReturnType<typeof exportDescriptorCensus>;
        readonly imports: ReturnType<typeof importDescriptorCensus>;
        readonly binary: Uint8Array;
      }
    >();
    for (const { label: order, files } of DATE_MULTI_SOURCE_ORDERS) {
      for (const target of ["host", "standalone", "wasi"] as const) {
        for (const hostBridge of ["auto", "off", "always"] as const) {
          const label = `${order}/${target}/${hostBridge}`;
          const fileName = `issue-3520-c39-date-provider-${order}-${target}-${hostBridge}.ts`;
          const untrackedGenerated = generateGraph(files, "./entry.ts", target, hostBridge);
          const trackedGenerated = generateGraph(files, "./entry.ts", target, hostBridge, true);
          assertExactPublicSurface(
            untrackedGenerated,
            `${label}/untracked`,
            target,
            hostBridge,
            multiDateHostBridgeExportsFor(target),
            multiSourcePolicySurvivors(target, hostBridge),
          );
          assertExactPublicSurface(
            trackedGenerated,
            `${label}/tracked`,
            target,
            hostBridge,
            multiDateHostBridgeExportsFor(target),
            multiSourcePolicySurvivors(target, hostBridge),
          );
          const dateShouldRemain = target === "host" ? hostBridge !== "off" : hostBridge === "always";
          if (dateShouldRemain) {
            assertExactDateCensus(untrackedGenerated, `${label}/untracked`, true);
            assertExactDateCensus(trackedGenerated, `${label}/tracked`, true);
          } else {
            expect(dateEntries(untrackedGenerated), `${label} untracked Date exports`).toEqual([]);
            expect(dateEntries(trackedGenerated), `${label} tracked Date exports`).toEqual([]);
          }
          assertExactMultiImportCensus(untrackedGenerated, target, `${label}/untracked`);
          assertExactMultiImportCensus(trackedGenerated, target, `${label}/tracked`);
          assertGeneratedParity(untrackedGenerated, trackedGenerated, label);

          const untracked = await compileMulti(files, "./entry.ts", compileOptions(fileName, target, hostBridge));
          const tracked = await compileMulti(files, "./entry.ts", compileOptions(fileName, target, hostBridge, true));
          assertCompiledParity(untracked, tracked, label);
          if (target !== "host") {
            expect(untracked.imports, `${label} untracked compiled imports`).toEqual([]);
            expect(tracked.imports, `${label} tracked compiled imports`).toEqual([]);
          }
          await assertDateRuntime(tracked, target, label);

          const key = `${target}/${hostBridge}`;
          const baseline = orderBaselines.get(key);
          const generated = exportDescriptorCensus(trackedGenerated);
          const imports = importDescriptorCensus(trackedGenerated);
          if (baseline) {
            expect(generated, `${label} source-order descriptor parity`).toEqual(baseline.generated);
            expect(imports, `${label} source-order import parity`).toEqual(baseline.imports);
            expect(tracked.binary, `${label} source-order binary parity`).toEqual(baseline.binary);
          } else {
            orderBaselines.set(key, { generated, imports, binary: tracked.binary });
          }
        }
      }
    }
  });

  it("retains a genuine same-spelled user descriptor and a near spelling that targets a recorded Date allocator", () => {
    const ctx = makeDateContext();
    const recorded = dateEntry(ctx);
    if (recorded.desc.kind !== "func") throw new Error("Date descriptor is not a function");
    const user = appendDistinctUserExport(ctx, recorded.name);
    const near = cloneExport(recorded, `${recorded.name}$`);
    ctx.mod.exports.push(near);
    expect(isCompilerOwnedDateHostBridgeExport(ctx, user)).toBe(false);
    expect(isCompilerOwnedDateHostBridgeExport(ctx, near)).toBe(false);
    expect(isCoreDateHostBridgePublicName(near.name)).toBe(false);

    ctx.emitHostBridge = false;
    expect(stripHostBridgeExports(ctx)).toBe(DATE_BRIDGE_NAMES.length);
    expect(ctx.mod.exports).toContain(user);
    expect(ctx.mod.exports).toContain(near);
    expect(ctx.mod.exports).not.toContain(recorded);
  });

  it("validates and strips all recorded Date descriptors through distinct stable handles", () => {
    const ctx = makeDateContext();
    const entries = DATE_BRIDGE_NAMES.map((name) => dateEntry(ctx, name));
    const funcs = entries.map((entry) => contextFunctionForExport(ctx, entry));
    for (const [ordinal, entry] of entries.entries()) {
      const func = funcs[ordinal]!;
      const position = ctx.mod.functions.indexOf(func);
      expect(position, `stable Date allocator ${entry.name}`).toBeGreaterThanOrEqual(0);
      ctx.mod.funcOrdinalToPosition.push(position);
      entry.desc = { kind: "func", index: STABLE_FUNC_BASE + ordinal };
      expect(definedFuncAt(ctx, entry.desc.index), `stable Date handle ${entry.name}`).toBe(func);
    }

    finalizeDateHostBridgeExports(ctx);
    ctx.emitHostBridge = false;
    expect(stripHostBridgeExports(ctx)).toBe(DATE_BRIDGE_NAMES.length);
    expect(ctx.mod.exports).toEqual([]);
  });

  it("validates and strips all recorded Date descriptors against the current function-import prefix", () => {
    const ctx = makeDateContext();
    const entries = DATE_BRIDGE_NAMES.map((name) => dateEntry(ctx, name));
    const funcs = entries.map((entry) => contextFunctionForExport(ctx, entry));
    ctx.mod.imports.push({
      module: "env",
      name: "late_date_import",
      desc: { kind: "func", typeIdx: funcs[0]!.typeIdx },
    });
    expect(ctx.numImportFuncs, "stale creation-time import count").toBe(0);
    for (const [index, entry] of entries.entries()) {
      entry.desc = { kind: "func", index: index + 1 };
      expect(contextFunctionForExport(ctx, entry), `rebased Date handle ${entry.name}`).toBe(funcs[index]);
    }

    finalizeDateHostBridgeExports(ctx);
    ctx.emitHostBridge = false;
    expect(stripHostBridgeExports(ctx)).toBe(DATE_BRIDGE_NAMES.length);
    expect(ctx.mod.exports).toEqual([]);
  });

  it("rejects a same-context exact-name clone after a successful pre-freeze validation without a partial rewrite", () => {
    const ctx = makeDateContext();
    const recorded = dateEntry(ctx);
    finalizeDateHostBridgeExports(ctx);
    const clone = cloneExport(recorded);
    ctx.mod.exports.push(clone);
    expect(isCompilerOwnedDateHostBridgeExport(ctx, clone)).toBe(false);
    expectPreFreezeRejection(
      ctx,
      /unrecorded Date host bridge export descriptor .* resolves to a recorded allocator function/,
      "same-context clone",
    );
  });

  it("rejects an identically laid-out foreign-context Date descriptor without a partial rewrite", () => {
    const recipient = makeDateContext();
    const donor = makeDateContext();
    const recipientEntry = dateEntry(recipient);
    const donorEntry = dateEntry(donor);
    if (recipientEntry.desc.kind !== "func" || donorEntry.desc.kind !== "func") {
      throw new Error("Date donor descriptors are not functions");
    }
    expect(donorEntry).not.toBe(recipientEntry);
    expect(donorEntry.desc.index, "identical-layout handle").toBe(recipientEntry.desc.index);
    expect(isCompilerOwnedDateHostBridgeExport(donor, donorEntry)).toBe(true);
    expect(isCompilerOwnedDateHostBridgeExport(recipient, donorEntry)).toBe(false);
    recipient.mod.exports.push(donorEntry);
    expectPreFreezeRejection(
      recipient,
      /unrecorded Date host bridge export descriptor .* resolves to a recorded allocator function/,
      "foreign-context donor",
    );
  });

  it("keeps a post-freeze replacement copy unowned and retained without allocator fallback", () => {
    const ctx = makeDateContext();
    const recordedIndex = ctx.mod.exports.indexOf(dateEntry(ctx));
    if (recordedIndex < 0) throw new Error("missing recorded Date descriptor");
    const recorded = ctx.mod.exports[recordedIndex]!;
    finalizeDateHostBridgeExports(ctx);
    ctx.indexSpaceFrozen = true;
    const replacement = cloneExport(recorded);
    ctx.mod.exports[recordedIndex] = replacement;
    expect(isCompilerOwnedDateHostBridgeExport(ctx, replacement)).toBe(false);

    ctx.emitHostBridge = false;
    expect(stripHostBridgeExports(ctx)).toBe(DATE_BRIDGE_NAMES.length - 1);
    expect(ctx.mod.exports).toContain(replacement);
    expect(ctx.mod.exports).not.toContain(recorded);
  });

  it.each([
    ["vec", "$v0"],
    ["constructor-closure", "$ch"],
  ] as const)(
    "strips a recorded Date descriptor renamed into the %s namespace before retaining a genuine user descriptor",
    (family, name) => {
      const ctx = makeDateContext();
      const recorded = dateEntry(ctx);
      const user = appendDistinctUserExport(ctx, name);
      finalizeDateHostBridgeExports(ctx);
      ctx.indexSpaceFrozen = true;
      recorded.name = name;
      expect(isCompilerOwnedDateHostBridgeExport(ctx, recorded)).toBe(true);
      expect(isCompilerOwnedDateHostBridgeExport(ctx, user)).toBe(false);

      ctx.emitHostBridge = false;
      expect(stripHostBridgeExports(ctx), family).toBe(DATE_BRIDGE_NAMES.length);
      expect(ctx.mod.exports).not.toContain(recorded);
      expect(ctx.mod.exports).toContain(user);
    },
  );

  it.each([
    {
      name: "missing descriptor",
      mutate: (ctx: Context, entry: WasmExport) => {
        ctx.mod.exports.splice(ctx.mod.exports.indexOf(entry), 1);
      },
      expected: /disappeared before finalization/,
    },
    {
      name: "duplicate descriptor object",
      mutate: (ctx: Context, entry: WasmExport) => {
        ctx.mod.exports.push(entry);
      },
      expected: /appears more than once in the module/,
    },
    {
      name: "renamed descriptor",
      mutate: (_ctx: Context, entry: WasmExport) => {
        entry.name = "__\0js2_is_date$";
      },
      expected: /changed its published name/,
    },
    {
      name: "kind-changed descriptor",
      mutate: (_ctx: Context, entry: WasmExport) => {
        entry.desc = { kind: "global", index: 0 };
      },
      expected: /changed kind to global/,
    },
    {
      name: "retargeted descriptor",
      mutate: (ctx: Context, entry: WasmExport) => {
        const other = dateEntry(ctx, DATE_BRIDGE_NAMES[1]);
        if (other.desc.kind !== "func") throw new Error("alternate Date descriptor is not a function");
        entry.desc = { kind: "func", index: other.desc.index };
      },
      expected: /resolves to a different allocator function/,
    },
    {
      name: "one-past live handle",
      mutate: (ctx: Context, entry: WasmExport) => {
        entry.desc = {
          kind: "func",
          index:
            ctx.mod.imports.filter((candidate) => candidate.desc.kind === "func").length + ctx.mod.functions.length,
        };
        if (entry.desc.kind !== "func" || entry.desc.index >= STABLE_FUNC_BASE) {
          throw new Error("one-past Date handle did not stay in the live regime");
        }
      },
      expected: /resolves to a different allocator function/,
    },
    {
      name: "negative live handle",
      mutate: (_ctx: Context, entry: WasmExport) => {
        entry.desc = { kind: "func", index: -1 };
      },
      expected: /resolves to a different allocator function/,
    },
    {
      name: "invalid live handle despite a stable ordinal",
      mutate: (ctx: Context, entry: WasmExport) => {
        const func = contextFunctionForExport(ctx, entry);
        ctx.mod.funcOrdinalToPosition.push(ctx.mod.functions.indexOf(func));
        expect(definedFuncAt(ctx, STABLE_FUNC_BASE), "available stable Date allocator").toBe(func);
        ctx.mod.imports.push({
          module: "env",
          name: "late_date_import",
          desc: { kind: "func", typeIdx: func.typeIdx },
        });
        if (entry.desc.kind !== "func" || entry.desc.index >= STABLE_FUNC_BASE) {
          throw new Error("Date descriptor did not remain a live handle");
        }
      },
      expected: /resolves to a different allocator function/,
    },
    {
      name: "removed allocator",
      mutate: (ctx: Context, entry: WasmExport) => {
        const func = contextFunctionForExport(ctx, entry);
        ctx.mod.functions.splice(ctx.mod.functions.indexOf(func), 1);
      },
      expected: /lost its allocator function/,
    },
    {
      name: "duplicated allocator object",
      mutate: (ctx: Context, entry: WasmExport) => {
        ctx.mod.functions.push(contextFunctionForExport(ctx, entry));
      },
      expected: /allocator function .* appears more than once in the module/,
    },
  ] as const)("fails closed before policy rewrite for %s", ({ name, mutate, expected }) => {
    const ctx = makeDateContext();
    const entry = dateEntry(ctx);
    mutate(ctx, entry);
    expectPreFreezeRejection(ctx, expected, name);
  });
});
