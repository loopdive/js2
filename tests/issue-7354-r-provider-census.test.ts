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
import type { PhysicalNativeStringSetup, PhysicalSetupPlan } from "../src/ir/program-physical-plan.js";
import type { EmittedPreparedIrProgram } from "../src/ir/program.js";
import { emittedNativeRealmSlots } from "../src/ir/program-consumer.js";
import type { NativeSetupSlots } from "../src/compiler/prepared-provider-census.js";
import { RUNTIME_PROVIDERS } from "../src/ir/runtime/manifest.js";
import { preparedIrDataMismatch } from "../src/ir/program/data.js";
import { NUMBER_REMAINDER_RUNTIME_PROVIDERS } from "../src/ir/runtime/number-remainder-callables.js";

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
  receipts: undefined as
    | undefined
    | ((receipts: readonly Receipt[], emitted: EmittedPreparedIrProgram) => readonly Receipt[]),
  setup: undefined as undefined | ((setup: PhysicalNativeStringSetup) => PhysicalNativeStringSetup | undefined),
  plan: undefined as undefined | ((plan: PhysicalSetupPlan) => PhysicalSetupPlan),
  target: undefined as undefined | "gc" | "wasi",
  forged: new WeakMap<object, unknown>(),
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
      return census.receipts?.(receipts, args[0]) ?? receipts;
    },
    // (#7354 Str) A forged plan is ONE object, as the emission's own plan is: the census, the presentation's record
    // and its finalization all read the same forgery. (A fresh object per read would be a plan replaced between
    // presentation and finalization, which the finalization's identity check exists to catch.)
    emittedPhysicalSetupPlan: (...args: Parameters<typeof real.emittedPhysicalSetupPlan>) => {
      const plan = real.emittedPhysicalSetupPlan(...args);
      if (!census.forged.has(plan)) {
        const setup = plan.nativeStrings && census.setup ? census.setup(plan.nativeStrings) : plan.nativeStrings;
        const strings = setup === plan.nativeStrings ? plan : { ...plan, nativeStrings: setup };
        census.forged.set(plan, census.plan?.(strings) ?? strings);
      }
      return census.forged.get(plan) as typeof plan;
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
  census.providers = census.slots = census.receipts = census.setup = census.plan = census.target = undefined;
  census.forged = new WeakMap();
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

  // (#7354 Str) String constants are selected now. (#7354 L0a) The presentation still selects no `js.string.compare`
  // provider: a relational compare of typed strings takes the dynamic value's own code-unit compare.
  it("compares typed strings without selecting the string-compare family", async () => {
    const exports = await present(
      "function lt(a: string, b: string): boolean { return a < b; }\nexport function main(): number { return (lt('a', 'b') ? 2 : 0) + (lt('b', 'a') ? 1 : 0); }",
      "entry.ts",
    );
    expect((exports.main as () => number)()).toBe(2);
  });

  it("leaves a numeric-only program on the exact numeric contract (no detached finalization)", async () => {
    const exports = await present("export function f(x: number): number { return x % 3; }", "entry.ts");
    expect((exports.f as (x: number) => number)(7)).toBe(1);
  });
});

