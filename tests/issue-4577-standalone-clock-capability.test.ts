// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import {
  buildCapabilityRequirements,
  hasCertifiedStandaloneClockCapabilityProvider,
  isValidatedPlatformCapabilityImport,
  validatePlatformCapabilityRequirements,
} from "../src/capability-registry.js";
import { validateJavaScriptAdapterManifest } from "../src/adapter-manifest.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { planProgramAbiCallableImports } from "../src/codegen/program-abi-import-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { buildHostImportInventory, classifyHostImport } from "../src/host-import-policy.js";
import { compile, compileMulti, type ImportDescriptor } from "../src/index.js";
import { irCallableBindingKey, irCapabilityImportFuncRef, irImportFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { createEmptyModule, type ValType, type WasmModule } from "../src/ir/types.js";
import { buildCompiledAdapterImports, buildCompiledImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const CLOCK_DESCRIPTOR: ImportDescriptor = Object.freeze({
  module: "env",
  name: "__date_now",
  kind: "func",
  intent: Object.freeze({ type: "date_now" }),
  paramCount: 0,
});

function moduleWithClockImport(params: ValType[] = [], results: ValType[] = [{ kind: "f64" }]): WasmModule {
  const module = createEmptyModule();
  module.types.push({ kind: "func", params, results });
  const imported: WasmModule["imports"][number] = {
    module: "env",
    name: "__date_now",
    desc: { kind: "func", typeIdx: 0 },
  };
  module.imports.push(imported);
  module.platformCapabilityImportProvenance!.set(
    imported,
    Object.freeze({ capabilityId: "clock", providerId: "embedder" }),
  );
  return module;
}

function clockRequirement(module: WasmModule, environment: "javascript" | "none") {
  const inventory = buildHostImportInventory(module, [CLOCK_DESCRIPTOR], [], environment);
  const requirements = buildCapabilityRequirements(module, inventory, environment);
  expect(requirements).toHaveLength(1);
  return requirements[0]!;
}

function leakWarningNames(errors: readonly { message: string; severity: "error" | "warning" }[]): string[] {
  return errors
    .filter(({ severity, message }) => severity === "warning" && message.includes("Host import leak"))
    .flatMap(({ message }) => [...message.matchAll(/env\.([^\"]+)/g)].map((match) => match[1]!));
}

describe("#4577 standalone clock capability", () => {
  it("selects the exact clock@1 embedder manifest for environment none", () => {
    const module = moduleWithClockImport();
    const inventory = buildHostImportInventory(module, [CLOCK_DESCRIPTOR], [], "none");
    expect(inventory).toEqual([
      expect.objectContaining({
        module: "env",
        name: "__date_now",
        kind: "func",
        intentType: "date_now",
        classification: "platform-capability",
        family: "clock",
        ownerIssue: 4577,
        nativeFallback: false,
      }),
    ]);

    const requirement = clockRequirement(module, "none");
    expect(requirement).toEqual({
      id: "clock",
      abiNamespace: "js2wasm:capability/clock",
      abiVersion: 1,
      permissions: ["clock:read"],
      selectedProviders: ["embedder"],
      compatibleProviders: ["js-host", "wasi-preview1", "embedder"],
      imports: [
        {
          module: "env",
          name: "__date_now",
          kind: "func",
          params: [],
          results: ["f64"],
        },
      ],
    });
    expect(validatePlatformCapabilityRequirements([requirement], "none")).toEqual([]);
  });

  it("requires compiler demand and the one exact () -> f64 import before certifying the provider", () => {
    const exact = moduleWithClockImport();
    expect(hasCertifiedStandaloneClockCapabilityProvider(exact, true, "none")).toBe(true);
    expect(isValidatedPlatformCapabilityImport(exact, 0, "clock", "embedder", "none")).toBe(true);

    expect(hasCertifiedStandaloneClockCapabilityProvider(exact, false, "none")).toBe(false);
    expect(hasCertifiedStandaloneClockCapabilityProvider(exact, true, "javascript")).toBe(false);

    const wrongResult = moduleWithClockImport([], [{ kind: "i32" }]);
    expect(hasCertifiedStandaloneClockCapabilityProvider(wrongResult, true, "none")).toBe(false);
    expect(isValidatedPlatformCapabilityImport(wrongResult, 0, "clock", "embedder", "none")).toBe(false);

    const wrongParams = moduleWithClockImport([{ kind: "f64" }]);
    expect(hasCertifiedStandaloneClockCapabilityProvider(wrongParams, true, "none")).toBe(false);

    const duplicate = moduleWithClockImport();
    duplicate.imports.push({ module: "env", name: "__date_now", desc: { kind: "func", typeIdx: 0 } });
    expect(hasCertifiedStandaloneClockCapabilityProvider(duplicate, true, "none")).toBe(false);
  });

  it("keeps clock provider provenance in the Program ABI callable identity", () => {
    const module = moduleWithClockImport();
    const sourceFile = ts.createSourceFile(
      "/repo/entry.ts",
      `export function readClock(): number { return new Date().getFullYear(); }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
    const session = new ProgramAbiSession(inventory, module);
    const context = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const catalog = planProgramAbiCallableImports(context);
    const certifiedKey = irCallableBindingKey(
      irCapabilityImportFuncRef("env", "__date_now", "clock", "embedder").binding,
    );
    const ambientKey = irCallableBindingKey(irImportFuncRef("env", "__date_now").binding);

    expect(certifiedKey).not.toBe(ambientKey);
    expect(catalog.has(certifiedKey)).toBe(true);
    expect(catalog.has(ambientKey)).toBe(false);
    expect(session.getDraft(catalog.get(certifiedKey)!)).toMatchObject({
      structuralReferenceKey: certifiedKey,
      intent: {
        kind: "callable",
        origin: "import",
        capabilityId: "clock",
        providerId: "embedder",
      },
    });
  });

  it("fails manifest validation on signature drift or an incomplete embedder contract", () => {
    const exact = clockRequirement(moduleWithClockImport(), "none");
    const drifted = {
      ...exact,
      imports: exact.imports.map((entry) => ({ ...entry, results: ["i32"] })),
    };
    expect(validatePlatformCapabilityRequirements([drifted], "none")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "clock",
          provider: "embedder",
          code: "provider-import-mismatch",
        }),
      ]),
    );

    expect(validatePlatformCapabilityRequirements([{ ...exact, imports: [] }], "none")).toEqual([
      expect.objectContaining({
        capability: "clock",
        provider: "embedder",
        code: "provider-import-mismatch",
      }),
    ]);
  });

  it("does not let an ambient same-name declaration forge compiler clock authority", async () => {
    const result = await compile(
      `
        declare function __date_now(): number;
        declare function __arbitrary_env_import(value: number): number;
        export function probe(value: number): number {
          return __date_now() + __arbitrary_env_import(value);
        }
      `,
      {
        fileName: "issue-4577-clock-authority-forgery.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([
      { module: "env", name: "__date_now", kind: "function" },
      { module: "env", name: "__arbitrary_env_import", kind: "function" },
    ]);
    expect(leakWarningNames(result.errors)).toEqual(expect.arrayContaining(["__date_now", "__arbitrary_env_import"]));
    expect(result.capabilityRequirements).toEqual([]);
  });

  it("does not let a same-source ambient declaration share an exact Date snapshot clock slot", async () => {
    const result = await compile(
      `
        declare function __date_now(): number;
        export function calendarYear(): number { return new Date().getFullYear(); }
        export function ambientClock(): number { return __date_now(); }
      `,
      {
        fileName: "issue-4577-clock-single-source-collision.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
        ({ module, name }) => module === "env" && name === "__date_now",
      ),
    ).toEqual([{ module: "env", name: "__date_now", kind: "function" }]);
    expect(result.capabilityRequirements?.some(({ id }) => id === "clock")).toBe(false);
    expect(leakWarningNames(result.errors)).toContain("__date_now");
    expect(() => buildCompiledImports(result, { dateNow: () => 1 })).toThrow(/no capability requirement/i);
  });

  it.each([false, true])(
    "does not let a same-source ambient callable const borrow the clock slot (experimentalIR=%s)",
    async (experimentalIR) => {
      const result = await compile(
        `
          declare const __date_now: () => number;
          export function calendarYear(): number { return new Date().getFullYear(); }
          export function ambientClock(): number { return __date_now(); }
        `,
        {
          fileName: `issue-4577-clock-single-source-const-collision-${experimentalIR}.ts`,
          target: "standalone",
          experimentalIR,
          skipSemanticDiagnostics: true,
        },
      );
      expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
      expect(
        WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
          ({ module, name }) => module === "env" && name === "__date_now",
        ),
      ).toEqual([]);
      expect(result.capabilityRequirements?.some(({ id }) => id === "clock")).toBe(false);
      expect(buildCompiledImports(result, { dateNow: () => 1 }).env.__date_now).toBeUndefined();
    },
  );

  it.each([
    ["function", `export function __date_now(): number { return 123; }`],
    ["const", `const __date_now = (): number => 123;`],
  ])("keeps a real same-source %s binding separate from Date snapshots", async (_kind, declaration) => {
    for (const experimentalIR of [false, true]) {
      const result = await compile(
        `
          ${declaration}
          export function calendarYear(): number { return new Date().getFullYear(); }
          export function sourceClock(): number { return __date_now(); }
        `,
        {
          fileName: `issue-4577-clock-defined-binding-${_kind}-${experimentalIR}.ts`,
          target: "standalone",
          experimentalIR,
          skipSemanticDiagnostics: true,
        },
      );
      expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.capabilityRequirements?.some(({ id }) => id === "clock")).toBe(false);
      const imports = buildCompiledImports(result);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      expect((instance.exports.sourceClock as () => number)()).toBe(123);
      expect((instance.exports.calendarYear as () => number)()).toBe(1970);
    }
  });

  it("does not confuse a property name with the reserved clock value binding", async () => {
    const result = await compile(
      `
        const holder = { __date_now: (): number => 123 };
        export function calendarYear(): number { return new Date().getFullYear(); }
        export function propertyClock(): number { return holder.__date_now(); }
      `,
      {
        fileName: "issue-4577-clock-property-name-control.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(result.capabilityRequirements?.some(({ id }) => id === "clock")).toBe(true);
    const imports = buildCompiledImports(result, { dateNow: () => 1_734_220_800_000 });
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.calendarYear as () => number)()).toBe(2024);
    expect((instance.exports.propertyClock as () => number)()).toBe(123);
  });

  it("does not let a cross-source ambient declaration borrow exact Date clock authority", async () => {
    const result = await compileMulti(
      {
        "./calendar.ts": `
          export function calendarYear(): number { return new Date().getFullYear(); }
        `,
        "./ambient.ts": `
          export declare function __date_now(): number;
          export function ambientClock(): number { return __date_now(); }
        `,
        "./entry.ts": `
          import { calendarYear } from "./calendar";
          import { ambientClock } from "./ambient";
          export function readCalendar(): number { return calendarYear(); }
          export function readAmbient(): number { return ambientClock(); }
        `,
      },
      "./entry.ts",
      {
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
        ({ module, name }) => module === "env" && name === "__date_now",
      ),
    ).toEqual([{ module: "env", name: "__date_now", kind: "function" }]);
    expect(result.capabilityRequirements?.some(({ id }) => id === "clock")).toBe(false);
    expect(leakWarningNames(result.errors)).toContain("__date_now");
    expect(() => buildCompiledImports(result, { dateNow: () => 1 })).toThrow(/no capability requirement/i);
  });

  it("does not let a cross-source ambient callable const borrow exact Date clock authority", async () => {
    const result = await compileMulti(
      {
        "./calendar.ts": `
          export function calendarYear(): number { return new Date().getFullYear(); }
        `,
        "./ambient.ts": `
          export declare const __date_now: () => number;
          export function ambientClock(): number { return __date_now(); }
        `,
        "./entry.ts": `
          import { calendarYear } from "./calendar";
          import { ambientClock } from "./ambient";
          export function readCalendar(): number { return calendarYear(); }
          export function readAmbient(): number { return ambientClock(); }
        `,
      },
      "./entry.ts",
      {
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
        ({ module, name }) => module === "env" && name === "__date_now",
      ),
    ).toEqual([]);
    expect(result.capabilityRequirements?.some(({ id }) => id === "clock")).toBe(false);
    expect(buildCompiledImports(result, { dateNow: () => 1 }).env.__date_now).toBeUndefined();
  });

  it("keeps a cross-source __date_now export alias separate from Date snapshots", async () => {
    const result = await compileMulti(
      {
        "./calendar.ts": `
          export function calendarYear(): number { return new Date().getFullYear(); }
        `,
        "./source-clock.ts": `
          export function provider(): number { return 123; }
          export { provider as __date_now };
        `,
        "./entry.ts": `
          import { calendarYear } from "./calendar";
          import { __date_now as sourceClock } from "./source-clock";
          export function readCalendar(): number { return calendarYear(); }
          export function readSourceClock(): number { return sourceClock(); }
        `,
      },
      "./entry.ts",
      {
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    expect(result.capabilityRequirements?.some(({ id }) => id === "clock")).toBe(false);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.readSourceClock as () => number)()).toBe(123);
    expect((instance.exports.readCalendar as () => number)()).toBe(1970);
  });

  it.each([false, true])(
    "does not let a same-source Date parameter borrow the ambient clock lowering (experimentalIR=%s)",
    async (experimentalIR) => {
      const result = await compile(
        `
          class ShadowDate {
            now(): number { return 123; }
            UTC(year: number): number { return year + 10; }
            parse(_value: string): number { return 3; }
          }
          function readShadow(Date: ShadowDate): number {
            return Date.now() + Date.UTC(2) + Date.parse("ignored");
          }
          export function calendarYear(): number { return new Date().getFullYear(); }
          export function shadowedDateStatics(): number { return readShadow(new ShadowDate()); }
        `,
        {
          fileName: `issue-4577-clock-date-shadow-${experimentalIR}.ts`,
          target: "standalone",
          experimentalIR,
          skipSemanticDiagnostics: true,
        },
      );
      expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
      expect(result.capabilityRequirements?.some(({ id }) => id === "clock")).toBe(true);
      expect(
        WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
          ({ module, name }) => module === "env" && name === "__date_now",
        ),
      ).toEqual([{ module: "env", name: "__date_now", kind: "function" }]);
      const imports = buildCompiledImports(result, { dateNow: () => 1_734_220_800_000 });
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      expect((instance.exports.calendarYear as () => number)()).toBe(2024);
      expect((instance.exports.shadowedDateStatics as () => number)()).toBe(138);
    },
  );

  it.each([false, true])(
    "does not let a cross-source Date parameter borrow the module clock lowering (experimentalIR=%s)",
    async (experimentalIR) => {
      const result = await compileMulti(
        {
          "./calendar.ts": `
            export function calendarYear(): number { return new Date().getFullYear(); }
          `,
          "./shadow.ts": `
            class ShadowDate {
              now(): number { return 123; }
              UTC(year: number): number { return year + 10; }
              parse(_value: string): number { return 3; }
            }
            function readShadow(Date: ShadowDate): number {
              return Date.now() + Date.UTC(2) + Date.parse("ignored");
            }
            export function shadowedDateStatics(): number { return readShadow(new ShadowDate()); }
          `,
          "./entry.ts": `
            import { calendarYear } from "./calendar";
            import { shadowedDateStatics } from "./shadow";
            export function readCalendar(): number { return calendarYear(); }
            export function readShadow(): number { return shadowedDateStatics(); }
          `,
        },
        "./entry.ts",
        {
          target: "standalone",
          experimentalIR,
          skipSemanticDiagnostics: true,
        },
      );
      expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
      expect(result.capabilityRequirements?.some(({ id }) => id === "clock")).toBe(true);
      expect(
        WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
          ({ module, name }) => module === "env" && name === "__date_now",
        ),
      ).toEqual([{ module: "env", name: "__date_now", kind: "function" }]);
      const imports = buildCompiledImports(result, { dateNow: () => 1_734_220_800_000 });
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      expect((instance.exports.readCalendar as () => number)()).toBe(2024);
      expect((instance.exports.readShadow as () => number)()).toBe(138);
    },
  );

  it("requires an explicit finite deps.dateNow binding for the embedder provider", async () => {
    const result = await compile(
      `
        export function readClock(): number { return new Date().getFullYear(); }
      `,
      {
        fileName: "issue-4577-clock-runtime-binding.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(() => buildCompiledImports(result)).toThrow(/clock.+deps\.dateNow/i);

    const imports = buildCompiledImports(result, { dateNow: () => 1_734_220_800_000 });
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.readClock as () => number)()).toBe(2024);

    const invalidImports = buildCompiledImports(result, { dateNow: () => Number.POSITIVE_INFINITY });
    const { instance: invalidInstance } = await WebAssembly.instantiate(result.binary, invalidImports);
    invalidImports.setInstance?.(invalidInstance);
    expect(() => (invalidInstance.exports.readClock as () => number)()).toThrow(/finite number/i);

    const timeClipBound = 8_640_000_000_000_000;
    for (const boundary of [-timeClipBound, timeClipBound]) {
      const boundaryImports = buildCompiledImports(result, { dateNow: () => boundary });
      expect(boundaryImports.env.__date_now!()).toBe(boundary);
    }
    for (const outside of [-timeClipBound - 1, timeClipBound + 1]) {
      const outsideImports = buildCompiledImports(result, { dateNow: () => outside });
      expect(() => outsideImports.env.__date_now!()).toThrow(/TimeClip range/i);
    }

    let providerReads = 0;
    const switchingDeps: Record<string, unknown> = {};
    Object.defineProperty(switchingDeps, "dateNow", {
      get: () => {
        providerReads++;
        return providerReads === 1 ? () => 994_032_000_000 : undefined;
      },
    });
    const pinnedImports = buildCompiledImports(result, switchingDeps);
    expect(providerReads).toBe(1);
    const { instance: pinnedInstance } = await WebAssembly.instantiate(result.binary, pinnedImports);
    pinnedImports.setInstance?.(pinnedInstance);
    expect((pinnedInstance.exports.readClock as () => number)()).toBe(2001);
    expect(providerReads).toBe(1);
  });

  it("preserves the standalone UTC Date profile when the host local timezone differs", async () => {
    const result = await compile(
      `
        export function calendarStamp(): number {
          const date = new Date();
          return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
        }
      `,
      {
        fileName: "issue-4577-clock-utc-profile.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);

    const epoch = Date.parse("2024-12-31T23:30:00.000Z");
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      const hostLocal = new Date(epoch);
      expect([hostLocal.getFullYear(), hostLocal.getMonth(), hostLocal.getDate()]).toEqual([2025, 0, 1]);

      const imports = buildCompiledImports(result, { dateNow: () => epoch });
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      // Standalone's established native Date profile uses zero-offset civil
      // fields. This preserves target semantics; it is not JS-host local-time
      // equivalence and therefore must not add a timezone capability/import.
      expect((instance.exports.calendarStamp as () => number)()).toBe(20_241_231);
    } finally {
      if (previousTimezone === undefined) Reflect.deleteProperty(process.env, "TZ");
      else process.env.TZ = previousTimezone;
    }
  });

  it("rejects duplicate capability requirement identities before binding authority", async () => {
    const result = await compile(
      `
        export function readClock(): number { return new Date().getFullYear(); }
      `,
      {
        fileName: "issue-4577-clock-duplicate-requirement.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
    const manifest = result.adapterManifest!;
    const clock = manifest.capabilities.find(({ id }) => id === "clock")!;
    const duplicated = { ...manifest, capabilities: [...manifest.capabilities, clock] };

    expect(validateJavaScriptAdapterManifest(duplicated)).toEqual(
      expect.arrayContaining([expect.stringMatching(/duplicate capability requirement 'clock' appears 2 times/)]),
    );
    expect(() => buildCompiledAdapterImports(duplicated, { dateNow: () => 1 })).toThrow(
      /duplicate capability requirement 'clock'/,
    );
  });

  it("rejects duplicate exact import descriptors and capability ownership claims", async () => {
    const result = await compile(
      `
        export function readClock(): number { return new Date().getFullYear(); }
      `,
      {
        fileName: "issue-4577-clock-duplicate-import.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
    const manifest = result.adapterManifest!;
    const clockDescriptor = manifest.imports.find(({ module, name }) => module === "env" && name === "__date_now")!;
    const duplicateDescriptor = { ...manifest, imports: [...manifest.imports, clockDescriptor] };
    expect(validateJavaScriptAdapterManifest(duplicateDescriptor)).toEqual(
      expect.arrayContaining([expect.stringMatching(/duplicate adapter import 'env::__date_now' appears 2 times/)]),
    );
    expect(() => buildCompiledAdapterImports(duplicateDescriptor, { dateNow: () => 1 })).toThrow(
      /duplicate adapter import 'env::__date_now'/,
    );

    const duplicateOwnership = {
      ...manifest,
      capabilities: manifest.capabilities.map((requirement) =>
        requirement.id === "clock"
          ? { ...requirement, imports: [...requirement.imports, requirement.imports[0]!] }
          : requirement,
      ),
    };
    expect(validateJavaScriptAdapterManifest(duplicateOwnership)).toEqual(
      expect.arrayContaining([expect.stringMatching(/capability import 'env::__date_now' has 2 ownership claims/)]),
    );
  });

  it("keeps the JS-host and WASI clock selections and ABIs unchanged", async () => {
    const source = `export function now(): number { return Date.now(); }`;
    const [javascript, wasi] = await Promise.all([
      compile(source, { fileName: "issue-4577-clock-js-host-control.ts" }),
      compile(source, { fileName: "issue-4577-clock-wasi-control.ts", target: "wasi" }),
    ]);
    expect(javascript.success, javascript.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(wasi.success, wasi.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(javascript.capabilityProviderDiagnostics).toEqual([]);
    expect(wasi.capabilityProviderDiagnostics).toEqual([]);

    expect(classifyHostImport(CLOCK_DESCRIPTOR, "javascript")).toEqual({
      classification: "platform-capability",
      family: "clock",
      ownerIssue: 4398,
      nativeFallback: true,
      reason: "wall-clock capability",
    });
    expect(javascript.capabilityRequirements).toContainEqual(
      expect.objectContaining({
        id: "clock",
        selectedProviders: ["js-host"],
        imports: [
          {
            module: "env",
            name: "__date_now",
            kind: "func",
            params: [],
            results: ["f64"],
          },
        ],
      }),
    );
    const javascriptImports = buildCompiledImports(javascript, { dateNow: () => 987_654_321 });
    const originalDateNow = Date.now;
    try {
      Date.now = () => 123_456_789;
      expect(javascriptImports.env.__date_now!()).toBe(123_456_789);
      Date.now = () => 234_567_890;
      expect(javascriptImports.env.__date_now!()).toBe(234_567_890);
    } finally {
      Date.now = originalDateNow;
    }
    const { instance: javascriptInstance } = await WebAssembly.instantiate(javascript.binary, javascriptImports);
    javascriptImports.setInstance?.(javascriptInstance);
    expect(Number.isFinite((javascriptInstance.exports.now as () => number)())).toBe(true);
    expect(wasi.capabilityRequirements).toContainEqual(
      expect.objectContaining({
        id: "clock",
        selectedProviders: ["wasi-preview1"],
        imports: [
          {
            module: "wasi_snapshot_preview1",
            name: "clock_time_get",
            kind: "func",
            params: ["i32", "i64", "i32"],
            results: ["i32"],
          },
        ],
      }),
    );
  });
});
