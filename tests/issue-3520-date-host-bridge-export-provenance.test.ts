// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// C39 — Date carrier host-bridge export provenance. The Date helpers are
// compiler-only inspection exports for the JavaScript host. Their names are
// deliberately not broad namespace authority: removal is permitted only from
// the exact three-entry descriptor/function census captured by the emitter.

import { describe, expect, it } from "vitest";

import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  emitDateHostBridge,
  finalizeDateHostBridgeExports,
  isCompilerOwnedDateHostBridgeExport,
  isCoreDateHostBridgePublicName,
} from "../src/codegen/date-host-bridge.js";
import { stripHostBridgeExports } from "../src/codegen/host-bridge-exports.js";
import { type GeneratedCodegenModule, generateModule, generateMultiModule } from "../src/codegen/index.js";
import { emitBinary } from "../src/emit/binary.js";
import { STABLE_FUNC_BASE } from "../src/emit/resolve-layout.js";
import { type CompileOptions, compile, compileMulti } from "../src/index.js";
import { type WasmExport, type WasmFunction, createEmptyModule } from "../src/ir/types.js";
import { buildImports, buildWasiPolyfill } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const DATE_BRIDGE_NAMES = Object.freeze(["__\0js2_is_date", "__\0js2_date_value", "__\0js2_date_set_value"]);
const DATE_ALWAYS_BRIDGE_NAMES = Object.freeze([
  "__sget_length",
  "__sget_data",
  "__sget_byteOffset",
  "__sget_timestamp",
  "__sset_length",
  ...DATE_BRIDGE_NAMES,
  "__is_data_struct",
  "$d0",
  "__\0js2_data_struct_host_bridge_marker",
  "$dt",
  "__\0js2_data_struct_host_bridge_bindings",
  "$du",
  "__\0js2_data_struct_host_bridge",
  "$dm",
]);
const DATE_MULTI_ALWAYS_BRIDGE_NAMES = Object.freeze([
  "__sget_timestamp",
  ...DATE_BRIDGE_NAMES,
  "__is_data_struct",
  "$d0",
  "__\0js2_data_struct_host_bridge_marker",
  "$dt",
  "__\0js2_data_struct_host_bridge_bindings",
  "$du",
  "__\0js2_data_struct_host_bridge",
  "$dm",
]);

const DATE_SOURCE = `
  export function dateValue(): number {
    return new Date(5).getTime();
  }
`;

const DATE_MULTI_FILES = {
  "./provider.ts": `
    export function provideDate(): Date {
      return new Date(5);
    }
  `,
  "./entry.ts": `
    import { provideDate } from "./provider.ts";
    export function dateValue(): number {
      const value: Date = provideDate();
      return value.getTime();
    }
  `,
} as const;

type CompileResult = Awaited<ReturnType<typeof compile>>;
type GeneratedResult = ReturnType<typeof generateModule>;
type ErrorCarrier = {
  readonly errors: readonly {
    readonly severity: string;
    readonly message: string;
  }[];
};

function generatedOptions(options: Pick<CompileOptions, "target" | "hostBridge" | "trackIrOutcomes">) {
  return {
    experimentalIR: true,
    trackIrOutcomes: options.trackIrOutcomes,
    hostBridge: options.hostBridge,
    standalone: options.target === "standalone",
    wasi: options.target === "wasi",
  };
}

function generateSingle(
  source: string,
  fileName: string,
  options: Pick<CompileOptions, "target" | "hostBridge" | "trackIrOutcomes">,
): GeneratedResult {
  return generateModule(analyzeSource(source, fileName), generatedOptions(options));
}

function generateGraph(
  files: Record<string, string>,
  entryFile: string,
  options: Pick<CompileOptions, "target" | "hostBridge" | "trackIrOutcomes">,
): GeneratedCodegenModule {
  return generateMultiModule(analyzeMultiSource(files, entryFile), generatedOptions(options));
}

