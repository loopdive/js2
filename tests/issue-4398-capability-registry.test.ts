// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { isValidatedPlatformCapabilityImport, type CapabilityProviderId } from "../src/capability-registry.js";
import { scanForLeakedHostImports } from "../src/codegen/host-import-allowlist.js";
import { compile, formatCompileExplanation, validatePlatformCapabilityRequirements } from "../src/index.js";
import { createEmptyModule, type ValType, type WasmModule } from "../src/ir/types.js";
import { buildCompiledAdapterImports, buildCompiledImports } from "../src/runtime.js";

const AUTHENTICATION_CASES = [
  {
    capabilityId: "timers",
    name: "__timer_set_timeout",
    params: ["externref", "externref"],
    results: ["externref"],
  },
  {
    capabilityId: "dom",
    name: "global_document",
    params: [],
    results: ["externref"],
  },
  {
    capabilityId: "dom-interaction",
    name: "CSSStyleDeclaration_set_background",
    params: ["externref", "externref"],
    results: [],
  },
] as const satisfies ReadonlyArray<{
  capabilityId: "timers" | "dom" | "dom-interaction";
  name: string;
  params: readonly string[];
  results: readonly string[];
}>;

function wasmValType(name: string): ValType {
  if (name === "externref") return { kind: "externref" };
  if (name === "i32") return { kind: "i32" };
  throw new Error(`unsupported test value type: ${name}`);
}

function moduleWithCapabilityImports(
  capabilityCase: (typeof AUTHENTICATION_CASES)[number],
  occurrences: ReadonlyArray<"exact" | "malformed">,
  siblingName?: string,
): WasmModule {
  const module = createEmptyModule();
  module.types.push({
    kind: "func",
    params: capabilityCase.params.map(wasmValType),
    results: capabilityCase.results.map(wasmValType),
  });
  module.imports.push(
    ...occurrences.map((occurrence) => ({
      module: "env",
      name: capabilityCase.name,
      desc:
        occurrence === "exact"
          ? ({ kind: "func", typeIdx: 0 } as const)
          : ({ kind: "global", type: { kind: "i32" } as const, mutable: false } as const),
    })),
  );
  if (siblingName) {
    module.imports.push({
      module: "env",
      name: siblingName,
      desc: { kind: "func", typeIdx: 0 },
    });
  }
  return module;
}

function importShape(module: WasmModule): unknown[] {
  return module.imports.map((entry, index) => ({
    index,
    module: entry.module,
    name: entry.name,
    kind: entry.desc.kind,
    ...(entry.desc.kind === "func" ? { typeIdx: entry.desc.typeIdx } : { type: entry.desc.type }),
  }));
}

