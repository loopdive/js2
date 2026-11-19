// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Str2-c — the Prepared presentation admits the native number formatter. The provider census joins the
// formatter setup (kernels, radix body and thunk, Ryu, `number_toString`, the adapter), the formatter scratch (the
// string data type, bound twice), the adapter provider and the runtime-support batch to the canonical declarations
// of the runtime ABI anchor, by identity (`src/compiler/prepared-formatter-census.ts`). Each forgery below alters ONE
// population the census reads and must refuse by name, never with an exception out of compile().
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import type { RuntimeProviderDefinition } from "../src/ir/runtime/contracts/manifest.js";
import type { PhysicalNativeNumberFormatSetup, PhysicalNativeStringSetup } from "../src/ir/program-physical-plan.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
import { RUNTIME_PROVIDERS } from "../src/ir/runtime/manifest.js";
import { callableCarried, runtimeCensus } from "../src/compiler/prepared-provider-census.js";
import { emittedPhysicalSetupPlan } from "../src/ir/program-consumer.js";
import { formatterSetupJoins } from "../src/compiler/prepared-formatter-census.js";

type Receipt = { readonly key: string; readonly index: number };
type Contract = Parameters<typeof import("../src/compiler/prepared-provider-census.js").callableCarried>[1];
const forge = vi.hoisted(() => ({
  providers: undefined as
    | undefined
    | ((providers: readonly RuntimeProviderDefinition[]) => readonly RuntimeProviderDefinition[]),
  program: undefined as undefined | ((program: PreparedIrProgram) => PreparedIrProgram),
  contract: undefined as undefined | ((contract: Contract) => Contract),
  receipts: undefined as undefined | ((receipts: readonly Receipt[]) => readonly Receipt[]),
  strings: undefined as undefined | ((setup: PhysicalNativeStringSetup) => PhysicalNativeStringSetup),
  formatter: undefined as
    | undefined
    | ((setup: PhysicalNativeNumberFormatSetup) => PhysicalNativeNumberFormatSetup | undefined),
  // A forged binding index: the slot the completed emission reports for a binding id.
  index: undefined as
    | undefined
    | ((id: string, real: (id: string) => { space: string; index: number } | undefined) => unknown),
  forged: new WeakMap<object, unknown>(),
  // The last unforged census and contract calls, replayed by the census-level forgeries below.
  census: undefined as unknown,
  contracts: [] as unknown[],
}));
vi.mock("../src/compiler/prepared-provider-census.js", async (original) => {
  const real = await original<typeof import("../src/compiler/prepared-provider-census.js")>();
  return {
    ...real,
    runtimeCensus: (...[program, emission, backend, providers]: Parameters<typeof real.runtimeCensus>) => {
      if (!forge.program && !forge.providers) forge.census = [program, emission, backend, providers];
      return real.runtimeCensus(
        forge.program?.(program) ?? program,
        emission,
        backend,
        forge.providers?.(providers) ?? providers,
      );
    },
    callableCarried: (...[program, contract, carried]: Parameters<typeof real.callableCarried>) => {
      if (!forge.contract) forge.contracts.push([program, contract, carried]);
      return real.callableCarried(program, forge.contract?.(contract) ?? contract, carried);
    },
  };
});
vi.mock("../src/ir/program-consumer.js", async (original) => {
  const real = await original<typeof import("../src/ir/program-consumer.js")>();
  return {
    ...real,
    emittedSupportFunctionReceipts: (...args: Parameters<typeof real.emittedSupportFunctionReceipts>) => {
      const receipts = real.emittedSupportFunctionReceipts(...args);
      return forge.receipts?.(receipts) ?? receipts;
    },
    emittedProgramBindingIndex: (...[emitted, id]: Parameters<typeof real.emittedProgramBindingIndex>) =>
      forge.index
        ? (forge.index(id, (other) => real.emittedProgramBindingIndex(emitted, other as typeof id)) as ReturnType<
            typeof real.emittedProgramBindingIndex
          >)
        : real.emittedProgramBindingIndex(emitted, id),
    // One forged plan object per emitted plan, as R's census test does: every reader sees the same forgery.
    emittedPhysicalSetupPlan: (...args: Parameters<typeof real.emittedPhysicalSetupPlan>) => {
      const plan = real.emittedPhysicalSetupPlan(...args);
      if (!plan.nativeStrings || (!forge.strings && !forge.formatter)) return plan;
      if (!forge.forged.has(plan))
        forge.forged.set(plan, {
          ...plan,
          nativeStrings: forge.strings?.(plan.nativeStrings) ?? plan.nativeStrings,
          // A formatter forgery may also inject a setup into a program that has none.
          nativeNumberFormat: forge.formatter
            ? forge.formatter(plan.nativeNumberFormat as PhysicalNativeNumberFormatSetup)
            : plan.nativeNumberFormat,
        });
      return forge.forged.get(plan) as typeof plan;
    },
  };
});

const options = (target: "standalone" | "gc" = "standalone"): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target,
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

afterEach(() => {
  vi.restoreAllMocks();
  forge.providers = forge.program = forge.contract = forge.receipts = forge.strings = forge.formatter = undefined;
  forge.index = undefined;
  forge.forged = new WeakMap();
});

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);
const RUNTIME_DEMAND = "host provider or async demand is outside this numeric presentation contract";
const SUPPORT_DEMAND = "source and prepared runtime must independently prove no async/support demand";
const BOUNDARY = "promise/reference callable contracts require an explicit boundary producer";

