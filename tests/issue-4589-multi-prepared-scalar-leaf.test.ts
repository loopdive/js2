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

  it("keeps kill-switch WAT, binary, and runtime behavior exact", async () => {
    const prepared = await compileMulti(TYPE_ONLY_FILES, "./entry.ts", {
      experimentalIR: true,
      target: "standalone",
      emitWat: true,
    });
    vi.stubEnv(CUTOVER, "0");
    const direct = await compileMulti(TYPE_ONLY_FILES, "./entry.ts", {
      experimentalIR: true,
      target: "standalone",
      emitWat: true,
    });
    expectSuccess(prepared, "Prepared compile");
    expectSuccess(direct, "direct control compile");

    expect(digest(prepared.binary)).toBe(digest(direct.binary));
    expect(digest(prepared.wat)).toBe(digest(direct.wat));
    const preparedInstance = await instantiateWithRuntime(prepared);
    const directInstance = await instantiateWithRuntime(direct);
    const preparedEntry = preparedInstance.exports.entryPure as (value: number) => number;
    const directEntry = directInstance.exports.entryPure as (value: number) => number;
    expect(preparedEntry(5)).toBe(9);
    expect(preparedEntry(5)).toBe(directEntry(5));
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