describe("#7354 R — the census refuses what joins nothing", () => {
  const program = "try { throw 5; } catch (e) {}";
  const refusal = async (source = program, fileName = "test.js") => {
    const result = await compile(source, options("standalone", fileName));
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
      "adds a canonical remainder the program has no resource for",
      (rows: readonly RuntimeProviderDefinition[]) => [...rows, NUMBER_REMAINDER_RUNTIME_PROVIDERS[0]!],
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

  // (#7354 O1) The realm's functions are support receipts like any other: each joins the realm's own completed slot,
  // by index and key, exactly once. (The unaltered realm program presents: `issue-7354-o-objects.test.ts`.)
  const realmProgram = "function f(){ var o = { a: 1 }; return o.a; } if (f() !== 1) throw 1;";
  const realmFunctions = (emitted: EmittedPreparedIrProgram) => emittedNativeRealmSlots(emitted)!.functions;
  it.each([
    [
      "adds a receipt at a realm function's index with a key the realm never reserved",
      (rows: readonly Receipt[], emitted: EmittedPreparedIrProgram) => [
        ...rows,
        { key: "forged:not-a-realm-key", index: realmFunctions(emitted)[0]!.index },
      ],
    ],
    [
      "duplicates a realm function's receipt",
      (rows: readonly Receipt[], emitted: EmittedPreparedIrProgram) => [
        ...rows,
        rows.find((row) => row.index === realmFunctions(emitted)[0]!.index)!,
      ],
    ],
    [
      "drops every realm function's receipt",
      (rows: readonly Receipt[], emitted: EmittedPreparedIrProgram) =>
        rows.filter((row) => !realmFunctions(emitted).some((realm) => realm.index === row.index)),
    ],
  ])("refuses a realm program's support population that %s", async (_, alter) => {
    census.receipts = alter;
    expect(await refusal(realmProgram)).toContain(RUNTIME_DEMAND);
  });

  it("refuses a realm program whose object call row binds a key the realm never served", async () => {
    census.plan = (plan) => ({
      ...plan,
      nativeSourceObjects: {
        ...plan.nativeSourceObjects!,
        bindings: plan.nativeSourceObjects!.bindings.map((row, i) => (i ? row : { ...row, resourceKey: "forged" })),
      },
    });
    expect(await refusal(realmProgram)).toContain(RUNTIME_DEMAND);
  });

  type Declaration = PhysicalNativeStringSetup["resources"]["declarations"][number];
  const declarations = (alter: (row: Declaration) => Declaration) => (setup: PhysicalNativeStringSetup) =>
    ({ ...setup, resources: { ...setup.resources, declarations: setup.resources.declarations.map(alter) } }) as never;
  const named = (name: string, alter: (row: Declaration) => Declaration) =>
    declarations((row) => ("name" in row && row.name === name ? alter(row) : row));
  const f64 = { kind: "f64" as const };
  it.each([
    [
      "a native function's declared type key (naming no native type)",
      named("__str_flatten", (row) =>
        row.space === "function"
          ? { ...row, signature: { ...row.signature, params: [{ kind: "ref" as const, typeKey: "foreign" }] } }
          : row,
      ),
    ],
    [
      // __str_flatten takes (ref AnyString), type slot 2; the scanner __str_to_number is function slot 2. A type key
      // naming the scanner's declaration resolves only if the key's space is ignored.
      "a native function's declared type key (naming a function declaration at the same index)",
      (setup: PhysicalNativeStringSetup) => {
        const scanner = setup.resources.declarations.find((row) => "name" in row && row.name === "__str_to_number")!;
        return named("__str_flatten", (row) =>
          row.space === "function"
            ? { ...row, signature: { ...row.signature, params: [{ kind: "ref" as const, typeKey: scanner.key }] } }
            : row,
        )(setup);
      },
    ],
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

  // Two native providers (box and unbox) make the census compare provider populations; a non-canonical provider
  // must refuse before that comparison, never reach it.
  // (#7354 T) The catch binding is the dynamic value, so the conversion back to a number is the explicit ToNumber.
  const twoNatives = "export function f(x: number): number { try { throw x * 2; } catch (e: any) { return e * 1; } }";
  const renamed = (row: RuntimeProviderDefinition) => ({ ...row, id: `${row.id}.renamed` });
  it.each([
    [
      "renames one",
      twoNatives,
      "entry.ts",
      (rows: readonly RuntimeProviderDefinition[]) => rows.map((row) => (native(row) ? renamed(row) : row)),
    ],
    [
      "adds a renamed copy of one",
      twoNatives,
      "entry.ts",
      (rows: readonly RuntimeProviderDefinition[]) => [...rows, renamed(rows.find(native)!)],
    ],
    [
      "alters the feature of one",
      twoNatives,
      "entry.ts",
      (rows: readonly RuntimeProviderDefinition[]) =>
        rows.map((row) => (native(row) ? { ...row, feature: "js.number.unbox" } : row)),
    ],
    [
      "adds a renamed copy of one",
      program,
      "test.js",
      (rows: readonly RuntimeProviderDefinition[]) => [...rows, renamed(rows.find(native)!)],
    ],
  ])("refuses, without throwing, a census that %s native provider: %s", async (_, source, fileName, alter) => {
    census.providers = alter;
    expect(await refusal(source, fileName)).toContain(RUNTIME_DEMAND);
  });
});

describe("#7354 D1/T — the census on a dynamic-value program", () => {
  const program =
    "function id(v: any): any { return v; }\n" +
    "export function main(): number { return (id(1) === id(1) ? 1 : 0) + (id(undefined) === undefined ? 2 : 0) + (id(1) ? 4 : 0); }";
  const refusal = async () => {
    const result = await compile(program, options("standalone", "entry.ts"));
    expect(result.success).toBe(false);
    return messages(result).join("\n");
  };
  const RUNTIME_DEMAND = "host provider or async demand is outside this numeric presentation contract";
  const IDS = ["native.js.value.strict_eq", "native.js.value.to_boolean", "native.js.value.undefined"];

  it("presents the unaltered program", async () => {
    expect(((await present(program, "entry.ts")).main as () => number)()).toBe(7);
  });

  // (#7354 Str) No string reaches the carrier here, so strict equality keeps its string-free body and the setup
  // reserves no string equality.
  it("reserves no string equality for a program whose dynamic values hold no string", async () => {
    let roles: string[] = [];
    census.setup = (setup) => {
      roles = setup.resources.declarations.map((row) => row.role[0]!);
      return setup;
    };
    await present(program, "entry.ts");
    expect(roles).not.toContain("string-equality");
  });

  it.each(IDS)("refuses a census that drops %s", async (id) => {
    census.providers = (rows) => rows.filter((row) => row.id !== id);
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each(IDS)("refuses a census that renames %s", async (id) => {
    census.providers = (rows) => rows.map((row) => (row.id === id ? { ...row, id: `${id}.renamed` } : row));
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each(["__js_strict_eq", "__is_truthy", "__js_undefined"])(
    "refuses a native setup that renames the %s resource",
    async (name) => {
      census.setup = (setup) =>
        ({
          ...setup,
          resources: {
            ...setup.resources,
            declarations: setup.resources.declarations.map((row) =>
              "name" in row && row.name === name ? { ...row, name: `${name}_renamed` } : row,
            ),
          },
        }) as never;
      expect(await refusal()).toContain(RUNTIME_DEMAND);
    },
  );
});

describe("#7354 Ty — the census on typeof comparisons", () => {
  // The number and Boolean `typeof` tag tests bind the native value and Boolean resources' existing predicates;
  // (#7354 Str2 merge) the string test is the dynamic-value resources' own.
  const program =
    "function id(v: any): any { return v; }\n" +
    'export function main(): number { return (typeof id(1) === "number" ? 1 : 0) + (typeof id(true) === "boolean" ? 2 : 0) +' +
    ' (typeof id("a") === "string" ? 4 : 0); }';
  const refusal = async () => {
    const result = await compile(program, options("standalone", "entry.ts"));
    expect(result.success).toBe(false);
    return messages(result).join("\n");
  };
  const RUNTIME_DEMAND = "host provider or async demand is outside this numeric presentation contract";
  const IDS = ["native.js.value.is_number", "native.js.value.is_boolean", "native.js.value.is_string"];

  it("presents the unaltered program", async () => {
    expect(((await present(program, "entry.ts")).main as () => number)()).toBe(7);
  });

  it.each(IDS)("refuses a census that drops %s", async (id) => {
    census.providers = (rows) => rows.filter((row) => row.id !== id);
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each(IDS)("refuses a census that renames %s", async (id) => {
    census.providers = (rows) => rows.map((row) => (row.id === id ? { ...row, id: `${id}.renamed` } : row));
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each(["__typeof_number", "__typeof_boolean", "__typeof_string"])(
    "refuses a native setup that renames the %s resource",
    async (name) => {
      census.setup = (setup) =>
        ({
          ...setup,
          resources: {
            ...setup.resources,
            declarations: setup.resources.declarations.map((row) =>
              "name" in row && row.name === name ? { ...row, name: `${name}_renamed` } : row,
            ),
          },
        }) as never;
      expect(await refusal()).toContain(RUNTIME_DEMAND);
    },
  );
});

describe("#7354 H — the census on a script var in the dynamic home", () => {
  // The program-level demand a dynamic home adds is the `undefined` the module-init stores into it first.
  const program = "var x; if (x !== undefined) throw 1; x = 2; if (x !== 2) throw 2;";
  const refusal = async () => {
    const result = await compile(program, options("standalone", "test.js"));
    expect(result.success).toBe(false);
    return messages(result).join("\n");
  };
  const RUNTIME_DEMAND = "host provider or async demand is outside this numeric presentation contract";
  const ID = "native.js.value.undefined";

  it("presents and runs the unaltered program", async () => {
    const exports = await present(program, "test.js");
    expect(() => (exports.__module_init as (() => void) | undefined)?.()).not.toThrow();
  });

  it("refuses a census that drops the undefined value provider", async () => {
    census.providers = (rows) => rows.filter((row) => row.id !== ID);
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a census that renames the undefined value provider", async () => {
    census.providers = (rows) => rows.map((row) => (row.id === ID ? { ...row, id: `${ID}.renamed` } : row));
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a native setup that renames the __js_undefined resource", async () => {
    census.setup = (setup) =>
      ({
        ...setup,
        resources: {
          ...setup.resources,
          declarations: setup.resources.declarations.map((row) =>
            "name" in row && row.name === "__js_undefined" ? { ...row, name: "__js_undefined_renamed" } : row,
          ),
        },
      }) as never;
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });
});

describe("#7354 Str — the census on a typed string program", () => {
  const program =
    "function cat(a: string, b: string): string { return a + b; }\n" +
    "function eq(a: string, b: string): boolean { return a === b; }\n" +
    "export function main(): number { const s = cat('a', 'bc'); return (s.length === 3 ? 1 : 0) + (eq(s, 'abc') ? 2 : 0); }";
  const refusal = async () => {
    const result = await compile(program, options("standalone", "entry.ts"));
    expect(result.success).toBe(false);
    return messages(result).join("\n");
  };
  const RUNTIME_DEMAND = "host provider or async demand is outside this numeric presentation contract";
  const IDS = ["native.js.string.const", "native.js.string.eq", "native.js.string.len", "native.js.string.concat"];
  type Declaration = PhysicalNativeStringSetup["resources"]["declarations"][number];
  const declarations = (alter: (row: Declaration) => Declaration) => (setup: PhysicalNativeStringSetup) =>
    ({ ...setup, resources: { ...setup.resources, declarations: setup.resources.declarations.map(alter) } }) as never;

  it("presents the unaltered program", async () => {
    expect(((await present(program, "entry.ts")).main as () => number)()).toBe(3);
  });

  // Each string provider joins the executable occurrences that demand it, both ways and with multiplicity.
  const provider = (id: string) => RUNTIME_PROVIDERS.find((row) => row.id === id)!;
  it.each(IDS)("refuses a census that drops %s", async (id) => {
    census.providers = (rows) => rows.filter((row) => row.id !== id);
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a census that drops every string provider", async () => {
    census.providers = (rows) => rows.filter((row) => !IDS.includes(row.id));
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each([
    ["adds the foreign UTF-16 literal provider", "native.js.string.const.utf16"],
    ["duplicates the literal provider", "native.js.string.const"],
    ["duplicates the length provider", "native.js.string.len"],
  ])("refuses a census that %s", async (_, id) => {
    census.providers = (rows) => [...rows, provider(id)];
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each([
    [
      "the length provider to a program that never reads a length",
      "native.js.string.len",
      "function eq(a: string, b: string): boolean { return a === b; }\n" +
        "export function main(): number { return eq('a', 'b') ? 1 : 0; }",
    ],
    [
      "the string equality provider to a program with only strict equality of dynamic values",
      "native.js.string.eq",
      "function id(v: any): any { return v; }\nexport function main(): number { return id('a') === id('a') ? 1 : 0; }",
    ],
  ])("refuses a census that adds %s", async (_, id, source) => {
    expect(((await present(source, "entry.ts")).main as () => number)()).toBe(id.endsWith("len") ? 0 : 1);
    census.providers = (rows) => [...rows, provider(id)];
    const result = await compile(source, options("standalone", "entry.ts"));
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain(RUNTIME_DEMAND);
  });

  it("refuses a native setup that swaps the names of __str_equals and __str_concat", async () => {
    const swap: Record<string, string> = { __str_equals: "__str_concat", __str_concat: "__str_equals" };
    census.setup = declarations((row) =>
      "name" in row && swap[row.name] ? ({ ...row, name: swap[row.name] } as never) : row,
    );
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  // The number box is a struct too, but its field 0 is the f64 payload, not a length: its slot was not reserved as
  // the string carrier.
  it("refuses a length provider joined to the number box relabelled as the string carrier", async () => {
    const source =
      "function len(s: string): number { return s.length; }\nfunction id(v: any): any { return v; }\n" +
      "export function main(): number { return len('ab') + (id(1) === id(1) ? 1 : 0); }";
    expect(((await present(source, "entry.ts")).main as () => number)()).toBe(3);
    census.setup = declarations((row) =>
      row.role[0] === "values" && row.role[1] === "number"
        ? { ...row, role: ["string-type", "any"] }
        : row.role[0] === "string-type" && row.role[1] === "any"
          ? { ...row, role: ["foreign"] }
          : row,
    );
    const result = await compile(source, options("standalone", "entry.ts"));
    expect(messages(result).join("\n")).toContain(RUNTIME_DEMAND);
  });

  it("refuses a selected native provider that is neither a string provider nor a runtime callable", async () => {
    const foreign = RUNTIME_PROVIDERS.find(
      (row) =>
        row.implementation.kind !== "runtime-callable" &&
        !row.feature.startsWith("js.string.") &&
        !row.dependencies.length &&
        !row.hostCapabilities.length,
    )!;
    census.providers = (rows) => [...rows, foreign];
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a native setup with a second function in the string equality role", async () => {
    census.setup = declarations((row) =>
      row.role[0] === "flatten" && row.role[1] === "flatten" ? { ...row, role: ["string-equality", "equals"] } : row,
    );
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a native setup with a second string carrier type", async () => {
    census.setup = declarations((row) =>
      row.role[0] === "string-type" && row.role[1] === "flat" ? { ...row, role: ["string-type", "any"] } : row,
    );
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a native setup whose literal uses miss one executable string literal", async () => {
    census.setup = (setup) =>
      ({
        ...setup,
        resources: {
          ...setup.resources,
          literalUses: (setup.resources as { literalUses: unknown[] }).literalUses.slice(1),
        },
      }) as never;
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a native setup that strips the role of one literal global the program uses", async () => {
    census.setup = declarations((row) =>
      row.role[0] === "literal-global" && String(row.role[1]).endsWith(":abc") ? { ...row, role: ["foreign"] } : row,
    );
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each(IDS)("refuses a census that renames %s", async (id) => {
    census.providers = (rows) => rows.map((row) => (row.id === id ? { ...row, id: `${id}.renamed` } : row));
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each(["__str_equals", "__str_concat"])("refuses a native setup that renames the %s resource", async (name) => {
    census.setup = declarations((row) =>
      "name" in row && row.name === name ? ({ ...row, name: `${name}_x` } as never) : row,
    );
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each([
    ["the literal storage", (row: Declaration) => row.role[0] === "literal-global"],
    ["the string carrier type", (row: Declaration) => row.role[0] === "string-type" && row.role[1] === "any"],
  ])("refuses a native setup that declares no %s", async (_, match) => {
    census.setup = declarations((row) => (match(row) ? { ...row, role: ["foreign", ...row.role] } : row));
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  // (#7354 Str review 2) Every role and name the census reads is the one its completed slot was reserved under, each
  // literal use is its own occurrence's literal, and the forgeries the review found refuse by name.
  const role =
    (...parts: string[]) =>
    (row: Declaration) =>
      preparedIrDataMismatch(row.role, parts) === undefined;
  type Use = { readonly demandIndex: number; readonly cacheKey: string };
  const uses = (alter: (rows: readonly Use[]) => readonly Use[]) => (setup: PhysicalNativeStringSetup) =>
    ({ ...setup, resources: { ...setup.resources, literalUses: alter(setup.resources.literalUses) } }) as never;
  /** Exchanges role and name between the two declarations `left` and `right` match. */
  const exchange =
    (left: (row: Declaration) => boolean, right: (row: Declaration) => boolean) =>
    (setup: PhysicalNativeStringSetup) => {
      const rows = setup.resources.declarations;
      const a = rows.find(left)! as Declaration & { name: string };
      const b = rows.find(right)! as Declaration & { name: string };
      return declarations((row) =>
        row === a
          ? ({ ...a, role: b.role, name: b.name } as never)
          : row === b
            ? ({ ...b, role: a.role, name: a.name } as never)
            : row,
      )(setup);
    };
  /** Adds a second declaration (and binding) of the one `match` finds: same role, name and completed slot. */
  const duplicate = (match: (row: Declaration) => boolean) => (setup: PhysicalNativeStringSetup) => {
    const row = setup.resources.declarations.find(match)!;
    const binding = setup.bindings.find((entry) => entry.resourceKey === row.key)!;
    return {
      ...setup,
      resources: {
        ...setup.resources,
        declarations: [...setup.resources.declarations, { ...row, key: `${row.key}:twin` }],
      },
      bindings: [...setup.bindings, { ...binding, resourceKey: `${row.key}:twin` }],
    } as never;
  };

  it.each([
    [
      "the string equality function with the flatten function",
      role("flatten", "flatten"),
      role("string-equality", "equals"),
    ],
    [
      "the string equality function with the concatenation",
      role("output", "concat"),
      role("string-equality", "equals"),
    ],
    ["two literal globals", role("literal-global", "u16:a"), role("literal-global", "u16:bc")],
  ])("refuses a native setup that exchanges role and name of %s", async (_, left, right) => {
    census.setup = exchange(left, right);
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each([
    ["the empty literal the setup owns", role("literal-global", "u16:")],
    ["the flatten function", role("flatten", "flatten")],
    ["the flatten copy loop", role("flatten", "copy-tree")],
    ["a string carrier subtype", role("string-type", "cons")],
  ])("refuses a native setup that strips the role of %s", async (_, match) => {
    census.setup = declarations((row) => (match(row) ? { ...row, role: ["foreign"] } : row));
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each([
    [
      "one literal use to another literal's storage",
      (rows: readonly Use[]) => [{ ...rows[0]!, cacheKey: rows[1]!.cacheKey }, ...rows.slice(1)],
    ],
    [
      "every literal use to one storage",
      (rows: readonly Use[]) => rows.map((row) => ({ ...row, cacheKey: rows[2]!.cacheKey })),
    ],
    [
      "two literal uses to each other's occurrence",
      (rows: readonly Use[]) => [
        { ...rows[0]!, demandIndex: rows[1]!.demandIndex },
        { ...rows[1]!, demandIndex: rows[0]!.demandIndex },
        ...rows.slice(2),
      ],
    ],
    [
      "one literal use to another's occurrence (that occurrence used twice)",
      (rows: readonly Use[]) => [rows[1]!, ...rows.slice(1)],
    ],
  ])("refuses a native setup that repoints %s", async (_, alter) => {
    census.setup = uses(alter);
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it.each([
    ["literal global a use names", role("literal-global", "u16:a")],
    ["string carrier type", role("string-type", "any")],
  ])("refuses a native setup with a second %s on the same completed slot", async (_, match) => {
    census.setup = duplicate(match);
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  it("refuses a setup function bound as an intrinsic that no by-instruction provider owns", async () => {
    census.setup = (setup) => {
      const flatten = setup.resources.declarations.find(role("flatten", "flatten"))!;
      return {
        ...declarations((row) => (row === flatten ? { ...row, role: ["foreign"] } : row))(setup),
        bindings: setup.bindings.map((row) =>
          row.resourceKey === flatten.key
            ? { ...row, reference: { ...row.reference, binding: { kind: "intrinsic", symbol: "__str_flatten" } } }
            : row,
        ),
      } as never;
    };
    expect(await refusal()).toContain(RUNTIME_DEMAND);
  });

  // The census authenticates what the presentation consumes; plan data no join reads (here the reservation steps)
  // leaves the emission it presents untouched, so the forged plan presents the real, unaltered module.
  it("presents the unaltered emission under a forgery of plan data no join reads", async () => {
    census.setup = (setup) =>
      ({
        ...setup,
        resources: { ...setup.resources, reservationSteps: [...setup.resources.reservationSteps].reverse() },
      }) as never;
    expect(((await present(program, "entry.ts")).main as () => number)()).toBe(3);
  });
});
