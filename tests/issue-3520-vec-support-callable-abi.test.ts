// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { SINGLE_HOST_ENTRIES } from "../scripts/check-ir-only.js";
import { analyzeSource } from "../src/checker/index.js";
import { definedFuncAt } from "../src/codegen/func-space.js";
import { stripHostBridgeExports } from "../src/codegen/host-bridge-exports.js";
import { generateModule } from "../src/codegen/index.js";
import { ProgramAbiCallableRegistry } from "../src/codegen/program-abi-callable-planning.js";
import {
  VEC_HOST_BRIDGE_ROLE,
  type VecHostBridgeKind,
  finalizeVecHostBridgeExports,
  isCoreVecHostBridgePublicName,
  resolveVecHostBridgeHelper,
  vecHostBridgePhysicalExportBase,
} from "../src/codegen/vec-access-exports.js";
import { emitBinary } from "../src/emit/binary.js";
import { STABLE_FUNC_BASE } from "../src/emit/resolve-layout.js";
import { type CompileResult, compile } from "../src/index.js";
import { irSupportFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import type { WasmExport, WasmFunction } from "../src/ir/types.js";
import { buildImports, instantiateWasm, wrapExports } from "../src/runtime.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const VEC_BRIDGES: readonly {
  kind: VecHostBridgeKind;
  name: string;
  ordinal: number;
}[] = [
  { kind: "len", name: "__vec_len", ordinal: 0 },
  { kind: "get", name: "__vec_get", ordinal: 1 },
  { kind: "is-vec", name: "__is_vec", ordinal: 2 },
  { kind: "mut-supported", name: "__vec_mut_supported", ordinal: 3 },
  { kind: "push", name: "__vec_push", ordinal: 4 },
  { kind: "pop", name: "__vec_pop", ordinal: 5 },
];

function isVecHostBridgePhysicalExport(name: string): boolean {
  return VEC_BRIDGES.some((bridge) => {
    const base = vecHostBridgePhysicalExportBase(bridge.kind);
    return name.startsWith(base) && /^\$*$/.test(name.slice(base.length));
  });
}

const ARRAY_SOURCE = `
  function __vec_get(_value: any, _index: number): number { return 99; }
  export function main(): number {
    const values: any = [41];
    values.push(1);
    values.pop();
    return values[0] + __vec_get(values, 0);
  }
`;

const ALL_PUBLIC_COLLISION_SOURCE = `
  export function __vec_len(): number { return 101; }
  export function __vec_get(): number { return 102; }
  export function __is_vec(): number { return 103; }
  export function __vec_mut_supported(): number { return 104; }
  export function __vec_push(): number { return 105; }
  export function __vec_pop(): number { return 106; }
  export function $v0(): number { return 901; }
  export function $v0$$(): number { return 902; }

  export function dynamicPush(values: any, value: any): any {
    return values.push(value);
  }

  export function dynamicPop(values: any): any {
    return values.pop();
  }

  export function echo(values: any): any {
    return values;
  }

  export function returnedValues(): number[] {
    return [7, 8];
  }
`;

const PREFIX_ONLY_COLLISION_SOURCE = `
  export function $v0(): number { return 201; }
  export function $v1(): number { return 202; }
  export function $v2(): number { return 203; }
  export function $v3(): number { return 204; }
  export function $v4(): number { return 205; }
  export function $v5(): number { return 206; }

  class Empty {
    m(): number { return 1; }
  }

  export function mkInstance(): Empty {
    return new Empty();
  }

  export function dynamicPush(values: any, value: any): any {
    return values.push(value);
  }

  export function echo(values: any): any {
    return values;
  }

  export function returnedValues(): number[] {
    return [7, 8];
  }
`;

const SPARSE_PHYSICAL_COLLISION_SOURCE = `
  export function $v0(): number { return 301; }
  export function $v0$$(): number { return 302; }
  export function $v0$$$$(): number { return 304; }

  export function dynamicPush(values: any, value: any): any {
    return values.push(value);
  }

  export function returnedValues(): number[] {
    return [7, 8];
  }
`;

const HOST_FREE_PHYSICAL_COLLISION_SOURCE = `
  export function $v0$(): number { return 811; }

  export function returnedValues(): number[] {
    return [7, 8];
  }
`;

const ARRAY_FREE_PHYSICAL_SPOOF_SOURCE = `
  export function $v0(): number { return 701; }

  class Empty {
    m(): number { return 1; }
  }

  export function mkInstance(): Empty {
    return new Empty();
  }
`;

const ARRAY_FREE_LOGICAL_SPOOF_SOURCE = `
  export function __vec_len(): number { return 702; }

  class Empty {
    m(): number { return 1; }
  }

  export function mkInstance(): Empty {
    return new Empty();
  }
`;