describe("#4398 duplicate platform-capability import authentication", () => {
  for (const capabilityCase of AUTHENTICATION_CASES) {
    const providerId: CapabilityProviderId = "embedder";
    const validate = (module: WasmModule, importIndex: number): boolean =>
      isValidatedPlatformCapabilityImport(module, importIndex, capabilityCase.capabilityId, providerId, "none");

    it(`${capabilityCase.capabilityId}: authenticates one exact Wasm import and its ABI`, () => {
      const module = moduleWithCapabilityImports(capabilityCase, ["exact"]);
      expect(importShape(module)).toEqual([
        { index: 0, module: "env", name: capabilityCase.name, kind: "func", typeIdx: 0 },
      ]);
      expect(module.types).toEqual([
        {
          kind: "func",
          params: capabilityCase.params.map(wasmValType),
          results: capabilityCase.results.map(wasmValType),
        },
      ]);
      expect(validate(module, 0)).toBe(true);
    });

    it(`${capabilityCase.capabilityId}: rejects exact plus malformed same-name imports`, () => {
      const module = moduleWithCapabilityImports(capabilityCase, ["exact", "malformed"]);
      expect(importShape(module)).toEqual([
        { index: 0, module: "env", name: capabilityCase.name, kind: "func", typeIdx: 0 },
        { index: 1, module: "env", name: capabilityCase.name, kind: "global", type: { kind: "i32" } },
      ]);
      expect([0, 1].map((index) => validate(module, index))).toEqual([false, false]);
    });

    it(`${capabilityCase.capabilityId}: rejects two exact same-name imports`, () => {
      const module = moduleWithCapabilityImports(capabilityCase, ["exact", "exact"]);
      expect(importShape(module)).toEqual([
        { index: 0, module: "env", name: capabilityCase.name, kind: "func", typeIdx: 0 },
        { index: 1, module: "env", name: capabilityCase.name, kind: "func", typeIdx: 0 },
      ]);
      expect([0, 1].map((index) => validate(module, index))).toEqual([false, false]);
    });

    it(`${capabilityCase.capabilityId}: rejects a malformed-only import`, () => {
      const module = moduleWithCapabilityImports(capabilityCase, ["malformed"]);
      expect(importShape(module)).toEqual([
        { index: 0, module: "env", name: capabilityCase.name, kind: "global", type: { kind: "i32" } },
      ]);
      expect(validate(module, 0)).toBe(false);
    });

    it(`${capabilityCase.capabilityId}: scopes uniqueness to the exact module/name pair`, () => {
      const siblingName = `${capabilityCase.name}_different`;
      const module = moduleWithCapabilityImports(capabilityCase, ["exact"], siblingName);
      expect(importShape(module)).toEqual([
        { index: 0, module: "env", name: capabilityCase.name, kind: "func", typeIdx: 0 },
        { index: 1, module: "env", name: siblingName, kind: "func", typeIdx: 0 },
      ]);
      expect(validate(module, 0)).toBe(true);
      expect(validate(module, 1)).toBe(false);
    });
  }

  it("retains a deduplicated timer leak when exact-name authentication is ambiguous", () => {
    const timer = AUTHENTICATION_CASES[0]!;
    const module = moduleWithCapabilityImports(timer, ["exact", "malformed"]);
    const leaks = scanForLeakedHostImports(module.imports);
    expect(leaks).toEqual([{ module: "env", name: timer.name, reason: "env-not-on-allowlist" }]);

    const retainedLeaks = leaks.filter(
      ({ module: leakModule, name: leakName }) =>
        !module.imports.some(
          (entry, index) =>
            entry.module === leakModule &&
            entry.name === leakName &&
            isValidatedPlatformCapabilityImport(module, index, timer.capabilityId, "embedder", "none"),
        ),
    );
    expect(retainedLeaks).toEqual(leaks);
  });
});

