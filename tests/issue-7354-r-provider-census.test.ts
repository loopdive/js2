// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice R — the Prepared presentation selects the native number boundary on wasmgc standalone, and its
// resource check authenticates each selected provider against the completed physical plan (the number
// remainders, and the native setup's runtime callables) instead of refusing every provider. A reserved
// reference type asks for the detached finalization, which widens a copy, so the completed emission the
// receipts check is never altered. Hosts and WASI keep their contract.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import type { RuntimeProviderDefinition } from "../src/ir/runtime/contracts/manifest.js";

/**
 * The census runs on the real completed emission; each alteration rewrites one population it is given, so each
 * check can be shown to refuse on its own. (The emission itself cannot be altered here: its own reservation
 * census refuses any changed function, global or type before the presentation looks.)
 */
type Slots = { readonly types: ReadonlySet<number>; readonly globals: ReadonlySet<number> };
type Receipt = { readonly key: string; readonly index: number };
const census = vi.hoisted(() => ({
  providers: undefined as
    | undefined
    | ((providers: readonly RuntimeProviderDefinition[]) => readonly RuntimeProviderDefinition[]),
  slots: undefined as undefined | ((slots: Slots) => Slots),
  receipts: undefined as undefined | ((receipts: readonly Receipt[]) => readonly Receipt[]),
}));
vi.mock("../src/compiler/prepared-provider-census.js", async (original) => {
  const real = await original<typeof import("../src/compiler/prepared-provider-census.js")>();
  return {
    ...real,
    providerCensusMatches: (
      ...[program, emission, backend, providers]: Parameters<typeof real.providerCensusMatches>
    ) => real.providerCensusMatches(program, emission, backend, census.providers?.(providers) ?? providers),
    nativeSetupSlots: (...args: Parameters<typeof real.nativeSetupSlots>) => {
      const slots = real.nativeSetupSlots(...args);
      return slots && (census.slots?.(slots) ?? slots);
    },
  };
});
vi.mock("../src/ir/program-consumer.js", async (original) => {
  const real = await original<typeof import("../src/ir/program-consumer.js")>();
  return {
    ...real,
    emittedSupportFunctionReceipts: (...args: Parameters<typeof real.emittedSupportFunctionReceipts>) => {
      const receipts = real.emittedSupportFunctionReceipts(...args);
      return census.receipts?.(receipts) ?? receipts;
    },
  };
});

const base = {
  wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
  backend: "wasmgc",
  sourceMap: false,
  optimize: false,
  emitWat: false,
} as const;
const options = (target: "standalone" | "gc" | "wasi", fileName: string): Test262CompileOptions =>
  ({ ...base, target, fileName, ...(fileName.endsWith(".js") ? { allowJs: true } : {}) }) as Test262CompileOptions;

function forbidDirectGenerators(): void {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
}
afterEach(() => {
  vi.restoreAllMocks();
  census.providers = census.slots = census.receipts = undefined;
});

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

