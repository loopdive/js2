// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { SINGLE_HOST_ENTRIES } from "../scripts/check-ir-only.js";
import { analyzeSource } from "../src/checker/index.js";
import { definedFuncAt } from "../src/codegen/func-space.js";
import { generateModule } from "../src/codegen/index.js";
import { ProgramAbiCallableRegistry } from "../src/codegen/program-abi-callable-planning.js";
import {
  VEC_HOST_BRIDGE_ROLE,
  type VecHostBridgeKind,
  resolveVecHostBridgeHelper,
  vecHostBridgePhysicalExportBase,
} from "../src/codegen/vec-access-exports.js";
import { type CompileResult, compile } from "../src/index.js";
import { irSupportFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import type { WasmFunction } from "../src/ir/types.js";
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

const ARRAY_FREE_PHYSICAL_SPOOF_SOURCE = `
  export function $v0(): number { return 701; }

  class Empty {
    m(): number { return 1; }
  }

  export function mkInstance(): Empty {
    return new Empty();
  }
`;

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

  it("keeps captured bridge objects through late-import shifts and dead-import compaction", () => {
    let registry: ProgramAbiCallableRegistry | undefined;
    let observedImportCount = -1;
    let reserved: readonly WasmFunction[] = [];
    const handleImportCounts: number[] = [];
    const originalObserve = ProgramAbiCallableRegistry.prototype.observeEntrySourceSupports;
    const originalHandle = ProgramAbiCallableRegistry.prototype.handleForEntrySourceSupport;
    const observe = vi
      .spyOn(ProgramAbiCallableRegistry.prototype, "observeEntrySourceSupports")
      .mockImplementation(function (observations) {
        registry = this;
        observedImportCount = this.ctx.numImportFuncs;
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

  it("keeps tracked output and IR routing stable across the composed five-entry census", async () => {
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

    let definedFunctions = 0;
    let genericRows = 0;
    let vecRows = 0;
    let closureRows = 0;
    let dateRows = 0;
    let dataRows = 0;
    for (const entry of SINGLE_HOST_ENTRIES) {
      const source = readFileSync(resolve(entry), "utf8");
      const ast = analyzeSource(source, entry);
      const result = generateModule(ast, {
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      const hardErrors = result.errors.filter((error) => error.severity !== "warning");
      expect(hardErrors, `${entry}\n${hardErrors.map((error) => error.message).join("\n")}`).toEqual([]);
      definedFunctions += result.module.functions.length;
      const entries = result.programAbi!.abi.entries();
      genericRows += entries.filter((candidate) => candidate.id.includes("retained-module-function")).length;
      vecRows += entries.filter((candidate) => candidate.id.includes(VEC_HOST_BRIDGE_ROLE)).length;
      closureRows += entries.filter((candidate) => candidate.id.includes(":closure-host-bridge:")).length;
      dateRows += entries.filter((candidate) => candidate.id.includes(":date-civil-support:")).length;
      dataRows += entries.filter((candidate) => candidate.id.includes(":data-struct-host-bridge:")).length;
    }
    expect({ definedFunctions, genericRows, vecRows, closureRows, dateRows, dataRows }).toEqual({
      definedFunctions: 166,
      genericRows: 45,
      vecRows: 24,
      closureRows: 26,
      dateRows: 1,
      dataRows: 5,
    });
  });
});
