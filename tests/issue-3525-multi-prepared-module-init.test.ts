// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import { generateMultiModule } from "../src/codegen/index.js";
import { compileMulti, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

import "../src/codegen/expressions.js";

const OPTIONS = {
  experimentalIR: true,
  nativeStrings: true,
  target: "standalone" as const,
  trackIrOutcomes: true,
};

const DEP_CONTRIBUTOR = {
  "./dep.ts": `let value: number = 40; value = value + 2; export { value };`,
  "./entry.ts": `import { value } from "./dep"; export function read(): number { return value; }`,
} as const;

const ENTRY_CONTRIBUTOR = {
  "./dep.ts": `export interface Marker { readonly kind: "dep"; }`,
  "./entry.ts": `import type { Marker } from "./dep";
    let value: number = 5; value = value + 3; export { value };
    export type EntryMarker = Marker;`,
} as const;

const DEFERRED_ENTRY_TDZ = {
  "./dep.ts": `export interface Marker { readonly kind: "dep"; }`,
  "./entry.ts": `import type { Marker } from "./dep";
    export function read(): number { try { return value; } finally {} }
    let value: number = 5; value = value + 3;
    export type EntryMarker = Marker;`,
} as const;

function generate(files: Record<string, string>, options = OPTIONS) {
  return generateMultiModule(analyzeMultiSource(files, "./entry.ts"), options);
}

function moduleInitOutcomes(result: CompileResult) {
  return result.irOutcomes?.filter((outcome) => outcome.unitKind === "module-init") ?? [];
}

async function instantiateDeferred(result: CompileResult): Promise<Record<string, unknown>> {
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return instance.exports as Record<string, unknown>;
}

afterEach(() => vi.unstubAllEnvs());

describe("#3525 M2 prepared multi-source module-init", () => {
  it("owns the contributor's exact unit and never enters compileModuleInitBody", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "1");

    const generated = generate(DEP_CONTRIBUTOR);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const audit = generated.multiPreparedProgramAudit?.moduleInit;
    expect(audit).toMatchObject({
      executablePlanCount: 1,
      emptyPlanCount: 1,
      directCompileModuleInitBodyRoots: 0,
      irBodyEmissions: 1,
      invocationKind: "wasm-start",
    });
    expect(generated.multiPreparedProgramAudit?.bodyPlan.reservations).toEqual([
      expect.objectContaining({
        unitId: audit?.contributorUnitId,
        sourceId: audit?.contributorSourceId,
        routeKind: "module-init",
        preparedBeforeDirectBodies: true,
        publicationPhase: "before-direct-bodies",
      }),
    ]);

    const result = await compileMulti(DEP_CONTRIBUTOR, "./entry.ts", OPTIONS);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(
      result.irBodyRouteAudit?.legacyEntries.filter((entry) => entry.entryPoint === "compileModuleInitBody"),
    ).toEqual([]);
    expect(moduleInitOutcomes(result)).toEqual([
      expect.objectContaining({
        unitId: audit?.contributorUnitId,
        sourceId: audit?.contributorSourceId,
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        kind: "emitted",
      }),
    ]);
    const ir = await instantiateWithRuntime(result);
    expect((ir.exports.read as () => number)()).toBe(42);

    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "");
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "0");
    const legacy = await compileMulti(DEP_CONTRIBUTOR, "./entry.ts", OPTIONS);
    expect(legacy.success, legacy.errors.map((error) => error.message).join("\n")).toBe(true);
    const legacyInstance = await instantiateWithRuntime(legacy);
    expect((legacyInstance.exports.read as () => number)()).toBe((ir.exports.read as () => number)());
  }, 120_000);

  it("keeps source-qualified ownership independent of contributor direction", () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "1");

    const dependency = generate(DEP_CONTRIBUTOR).multiPreparedProgramAudit;
    const entry = generate(ENTRY_CONTRIBUTOR).multiPreparedProgramAudit;
    expect(dependency?.moduleInit?.contributorSourceId).not.toBe(dependency?.bodyPlan.entrySourceId);
    expect(entry?.moduleInit?.contributorSourceId).toBe(entry?.bodyPlan.entrySourceId);
    expect(dependency?.moduleInit?.directCompileModuleInitBodyRoots).toBe(0);
    expect(entry?.moduleInit?.directCompileModuleInitBodyRoots).toBe(0);
  }, 120_000);

  it("rejects all-empty, two-contributor, and cross-source-read graphs before reservation", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "1");

    const empty = generate({
      "./dep.ts": `export interface Dep { readonly kind: "dep"; }`,
      "./entry.ts": `import type { Dep } from "./dep"; export type Entry = Dep;`,
    });
    expect(empty.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    expect(empty.multiPreparedProgramAudit?.moduleInit).toBeUndefined();
    expect(empty.multiPreparedProgramAudit?.bodyPlan.reservations).toEqual([]);

    const two = await compileMulti(
      {
        "./dep.ts": `export let left: number = 1;`,
        "./entry.ts": `export let right: number = 2;`,
      },
      "./entry.ts",
      OPTIONS,
    );
    expect(two.success).toBe(false);
    expect(two.errors.map((error) => error.message).join("\n")).toContain("injected direct module-init body poison");

    const crossSourceRead = await compileMulti(
      {
        "./dep.ts": `export declare const seed: number;`,
        "./entry.ts": `import { seed } from "./dep"; export let value: number = seed;`,
      },
      "./entry.ts",
      OPTIONS,
    );
    expect(crossSourceRead.success).toBe(false);
    expect(crossSourceRead.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct module-init body poison",
    );

    const resolverRejected = {
      "./dep.ts": `export interface Marker { readonly kind: "dep"; }`,
      "./entry.ts": `import type { Marker } from "./dep";
        let flag: boolean = true; let result: number = flag + 1; export { result };
        export type EntryMarker = Marker;`,
    };
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "");
    const rejectedAudit = generate(resolverRejected).multiPreparedProgramAudit;
    expect(rejectedAudit?.moduleInit).toBeUndefined();
    expect(rejectedAudit?.bodyPlan.reservations.some((entry) => entry.routeKind === "module-init")).toBe(false);

    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "1");
    const resolverRejectedControl = await compileMulti(resolverRejected, "./entry.ts", OPTIONS);
    expect(resolverRejectedControl.success).toBe(false);
    expect(resolverRejectedControl.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct module-init body poison",
    );
  }, 120_000);

  it("preserves deferred-host TDZ timing and one exact startup export", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "1");
    const options = {
      ...OPTIONS,
      nativeStrings: false,
      target: "gc" as const,
      deferTopLevelInit: true,
    };

    const result = await compileMulti(DEFERRED_ENTRY_TDZ, "./entry.ts", options);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const outcomes = moduleInitOutcomes(result);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ legacyBodyEmitted: false, irBodyEmitted: true });
    const exports = await instantiateDeferred(result);
    expect(typeof exports.__module_init).toBe("function");
    expect(() => (exports.read as () => number)()).toThrow();
    (exports.__module_init as () => void)();
    expect((exports.read as () => number)()).toBe(8);
  }, 120_000);

  it("fails closed when body evidence changes or startup gets two adapters", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");

    vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_MODULE_INIT_BODY", "1");
    const mutated = await compileMulti(DEP_CONTRIBUTOR, "./entry.ts", OPTIONS);
    expect(mutated.success).toBe(false);
    expect(mutated.binary).toHaveLength(0);
    expect(mutated.errors.map((error) => error.message).join("\n")).toContain(
      "body or exact ABI slot changed before startup finalization",
    );

    vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_MODULE_INIT_BODY", "0");
    vi.stubEnv("JS2WASM_TEST_MODULE_INIT_DOUBLE_ADAPTER", "1");
    const doubled = await compileMulti(DEP_CONTRIBUTOR, "./entry.ts", OPTIONS);
    expect(doubled.success).toBe(false);
    expect(doubled.binary).toHaveLength(0);
    expect(doubled.errors.map((error) => error.message).join("\n")).toContain(
      "must have exactly one wasm start adapter",
    );
  }, 120_000);

  it("keeps the exact env gate as a direct-route kill switch", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "0");
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "1");
    const killed = await compileMulti(DEP_CONTRIBUTOR, "./entry.ts", OPTIONS);
    expect(killed.success).toBe(false);
    expect(killed.errors.map((error) => error.message).join("\n")).toContain("injected direct module-init body poison");
  });
});