async function present(source: string, fileName: string) {
  forbidDirectGenerators();
  const result = await compile(source, options("standalone", fileName));
  expect(messages(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  return instantiatePreparedArtifact(result).instance.exports;
}

describe("#7354 R — the Prepared presentation's provider census", () => {
  it.each([
    ["if (1 !== 1) throw 1;", "test.js"],
    ["try { throw 1; } catch (e) { }", "test.js"],
    ["if (1 + 1 !== 2) throw 1;", "entry.ts"],
    ["function g(a: number): void { if (a !== a) throw a; }\ng(1);", "entry.ts"],
  ])("presents and runs a script that boxes a thrown number: %s", async (source, fileName) => {
    const exports = await present(source, fileName);
    const start = exports.__module_init ?? exports._start;
    if (typeof start === "function") expect(() => (start as () => void)()).not.toThrow();
  });

  it("throws the boxed number from an exported function, and returns otherwise", async () => {
    const exports = await present(
      "export function f(x: number): number { if (x !== 1) throw x; return x; }",
      "entry.ts",
    );
    const f = exports.f as (x: number) => number;
    expect(f(1)).toBe(1);
    expect(() => f(2)).toThrow();
  });

  it("joins a number remainder and the native box in one program", async () => {
    const exports = await present(
      "export function f(x: number): number { if (x % 2 !== 0) throw x; return x; }",
      "entry.ts",
    );
    const f = exports.f as (x: number) => number;
    expect(f(4)).toBe(4);
    expect(() => f(3)).toThrow();
  });

  it("catches the boxed number inside the program", async () => {
    const exports = await present(
      "export function f(x: number): number { try { if (x > 1) throw x; return 0; } catch (e) { return 1; } }",
      "entry.ts",
    );
    const f = exports.f as (x: number) => number;
    expect(f(0)).toBe(0);
    expect(f(2)).toBe(1);
  });

  it.each(["gc", "wasi"] as const)("keeps the %s contract: no native number boundary is selected", async (target) => {
    const result = await compile(
      "export function f(x: number): number { if (x !== 1) throw x; return x; }",
      options(target, "entry.ts"),
    );
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain("js.number.box is unavailable under number-boundary policy");
  });

  it("still refuses a native family the presentation does not select (string constants)", async () => {
    const result = await compile('if (1 > 2) throw "x";', options("standalone", "test.js"));
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain("js.string.const is unavailable");
  });

  it("leaves a numeric-only program on the exact numeric contract (no detached finalization)", async () => {
    const exports = await present("export function f(x: number): number { return x % 3; }", "entry.ts");
    expect((exports.f as (x: number) => number)(7)).toBe(1);
  });
});

describe("#7354 R — the census refuses what joins nothing", () => {
  const program = "try { throw 5; } catch (e) {}";
  const refusal = async () => {
    const result = await compile(program, options("standalone", "test.js"));
    expect(result.success).toBe(false);
    return messages(result).join("\n");
  };
  const native = (row: RuntimeProviderDefinition) => row.id === "native.js.number.box";
  const RUNTIME_DEMAND = "host provider or async demand is outside this numeric presentation contract";
  const WIDENING_DEMAND = "nondefaultable reference widening needs a separately authenticated physical post-state";

  it("presents the unaltered program through the same wrappers", async () => {
    census.providers = (providers) => providers;
    census.slots = (slots) => slots;
    census.receipts = (receipts) => receipts;
    await present(program, "test.js");
  });

  it.each([
    ["drops the native provider", (rows: readonly RuntimeProviderDefinition[]) => rows.filter((row) => !native(row))],
    [
      "duplicates the native provider",
      (rows: readonly RuntimeProviderDefinition[]) => [...rows, ...rows.filter(native)],
    ],
    [
      "renames the native provider (same runtime symbol)",
      (rows: readonly RuntimeProviderDefinition[]) =>
        rows.map((row) => (native(row) ? { ...row, id: "native.js.number.box.renamed" } : row)),
    ],
    [
      "alters the native provider's canonical definition (same id)",
      (rows: readonly RuntimeProviderDefinition[]) =>
        rows.map((row) => (native(row) ? { ...row, supportedTargets: ["standalone", "wasi"] as const } : row)),
    ],
  ])("refuses a provider census that %s", async (_, alter) => {
    census.providers = alter;
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a support receipt that joins no provider and no native-setup function", async () => {
    census.receipts = (receipts) => [...receipts, { key: "foreign-support", index: receipts.length + 100 }];
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a support receipt joined under its key at another index", async () => {
    census.receipts = (receipts) => receipts.map((row, index) => (index === 0 ? { ...row, index: 1000 } : row));
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each([
    ["global", (slots: Slots) => ({ ...slots, globals: new Set<number>() })],
    ["type", (slots: Slots) => ({ ...slots, types: new Set<number>() })],
  ])("refuses a reference %s that is no native-setup slot", async (_, alter) => {
    census.slots = alter;
    expect(await refusal()).toContain(WIDENING_DEMAND);
  });
});
