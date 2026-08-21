// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compileMulti, compileProject, type CompileResult } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const CUTOVER = "JS2WASM_MULTI_PREPARED_SCALAR_LEAF_CUTOVER";
const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const SEAL_FAILURE = "JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE";
const TAMPER = "JS2WASM_TEST_TAMPER_MULTI_PREPARED_SCALAR_LEAF";

const TYPE_ONLY_FILES = {
  "./dep.ts": `export interface Marker { readonly tag: "marker"; }`,
  "./entry.ts": `
    import type { Marker } from "./dep";
    type KeepDependencyInProgram = Marker;
    export function entryPure(x: number): number {
      return x + 4;
    }
  `,
} as const;

const CANONICAL_ROUTE_FILES = {
  "./dep.ts": `
    export function depPure(x: number): number {
      return x * 3;
    }
  `,
  "./entry.ts": `
    import { depPure as renamedPure } from "./dep";

    let initialized: number = 40;

    function initHelper(x: number): number {
      return x + 2;
    }

    initialized = initHelper(initialized);

    export function entryPure(x: number): number {
      return x + 4;
    }

    export function callRenamed(x: number): number {
      return renamedPure(x);
    }

    export function readInit(): number {
      return initialized;
    }
  `,
} as const;

function expectSuccess(result: CompileResult, label: string): void {
  expect(
    result.success,
    `${label} failed:\n${result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")}`,
  ).toBe(true);
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function entryPureLegacyRows(result: CompileResult) {
  return (
    result.irBodyRouteAudit?.legacyEntries.filter(
      (entry) => entry.unitId !== undefined && entry.bodyName === "entryPure",
    ) ?? []
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#4589 multi-source Prepared scalar-leaf cutover", () => {
  it("is default-on, bypasses the poisoned direct body, and restores it with the kill switch", async () => {
    vi.stubEnv(DIRECT_POISON, "entryPure");
    const prepared = await compileMulti(TYPE_ONLY_FILES, "./entry.ts", {
      trackIrOutcomes: true,
      target: "standalone",
    });
    expectSuccess(prepared, "default-on Prepared compile");
    expect(prepared.irCompiledFuncs?.filter((name) => name === "entryPure")).toEqual(["entryPure"]);
    expect(entryPureLegacyRows(prepared)).toEqual([]);
    const outcome = prepared.irOutcomes?.find((candidate) => candidate.displayName === "entryPure");
    expect(outcome).toMatchObject({ irBodyEmitted: true, legacyBodyEmitted: false });
    expect(prepared.irBodyRouteAudit?.dispositions.find((row) => row.unitId === outcome?.unitId)?.disposition).toBe(
      "terminal-ir",
    );

    vi.stubEnv(CUTOVER, "0");
    const direct = await compileMulti(TYPE_ONLY_FILES, "./entry.ts", {
      experimentalIR: true,
      trackIrOutcomes: true,
      target: "standalone",
    });
    expect(direct.success).toBe(false);
    expect(direct.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: entryPure",
    );
    expect(entryPureLegacyRows(direct).map((entry) => entry.entryPoint)).toContain("compileFunctionBody");
  });

  it("pins canonical route counts, hashes, and kill-switch runtime parity", async () => {
    const prepared = await compileMulti(CANONICAL_ROUTE_FILES, "./entry.ts", {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
      emitWat: true,
    });
    vi.stubEnv(CUTOVER, "0");
    const direct = await compileMulti(CANONICAL_ROUTE_FILES, "./entry.ts", {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(prepared, "Prepared compile");
    expectSuccess(direct, "direct control compile");

    expect(prepared.irCompiledFuncs).toEqual(["entryPure"]);
    expect(direct.irCompiledFuncs).toEqual(["entryPure"]);
    expect(prepared.irFirstSkipped).toBeUndefined();
    expect(direct.irFirstSkipped).toBeUndefined();
    expect(digest(prepared.binary)).toBe("6facf9cc597fc8b9b3070723139d5d91d88dfaf11868644e15d6eb606eb96bef");
    expect(digest(direct.binary)).toBe(digest(prepared.binary));
    expect(digest(prepared.wat)).toBe("ebb3d4b26b057ac3798e423678c46f425da34c3b0a466cd7b7c2bc70f2fb5c74");
    expect(digest(direct.wat)).toBe(digest(prepared.wat));

    const preparedRows = prepared.irBodyRouteAudit?.legacyEntries ?? [];
    const directRows = direct.irBodyRouteAudit?.legacyEntries ?? [];
    expect([directRows.length, preparedRows.length]).toEqual([14, 12]);
    expect([
      directRows.filter((row) => row.entryPoint !== "compileDeclarations").length,
      preparedRows.filter((row) => row.entryPoint !== "compileDeclarations").length,
    ]).toEqual([12, 10]);
    expect([
      directRows.filter((row) => row.unitId !== undefined).length,
      preparedRows.filter((row) => row.unitId !== undefined).length,
    ]).toEqual([11, 9]);
    expect(
      directRows
        .filter((row) => row.bodyName === "entryPure")
        .map((row) => row.entryPoint)
        .sort(),
    ).toEqual(["compileFunctionBody", "compileStatement"]);
    expect(preparedRows.filter((row) => row.bodyName === "entryPure")).toEqual([]);
    const rowKey = (row: (typeof directRows)[number]): string =>
      JSON.stringify({
        target: row.target,
        entryPoint: row.entryPoint,
        bodyName: row.bodyName,
        file: row.file,
        line: row.line,
        column: row.column,
        sourceId: row.sourceId,
        unitId: row.unitId,
        classId: row.classId,
        unitKind: row.unitKind,
        terminalOwnerId: row.terminalOwnerId,
        count: row.count,
      });
    expect(preparedRows.map(rowKey).sort()).toEqual(
      directRows
        .filter((row) => row.bodyName !== "entryPure")
        .map(rowKey)
        .sort(),
    );
    const discoverModuleInit = directRows.find((row) => row.bodyName === "__module_init" && row.unitId === undefined);
    expect(discoverModuleInit).toMatchObject({ entryPoint: "compileModuleInitBody" });
    expect(discoverModuleInit?.sourceId).toBeDefined();

    const preparedInstance = await instantiateWithRuntime(prepared);
    const directInstance = await instantiateWithRuntime(direct);
    const observed = (instance: WebAssembly.Instance) => [
      (instance.exports.entryPure as (value: number) => number)(5),
      (instance.exports.callRenamed as (value: number) => number)(5),
      (instance.exports.readInit as () => number)(),
    ];
    expect(observed(preparedInstance)).toEqual([9, 15, 42]);
    expect(observed(preparedInstance)).toEqual(observed(directInstance));
  });

  it("reaches the non-vacuous type-only graph through compileMulti and compileProject", async () => {
    const multi = await compileMulti(TYPE_ONLY_FILES, "./entry.ts", {
      experimentalIR: true,
      trackIrOutcomes: true,
      target: "standalone",
    });
    expectSuccess(multi, "compileMulti");
    expect(multi.irBodyRouteAudit?.sourceCount).toBe(2);
    expect(entryPureLegacyRows(multi)).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "js2wasm-4589-"));
    const depPath = join(dir, "dep.ts");
    const entryPath = join(dir, "entry.ts");
    writeFileSync(depPath, TYPE_ONLY_FILES["./dep.ts"]);
    writeFileSync(entryPath, TYPE_ONLY_FILES["./entry.ts"]);
    try {
      const project = await compileProject(entryPath, {
        experimentalIR: true,
        trackIrOutcomes: true,
        target: "standalone",
      });
      expectSuccess(project, "compileProject");
      expect(project.irBodyRouteAudit?.sourceCount).toBe(2);
      expect(entryPureLegacyRows(project)).toEqual([]);
      expect(project.irCompiledFuncs?.filter((name) => name === "entryPure")).toEqual(["entryPure"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the default GC multi-source lane on the direct body route", async () => {
    vi.stubEnv(DIRECT_POISON, "entryPure");
    const result = await compileMulti(TYPE_ONLY_FILES, "./entry.ts", {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: entryPure",
    );
    expect(entryPureLegacyRows(result).map((entry) => entry.entryPoint)).toContain("compileFunctionBody");
  });

  it("fails closed when the allocated callable drifts after Prepared certification", async () => {
    vi.stubEnv(TAMPER, "entryPure");
    const result = await compileMulti(TYPE_ONLY_FILES, "./entry.ts", {
      target: "standalone",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain("drifted after direct-body certification");
  });

  it.each([
    {
      label: "ambiguous graph candidates",
      entry: `
        export function entryPure(x: number): number { return x + 4; }
        export function otherPure(x: number): number { return x - 4; }
      `,
    },
    {
      label: "runtime function-value support",
      entry: `
        export function entryPure(x: number): number { return x + 4; }
        export function expose(): (x: number) => number { return entryPure; }
      `,
    },
    {
      label: "derived remainder support",
      entry: `export function entryPure(x: number): number { return x % 2; }`,
    },
    {
      label: "class-bearing source",
      entry: `
        export class Box {}
        export function entryPure(x: number): number { return x + 4; }
      `,
    },
    {
      label: "CommonJS export surface",
      entry: `
        declare const module: { exports: unknown };
        function entryPure(x: number): number { return x + 4; }
        module.exports = entryPure;
      `,
    },
  ])("withdraws before skip for $label", async ({ entry }) => {
    vi.stubEnv(DIRECT_POISON, "entryPure");
    const result = await compileMulti({ ...TYPE_ONLY_FILES, "./entry.ts": entry }, "./entry.ts", {
      target: "standalone",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: entryPure",
    );
    expect(entryPureLegacyRows(result).map((entry) => entry.entryPoint)).toContain("compileFunctionBody");
  });

  it("withdraws when another source re-exports the candidate", async () => {
    vi.stubEnv(DIRECT_POISON, "entryPure");
    const result = await compileMulti(
      {
        ...TYPE_ONLY_FILES,
        "./bridge.ts": `export { entryPure } from "./entry";`,
      },
      "./entry.ts",
      { target: "standalone", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: entryPure",
    );
    expect(entryPureLegacyRows(result).map((entry) => entry.entryPoint)).toContain("compileFunctionBody");
  });

  it.each([
    ["fast", { target: "standalone" as const, fast: true }],
    ["WASI", { target: "wasi" as const }],
    ["IR-first-disabled", { target: "standalone" as const, disableIrFirst: true }],
  ])("keeps the %s target lane direct-owned", async (_label, targetOptions) => {
    vi.stubEnv(DIRECT_POISON, "entryPure");
    const result = await compileMulti(TYPE_ONLY_FILES, "./entry.ts", {
      ...targetOptions,
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: entryPure",
    );
  });

  it("withdraws an exact Unsupported preparation before requesting the skip", async () => {
    vi.stubEnv(SEAL_FAILURE, "1");
    vi.stubEnv(DIRECT_POISON, "entryPure");
    const result = await compileMulti(TYPE_ONLY_FILES, "./entry.ts", {
      target: "standalone",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(false);
    const errors = result.errors.map((error) => error.message).join("\n");
    expect(errors).toContain("injected direct function-body poison: entryPure");
    expect(errors).not.toContain("did not withdraw atomically before its skip");
    expect(entryPureLegacyRows(result).map((entry) => entry.entryPoint)).toContain("compileFunctionBody");
  });
});