const ALL_PUBLIC_COLLISION_VALUES = [
  ["__vec_len", 101],
  ["__vec_get", 102],
  ["__is_vec", 103],
  ["__vec_mut_supported", 104],
  ["__vec_push", 105],
  ["__vec_pop", 106],
  ["$v0", 901],
  ["$v0$$", 902],
] as const;

const PREFIX_ONLY_COLLISION_VALUES = [
  ["$v0", 201],
  ["$v1", 202],
  ["$v2", 203],
  ["$v3", 204],
  ["$v4", 205],
  ["$v5", 206],
] as const;

const STANDALONE_VALUE_HELPER_EXPORTS = [
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

function assertFunctionValueCensus(
  exports: Record<string, WebAssembly.ExportValue>,
  expected: readonly (readonly [string, number])[],
): void {
  for (const [name, value] of expected) {
    expect(exports[name], name).toEqual(expect.any(Function));
    expect((exports[name] as () => number)(), name).toBe(value);
  }
}

function generate(source: string, fileName: string, trackIrOutcomes = true) {
  const ast = analyzeSource(source, fileName);
  return {
    ast,
    result: generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes,
    }),
  };
}

function generateWithCapturedRegistry(
  source: string,
  fileName: string,
): {
  readonly registry: ProgramAbiCallableRegistry;
  readonly result: ReturnType<typeof generate>["result"];
} {
  let registry: ProgramAbiCallableRegistry | undefined;
  const original = ProgramAbiCallableRegistry.prototype.observeEntrySourceSupports;
  const observe = vi
    .spyOn(ProgramAbiCallableRegistry.prototype, "observeEntrySourceSupports")
    .mockImplementation(function (observations) {
      registry = this;
      return original.call(this, observations);
    });
  let result: ReturnType<typeof generate>["result"];
  try {
    result = generate(source, fileName).result;
  } finally {
    observe.mockRestore();
  }
  if (!registry) throw new Error(`missing vec Program ABI registry for ${fileName}`);
  return { registry, result };
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
  imports.setInstance?.(instance);
  return instance.exports as Record<string, WebAssembly.ExportValue>;
}

