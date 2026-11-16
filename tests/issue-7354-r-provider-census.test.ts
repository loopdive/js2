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
import type { PhysicalNativeStringSetup } from "../src/ir/program-physical-plan.js";
import type { NativeSetupSlots } from "../src/compiler/prepared-provider-census.js";
import { RUNTIME_PROVIDERS } from "../src/ir/runtime/manifest.js";

/**
 * The census runs on the real completed emission; each alteration rewrites one population it is given (the
 * providers, the receipts, the accepted native setup plan, or the slots the census answers), so each check can be
 * shown to refuse on its own. (The emission itself cannot be altered here: its own reservation census refuses any
 * changed function, global or type before the presentation looks.)
 */
type Receipt = { readonly key: string; readonly index: number };
const census = vi.hoisted(() => ({
  providers: undefined as
    | undefined
    | ((providers: readonly RuntimeProviderDefinition[]) => readonly RuntimeProviderDefinition[]),
  slots: undefined as undefined | ((slots: NativeSetupSlots) => NativeSetupSlots),
  receipts: undefined as undefined | ((receipts: readonly Receipt[]) => readonly Receipt[]),
  setup: undefined as undefined | ((setup: PhysicalNativeStringSetup) => PhysicalNativeStringSetup | undefined),
  target: undefined as undefined | "gc" | "wasi",
}));
vi.mock("../src/compiler/prepared-provider-census.js", async (original) => {
  const real = await original<typeof import("../src/compiler/prepared-provider-census.js")>();
  return {
    ...real,
    runtimeCensus: (...[program, emission, backend, providers]: Parameters<typeof real.runtimeCensus>) => {
      const target = census.target ? { ...backend, target: census.target } : backend;
      const result = real.runtimeCensus(program, emission, target, census.providers?.(providers) ?? providers);
      return result?.native && census.slots ? { native: census.slots(result.native) } : result;
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
    emittedPhysicalSetupPlan: (...args: Parameters<typeof real.emittedPhysicalSetupPlan>) => {
      const plan = real.emittedPhysicalSetupPlan(...args);
      if (!plan.nativeStrings || !census.setup) return plan;
      const setup = census.setup(plan.nativeStrings);
      return setup === plan.nativeStrings ? plan : { ...plan, nativeStrings: setup };
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
  census.providers = census.slots = census.receipts = census.setup = census.target = undefined;
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
    census.setup = (setup) => setup;
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
      "adds another canonical provider of the same runtime symbol",
      (rows: readonly RuntimeProviderDefinition[]) => [
        ...rows,
        RUNTIME_PROVIDERS.find((row) => row.id === "native.js.generator.number-box")!,
      ],
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

  it.each([
    ["adds a receipt that joins nothing", (rows: readonly Receipt[]) => [...rows, { key: "foreign", index: 100 }]],
    ["drops a receipt", (rows: readonly Receipt[]) => rows.slice(1)],
    [
      "moves a receipt to another index",
      (rows: readonly Receipt[]) => rows.map((row, i) => (i ? row : { ...row, index: 1000 })),
    ],
    [
      "renames a receipt at its index",
      (rows: readonly Receipt[]) => rows.map((row, i) => (i ? row : { ...row, key: "foreign" })),
    ],
    [
      "duplicates one receipt in place of another",
      (rows: readonly Receipt[]) => rows.map((row, i) => (i === 1 ? rows[0]! : row)),
    ],
  ])("refuses a support population that %s", async (_, alter) => {
    census.receipts = alter;
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  type Declaration = PhysicalNativeStringSetup["resources"]["declarations"][number];
  const declarations = (alter: (row: Declaration) => Declaration) => (setup: PhysicalNativeStringSetup) =>
    ({ ...setup, resources: { ...setup.resources, declarations: setup.resources.declarations.map(alter) } }) as never;
  const named = (name: string, alter: (row: Declaration) => Declaration) =>
    declarations((row) => ("name" in row && row.name === name ? alter(row) : row));
  const f64 = { kind: "f64" as const };
  it.each([
    [
      "a native function's declared params",
      named("__str_to_number", (row) =>
        row.space === "function" ? { ...row, signature: { ...row.signature, params: [f64] } } : row,
      ),
    ],
    [
      "a native function's declared results",
      named("__box_number", (row) =>
        row.space === "function" ? { ...row, signature: { ...row.signature, results: [f64] } } : row,
      ),
    ],
    [
      "a native global's declared type",
      named("__pow10_f64", (row) => (row.space === "global" ? { ...row, valueType: f64 } : row)),
    ],
    [
      "a native global's declared mutability",
      named("__pow10_f64", (row) => (row.space === "global" ? { ...row, mutable: !row.mutable } : row)),
    ],
    [
      "the runtime-bound function's declared name",
      named("__box_number", (row) => ({ ...row, name: "__box_number_x" }) as never),
    ],
    [
      "a declaration's space (a type declared as a global)",
      declarations((row) =>
        row.space === "type" && row.key.endsWith(":data")
          ? ({ ...row, space: "global", name: "x", valueType: f64, mutable: false } as never)
          : row,
      ),
    ],
  ])("refuses a native setup plan that alters %s", async (_, alter) => {
    census.setup = alter;
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each([
    [
      "publishes an extra binding",
      (setup: PhysicalNativeStringSetup) => ({
        ...setup,
        bindings: [...setup.bindings, { ...setup.bindings[0]!, resourceKey: "foreign" }],
      }),
    ],
    [
      "duplicates a binding",
      (setup: PhysicalNativeStringSetup) => ({ ...setup, bindings: [...setup.bindings, setup.bindings[0]!] }),
    ],
    [
      // The Boolean box type is named by no signature or global, so only the slot-space join sees the swap.
      "resolves a type declaration's binding to a global slot",
      (setup: PhysicalNativeStringSetup) => {
        const global = setup.bindings.find((row) => row.reference.kind === "global")!;
        return {
          ...setup,
          bindings: setup.bindings.map((row) =>
            row.resourceKey.endsWith(":boolean") ? { ...row, entry: global.entry } : row,
          ),
        };
      },
    ],
    ["drops a binding", (setup: PhysicalNativeStringSetup) => ({ ...setup, bindings: setup.bindings.slice(1) })],
    [
      "duplicates a declaration",
      (setup: PhysicalNativeStringSetup) =>
        ({
          ...setup,
          resources: {
            ...setup.resources,
            declarations: [...setup.resources.declarations, setup.resources.declarations[0]!],
          },
        }) as never,
    ],
  ])("refuses a native setup plan that %s", async (_, alter) => {
    census.setup = alter;
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each(["gc", "wasi"] as const)("refuses a native setup census run for the %s target", async (target) => {
    census.target = target;
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a native provider with neither a native setup nor a support function", async () => {
    census.setup = () => undefined;
    census.receipts = () => [];
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  // A catalogue provider that is not dependency/capability-free, given a setup whose runtime-bound function carries
  // its symbol: only the canonical callable's own dependency/capability check is left to refuse it.
  it.each(["native.async.delay", "host.js.string.char_code_at"])(
    "refuses the canonical %s even when the setup binds its symbol",
    async (id) => {
      const provider = RUNTIME_PROVIDERS.find((row) => row.id === id)!;
      if (provider.implementation.kind !== "runtime-callable") throw new Error("expected a runtime callable");
      const symbol = provider.implementation.symbol;
      census.providers = (rows) => rows.map((row) => (native(row) ? provider : row));
      census.setup = (setup) =>
        ({
          ...setup,
          resources: {
            ...setup.resources,
            declarations: setup.resources.declarations.map((row) =>
              "name" in row && row.name === "__box_number" ? { ...row, name: symbol } : row,
            ),
          },
          bindings: setup.bindings.map((row) =>
            row.reference.kind === "func" && row.reference.binding.kind === "runtime"
              ? { ...row, reference: { ...row.reference, binding: { kind: "runtime", symbol } } }
              : row,
          ),
        }) as never;
      expect(await refusal()).toContain(RUNTIME_DEMAND);
    },
  );

  it.each([
    ["global", (slots: NativeSetupSlots) => ({ ...slots, globals: new Set<number>() })],
    ["type", (slots: NativeSetupSlots) => ({ ...slots, types: new Set<number>() })],
  ])("refuses a reference %s that is no native-setup slot", async (_, alter) => {
    census.slots = alter;
    expect(await refusal()).toContain(WIDENING_DEMAND);
  });
});