function hardErrors(result: ErrorCarrier): string[] {
  return result.errors.filter((error) => error.severity !== "warning").map((error) => error.message);
}

function dateEntries(result: GeneratedResult): WasmExport[] {
  return result.module.exports.filter((entry) => DATE_BRIDGE_NAMES.includes(entry.name));
}

function importFunctionCount(result: GeneratedResult): number {
  return result.module.imports.filter((entry) => entry.desc.kind === "func").length;
}

function expectedTargetExportNames(
  target: "standalone" | "wasi",
  hostBridge: "auto" | "off" | "always",
  alwaysBridgeNames: readonly string[],
) {
  return [...(target === "wasi" ? ["memory"] : []), "dateValue", ...(hostBridge === "always" ? alwaysBridgeNames : [])];
}

function assertExactTargetSurface(
  result: GeneratedCodegenModule,
  target: "standalone" | "wasi",
  hostBridge: "auto" | "off" | "always",
  alwaysBridgeNames: readonly string[] = DATE_ALWAYS_BRIDGE_NAMES,
): void {
  expect(result.module.imports, `${target}/${hostBridge} imports`).toEqual([]);
  expect(result.module.exports.map(({ name }) => name).sort(), `${target}/${hostBridge} exports`).toEqual(
    expectedTargetExportNames(target, hostBridge, alwaysBridgeNames).sort(),
  );
}

function functionForExport(result: GeneratedResult, entry: WasmExport): WasmFunction {
  if (entry.desc.kind !== "func") throw new Error(`Date export ${entry.name} is not a function`);
  const func = result.module.functions[entry.desc.index - importFunctionCount(result)];
  if (!func) throw new Error(`Date export ${entry.name} has no defined function target`);
  return func;
}

function assertExactDateCensus(result: GeneratedResult): void {
  expect(hardErrors(result), hardErrors(result).join("\n")).toEqual([]);
  const entries = dateEntries(result);
  expect(entries.map((entry) => entry.name).sort()).toEqual([...DATE_BRIDGE_NAMES].sort());
  expect(new Set(entries.map((entry) => (entry.desc.kind === "func" ? entry.desc.index : -1))).size).toBe(3);
  const expectedTypes = [
    { params: [{ kind: "externref" }], results: [{ kind: "i32" }] },
    { params: [{ kind: "externref" }], results: [{ kind: "i64" }] },
    {
      params: [
        {
          kind: "ref",
          typeIdx: result.module.types.findIndex((type) => type.kind === "struct" && type.name === "__Date"),
        },
        { kind: "i64" },
      ],
      results: [],
    },
  ];
  for (const [index, name] of DATE_BRIDGE_NAMES.entries()) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`missing Date export ${name}`);
    const func = functionForExport(result, entry);
    expect(func.name, name).toBe(name);
    const type = result.module.types[func.typeIdx];
    expect(type?.kind, name).toBe("func");
    if (type?.kind !== "func") continue;
    expect(type.params, name).toEqual(expectedTypes[index]!.params);
    expect(type.results, name).toEqual(expectedTypes[index]!.results);
  }
}