describe("#4398 explicit platform capability requirements", () => {
  it("selects the target-specific timer provider and records its exact ABI", async () => {
    const source = `
      export function schedule(callback: any, ms: number): any {
        return setTimeout(callback, ms);
      }
    `;
    const [js, standalone] = await Promise.all([
      compile(source, { fileName: "issue-4398-timer-js.ts", skipSemanticDiagnostics: true }),
      compile(source, {
        fileName: "issue-4398-timer-standalone.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      }),
    ]);
    expect(js.success, js.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(standalone.success, standalone.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(js.capabilityProviderDiagnostics).toEqual([]);
    expect(standalone.capabilityProviderDiagnostics).toEqual([]);

    const jsTimers = js.capabilityRequirements?.find(({ id }) => id === "timers");
    const standaloneTimers = standalone.capabilityRequirements?.find(({ id }) => id === "timers");
    const timerImport = {
      module: "env",
      name: "__timer_set_timeout",
      kind: "func",
      params: ["externref", "externref"],
      results: ["externref"],
    };
    expect(jsTimers).toEqual({
      id: "timers",
      abiNamespace: "js2wasm:capability/timers",
      abiVersion: 1,
      permissions: ["timers:schedule"],
      selectedProviders: ["js-host"],
      compatibleProviders: ["js-host", "embedder"],
      imports: [timerImport],
    });
    expect(standaloneTimers).toEqual({
      id: "timers",
      abiNamespace: "js2wasm:capability/timers",
      abiVersion: 1,
      permissions: ["timers:schedule"],
      selectedProviders: ["embedder"],
      compatibleProviders: ["js-host", "embedder"],
      imports: [timerImport],
    });
    expect(standalone.explanation).toMatchObject({
      schemaVersion: 1,
      status: "declared-host-capability",
      target: { target: "standalone", environment: "none", capabilityPolicy: "explicit-only" },
      capabilities: [
        expect.objectContaining({
          id: "timers",
          selectedProviders: ["embedder"],
        }),
      ],
      capabilityDiagnostics: [],
    });
    expect(formatCompileExplanation(standalone.explanation!)).toContain("timers@1: embedder [timers:schedule]");

    const drifted = {
      ...standaloneTimers!,
      imports: standaloneTimers!.imports.map((entry) => ({ ...entry, params: ["externref"] })),
    };
    expect(validatePlatformCapabilityRequirements([drifted], "none")).toEqual([
      expect.objectContaining({
        capability: "timers",
        provider: "embedder",
        code: "provider-import-mismatch",
      }),
    ]);
  });

  it("projects the same clock and randomness contracts onto JS and WASI providers", async () => {
    const source = `
      export function sample(): number {
        return Date.now() + Math.random();
      }
    `;
    const js = await compile(source, { fileName: "issue-4398-js.ts", wit: true });
    const wasi = await compile(source, { fileName: "issue-4398-wasi.ts", target: "wasi", wit: true });
    expect(js.success, js.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(wasi.success, wasi.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(js.capabilityProviderDiagnostics).toEqual([]);
    expect(wasi.capabilityProviderDiagnostics).toEqual([]);
    expect(js.explanation).toMatchObject({
      schemaVersion: 1,
      status: "declared-host-capability",
      target: { environment: "javascript" },
    });
    expect(formatCompileExplanation(js.explanation!)).toContain("clock@1: js-host [clock:read]");

    const byId = (requirements: NonNullable<typeof js.capabilityRequirements>) =>
      new Map(requirements.map((requirement) => [requirement.id, requirement]));
    const jsRequirements = byId(js.capabilityRequirements ?? []);
    const wasiRequirements = byId(wasi.capabilityRequirements ?? []);

    for (const id of ["clock", "randomness"]) {
      const jsRequirement = jsRequirements.get(id);
      const wasiRequirement = wasiRequirements.get(id);
      expect(jsRequirement).toMatchObject({
        id,
        abiNamespace: `js2wasm:capability/${id}`,
        abiVersion: 1,
        selectedProviders: ["js-host"],
        compatibleProviders: id === "clock" ? ["js-host", "wasi-preview1", "embedder"] : ["js-host", "wasi-preview1"],
      });
      expect(wasiRequirement).toMatchObject({
        id,
        abiNamespace: `js2wasm:capability/${id}`,
        abiVersion: 1,
        selectedProviders: ["wasi-preview1"],
        compatibleProviders: id === "clock" ? ["js-host", "wasi-preview1", "embedder"] : ["js-host", "wasi-preview1"],
      });
      expect(jsRequirement?.imports.every((entry) => entry.params && entry.results)).toBe(true);
      expect(wasiRequirement?.imports.every((entry) => entry.params && entry.results)).toBe(true);
    }
    expect(js.wit).toContain("Capability: js2wasm:capability/clock@1");
    expect(js.wit).toContain("Selected provider: js-host");
    expect(js.wit).toContain("Core provider import: env.__date_now");
    expect(wasi.wit).toContain("Capability: js2wasm:capability/randomness@1");
    expect(wasi.wit).toContain("Selected provider: wasi-preview1");
    expect(wasi.wit).toContain("Core provider import: wasi_snapshot_preview1.random_get");
  });

  it("keeps value adapters and semantic fallbacks out of capability authority", async () => {
    const result = await compile(`export function trim(value: string): string { return value.trim(); }`, {
      fileName: "issue-4398-no-capability.ts",
      semanticProviders: "native-first",
    });
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(result.capabilityRequirements).toEqual([]);
    expect(result.capabilityProviderDiagnostics).toEqual([]);
  });

  it("executes clock and randomness through the selected JS and WASI providers", async () => {
    const source = `export function sample(): number { return Date.now() + Math.random(); }`;
    const js = await compile(source, { fileName: "issue-4398-js-provider.ts" });
    expect(js.success, js.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(() =>
      buildCompiledAdapterImports({
        ...js.adapterManifest!,
        capabilities: [],
      }),
    ).toThrow("platform import 'env::__date_now' has no capability requirement");
    const jsImports = buildCompiledImports(js);
    const { instance: jsInstance } = await WebAssembly.instantiate(js.binary, jsImports);
    jsImports.setInstance?.(jsInstance);
    jsImports.startImportCounting?.();
    const jsValue = (jsInstance.exports.sample as () => number)();
    expect(Number.isFinite(jsValue)).toBe(true);
    expect(jsImports.takeImportCounts?.()).toMatchObject({ __date_now: 1, Math_random: 1 });

    const wasi = await compile(source, { fileName: "issue-4398-wasi-provider.ts", target: "wasi" });
    expect(wasi.success, wasi.errors.map((error) => error.message).join("; ")).toBe(true);
    await expect(WebAssembly.instantiate(wasi.binary, {})).rejects.toThrow(/wasi_snapshot_preview1/);
    const wasiState: { memory?: WebAssembly.Memory } = {};
    let clockCalls = 0;
    let randomCalls = 0;
    const { instance: wasiInstance } = await WebAssembly.instantiate(wasi.binary, {
      wasi_snapshot_preview1: {
        clock_time_get(_clockId: number, _precision: bigint, outPointer: number): number {
          clockCalls++;
          new DataView(wasiState.memory!.buffer).setBigUint64(outPointer, 1_234_000_000n, true);
          return 0;
        },
        random_get(pointer: number, length: number): number {
          randomCalls++;
          new Uint8Array(wasiState.memory!.buffer, pointer, length).fill(0);
          return 0;
        },
      },
    });
    wasiState.memory = wasiInstance.exports.memory as WebAssembly.Memory;
    expect((wasiInstance.exports.sample as () => number)()).toBe(1234);
    expect({ clockCalls, randomCalls }).toEqual({ clockCalls: 1, randomCalls: 1 });
  });

  it("detects provider environment, version, and signature drift", async () => {
    const result = await compile(`export function now(): number { return Date.now(); }`, {
      fileName: "issue-4398-provider-drift.ts",
    });
    const clock = result.capabilityRequirements?.find(({ id }) => id === "clock");
    expect(clock).toBeDefined();

    const drifted = {
      ...clock!,
      abiVersion: 2 as unknown as 1,
      imports: clock!.imports.map((entry) => ({ ...entry, results: ["i32"] })),
    };
    expect(validatePlatformCapabilityRequirements([drifted], "wasi")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "clock", code: "abi-version-mismatch" }),
        expect.objectContaining({ capability: "clock", provider: "js-host", code: "unsupported-environment" }),
        expect.objectContaining({ capability: "clock", provider: "js-host", code: "provider-import-mismatch" }),
      ]),
    );
  });

  it("emits a stable host-free explanation when no provider is required", async () => {
    const source = `export function answer(): number { return 42; }`;
    const first = await compile(source, { fileName: "issue-4398-explain-a.ts", target: "standalone" });
    const second = await compile(source, { fileName: "issue-4398-explain-b.ts", target: "standalone" });
    expect(first.explanation).toMatchObject({
      schemaVersion: 1,
      status: "host-free-wasm",
      hostImports: { total: 0 },
      capabilities: [],
      capabilityDiagnostics: [],
    });
    expect(JSON.stringify(first.explanation)).toBe(JSON.stringify(second.explanation));
  });
});