describe("#3520 vec host-bridge Program ABI ownership", () => {
  it("classifies only exact core logical and physical vec names", () => {
    expect(VEC_BRIDGES.every((bridge) => isCoreVecHostBridgePublicName(bridge.name))).toBe(true);
    expect(["$v0", "$v0$", "$v0$$", "$v5$$$$"].every(isCoreVecHostBridgePublicName)).toBe(true);
    expect(["$v00", "$v0x", "$v6", "__vec_len$", "__vec_custom"].some(isCoreVecHostBridgePublicName)).toBe(false);
  });

  it("publishes all six bridges beneath the entry source with fixed ordinals and exact final slots", () => {
    const { ast, result } = generate(ARRAY_SOURCE, "vec-host-bridge.ts");
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const entrySource = inventory.sources.find((source) => source.kind === "entry");
    if (!entrySource) throw new Error("missing entry source");

    const entries = result.programAbi!.abi.entries();
    const importCount = result.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
    for (const bridge of VEC_BRIDGES) {
      const ref = irSupportFuncRef(entrySource.id, VEC_HOST_BRIDGE_ROLE, bridge.name, bridge.ordinal);
      if (ref.binding.kind !== "support") throw new Error(`missing ${bridge.name} support reference`);
      const entry = entries.find((candidate) => candidate.id === ref.binding.bindingId);
      expect(entry).toMatchObject({
        id: ref.binding.bindingId,
        displayName: bridge.name,
        slotPolicy: "required",
        slotSpace: "function",
        intent: {
          kind: "callable",
          origin: "support",
          sourceId: entrySource.id,
        },
      });
      const slot = result.programAbi!.abi.resolveFinalIndex(ref.binding.bindingId);
      expect(slot).toEqual(expect.objectContaining({ space: "function" }));
      if (!slot || slot.space !== "function") throw new Error(`missing ${bridge.name} final slot`);
      expect(result.module.functions[slot.index - importCount]?.name).toBe(bridge.name);
    }

    const genericVecRows = entries.filter(
      (entry) =>
        entry.id.includes("retained-module-function") &&
        VEC_BRIDGES.some((bridge) => bridge.name === entry.displayName),
    );
    expect(genericVecRows).toEqual([]);
    expect(result.module.exports.filter((entry) => isVecHostBridgePhysicalExport(entry.name))).toEqual([]);
  });

  it("keeps the exact reserved allocator objects through final body filling", () => {
    let registry: ProgramAbiCallableRegistry | undefined;
    let reserved: readonly WasmFunction[] = [];
    const original = ProgramAbiCallableRegistry.prototype.observeEntrySourceSupports;
    const observe = vi
      .spyOn(ProgramAbiCallableRegistry.prototype, "observeEntrySourceSupports")
      .mockImplementation(function (observations) {
        registry = this;
        reserved = observations.map((observation) => {
          const func = definedFuncAt(this.ctx, observation.funcIdx);
          if (!func) throw new Error(`missing reserved helper ${observation.displayName}`);
          return func;
        });
        return original.call(this, observations);
      });
    const { result } = generate(ARRAY_SOURCE, "vec-reserve-fill.ts");
    observe.mockRestore();

    expect(reserved).toHaveLength(6);
    expect(registry).toBeDefined();
    for (const [index, bridge] of VEC_BRIDGES.entries()) {
      const func = reserved[index]!;
      const handle = registry!.handleForEntrySourceSupport(VEC_HOST_BRIDGE_ROLE, bridge.ordinal);
      expect(handle).toBeDefined();
      expect(handle === undefined ? undefined : definedFuncAt(registry!.ctx, handle)).toBe(func);
      expect(result.module.functions).toContain(func);
      expect(func.body).not.toEqual(
        bridge.kind === "get" || bridge.kind === "pop" ? [{ op: "ref.null.extern" }] : [{ op: "i32.const", value: 0 }],
      );
      expect(resolveVecHostBridgeHelper(registry!.ctx, bridge.kind)).toBe(handle);
      const entrySource = registry!.session.inventory.sources.find((source) => source.kind === "entry");
      if (!entrySource) throw new Error("missing registry entry source");
      const ref = irSupportFuncRef(entrySource.id, VEC_HOST_BRIDGE_ROLE, bridge.name, bridge.ordinal);
      if (ref.binding.kind !== "support") throw new Error(`missing ${bridge.name} support reference`);
      const slot = result.programAbi!.abi.resolveFinalIndex(ref.binding.bindingId);
      if (!slot || slot.space !== "function") throw new Error(`missing ${bridge.name} final slot`);
      const importCount = result.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
      expect(result.module.functions[slot.index - importCount]).toBe(func);
    }
  });

  it("keeps collision-free GC, standalone, and WASI binaries byte-identical with tracking", async () => {
    const source = `export function returnedValues(): number[] { return [7, 8]; }`;
    for (const target of ["gc", "standalone", "wasi"] as const) {
      const baseOptions = {
        fileName: `vec-collision-free-${target}.ts`,
        experimentalIR: true,
        target,
      } as const;
      const untracked = await compile(source, baseOptions);
      const tracked = await compile(source, { ...baseOptions, trackIrOutcomes: true });
      expect(untracked.success, `${target}: ${untracked.errors.map((error) => error.message).join("\n")}`).toBe(true);
      expect(tracked.success, `${target}: ${tracked.errors.map((error) => error.message).join("\n")}`).toBe(true);
      expect(tracked.binary, target).toEqual(untracked.binary);
      const module = await WebAssembly.compile(tracked.binary);
      expect(
        WebAssembly.Module.exports(module)
          .map(({ name }) => name)
          .filter(isVecHostBridgePhysicalExport),
        target,
      ).toEqual([]);
    }
  });

  it("strips exact compiler-owned suffixed aliases without deleting standalone or WASI user collisions", async () => {
    for (const target of ["standalone", "wasi"] as const) {
      const result = await compile(HOST_FREE_PHYSICAL_COLLISION_SOURCE, {
        fileName: `vec-host-free-physical-collision-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      });
      expect(result.success, `${target}: ${result.errors.map((error) => error.message).join("\n")}`).toBe(true);
      const module = await WebAssembly.compile(result.binary);
      const exportNames = WebAssembly.Module.exports(module).map(({ name }) => name);
      expect(exportNames, target).toContain("$v0$");
      expect(exportNames, target).not.toContain("__vec_len");
      expect(exportNames, target).not.toContain("$v0");
      expect(exportNames, target).not.toContain("$v0$$");
    }
  });

  it("emits no vec bridge for an array-free module", () => {
    const arrayFree = generate(`export function main(): number { return 1; }`, "vec-array-free.ts").result;
    expect(
      arrayFree.module.functions.filter((func) => VEC_BRIDGES.some((bridge) => bridge.name === func.name)),
    ).toEqual([]);
    expect(arrayFree.programAbi!.abi.entries().filter((entry) => entry.id.includes(VEC_HOST_BRIDGE_ROLE))).toEqual([]);
  });

  it("preserves all six same-labelled public exports while the runtime uses physical vec bridges", async () => {
    const runtime = await compile(ALL_PUBLIC_COLLISION_SOURCE, {
      fileName: "vec-helper-public-collisions.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const rawExports = await instantiate(runtime);
    expect((rawExports.$v0 as () => number)()).toBe(901);
    expect((rawExports["$v0$$"] as () => number)()).toBe(902);
    const terminalPhysicalNames = new Set<string>();
    const physicalHelpers = new Set<WebAssembly.ExportValue>();
    for (const [index, bridge] of VEC_BRIDGES.entries()) {
      expect((rawExports[bridge.name] as () => number)()).toBe(101 + index);
      let physicalName = vecHostBridgePhysicalExportBase(bridge.kind);
      let physicalHelper: WebAssembly.ExportValue | undefined;
      let terminalPhysicalName: string | undefined;
      while (Object.prototype.hasOwnProperty.call(rawExports, physicalName)) {
        physicalHelper = rawExports[physicalName];
        terminalPhysicalName = physicalName;
        physicalName += "$";
      }
      expect(physicalHelper).toEqual(expect.any(Function));
      expect(physicalHelper).not.toBe(rawExports[bridge.name]);
      expect(terminalPhysicalName).toBeDefined();
      terminalPhysicalNames.add(terminalPhysicalName!);
      physicalHelpers.add(physicalHelper!);
    }
    expect(terminalPhysicalNames.size).toBe(6);
    expect(physicalHelpers.size).toBe(6);

    const wrapped = wrapExports(rawExports);
    const rawValues = (rawExports.returnedValues as () => unknown)();
    expect((rawExports.dynamicPush as (values: unknown, value: number) => number)(rawValues, 3)).toBe(3);
    const intermediate = wrapped.echo(rawValues);
    expect(intermediate.length).toBe(3);
    expect(intermediate[2]).toBe(3);
    expect((rawExports.dynamicPop as (values: unknown) => number)(rawValues)).toBe(3);
    const finalValues = wrapped.echo(rawValues);
    expect(finalValues.length).toBe(2);
    expect(finalValues).toEqual([7, 8]);
    expect(wrapped.returnedValues()).toEqual([7, 8]);
  });

  it("retains exact logical and physical user collisions in standalone and WASI", async () => {
    const expectedNames = [
      ...ALL_PUBLIC_COLLISION_VALUES.map(([name]) => name),
      ...STANDALONE_VALUE_HELPER_EXPORTS,
      "dynamicPush",
      "dynamicPop",
      "echo",
      "returnedValues",
    ];
    for (const target of ["standalone", "wasi"] as const) {
      const options = {
        fileName: `vec-all-public-collisions-${target}.ts`,
        experimentalIR: true,
        target,
      } as const;
      const untracked = await compile(ALL_PUBLIC_COLLISION_SOURCE, options);
      const tracked = await compile(ALL_PUBLIC_COLLISION_SOURCE, { ...options, trackIrOutcomes: true });
      expect(untracked.success, `${target} untracked`).toBe(true);
      expect(tracked.success, `${target} tracked`).toBe(true);
      expect(untracked.imports, `${target} untracked imports`).toEqual([]);
      expect(tracked.imports, `${target} tracked imports`).toEqual([]);
      expect(tracked.binary, `${target} tracked/untracked bytes`).toEqual(untracked.binary);

      const untrackedExports = await instantiate(untracked);
      const trackedExports = await instantiate(tracked);
      const targetExpectedNames = [...expectedNames, ...(target === "wasi" ? ["memory"] : [])].sort();
      expect(Object.keys(untrackedExports).sort(), `${target} public names`).toEqual(targetExpectedNames);
      expect(Object.keys(trackedExports).sort(), `${target} tracked public names`).toEqual(targetExpectedNames);
      expect(
        Object.keys(untrackedExports).filter(isVecHostBridgePhysicalExport).sort(),
        `${target} physical collision names`,
      ).toEqual(["$v0", "$v0$$"]);
      expect(
        Object.keys(trackedExports).filter(isVecHostBridgePhysicalExport).sort(),
        `${target} tracked physical collision names`,
      ).toEqual(["$v0", "$v0$$"]);
      assertFunctionValueCensus(untrackedExports, ALL_PUBLIC_COLLISION_VALUES);
      assertFunctionValueCensus(trackedExports, ALL_PUBLIC_COLLISION_VALUES);
    }
  });

  it("terminates all six prefix-only physical families with the structural helper", async () => {
    const runtime = await compile(PREFIX_ONLY_COLLISION_SOURCE, {
      fileName: "vec-helper-prefix-only-collisions.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const rawExports = await instantiate(runtime);
    for (const [index, bridge] of VEC_BRIDGES.entries()) {
      const physicalBase = vecHostBridgePhysicalExportBase(bridge.kind);
      expect((rawExports[physicalBase] as () => number)()).toBe(201 + index);
      expect(rawExports[`${physicalBase}$`]).toBe(rawExports[bridge.name]);
      expect(rawExports[`${physicalBase}$$`]).toBeUndefined();
    }
    expect(Object.keys(rawExports).filter(isVecHostBridgePhysicalExport)).toHaveLength(12);

    const wrapped = wrapExports(rawExports);
    const rawValues = (rawExports.returnedValues as () => unknown)();
    expect((rawExports.dynamicPush as (values: unknown, value: number) => number)(rawValues, 3)).toBe(3);
    expect(wrapped.echo(rawValues)).toEqual([7, 8, 3]);
    expect(wrapped.mkInstance()).toEqual({});
  });

  it("retains exact prefix-only user collisions in standalone and WASI", async () => {
    const expectedNames = [
      ...PREFIX_ONLY_COLLISION_VALUES.map(([name]) => name),
      ...STANDALONE_VALUE_HELPER_EXPORTS,
      "mkInstance",
      "dynamicPush",
      "echo",
      "returnedValues",
    ];
    for (const target of ["standalone", "wasi"] as const) {
      const options = {
        fileName: `vec-prefix-only-collisions-${target}.ts`,
        experimentalIR: true,
        target,
      } as const;
      const untracked = await compile(PREFIX_ONLY_COLLISION_SOURCE, options);
      const tracked = await compile(PREFIX_ONLY_COLLISION_SOURCE, { ...options, trackIrOutcomes: true });
      expect(untracked.success, `${target} untracked`).toBe(true);
      expect(tracked.success, `${target} tracked`).toBe(true);
      expect(untracked.imports, `${target} untracked imports`).toEqual([]);
      expect(tracked.imports, `${target} tracked imports`).toEqual([]);
      expect(tracked.binary, `${target} tracked/untracked bytes`).toEqual(untracked.binary);

      const untrackedExports = await instantiate(untracked);
      const trackedExports = await instantiate(tracked);
      const targetExpectedNames = [...expectedNames, ...(target === "wasi" ? ["memory"] : [])].sort();
      expect(Object.keys(untrackedExports).sort(), `${target} public names`).toEqual(targetExpectedNames);
      expect(Object.keys(trackedExports).sort(), `${target} tracked public names`).toEqual(targetExpectedNames);
      expect(
        Object.keys(untrackedExports).filter(isVecHostBridgePhysicalExport).sort(),
        `${target} physical collision names`,
      ).toEqual(PREFIX_ONLY_COLLISION_VALUES.map(([name]) => name).sort());
      expect(
        Object.keys(trackedExports).filter(isVecHostBridgePhysicalExport).sort(),
        `${target} tracked physical collision names`,
      ).toEqual(PREFIX_ONLY_COLLISION_VALUES.map(([name]) => name).sort());
      assertFunctionValueCensus(untrackedExports, PREFIX_ONLY_COLLISION_VALUES);
      assertFunctionValueCensus(trackedExports, PREFIX_ONLY_COLLISION_VALUES);
    }
  });

  it("fills sparse physical gaps without rebasing any occupied user descriptor", async () => {
    const runtime = await compile(SPARSE_PHYSICAL_COLLISION_SOURCE, {
      fileName: "vec-helper-sparse-physical-collisions.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const rawExports = await instantiate(runtime);
    expect((rawExports.$v0 as () => number)()).toBe(301);
    expect((rawExports["$v0$$"] as () => number)()).toBe(302);
    expect((rawExports["$v0$$$$"] as () => number)()).toBe(304);
    expect(rawExports["$v0$"]).toBe(rawExports.__vec_len);
    expect(rawExports["$v0$$$"]).toBe(rawExports.__vec_len);
    expect(rawExports["$v0$$$$$"]).toBe(rawExports.__vec_len);
    expect(rawExports["$v0$$$$$$"]).toBeUndefined();

    const rawValues = (rawExports.returnedValues as () => unknown)();
    expect((rawExports.dynamicPush as (values: unknown, value: number) => number)(rawValues, 3)).toBe(3);
    expect(wrapExports(rawExports).returnedValues()).toEqual([7, 8]);
  });

  it("does not project an array-free user physical prefix into a logical vec helper", async () => {
    const runtime = await compile(ARRAY_FREE_PHYSICAL_SPOOF_SOURCE, {
      fileName: "vec-helper-array-free-physical-spoof.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const rawExports = await instantiate(runtime);
    expect((rawExports.$v0 as () => number)()).toBe(701);
    for (const bridge of VEC_BRIDGES) {
      expect(rawExports[bridge.name]).toBeUndefined();
    }
    expect(Object.keys(rawExports).filter(isVecHostBridgePhysicalExport)).toEqual(["$v0"]);

    const wrapped = wrapExports(rawExports);
    expect(wrapped.mkInstance()).toEqual({});
  });

  it("keeps array-free logical and physical spoof exports public without a vec family", async () => {
    for (const [target, source, name, value] of [
      ["standalone", ARRAY_FREE_LOGICAL_SPOOF_SOURCE, "__vec_len", 702],
      ["wasi", ARRAY_FREE_LOGICAL_SPOOF_SOURCE, "__vec_len", 702],
      ["standalone", ARRAY_FREE_PHYSICAL_SPOOF_SOURCE, "$v0", 701],
      ["wasi", ARRAY_FREE_PHYSICAL_SPOOF_SOURCE, "$v0", 701],
    ] as const) {
      const result = await compile(source, {
        fileName: `vec-array-free-spoof-${target}-${name.replaceAll("$", "s")}.ts`,
        experimentalIR: true,
        target,
        trackIrOutcomes: true,
      });
      expect(result.success, `${target} ${name}`).toBe(true);
      expect(result.imports, `${target} ${name} imports`).toEqual([]);
      expect(result.programAbi?.abi.entries().filter((entry) => entry.id.includes(VEC_HOST_BRIDGE_ROLE)) ?? []).toEqual(
        [],
      );
      const rawExports = await instantiate(result);
      expect(Object.keys(rawExports)).toContain(name);
      expect((rawExports[name] as () => number)()).toBe(value);
      expect(Object.keys(rawExports).filter(isVecHostBridgePhysicalExport)).toEqual(
        name.startsWith("$v") ? [name] : [],
      );
    }
  });

  it("aborts compilation when structural vec ABI observation fails", () => {
    const observe = vi
      .spyOn(ProgramAbiCallableRegistry.prototype, "observeEntrySourceSupports")
      .mockImplementation(() => {
        throw new Error("forced vec observation failure");
      });
    try {
      const { result } = generate(ARRAY_SOURCE, "vec-observation-failure.ts");
      expect(result.errors.filter((error) => error.severity !== "warning")).not.toEqual([]);
      expect(result.errors.map((error) => error.message).join("\n")).toMatch(/forced vec observation failure/);
      expect(result.module.exports.filter((entry) => isVecHostBridgePhysicalExport(entry.name))).toEqual([]);
    } finally {
      observe.mockRestore();
    }
  });

  it("fails closed when a compiler-owned export entry is replaced, duplicated, retargeted, or loses its function", () => {
    const cases: readonly {
      readonly name: string;
      readonly mutate: (
        registry: ProgramAbiCallableRegistry,
        result: ReturnType<typeof generate>["result"],
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
        name: "retargeted",
        mutate: (_registry, result, entry) => {
          const other = result.module.exports.find(
            (candidate) => candidate.name === "__vec_get" && candidate.desc.kind === "func",
          );
          if (!other || other.desc.kind !== "func") throw new Error("missing alternate vec helper export");
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
        mutate: (registry, result) => {
          const handle = resolveVecHostBridgeHelper(registry.ctx, "len");
          const func = handle === undefined ? undefined : definedFuncAt(registry.ctx, handle);
          if (!func) throw new Error("missing vec len allocator");
          result.module.functions.splice(result.module.functions.indexOf(func), 1);
        },
        expected: /lost its allocator function/,
      },
    ];

    for (const mutation of cases) {
      const { registry, result } = generateWithCapturedRegistry(ARRAY_SOURCE, `vec-export-${mutation.name}.ts`);
      const entry = result.module.exports.find(
        (candidate) => candidate.name === "__vec_len" && candidate.desc.kind === "func",
      );
      if (!entry) throw new Error(`missing compiler-owned vec export for ${mutation.name}`);
      mutation.mutate(registry, result, entry);
      expect(() => finalizeVecHostBridgeExports(registry.ctx), mutation.name).toThrow(mutation.expected);
    }
  });

  it("fails closed when disabled host-bridge policy retains a compiler-owned descriptor", () => {
    const { registry, result } = generateWithCapturedRegistry(ARRAY_SOURCE, "vec-export-disabled-policy-survivor.ts");
    const entry = result.module.exports.find(
      (candidate) => candidate.name === "__vec_len" && candidate.desc.kind === "func",
    );
    if (!entry) throw new Error("missing compiler-owned vec export for disabled-policy-survivor");

    const originalEmitHostBridge = registry.ctx.emitHostBridge;
    try {
      registry.ctx.emitHostBridge = false;
      expect(result.module.exports).toContain(entry);
      expect(() => finalizeVecHostBridgeExports(registry.ctx)).toThrow(/survived disabled host-bridge policy/);
    } finally {
      registry.ctx.emitHostBridge = originalEmitHostBridge;
    }
  });

  it("strips a cloned descriptor that still resolves to the exact compiler allocator", () => {
    const { registry, result } = generateWithCapturedRegistry(ARRAY_SOURCE, "vec-export-cloned-descriptor.ts");
    const entryIndex = result.module.exports.findIndex(
      (candidate) => candidate.name === "__vec_len" && candidate.desc.kind === "func",
    );
    if (entryIndex < 0) throw new Error("missing compiler-owned vec export for cloned-descriptor");
    const entry = result.module.exports[entryIndex]!;
    if (entry.desc.kind !== "func") throw new Error("vec clone source changed export kind");
    const clone: WasmExport = { name: entry.name, desc: { kind: "func", index: entry.desc.index } };
    result.module.exports[entryIndex] = clone;
    const originalEmitHostBridge = registry.ctx.emitHostBridge;
    try {
      registry.ctx.emitHostBridge = false;
      expect(result.module.exports).toContain(clone);
      expect(stripHostBridgeExports(registry.ctx)).toBeGreaterThan(0);
      expect(result.module.exports).not.toContain(clone);
    } finally {
      registry.ctx.emitHostBridge = originalEmitHostBridge;
    }
  });

  it("keeps captured bridge objects through late-import shifts and dead-import compaction", () => {
    let registry: ProgramAbiCallableRegistry | undefined;
    let observedImportCount = -1;
    let reserved: readonly WasmFunction[] = [];
    const userExports = new Map<string, { readonly entry: WasmExport; readonly func: WasmFunction }>();
    const handleImportCounts: number[] = [];
    const originalObserve = ProgramAbiCallableRegistry.prototype.observeEntrySourceSupports;
    const originalHandle = ProgramAbiCallableRegistry.prototype.handleForEntrySourceSupport;
    const observe = vi
      .spyOn(ProgramAbiCallableRegistry.prototype, "observeEntrySourceSupports")
      .mockImplementation(function (observations) {
        registry = this;
        observedImportCount = this.ctx.numImportFuncs;
        for (const name of ["__vec_len", "$v0", "$v0$$"] as const) {
          const entry = this.ctx.mod.exports.find(
            (candidate) => candidate.name === name && candidate.desc.kind === "func",
          );
          const func = entry?.desc.kind === "func" ? definedFuncAt(this.ctx, entry.desc.index) : undefined;
          if (!entry || !func) throw new Error(`missing exact user export ${name} before vec publication`);
          userExports.set(name, { entry, func });
        }
        reserved = observations.map((observation) => {
          const func = definedFuncAt(this.ctx, observation.funcIdx);
          if (!func) throw new Error(`missing reserved helper ${observation.displayName}`);
          return func;
        });
        return originalObserve.call(this, observations);
      });
    const handle = vi
      .spyOn(ProgramAbiCallableRegistry.prototype, "handleForEntrySourceSupport")
      .mockImplementation(function (role, ordinal) {
        handleImportCounts.push(this.ctx.numImportFuncs);
        return originalHandle.call(this, role, ordinal);
      });
    let result: ReturnType<typeof generate>["result"];
    try {
      result = generate(
        `
          export function __vec_len(): number { return 801; }
          export function $v0(): number { return 802; }
          export function $v0$$(): number { return 803; }
          export function first(values: any): number { return values.push(1); }
          export function later(value: any): any { return value.missing; }
          export function stringLater(value: string): boolean { return value.includes("x"); }
          export function last(values: any): any { return values[0]; }
        `,
        "vec-late-import-compaction.ts",
      ).result;
    } finally {
      handle.mockRestore();
      observe.mockRestore();
    }

    const finalImportCount = result.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
    expect(Math.max(...handleImportCounts)).toBeGreaterThan(observedImportCount);
    expect(finalImportCount).toBeLessThan(Math.max(...handleImportCounts));
    expect(reserved).toHaveLength(6);
    expect(registry).toBeDefined();
    expect(userExports.size).toBe(3);
    for (const [name, { entry, func }] of userExports) {
      expect(result.module.exports, name).toContain(entry);
      expect(entry.desc.kind, name).toBe("func");
      if (entry.desc.kind !== "func") throw new Error(`${name} changed export kind`);
      expect(definedFuncAt(registry!.ctx, entry.desc.index), name).toBe(func);
    }
    const entrySource = registry!.session.inventory.sources.find((source) => source.kind === "entry");
    if (!entrySource) throw new Error("missing registry entry source");
    for (const [index, bridge] of VEC_BRIDGES.entries()) {
      const func = reserved[index]!;
      const ref = irSupportFuncRef(entrySource.id, VEC_HOST_BRIDGE_ROLE, bridge.name, bridge.ordinal);
      if (ref.binding.kind !== "support") throw new Error(`missing ${bridge.name} support reference`);
      const slot = result.programAbi!.abi.resolveFinalIndex(ref.binding.bindingId);
      if (!slot || slot.space !== "function") throw new Error(`missing ${bridge.name} final slot`);
      expect(result.module.functions[slot.index - finalImportCount]).toBe(func);
      expect(result.module.functions).toContain(func);
    }
  });

  it("keeps tracked output and structural ownership stable across the exact five-entry corpus", async () => {
    const untracked = await compile(ARRAY_SOURCE, {
      fileName: "vec-tracking-parity.ts",
      experimentalIR: true,
    });
    const tracked = await compile(ARRAY_SOURCE, {
      fileName: "vec-tracking-parity.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(tracked.success, tracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.binary).toEqual(untracked.binary);
    expect(tracked.irOutcomes?.map((outcome) => outcome.kind)).toEqual(["emitted", "unsupported"]);
    expect(untracked.irOutcomes).toBeUndefined();

    const routed = generate(ARRAY_SOURCE, "vec-routing.ts", true).result;
    const unreported = generate(ARRAY_SOURCE, "vec-routing.ts", false).result;
    expect(unreported.irCompiledFuncs).toEqual(routed.irCompiledFuncs);
    expect(routed.irOutcomes?.map((outcome) => outcome.kind)).toEqual(["emitted", "unsupported"]);
    expect(unreported.irOutcomes).toBeUndefined();
    expect(unreported.module.functions).toHaveLength(routed.module.functions.length);

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
      const tracked = generateModule(trackedAst, {
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      const untracked = generateModule(untrackedAst, {
        experimentalIR: true,
        trackIrOutcomes: false,
      });
      const trackedErrors = tracked.errors.filter((error) => error.severity !== "warning");
      const untrackedErrors = untracked.errors.filter((error) => error.severity !== "warning");
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
      const outcomeIds = outcomes.map((outcome) => outcome.unitId);
      expect(
        outcomeIds.every((id) => id !== undefined),
        `${entry} structural outcome ids`,
      ).toBe(true);
      expect(new Set(outcomeIds).size, `${entry} unique outcome ids`).toBe(outcomes.length);
      expect([...outcomeIds].sort(), `${entry} terminal outcome closure`).toEqual(
        inventory.terminalUnits.map((unit) => unit.id).sort(),
      );
      for (const outcome of outcomes) {
        expect(outcome.kind === "emitted" ? outcome.irBodyEmitted : !outcome.irBodyEmitted, outcome.key).toBe(true);
        if (outcome.kind === "unsupported") expect(outcome.legacyBodyEmitted, outcome.key).toBe(true);
        expect(outcome.kind, outcome.key).not.toBe("invariant");
      }

      const entrySource = inventory.sources.find((candidate) => candidate.kind === "entry");
      if (!entrySource) throw new Error(`missing entry source for ${entry}`);
      const abiEntries = tracked.programAbi!.abi.entries();
      const familyEntries = abiEntries.filter(
        (candidate) => candidate.intent.kind === "callable" && candidate.id.includes(`:${VEC_HOST_BRIDGE_ROLE}:`),
      );
      const retainedFallbacks = abiEntries.filter(
        (candidate) =>
          candidate.intent.kind === "callable" &&
          candidate.id.includes(":retained-module-function:") &&
          VEC_BRIDGES.some((bridge) => bridge.name === candidate.displayName),
      );
      expect(retainedFallbacks, `${entry} vec retained-module-function fallbacks`).toEqual([]);
      corpusRetainedFallbacks += retainedFallbacks.length;
      const ownedFunctions = new Set<WasmFunction>();
      for (const bridge of VEC_BRIDGES) {
        const ref = irSupportFuncRef(entrySource.id, VEC_HOST_BRIDGE_ROLE, bridge.name, bridge.ordinal);
        if (ref.binding.kind !== "support") throw new Error(`missing ${bridge.name} structural binding`);
        const matchingEntries = familyEntries.filter((candidate) => candidate.id === ref.binding.bindingId);
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
        expect(ownedFunctions.has(helper), `${entry} duplicate vec helper owner`).toBe(false);
        ownedFunctions.add(helper);
      }
      expect(familyEntries, `${entry} unbounded vec family rows`).toHaveLength(ownedFunctions.size);
      corpusOwnedFunctions += ownedFunctions.size;
    }
    expect(corpusOwnedFunctions, "five-entry vec ownership anti-vacuity").toBeGreaterThan(0);
    expect(corpusRetainedFallbacks, "five-entry vec retained-module-function fallback census").toBe(0);
  });
});