async function instantiateGc(result: CompileResult): Promise<Record<string, unknown>> {
  expect(result.success, hardErrors(result).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return instance.exports as Record<string, unknown>;
}

async function instantiateTarget(
  result: CompileResult,
  target: "standalone" | "wasi",
): Promise<Record<string, unknown>> {
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
  return instantiateGc(result);
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

function dateEntry(ctx: ReturnType<typeof makeDateContext>, name = DATE_BRIDGE_NAMES[0]): WasmExport {
  const entry = ctx.mod.exports.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`missing Date export ${name}`);
  return entry;
}

function cloneExport(entry: WasmExport, name = entry.name): WasmExport {
  return {
    name,
    desc: entry.desc.kind === "func" ? { kind: "func", index: entry.desc.index } : { ...entry.desc },
  };
}

describe("#3520 C39 Date carrier export provenance", () => {
  it("accepts only the exact three Date bridge names", () => {
    expect(DATE_BRIDGE_NAMES.every(isCoreDateHostBridgePublicName)).toBe(true);
    expect(
      ["__\0js2_is_date$", "__\0js2_date_value_extra", "__\0js2_date_set_value0", "$d0", "$d0$"].some(
        isCoreDateHostBridgePublicName,
      ),
    ).toBe(false);
  });

  it.each([
    ["auto", {}],
    ["always", { hostBridge: "always" as const }],
  ] as const)(
    "captures exact names, types, targets, and runtime behavior for host policy %s",
    async (_label, policy) => {
      const options = {
        fileName: `issue-3520-c39-date-${_label}.ts`,
        experimentalIR: true,
        ...policy,
      } satisfies CompileOptions;
      assertExactDateCensus(generateSingle(DATE_SOURCE, options.fileName, options));
      const result = await compile(DATE_SOURCE, options);
      const exports = await instantiateGc(result);
      expect((exports.dateValue as () => number)()).toBe(5);
    },
  );

  it.each(["standalone", "wasi"] as const)(
    "removes all authenticated Date exports in %s auto/off policy with tracked parity",
    async (target) => {
      for (const hostBridge of ["auto", "off"] as const) {
        const options: CompileOptions = {
          fileName: `issue-3520-c39-date-${target}-${hostBridge}.ts`,
          experimentalIR: true,
          target,
          hostBridge,
        };
        const generated = generateSingle(DATE_SOURCE, options.fileName!, options);
        const generatedTracked = generateSingle(DATE_SOURCE, options.fileName!, {
          ...options,
          trackIrOutcomes: true,
        });
        expect(hardErrors(generated), `${target}/${hostBridge} generated untracked`).toEqual([]);
        expect(hardErrors(generatedTracked), `${target}/${hostBridge} generated tracked`).toEqual([]);
        assertExactTargetSurface(generated, target, hostBridge);
        assertExactTargetSurface(generatedTracked, target, hostBridge);
        expect(dateEntries(generated), `${target}/${hostBridge} untracked`).toEqual([]);
        expect(dateEntries(generatedTracked), `${target}/${hostBridge} tracked`).toEqual([]);
        expect(generatedTracked.module.imports, `${target}/${hostBridge} generated imports`).toEqual(
          generated.module.imports,
        );
        expect(
          generatedTracked.module.exports.map(({ name, desc }) => ({
            name,
            desc,
          })),
          `${target}/${hostBridge} generated exports`,
        ).toEqual(generated.module.exports.map(({ name, desc }) => ({ name, desc })));
        const untracked = await compile(DATE_SOURCE, options);
        const tracked = await compile(DATE_SOURCE, {
          ...options,
          trackIrOutcomes: true,
        });
        expect(untracked.success, hardErrors(untracked).join("\n")).toBe(true);
        expect(tracked.success, hardErrors(tracked).join("\n")).toBe(true);
        expect(tracked.imports, `${target}/${hostBridge} imports`).toEqual(untracked.imports);
        expect(tracked.binary, `${target}/${hostBridge} binary parity`).toEqual(untracked.binary);
        const exports = await instantiateTarget(tracked, target);
        expect((exports.dateValue as () => number)(), `${target}/${hostBridge} runtime`).toBe(5);
      }
    },
  );

  it.each(["standalone", "wasi"] as const)(
    "retains all three exact Date helpers in %s hostBridge always",
    async (target) => {
      const options: CompileOptions = {
        fileName: `issue-3520-c39-date-${target}-always.ts`,
        experimentalIR: true,
        target,
        hostBridge: "always",
      };
      const generated = generateSingle(DATE_SOURCE, options.fileName!, options);
      const generatedTracked = generateSingle(DATE_SOURCE, options.fileName!, {
        ...options,
        trackIrOutcomes: true,
      });
      assertExactDateCensus(generated);
      assertExactDateCensus(generatedTracked);
      assertExactTargetSurface(generated, target, "always");
      assertExactTargetSurface(generatedTracked, target, "always");
      expect(generatedTracked.module.imports).toEqual(generated.module.imports);
      expect(emitBinary(generatedTracked.module)).toEqual(emitBinary(generated.module));
      const untracked = await compile(DATE_SOURCE, options);
      const tracked = await compile(DATE_SOURCE, {
        ...options,
        trackIrOutcomes: true,
      });
      expect(tracked.imports).toEqual(untracked.imports);
      expect(tracked.binary).toEqual(untracked.binary);
      const exports = await instantiateTarget(tracked, target);
      expect((exports.dateValue as () => number)()).toBe(5);
    },
  );

  it("keeps a Date-free control free of Date census and carrier exports", async () => {
    const options = {
      fileName: "issue-3520-c39-date-free.ts",
      experimentalIR: true,
      target: "standalone",
      hostBridge: "always",
      trackIrOutcomes: true,
    } satisfies CompileOptions;
    const result = generateSingle("export function dateValue(): number { return 5; }", options.fileName!, options);
    expect(hardErrors(result), hardErrors(result).join("\n")).toEqual([]);
    expect(dateEntries(result)).toEqual([]);
    expect(result.module.functions.some((func) => DATE_BRIDGE_NAMES.includes(func.name))).toBe(false);
  });

  it("keeps Date provenance exact when Date is created in a non-entry provider", async () => {
    for (const target of ["standalone", "wasi"] as const) {
      for (const hostBridge of ["auto", "always"] as const) {
        const options: CompileOptions = {
          experimentalIR: true,
          target,
          hostBridge,
        };
        const generated = generateGraph(DATE_MULTI_FILES, "./entry.ts", options);
        const generatedTracked = generateGraph(DATE_MULTI_FILES, "./entry.ts", {
          ...options,
          trackIrOutcomes: true,
        });
        expect(hardErrors(generated), `${target}/${hostBridge} generated untracked`).toEqual([]);
        expect(hardErrors(generatedTracked), `${target}/${hostBridge} generated tracked`).toEqual([]);
        assertExactTargetSurface(generated, target, hostBridge, DATE_MULTI_ALWAYS_BRIDGE_NAMES);
        assertExactTargetSurface(generatedTracked, target, hostBridge, DATE_MULTI_ALWAYS_BRIDGE_NAMES);
        if (hostBridge === "auto") {
          expect(dateEntries(generated)).toEqual([]);
          expect(dateEntries(generatedTracked)).toEqual([]);
        } else {
          assertExactDateCensus(generated);
          assertExactDateCensus(generatedTracked);
        }
        expect(generatedTracked.module.imports, `${target}/${hostBridge} generated imports`).toEqual(
          generated.module.imports,
        );
        expect(
          generatedTracked.module.exports.map(({ name, desc }) => ({
            name,
            desc,
          })),
        ).toEqual(generated.module.exports.map(({ name, desc }) => ({ name, desc })));
        const untracked = await compileMulti(DATE_MULTI_FILES, "./entry.ts", options);
        const tracked = await compileMulti(DATE_MULTI_FILES, "./entry.ts", {
          ...options,
          trackIrOutcomes: true,
        });
        expect(untracked.success, `${target}/${hostBridge} untracked`).toBe(true);
        expect(tracked.success, `${target}/${hostBridge} tracked`).toBe(true);
        expect(tracked.binary, `${target}/${hostBridge} multi binary parity`).toEqual(untracked.binary);
        const exports = await instantiateTarget(tracked, target);
        expect((exports.dateValue as () => number)(), `${target}/${hostBridge} provider runtime`).toBe(5);
      }
    }
  });

  it("removes an exact-name copy only when its live target is the recorded allocator", () => {
    const ctx = makeDateContext();
    const recorded = dateEntry(ctx);
    const copy = cloneExport(recorded);
    ctx.mod.exports.push(copy);
    expect(isCompilerOwnedDateHostBridgeExport(ctx, copy)).toBe(true);
    ctx.emitHostBridge = false;
    expect(stripHostBridgeExports(ctx)).toBe(4);
    expect(ctx.mod.exports).not.toContain(copy);
  });

  it("keeps a same-spelled Date export that targets a distinct user allocator", () => {
    const ctx = makeDateContext();
    const recorded = dateEntry(ctx);
    const recordedFunc = recorded.desc.kind === "func" ? ctx.mod.functions[recorded.desc.index] : undefined;
    const userFunction: WasmFunction = {
      name: "user-date-spelling",
      typeIdx: recordedFunc?.typeIdx ?? 0,
      locals: [],
      body: [{ op: "i32.const", value: 7 }],
      exported: true,
    };
    const userIndex = ctx.mod.functions.length;
    ctx.mod.functions.push(userFunction);
    const user = cloneExport(recorded);
    user.desc = { kind: "func", index: userIndex };
    ctx.mod.exports.push(user);
    expect(isCompilerOwnedDateHostBridgeExport(ctx, user)).toBe(false);
    ctx.emitHostBridge = false;
    stripHostBridgeExports(ctx);
    expect(ctx.mod.exports).toContain(user);
    expect(ctx.mod.exports.filter((entry) => entry.name === recorded.name)).toEqual([user]);
  });

  it("keeps a near-spelled export even when it targets the compiler allocator", () => {
    const ctx = makeDateContext();
    const recorded = dateEntry(ctx);
    const near = cloneExport(recorded, `${recorded.name}$`);
    ctx.mod.exports.push(near);
    expect(isCoreDateHostBridgePublicName(near.name)).toBe(false);
    expect(isCompilerOwnedDateHostBridgeExport(ctx, near)).toBe(false);
    ctx.emitHostBridge = false;
    stripHostBridgeExports(ctx);
    expect(ctx.mod.exports).toContain(near);
  });

  it("accepts a stable-regime copy but never falls through from an invalid live handle", () => {
    const stableCtx = makeDateContext();
    const stableRecorded = dateEntry(stableCtx);
    if (stableRecorded.desc.kind !== "func") throw new Error("Date descriptor is not a function");
    const stableFunc = stableCtx.mod.functions[stableRecorded.desc.index];
    if (!stableFunc) throw new Error("missing Date allocator");
    stableCtx.mod.funcOrdinalToPosition.push(stableCtx.mod.functions.indexOf(stableFunc));
    const stableCopy = cloneExport(stableRecorded);
    stableCopy.desc = { kind: "func", index: STABLE_FUNC_BASE };
    stableCtx.mod.exports.push(stableCopy);
    expect(isCompilerOwnedDateHostBridgeExport(stableCtx, stableCopy)).toBe(true);
    stableCtx.emitHostBridge = false;
    expect(stripHostBridgeExports(stableCtx)).toBe(4);
    expect(stableCtx.mod.exports).not.toContain(stableCopy);

    const invalidCtx = makeDateContext();
    const invalidRecorded = dateEntry(invalidCtx);
    if (invalidRecorded.desc.kind !== "func") throw new Error("Date descriptor is not a function");
    const invalidStableFunc = invalidCtx.mod.functions[invalidRecorded.desc.index];
    if (!invalidStableFunc) throw new Error("missing Date allocator");
    finalizeDateHostBridgeExports(invalidCtx);
    invalidCtx.indexSpaceFrozen = true;
    expect(invalidCtx.numImportFuncs).toBe(0);
    invalidCtx.mod.imports.push({
      module: "env",
      name: "late_date_import",
      desc: { kind: "func", typeIdx: invalidStableFunc.typeIdx },
    });
    const invalidLive = cloneExport(invalidRecorded);
    invalidLive.desc = { kind: "func", index: invalidRecorded.desc.index };
    expect(invalidLive.desc.index).toBeLessThan(STABLE_FUNC_BASE);
    invalidCtx.mod.exports.push(invalidLive);
    expect(isCompilerOwnedDateHostBridgeExport(invalidCtx, invalidLive)).toBe(false);
    invalidCtx.emitHostBridge = false;
    stripHostBridgeExports(invalidCtx);
    expect(invalidCtx.mod.exports).toContain(invalidLive);
  });

  it("removes a recorded Date descriptor renamed into the vec/closure namespace after finalization", () => {
    for (const [name, userName] of [
      ["$v0", "$v0"],
      ["$ch", "$ch"],
    ] as const) {
      const ctx = makeDateContext();
      const recorded = dateEntry(ctx);
      const recordedFunc = recorded.desc.kind === "func" ? ctx.mod.functions[recorded.desc.index] : undefined;
      const userFunction: WasmFunction = {
        name: `user-${name}`,
        typeIdx: recordedFunc?.typeIdx ?? 0,
        locals: [],
        body: [{ op: "i32.const", value: 7 }],
        exported: true,
      };
      const userIndex = ctx.mod.functions.length;
      ctx.mod.functions.push(userFunction);
      const user: WasmExport = {
        name: userName,
        desc: { kind: "func", index: userIndex },
      };
      ctx.mod.exports.push(user);
      finalizeDateHostBridgeExports(ctx);
      ctx.indexSpaceFrozen = true;
      recorded.name = name;
      expect(isCompilerOwnedDateHostBridgeExport(ctx, recorded)).toBe(true);
      ctx.emitHostBridge = false;
      stripHostBridgeExports(ctx);
      expect(ctx.mod.exports).toContain(user);
      expect(ctx.mod.exports).not.toContain(recorded);
    }
  });

  it.each([
    [
      "missing",
      (ctx: ReturnType<typeof makeDateContext>, entry: WasmExport) =>
        ctx.mod.exports.splice(ctx.mod.exports.indexOf(entry), 1),
      /disappeared before finalization/,
    ],
    [
      "duplicated",
      (ctx: ReturnType<typeof makeDateContext>, entry: WasmExport) => ctx.mod.exports.push(entry),
      /appears more than once/,
    ],
    [
      "renamed",
      (_ctx: ReturnType<typeof makeDateContext>, entry: WasmExport) => {
        entry.name = "__\0js2_is_date$";
      },
      /changed its published name/,
    ],
    [
      "kind-changed",
      (_ctx: ReturnType<typeof makeDateContext>, entry: WasmExport) => {
        entry.desc = { kind: "global", index: 0 };
      },
      /changed kind to global/,
    ],
    [
      "retargeted",
      (ctx: ReturnType<typeof makeDateContext>, entry: WasmExport) => {
        entry.desc = { kind: "func", index: ctx.mod.functions.length - 1 };
      },
      /different allocator function/,
    ],
    [
      "one-past",
      (ctx: ReturnType<typeof makeDateContext>, entry: WasmExport) => {
        entry.desc = { kind: "func", index: ctx.mod.functions.length };
      },
      /different allocator function/,
    ],
    [
      "allocator-removed",
      (ctx: ReturnType<typeof makeDateContext>, entry: WasmExport) => {
        if (entry.desc.kind !== "func") throw new Error("not function");
        ctx.mod.functions.splice(entry.desc.index, 1);
      },
      /lost its allocator function/,
    ],
  ] as const)("fails closed before policy publication for %s", (_name, mutate, expected) => {
    const ctx = makeDateContext();
    const entry = dateEntry(ctx);
    mutate(ctx, entry);
    expect(() => finalizeDateHostBridgeExports(ctx)).toThrow(expected);
  });
});