async function run(source: string): Promise<"returned" | "threw"> {
  for (const spy of [vi.spyOn(gc, "generateModule"), vi.spyOn(linear, "generateLinearModule")])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  const result = await compile(source, options());
  expect(messages(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}
function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}
async function expectLikeNode(program: (right: boolean) => string) {
  expect(node(program(true))).toBe("returned");
  expect(await run(program(true))).toBe("returned");
  expect(node(program(false))).toBe("threw");
  expect(await run(program(false))).toBe("threw");
}

/**
 * A forgery refuses at the census: the census of the program compiled in `beforeAll` (replayed with the forgery
 * in place) answers nothing, which the presentation reports as the census gap (`refusedOnCompile`). A boundary
 * forgery: some captured callable contract is no longer carried.
 */
async function refused(expected: string): Promise<void> {
  if (expected === BOUNDARY) {
    expect(
      censusInputs.contracts.every(([program, contract, carried]) => callableCarried(program, contract, carried)),
    ).toBe(false);
    return;
  }
  expect(expected).toBe(RUNTIME_DEMAND);
  expect(runtimeCensus(...censusInputs.census)).toBeUndefined();
}
type CensusInputs = {
  readonly census: Parameters<typeof runtimeCensus>;
  readonly contracts: readonly Parameters<typeof callableCarried>[];
};
let censusInputs: CensusInputs;
async function capture(source: string): Promise<CensusInputs> {
  forge.contracts = [];
  expect(messages(await compile(source, options()))).toEqual([]);
  return {
    census: forge.census as Parameters<typeof runtimeCensus>,
    contracts: forge.contracts as Parameters<typeof callableCarried>[],
  };
}
beforeAll(async () => {
  censusInputs = await capture(PROGRAM);
}, 60_000);

/** A forged compile refuses: no artifact, the expected gap among its messages, and no internal failure. */
async function refusedOnCompile(expected: string, source = PROGRAM): Promise<void> {
  const result = await compile(source, options());
  expect(result.success).toBe(false);
  const text = messages(result).join("\n");
  expect(text).toContain(expected);
  expect(text).not.toMatch(/invariant|invalid-presentation|invalid-prepared-data|TypeError|Cannot read/);
}

// Strings beside the formatter (the full string setup), and the formatter alone (its string layout setup).
const PROGRAM = 'function g(v) { return String(v); }\nif (g(1.5) !== "1.5") throw 1;\nvar s = String(2);';
const LAYOUT = "var s = String(1);";

describe("#7354 Str2-c — String of a number on the Prepared path", () => {
  it.each([
    ["a typed number", "function f(n) { var m = n * 1; return String(m); }", "f(12.5)", '"12.5"', '"12.50"'],
    ["a typed number literal", "function f() { return String(-0); }", "f()", '"0"', '"-0"'],
    ["a dynamic number", "function g(v) { return String(v); }", "g(1e21)", '"1e+21"', '"1e21"'],
    ["a dynamic fraction", "function g(v) { return String(v); }", "g(0.1)", '"0.1"', '"0.10000000000000001"'],
    ["NaN", "function g(v) { return String(v); }", "g(0 / 0)", '"NaN"', '"nan"'],
    ["-Infinity", "function g(v) { return String(v); }", "g(-1 / 0)", '"-Infinity"', '"-inf"'],
    ["a dynamic boolean", "function g(v) { return String(v); }", "g(true)", '"true"', '"1"'],
    ["undefined", "function g(v) { return String(v); }", "g(undefined)", '"undefined"', '""'],
    ["null", "function g(v) { return String(v); }", "g(null)", '"null"', '"undefined"'],
    ["a dynamic string", "function g(v) { return String(v); }", 'g("ab")', '"ab"', '"a"'],
    ["a template literal's number", "function f(n) { var m = n * 2; return `${m}!`; }", "f(1.25)", '"2.5!"', '"2.5"'],
  ])("answers String of %s like node", async (_label, declarations, call, right, wrong) => {
    await expectLikeNode((ok) => `${declarations}\nif (${call} !== ${ok ? right : wrong}) throw 1;`);
  });

  it("formats in a loop across iterations", async () => {
    await expectLikeNode(
      (ok) =>
        `function g(v) { return String(v); }\nvar s = "";\nfor (var i = 0; i < 4; i++) { if (g(i / 2) !== String(i * 0.5)) throw 2; s = g(i); }\nif (s !== ${ok ? '"3"' : '"4"'}) throw 1;`,
    );
  });

  it("presents the formatter alone (no other string demand)", async () => {
    expect(await run(LAYOUT)).toBe("returned");
  });

  it("evaluates the operand of an unused String(x)", async () => {
    await expectLikeNode(
      (right) =>
        `function h(v) { if (v === 1) throw 7; return v; }\nfunction t(v) { String(h(v)); return 1; }\n` +
        `var r = 0;\ntry { t(1); } catch (e) { r = 1; }\nif (r !== ${right ? 1 : 0}) throw 1;`,
    );
  });

  it("keeps the gc target's contract (no formatter there)", async () => {
    const result = await compile("var s = String(1);", options("gc"));
    expect(result.success).toBe(false);
  });
});

type Setup = PhysicalNativeNumberFormatSetup;
type Binding = Setup["bindings"][number];
type Declaration = Setup["resources"]["declarations"][number];
const roleOf = (setup: Setup, role: readonly string[]): Declaration =>
  setup.resources.declarations.find((row) => JSON.stringify(row.role) === JSON.stringify(role))!;
const bindingOf = (setup: Setup, role: readonly string[]): Binding =>
  setup.bindings.find((row) => row.resourceKey === roleOf(setup, role).key)!;
const withBindings = (setup: Setup, bindings: readonly Binding[]): Setup => ({ ...setup, bindings });
const withDeclarations = (setup: Setup, declarations: readonly Declaration[]): Setup =>
  ({ ...setup, resources: { ...setup.resources, declarations } }) as Setup;

const ROWS: readonly (readonly [string, string])[] = [
  ...(["new", "get", "set", "fin", "trap", "radix-body", "radix-thunk", "finalize", "to-string"] as const).map(
    (role) => ["number-format", role] as const,
  ),
  ["number-format", "native-to-string"],
  ...(["mul-shift", "table-type", "inverse", "powers", "digits", "to-buffer"] as const).map(
    (role) => ["number-ryu", role] as const,
  ),
];

describe("#7354 Str2-c — the census refuses a forged formatter setup", () => {
  it("presents the unaltered program through the same wrappers", async () => {
    forge.providers = (rows) => rows;
    forge.program = (program) => program;
    forge.contract = (contract) => contract;
    forge.receipts = (rows) => rows;
    forge.strings = (setup) => setup;
    forge.formatter = (setup) => setup;
    expect(await run(PROGRAM)).toBe("returned");
  });

  it("refuses a program whose formatter setup is missing", async () => {
    forge.formatter = () => undefined;
    await refused(RUNTIME_DEMAND);
  });

  describe.each(ROWS)("the %s %s row", (family, role) => {
    const row = [family, role] as const;
    it("refuses its binding dropped", async () => {
      forge.formatter = (setup) =>
        withBindings(
          setup,
          setup.bindings.filter((b) => b !== bindingOf(setup, row)),
        );
      await refused(RUNTIME_DEMAND);
    });
    it("refuses its row (declaration and binding) dropped", async () => {
      forge.formatter = (setup) => {
        const declaration = roleOf(setup, row);
        return withDeclarations(
          withBindings(
            setup,
            setup.bindings.filter((b) => b.resourceKey !== declaration.key),
          ),
          setup.resources.declarations.filter((d) => d !== declaration),
        );
      };
      const result = await compile(PROGRAM, options());
      expect(result.success).toBe(false);
      expect(messages(result).join("\n")).not.toMatch(/invariant|invalid-presentation|TypeError|Cannot read/);
    });
    it("refuses its binding duplicated", async () => {
      forge.formatter = (setup) => withBindings(setup, [...setup.bindings, bindingOf(setup, row)]);
      await refused(RUNTIME_DEMAND);
    });
    it("refuses a second row of it added", async () => {
      forge.formatter = (setup) => {
        const declaration = roleOf(setup, row);
        const binding = bindingOf(setup, row);
        return withDeclarations(
          withBindings(setup, [...setup.bindings, { ...binding, resourceKey: declaration.key + ":2" }]),
          [...setup.resources.declarations, { ...declaration, key: declaration.key + ":2" }],
        );
      };
      await refused(RUNTIME_DEMAND);
    });
    it("refuses it relabelled to a role no row has", async () => {
      forge.formatter = (setup) =>
        withDeclarations(
          setup,
          setup.resources.declarations.map((d) =>
            d === roleOf(setup, row) ? { ...d, role: [family, role + "-x"] } : d,
          ),
        );
      await refused(RUNTIME_DEMAND);
    });
    it("refuses its binding moved to another row's resource key", async () => {
      forge.formatter = (setup) => {
        const other = roleOf(setup, row[1] === "new" ? ["number-format", "get"] : ["number-format", "new"]);
        return withBindings(
          setup,
          setup.bindings.map((b) => (b === bindingOf(setup, row) ? { ...b, resourceKey: other.key } : b)),
        );
      };
      await refused(RUNTIME_DEMAND);
    });
  });

  // Two rows exchange what binds them (reference and entry), each keeping its own declaration.
  it.each([
    ["new", "get"],
    ["set", "fin"],
    ["fin", "trap"],
    ["radix-body", "new"],
    ["radix-body", "radix-thunk"],
    ["native-to-string", "to-string"],
    ["native-to-string", "radix-body"],
    ["finalize", "to-string"],
  ])("refuses the %s and %s bindings swapped", async (left, right) => {
    forge.formatter = (setup) => {
      const a = bindingOf(setup, ["number-format", left]);
      const b = bindingOf(setup, ["number-format", right]);
      return withBindings(
        setup,
        setup.bindings.map((row) =>
          row === a
            ? { ...a, entry: b.entry, reference: b.reference }
            : row === b
              ? { ...b, entry: a.entry, reference: a.reference }
              : row,
        ),
      );
    };
    await refused(RUNTIME_DEMAND);
  });

  it.each([
    ["the adapter's reference", (b: Binding) => ({ ...b, reference: { ...b.reference, name: "other" } }) as Binding],
    [
      "the adapter bound to a runtime symbol",
      (b: Binding) =>
        ({
          ...b,
          reference: { ...b.reference, binding: { kind: "runtime", symbol: "__ir_number_toString_native" } },
        }) as Binding,
    ],
  ])("refuses %s altered", async (_label, alter) => {
    forge.formatter = (setup) => {
      const adapter = bindingOf(setup, ["number-format", "native-to-string"]);
      return withBindings(
        setup,
        setup.bindings.map((b) => (b === adapter ? alter(b) : b)),
      );
    };
    await refused(RUNTIME_DEMAND);
  });

  it.each([
    [
      "the support body's binding",
      (setup: Setup) => ({
        ...setup,
        support: { ...setup.support, bindingId: bindingOf(setup, ["number-format", "radix-thunk"]).entry.id },
      }),
    ],
    [
      "the support body's unit",
      (setup: Setup) => ({ ...setup, support: { ...setup.support, unitId: setup.bindings[0]!.entry.id as never } }),
    ],
    [
      "the support body's reference",
      (setup: Setup) => ({
        ...setup,
        support: { ...setup.support, reference: bindingOf(setup, ["number-format", "new"]).reference as never },
      }),
    ],
    [
      "a Ryu global's declared mutability",
      (setup: Setup) =>
        withDeclarations(
          setup,
          setup.resources.declarations.map((d) =>
            d === roleOf(setup, ["number-ryu", "inverse"]) && d.space === "global" ? { ...d, mutable: !d.mutable } : d,
          ),
        ),
    ],
    [
      "a kernel's declared signature",
      (setup: Setup) =>
        withDeclarations(
          setup,
          setup.resources.declarations.map((d) =>
            d === roleOf(setup, ["number-format", "get"]) && d.space === "function"
              ? { ...d, signature: { ...d.signature, params: [{ kind: "f64" as const }, { kind: "f64" as const }] } }
              : d,
          ),
        ),
    ],
    // Only a function keeps the batch's binding id: a type or global relabelled as a kernel is still setup-derived.
    ...(["table-type", "inverse"] as const).map(
      (role) =>
        [
          `the Ryu ${role} relabelled as a kernel`,
          (setup: Setup) =>
            withDeclarations(
              setup,
              setup.resources.declarations.map((d) =>
                d === roleOf(setup, ["number-ryu", role]) ? { ...d, role: ["number-format", "new"] } : d,
              ),
            ),
        ] as const,
    ),
  ])("refuses %s altered", async (_label, alter) => {
    forge.formatter = alter;
    await refused(RUNTIME_DEMAND);
  });
});

// (#7354 Str2 review 1) Every field of every formatter row is forged ALONE, and swapped between two rows: the rows
// of the same shape (which a swap could pass off as each other), and the review's repros. The forgeries are generated
// from the row table, so a new row is covered without a new test.
type Field = "role" | "entry id" | "reference" | "slot" | "signature" | "receipt";
const FIELDS: readonly Field[] = ["role", "entry id", "reference", "slot", "signature", "receipt"];
const SPACES: Readonly<Record<string, Declaration["space"]>> = {
  "table-type": "type",
  inverse: "global",
  powers: "global",
};
const spaceOf = (row: readonly string[]) => SPACES[row[1]!] ?? "function";
/** A declaration without its identity: a function's signature, a global's type and mutability, a type's layout. */
const shapeOf = (declaration: Declaration) => {
  const { key: _key, role: _role, name: _name, ...shape } = declaration as Declaration & { name?: string };
  return shape;
};
/** A shape no canonical row has. */
function foreignShape(declaration: Declaration): object {
  if (declaration.space === "function")
    return { ...shapeOf(declaration), signature: { params: [], results: [{ kind: "i32" }] } };
  if (declaration.space === "global") return { ...shapeOf(declaration), valueType: { kind: "i32" } };
  return { ...shapeOf(declaration), shape: { ...declaration.shape, name: "forged" } };
}
/**
 * How a field of a row is read and written in a setup, and given a value no row has. A row is named by its
 * declaration key (resource key), which a forged role does not move.
 */
interface SetupField {
  readonly read: (setup: Setup, key: string) => unknown;
  readonly write: (setup: Setup, key: string, value: unknown) => Setup;
  readonly foreign: (setup: Setup, key: string) => unknown;
}
const declarationOf = (setup: Setup, key: string) => setup.resources.declarations.find((row) => row.key === key)!;
const publishedOf = (setup: Setup, key: string) => setup.bindings.find((row) => row.resourceKey === key)!;
const declarationWith = (setup: Setup, key: string, alter: (d: Declaration) => Declaration): Setup =>
  withDeclarations(
    setup,
    setup.resources.declarations.map((d) => (d.key === key ? alter(d) : d)),
  );
const bindingWith = (setup: Setup, key: string, alter: (b: Binding) => Binding): Setup =>
  withBindings(
    setup,
    setup.bindings.map((b) => (b.resourceKey === key ? alter(b) : b)),
  );
const SETUP_FIELDS: Partial<Record<Field, SetupField>> = {
  role: {
    read: (setup, key) => declarationOf(setup, key).role,
    write: (setup, key, value) => declarationWith(setup, key, (d) => ({ ...d, role: value as string[] })),
    foreign: (setup, key) => [...declarationOf(setup, key).role, "forged"],
  },
  signature: {
    read: (setup, key) => shapeOf(declarationOf(setup, key)),
    write: (setup, key, value) =>
      declarationWith(
        setup,
        key,
        (d) => ({ ...(value as object), key: d.key, role: d.role, name: (d as { name?: string }).name }) as Declaration,
      ),
    foreign: (setup, key) => foreignShape(declarationOf(setup, key)),
  },
  "entry id": {
    read: (setup, key) => publishedOf(setup, key).entry.id,
    write: (setup, key, value) => bindingWith(setup, key, (b) => ({ ...b, entry: { ...b.entry, id: value as never } })),
    foreign: (setup, key) => publishedOf(setup, key).entry.id + ":forged",
  },
  reference: {
    read: (setup, key) => publishedOf(setup, key).reference,
    write: (setup, key, value) => bindingWith(setup, key, (b) => ({ ...b, reference: value as Binding["reference"] })),
    foreign: (setup, key) => ({ ...publishedOf(setup, key).reference, name: "forged" }),
  },
};
/** The formatter setup of the captured census. */
const capturedSetup = (): Setup => emittedPhysicalSetupPlan(censusInputs.census[1]).nativeNumberFormat!;

/**
 * Arrange one forgery: each `[row, from]` gives `row`'s `field` the value `from` has in the unforged setup (all
 * values are read before any is written), or a value no row has when `from` is undefined or has the same value
 * (two rows of one shape share their signature, so copying it would forge nothing).
 */
function arrangeField(
  field: Field,
  assignments: readonly (readonly [readonly string[], readonly string[] | undefined])[],
) {
  const setup = capturedSetup();
  const keyed = assignments.map(([row, from]) => [roleOf(setup, row).key, from && roleOf(setup, from).key] as const);
  if (field === "slot") {
    const ids = new Map(
      keyed.map(([key, from]) => [publishedOf(setup, key).entry.id, from && publishedOf(setup, from).entry.id]),
    );
    forge.index = (id, real) => {
      if (!ids.has(id)) return real(id);
      const from = ids.get(id);
      // A slot no formatter row has: the first or second slot of the space (another setup's, or a source function).
      return from ? real(from) : { ...real(id)!, index: real(id)!.index === 0 ? 1 : 0 };
    };
    return;
  }
  if (field === "receipt") {
    const keys = new Map(keyed);
    forge.receipts = (rows) =>
      rows.map((row) => (keys.has(row.key) ? { ...row, key: keys.get(row.key) ?? row.key + ":forged" } : row));
    return;
  }
  const { read, write, foreign } = SETUP_FIELDS[field]!;
  forge.formatter = (unforged) => {
    const values = keyed.map(([key, from]) => {
      const copied = from === undefined ? undefined : read(unforged, from);
      const own = JSON.stringify(read(unforged, key));
      return [key, copied !== undefined && JSON.stringify(copied) !== own ? copied : foreign(unforged, key)] as const;
    });
    return values.reduce((forged, [key, value]) => write(forged, key, value), unforged);
  };
}

describe("#7354 Str2 — every field of every formatter row is joined by identity", () => {
  /** The next row of the same space, so a forged field takes a value a real row has; undefined when it is alone. */
  const partnerOf = (row: readonly string[]) => {
    const peers = ROWS.filter((other) => spaceOf(other) === spaceOf(row));
    return peers.length > 1 ? peers[(peers.indexOf(row as (typeof ROWS)[number]) + 1) % peers.length] : undefined;
  };
  // Only a function has a support receipt.
  const alone = ROWS.flatMap((row) =>
    FIELDS.filter((field) => field !== "receipt" || spaceOf(row) === "function").map(
      (field) => [field, row.join(" "), row, partnerOf(row)] as const,
    ),
  );
  it.each(alone)("refuses the %s alone of the %s row", async (field, _label, row, partner) => {
    arrangeField(field, [[row, partner]]);
    await refused(RUNTIME_DEMAND);
  });

  it.each(alone.filter(([, , , partner]) => partner !== undefined))(
    "refuses the %s alone of the %s row set to a value no row has",
    async (field, _label, row) => {
      arrangeField(field, [[row, undefined]]);
      await refused(RUNTIME_DEMAND);
    },
  );

  // A swap of two rows of the same shape: the census must tell them apart by identity, not by shape. (Their shared
  // signature swapped is no forgery; each one's own is forged alone above.)
  const sameShapePairs = () => {
    const setup = capturedSetup();
    const pairs = ROWS.flatMap((left, index) =>
      ROWS.slice(index + 1)
        .filter(
          (right) => JSON.stringify(shapeOf(roleOf(setup, left))) === JSON.stringify(shapeOf(roleOf(setup, right))),
        )
        .map((right) => [left, right] as const),
    );
    expect(pairs.map((pair) => pair.map((row) => row[1]))).toEqual([["inverse", "powers"]]);
    return pairs;
  };
  it.each(["role", "entry id", "reference"] as const)(
    "refuses the %s swapped between two rows of one shape",
    async (field) => {
      for (const [left, right] of sameShapePairs()) {
        arrangeField(field, [
          [left, right],
          [right, left],
        ]);
        await refused(RUNTIME_DEMAND);
      }
    },
  );
  // (#7354 Str2 review 2) Two same-shape globals exchanged in the emission's binding-index record: each slot's
  // initializer is still the other table's.
  it("refuses two same-shape globals exchanged in the emission's own index record", async () => {
    for (const [left, right] of sameShapePairs()) {
      arrangeField("slot", [
        [left, right],
        [right, left],
      ]);
      await refused(RUNTIME_DEMAND);
    }
  });

  // The review's repros: kernel roles swapped or doubled, kernel and Ryu references swapped.
  const kernel = (role: string) => ["number-format", role] as const;
  it.each([
    ["role", kernel("new"), kernel("get")],
    ["role", kernel("set"), kernel("fin")],
    ["role", kernel("get"), kernel("trap")],
    ["reference", kernel("new"), kernel("get")],
    ["reference", ["number-ryu", "inverse"], ["number-ryu", "powers"]],
  ] as const)("refuses the %s swapped between %j and %j", async (field, left, right) => {
    arrangeField(field, [
      [left, right],
      [right, left],
    ]);
    await refused(RUNTIME_DEMAND);
  });
  it.each([
    ["role", kernel("trap"), kernel("new")],
    ["reference", kernel("radix-body"), kernel("new")],
  ] as const)("refuses the %s of %j set to that of %j", async (field, row, from) => {
    arrangeField(field, [[row, from]]);
    await refused(RUNTIME_DEMAND);
  });

  it("refuses a formatter setup injected into a program without a formatter call", async () => {
    const injected = capturedSetup();
    forge.formatter = () => injected;
    await refusedOnCompile(RUNTIME_DEMAND, 'var s = "a";\nif (s !== "a") throw 1;');
  });

  // One forgery per field category through compile(): refused by name, never an exception.
  it.each(FIELDS)("refuses a forged %s through compile()", async (field) => {
    arrangeField(field, [[kernel("trap"), field === "receipt" || field === "slot" ? kernel("new") : undefined]]);
    await refusedOnCompile(RUNTIME_DEMAND);
  });
});

// (#7354 Str2 review 2) The census reads no field of the formatter setup past: every leaf of the captured setup's
// object graph, forged alone to another value of its type, refuses. The walk replaces hand-enumerated field lists.
type Path = readonly string[];
const LEAF_COUNT = 532;
/** Every leaf (a primitive) of a plain-data graph, by path. An empty array or object has none. */
function leavesOf(value: unknown, path: Path = []): Path[] {
  if (value === null || typeof value !== "object") return [path];
  return Object.keys(value).flatMap((key) => leavesOf((value as Record<string, unknown>)[key], [...path, key]));
}
/** `value` with the node at `path` replaced (copied along the path; the frozen original is untouched). */
function withNode(value: unknown, path: Path, node: unknown): unknown {
  if (path.length === 0) return node;
  const [key, ...rest] = path;
  const copy: Record<string, unknown> = Array.isArray(value) ? [...value] : { ...(value as object) };
  copy[key!] = withNode((value as Record<string, unknown>)[key!], rest, node);
  return copy;
}
const nodeAt = (value: unknown, path: Path): unknown =>
  path.reduce((node, key) => (node as Record<string, unknown>)[key], value);
/** Another value of the leaf's type; undefined for a leaf whose type has no second value (none occurs). */
function otherLeaf(leaf: unknown): unknown {
  if (typeof leaf === "string") return leaf + ":forged";
  if (typeof leaf === "number") return leaf + 1;
  if (typeof leaf === "boolean") return !leaf;
  if (typeof leaf === "bigint") return leaf + 1n;
  return undefined;
}
/** Replay the captured census with the formatter setup replaced by `setup`. */
function censusWith(setup: unknown, backend = censusInputs.census[2]) {
  forge.formatter = () => setup as Setup;
  forge.forged = new WeakMap();
  const [program, emission, , providers] = censusInputs.census;
  return runtimeCensus(program, emission, backend, providers);
}

describe("#7354 Str2 review 2 — no field of the formatter setup is read past", () => {
  // The join itself per leaf (the census refuses whenever it does not hold: the named repros below go through it).
  it("refuses every leaf of the setup forged alone", () => {
    const [program, emission, backend] = censusInputs.census;
    const plan = emittedPhysicalSetupPlan(emission);
    const setup = plan.nativeNumberFormat!;
    const joins = (forged: unknown) =>
      formatterSetupJoins(program, forged as Setup, plan.nativeStrings!.resources, backend.numberFormat);
    expect(joins(setup)).toBe(true);
    const leaves = leavesOf(setup);
    // Reported in the issue file's review-round-2 section.
    expect(leaves.length).toBe(LEAF_COUNT);
    const accepted = leaves.filter((path) => {
      const leaf = nodeAt(setup, path);
      expect(otherLeaf(leaf), path.join(".")).not.toBeUndefined();
      return joins(withNode(setup, path, otherLeaf(leaf)));
    });
    expect(accepted.map((path) => path.join("."))).toEqual([]);
  });

  // The review's repros, each by name.
  const bindingIndex = (setup: Setup, role: readonly string[]) =>
    String(setup.bindings.indexOf(bindingOf(setup, role)));
  const kernelNew = ["number-format", "new"] as const;
  it.each([
    [
      "a formatter binding's signature intent",
      (s: Setup) => ["bindings", bindingIndex(s, kernelNew), "entry", "intent"],
      (s: Setup) => bindingOf(s, ["number-format", "get"]).entry.intent,
    ],
    [
      "a formatter binding's slot space",
      (s: Setup) => ["bindings", bindingIndex(s, kernelNew), "entry", "slotSpace"],
      () => "global",
    ],
    [
      "a formatter binding's slot policy",
      (s: Setup) => ["bindings", bindingIndex(s, kernelNew), "entry", "slotPolicy"],
      () => "optional",
    ],
    [
      "the support's resource key",
      () => ["support", "resourceKey"],
      (s: Setup) => bindingOf(s, ["number-format", "radix-thunk"]).resourceKey,
    ],
    ["the support's params", () => ["support", "params"], () => []],
    ["the support's results", () => ["support", "results"], () => []],
    ["the recipe input's key", () => ["resources", "input", "key"], (s: Setup) => s.resources.input.key + ":2"],
    [
      "the recipe input's integer policy",
      () => ["resources", "input", "integerBeforeScratch"],
      (s: Setup) => !s.resources.input.integerBeforeScratch,
    ],
    ["the support unit", () => ["resources", "supportUnitId"], (s: Setup) => s.bindings[0]!.entry.id],
  ] as const)("refuses %s altered", (_label, path, value) => {
    const setup = capturedSetup();
    expect(censusWith(withNode(setup, path(setup), value(setup)))).toBeUndefined();
  });
  it("refuses the scratch removed", () => {
    const setup = capturedSetup();
    const { scratch: _scratch, ...resources } = setup.resources;
    expect(censusWith({ ...setup, resources })).toBeUndefined();
  });

  // The number-format policy determines the recipe input (and the radix body), so it is compared, never assumed.
  it.each([
    [
      "flipped",
      (policy: { integerBeforeScratch: boolean }) => ({
        numberFormat: { integerBeforeScratch: !policy.integerBeforeScratch },
      }),
    ],
    ["absent", () => ({ numberFormat: undefined })],
  ] as const)("refuses the number-format policy %s, without an exception", (_label, policy) => {
    const backend = censusInputs.census[2];
    expect(censusWith(capturedSetup(), { ...backend, ...policy(backend.numberFormat!) })).toBeUndefined();
  });
  it("refuses an empty string-setup literal key, without an exception", () => {
    const setup = capturedSetup();
    forge.strings = (strings) =>
      ({
        ...strings,
        resources: { ...strings.resources, literalRequirements: { ...strings.resources.literalRequirements, key: "" } },
      }) as PhysicalNativeStringSetup;
    expect(censusWith(setup)).toBeUndefined();
  });

  // Known limit, ruled harmless (#7354 issue file, "Review round 2 (Str2)"): the binding-index record and the support receipts are snapshots the consumer
  // takes after the module is complete (`recordEmissionObservation`); the module's bytes come from the reservations
  // the join pins. Two same-signature functions exchanged in BOTH records leave the census nothing to tell them
  // apart by, and change no byte: it is a forgery of evidence nothing else reads.
  it("known limit: accepts two same-signature functions exchanged in both the index record and the receipts", () => {
    const plan = emittedPhysicalSetupPlan(censusInputs.census[1]);
    const strings = plan.nativeStrings as PhysicalNativeStringSetup;
    const declared = (role: readonly string[]) =>
      [...strings.resources.declarations, ...plan.nativeNumberFormat!.resources.declarations].find(
        (row) => JSON.stringify(row.role) === JSON.stringify(role),
      )!;
    const pair = [declared(["values", "box-number"]), declared(["number-format", "to-string"])];
    const ids = pair.map(
      (row) =>
        [...strings.bindings, ...plan.nativeNumberFormat!.bindings].find((b) => b.resourceKey === row.key)!.entry.id,
    );
    forge.index = (id, real) => real(id === ids[0] ? ids[1]! : id === ids[1] ? ids[0]! : id);
    forge.receipts = (rows) =>
      rows.map((row) =>
        row.key === pair[0]!.key
          ? { ...row, key: pair[1]!.key }
          : row.key === pair[1]!.key
            ? { ...row, key: pair[0]!.key }
            : row,
      );
    expect(runtimeCensus(...censusInputs.census)).toBeDefined();
  });
});

describe("#7354 Str2-c — the census refuses a forged formatter scratch", () => {
  const scratchBindings = (setup: PhysicalNativeStringSetup) =>
    setup.bindings.filter((row) => row.resourceKey.endsWith(":data"));
  it.each([
    [
      "dropped from the string setup",
      (setup: PhysicalNativeStringSetup) => ({ ...setup, formatterScratch: undefined }),
    ],
    [
      "with another nullability",
      (setup: PhysicalNativeStringSetup) => ({
        ...setup,
        formatterScratch: { ...setup.formatterScratch!, nullable: !setup.formatterScratch!.nullable },
      }),
    ],
    [
      "without its canonical binding",
      (setup: PhysicalNativeStringSetup) => ({
        ...setup,
        bindings: setup.bindings.filter((row) => row !== scratchBindings(setup)[0]),
      }),
    ],
    [
      "without the setup's own binding",
      (setup: PhysicalNativeStringSetup) => ({
        ...setup,
        bindings: setup.bindings.filter((row) => row !== scratchBindings(setup)[1]),
      }),
    ],
    [
      "with the setup's own binding duplicated",
      (setup: PhysicalNativeStringSetup) => ({ ...setup, bindings: [...setup.bindings, scratchBindings(setup)[1]!] }),
    ],
    [
      "with both bindings on the canonical reference",
      (setup: PhysicalNativeStringSetup) => ({
        ...setup,
        bindings: setup.bindings.map((row) =>
          row === scratchBindings(setup)[1] ? { ...row, reference: scratchBindings(setup)[0]!.reference } : row,
        ),
      }),
    ],
    [
      "with the setup's own binding under another id",
      (setup: PhysicalNativeStringSetup) => ({
        ...setup,
        bindings: setup.bindings.map((row) =>
          row === scratchBindings(setup)[1]
            ? { ...row, reference: { ...row.reference, binding: { kind: "source", bindingId: row.entry.id } } as never }
            : row,
        ),
      }),
    ],
    [
      "on another entry",
      (setup: PhysicalNativeStringSetup) => {
        const any = setup.bindings.find((row) => row.resourceKey.endsWith(":any"))!;
        return {
          ...setup,
          bindings: setup.bindings.map((row) =>
            scratchBindings(setup).includes(row) ? { ...row, entry: any.entry } : row,
          ),
        };
      },
    ],
    ...[0, 1].map(
      (which) =>
        [
          `with its ${which ? "setup-derived" : "canonical"} binding alone on another entry id`,
          (setup: PhysicalNativeStringSetup) => {
            const any = setup.bindings.find((row) => row.resourceKey.endsWith(":any"))!;
            const target = scratchBindings(setup)[which];
            return {
              ...setup,
              bindings: setup.bindings.map((row) =>
                row === target ? { ...row, entry: { ...row.entry, id: any.entry.id } } : row,
              ),
            };
          },
        ] as const,
    ),
    [
      // Same storage and nullability, another type identity: on the setup and on its canonical binding alike.
      "replaced by a structurally equal but distinct support type",
      (setup: PhysicalNativeStringSetup) => {
        const scratch = setup.formatterScratch!;
        const ref = { ...scratch.ref, binding: { kind: "support", bindingId: scratch.ref.binding.bindingId + "x" } };
        const canonical = scratchBindings(setup)[0];
        return {
          ...setup,
          formatterScratch: { ...scratch, ref } as never,
          bindings: setup.bindings.map((row) => (row === canonical ? { ...row, reference: ref as never } : row)),
        };
      },
    ],
    [
      "with the string data type relabelled",
      (setup: PhysicalNativeStringSetup) =>
        ({
          ...setup,
          resources: {
            ...setup.resources,
            declarations: setup.resources.declarations.map((row) =>
              row.key.endsWith(":data") ? { ...row, role: ["string-type", "scratch"] } : row,
            ),
          },
        }) as never,
    ],
  ])("refuses the scratch %s", async (_label, alter) => {
    forge.strings = alter;
    await refused(RUNTIME_DEMAND);
  });

  it("refuses a formatter scratch on a program without a formatter", async () => {
    const result = await compile('var s = "a";\nif (s !== "a") throw 1;', options());
    expect(result.success).toBe(true);
    // The string setup of a formatter-free program never carries a scratch; one that does joins nothing.
    forge.strings = (setup) => ({
      ...setup,
      formatterScratch: { kind: "support-ref", ref: { kind: "type", name: "__nfd_buffer" }, nullable: true } as never,
    });
    await refusedOnCompile(RUNTIME_DEMAND, 'var s = "a";\nif (s !== "a") throw 1;');
  });
});

describe("#7354 Str2-c — the census refuses a forged provider, receipt or support batch", () => {
  const adapter = (row: RuntimeProviderDefinition) => row.id === "native.async.number-to-string";
  it.each([
    ["drops the adapter provider", (rows: readonly RuntimeProviderDefinition[]) => rows.filter((row) => !adapter(row))],
    ["duplicates it", (rows: readonly RuntimeProviderDefinition[]) => [...rows, rows.find(adapter)!]],
    [
      "renames it",
      (rows: readonly RuntimeProviderDefinition[]) =>
        rows.map((row) => (adapter(row) ? { ...row, id: row.id + ".renamed" } : row)),
    ],
    [
      "relabels its feature",
      (rows: readonly RuntimeProviderDefinition[]) =>
        rows.map((row) => (adapter(row) ? { ...row, feature: "async.native.console-append" as never } : row)),
    ],
    [
      "replaces it by another native callable provider",
      (rows: readonly RuntimeProviderDefinition[]) =>
        rows.map((row) =>
          adapter(row) ? RUNTIME_PROVIDERS.find((p) => p.id === "native.async.console-append")! : row,
        ),
    ],
  ])("refuses a provider census that %s", async (_label, alter) => {
    forge.providers = alter;
    await refused(RUNTIME_DEMAND);
  });

  const formatterReceipts = (rows: readonly Receipt[]) =>
    rows.filter((row) => row.key.startsWith("native-number-format"));
  it.each([
    [
      "drops a formatter receipt",
      (rows: readonly Receipt[]) => rows.filter((row) => row !== formatterReceipts(rows)[0]),
    ],
    ["duplicates one", (rows: readonly Receipt[]) => [...rows, formatterReceipts(rows)[0]!]],
    [
      "swaps two formatter receipts' indices",
      (rows: readonly Receipt[]) => {
        const [a, b] = formatterReceipts(rows);
        return rows.map((row) =>
          row === a ? { ...a!, index: b!.index } : row === b ? { ...b!, index: a!.index } : row,
        );
      },
    ],
  ])("refuses a support population that %s", async (_label, alter) => {
    forge.receipts = alter;
    await refused(RUNTIME_DEMAND);
  });

  type Batch = NonNullable<PreparedIrProgram["runtimeSupport"]>["batches"][number];
  const batches = (alter: (batches: readonly Batch[]) => readonly Batch[]) => (program: PreparedIrProgram) =>
    ({
      ...program,
      runtimeSupport: { ...program.runtimeSupport!, batches: alter(program.runtimeSupport!.batches) },
    }) as PreparedIrProgram;
  const batch = (alter: (batch: Batch) => unknown) => batches((rows) => rows.map((row) => alter(row) as Batch));
  it.each([
    ["no batch", batches(() => [])],
    ["two batches", batches((rows) => [...rows, ...rows])],
    ["a batch of another kind", batch((row) => ({ ...row, kind: "number-format-radix-v2" }))],
    ["a batch of another source", batch((row) => ({ ...row, sourceId: row.sourceId + "x" }))],
    [
      "another scratch declaration",
      batch((row) => ({ ...row, scratch: { ...row.scratch, type: { ...row.scratch.type, nullable: false } } })),
    ],
    ["a kernel declaration dropped", batch((row) => ({ ...row, kernels: row.kernels.slice(1) }))],
    [
      "two kernel declarations swapped",
      batch((row) => ({ ...row, kernels: [row.kernels[1], row.kernels[0], ...row.kernels.slice(2)] })),
    ],
    [
      "another implementation declaration",
      batch((row) => ({ ...row, implementation: { ...row.implementation, declaration: row.kernels[0] } })),
    ],
    [
      "another implementation unit",
      batch((row) => ({
        ...row,
        implementation: { ...row.implementation, body: { ...row.implementation.body, unitId: row.demandOwners[0] } },
      })),
    ],
    ["no demand owner", batch((row) => ({ ...row, demandOwners: [] }))],
    [
      "an extra demand owner",
      batch((row) => ({ ...row, demandOwners: [...row.demandOwners, row.implementation.body.unitId] })),
    ],
  ])("refuses a runtime-support census with %s", async (_label, alter) => {
    forge.program = alter;
    await refused(RUNTIME_DEMAND);
  });

  it("refuses a batch the census never joined (support demand stays its own gap)", async () => {
    forge.formatter = () => undefined;
    await refusedOnCompile(SUPPORT_DEMAND);
  });

  // The kernels' scratch contracts are carried only as the canonical kernels' and only with the canonical scratch.
  const scratchOf = (contract: Contract) =>
    [...contract.params, ...contract.results].find((type) => type.kind === "support-ref")!;
  let scratch: ReturnType<typeof scratchOf> | undefined;
  it.each([
    [
      "the scratch on a non-kernel entry (the radix body)",
      (contract: Contract) => {
        if (contract.ref.name === "__nfd_new") scratch = scratchOf(contract);
        return contract.ref.name === "__sh_num_toString_radix" && scratch
          ? { ...contract, params: [scratch, ...contract.params.slice(1)] }
          : contract;
      },
    ],
    [
      "another support type on a kernel",
      (contract: Contract) =>
        contract.ref.name === "__nfd_get"
          ? {
              ...contract,
              params: [
                {
                  ...scratchOf(contract),
                  ref: { ...(scratchOf(contract) as { ref: object }).ref, name: "other" },
                } as never,
                ...contract.params.slice(1),
              ],
            }
          : contract,
    ],
    [
      "the scratch with another nullability on a kernel",
      (contract: Contract) =>
        contract.ref.name === "__nfd_fin"
          ? { ...contract, params: [{ ...scratchOf(contract), nullable: false } as never, ...contract.params.slice(1)] }
          : contract,
    ],
    [
      "a kernel's scratch contract under a foreign reference",
      (contract: Contract) =>
        contract.ref.name === "__nfd_set" ? { ...contract, ref: { ...contract.ref, name: "__nfd_set_x" } } : contract,
    ],
  ])("refuses %s", async (_label, alter) => {
    scratch = undefined;
    forge.contract = alter;
    await refused(BOUNDARY);
  });
});

describe("#7354 Str2-c — a program without a formatter call presents as before", () => {
  it("selects no formatter provider, setup or batch", async () => {
    let seen: PreparedIrProgram | undefined;
    let providers: readonly RuntimeProviderDefinition[] = [];
    forge.program = (program) => (seen = program);
    forge.providers = (rows) => (providers = rows);
    expect(await run('var s = "a" + "b";\nif (s !== "ab") throw 1;')).toBe("returned");
    expect(seen?.runtimeSupport).toBeUndefined();
    expect(providers.map((row) => row.id)).not.toContain("native.async.number-to-string");
  });

  it("refuses a support batch on a program without a formatter call", async () => {
    const support = censusInputs.census[0].runtimeSupport;
    forge.program = (program) => ({ ...program, runtimeSupport: support }) as PreparedIrProgram;
    await refusedOnCompile(RUNTIME_DEMAND, 'var s = "a";\nif (s !== "a") throw 1;');
  });
});

describe("#7354 Str2-c — census forgeries refuse by name through compile()", () => {
  it("replays an unforged census and contract population that join", () => {
    expect(runtimeCensus(...censusInputs.census)?.native).toBeDefined();
    expect(censusInputs.contracts.length).toBeGreaterThan(0);
    expect(
      censusInputs.contracts.every(([program, contract, carried]) => callableCarried(program, contract, carried)),
    ).toBe(true);
  });

  const kernelScratch = () =>
    censusInputs.contracts.map(([, contract]) => contract).find((row) => row.ref.name === "__nfd_new")!.results[0]!;
  it.each([
    [
      "a kernel binding dropped",
      () => {
        forge.formatter = (setup) =>
          withBindings(
            setup,
            setup.bindings.filter((b) => b !== bindingOf(setup, ["number-format", "new"])),
          );
      },
      RUNTIME_DEMAND,
    ],
    [
      "the scratch dropped",
      () => {
        forge.strings = (setup) => ({ ...setup, formatterScratch: undefined });
      },
      RUNTIME_DEMAND,
    ],
    [
      "the adapter provider dropped",
      () => {
        forge.providers = (rows) => rows.filter((row) => row.id !== "native.async.number-to-string");
      },
      RUNTIME_DEMAND,
    ],
    [
      "a formatter receipt dropped",
      () => {
        forge.receipts = (rows) => rows.filter((row) => !row.key.endsWith(":radix-thunk"));
      },
      RUNTIME_DEMAND,
    ],
    [
      "the support batch dropped",
      () => {
        forge.program = (program) =>
          ({ ...program, runtimeSupport: { ...program.runtimeSupport!, batches: [] } }) as PreparedIrProgram;
      },
      RUNTIME_DEMAND,
    ],
    [
      "a scratch contract on the radix body",
      () => {
        forge.contract = (contract) =>
          contract.ref.name === "__sh_num_toString_radix"
            ? { ...contract, params: [kernelScratch(), contract.params[1]!] }
            : contract;
      },
      BOUNDARY,
    ],
  ])("refuses %s", async (_label, arrange, expected) => {
    arrange();
    await refusedOnCompile(expected);
  });
});
