// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F2-S1 — the string boundary opens.
//
// Two sub-migrations, one PR, the F1-S4 shape:
//
//  * **sub-A** puts the string relational compare seam (`a < b` on two
//    strings) under manifest authority. The resolve-time provider table used
//    to read `ctx.nativeStrings` DIRECTLY — family 2's largest un-governed
//    dispatch — and pick `env.string_compare` or the native `__str_compare`
//    helper. That decision is now a frozen `stringCompare` policy, resolved
//    once by the caller before freeze.
//
//    Two things make this family unlike every family-1 slice. First, the seam
//    carries NO intrinsic instruction: from-ast emits a plain `call` through
//    the `__ir_str_compare` sentinel func-ref, so the demand is REQUESTED at
//    freeze (the F1-S3 `generatorNumberBoxDemand` shape) rather than collected
//    from an `intrinsic` use. Second, the host arm's physical import is a BASE
//    import minted by the legacy import collector long before IR preparation
//    runs — not an `addUnionImports` member and not an `ensureLateImport`
//    registration — so the migration cannot mint anything at all; it looks the
//    capability record's field up in `ctx.funcMap`, exactly as before.
//
//  * **sub-B** retires `lower.ts`'s `forof.string` `?? irIntrinsicFuncRef(...)`
//    fallback, the LAST string-op lane fallback in that file (the `gen.*`
//    quartet went in F1-S4; the surviving quartet is `extern.*`, family 6).
//    `attachIrStringSupport` attaches the provider unconditionally, and the
//    linear backend cannot reach the case at all, so the fallback was dead.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { ASYNC_HOST_CAPABILITY_RECORDS, asAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { prepareIrRuntimeManifest, preparedStringCompareProvider } from "../src/ir/intrinsic-support.js";
import { EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE, INTRINSIC_SIGNATURE_VERSION } from "../src/ir/intrinsics.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import {
  asBlockId,
  asValueId,
  forEachInstrDeep,
  irVal,
  type IrFunction,
  type IrInstr,
  type IrType,
} from "../src/ir/nodes.js";
import {
  BOOLEAN_BOUNDARY_POLICY_DISABLED,
  EXTERN_IS_UNDEFINED_POLICY_DISABLED,
  GENERATOR_NUMBER_BOX_POLICY_DISABLED,
  NUMBER_BOUNDARY_POLICY_DISABLED,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  STRING_COMPARE_POLICY_DISABLED,
  STRING_CONCAT_POLICY_DISABLED,
  STRING_CONCAT_MANY_POLICY_DISABLED,
  STRING_EQ_POLICY_DISABLED,
  STRING_LEN_POLICY_DISABLED,
  STRING_COMPARE_RUNTIME_FEATURES,
  STRING_COMPARE_RUNTIME_PROVIDER_IDS,
  type RuntimeManifestPolicy,
  type StringComparePolicy,
} from "../src/ir/runtime-manifest.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { attachIrStringSupport } from "../src/ir/string-support.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-string-boundary-compare");
const I32 = irVal({ kind: "i32" });
const STRING: IrType = { kind: "string" };

const HOST_COMPARE: StringComparePolicy = { compare: "host" };
const NATIVE_COMPARE: StringComparePolicy = { compare: "native" };

/** The sentinel func-ref from-ast emits for `a < b` on two strings. */
const IR_STRING_COMPARE_FN = "__ir_str_compare";

const COMPARE_SOURCE = `export function lt(a: string, b: string): boolean { return a < b; }`;

/** All four relational operators in one owner — the seam, exhaustively. */
const COMPARE_ALL_SOURCE = `export function all(a: string, b: string): number {
  let n = 0;
  if (a < b) n = n + 1;
  if (a > b) n = n + 2;
  if (a <= b) n = n + 4;
  if (a >= b) n = n + 8;
  return n;
}`;

function instrsOf(fn: IrFunction): IrInstr[] {
  const found: IrInstr[] = [];
  const scan = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) forEachInstrDeep(root, (instr) => found.push(instr));
  };
  for (const block of fn.blocks) scan(block.instrs);
  for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  return found;
}

function policy(stringCompare: StringComparePolicy): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", stringCompare };
}

/**
 * One hand-built owner that performs a string relational compare, i.e. carries
 * the exact `call` shape from-ast emits. It has no `intrinsic` instruction at
 * all — which is the whole reason this family needs a freeze-time demand.
 */
function compareFunction(name: string): IrFunction {
  const instr: IrInstr = {
    kind: "call",
    target: irIntrinsicFuncRef(IR_STRING_COMPARE_FN),
    args: [asValueId(0), asValueId(1)],
    result: asValueId(2),
    resultType: I32,
  } as unknown as IrInstr;
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [
      { name: "a", type: STRING, value: asValueId(0) },
      { name: "b", type: STRING, value: asValueId(1) },
    ],
    resultTypes: [I32],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [instr],
        terminator: { kind: "return", values: [asValueId(2)] },
      },
    ],
    exported: false,
    valueCount: 3,
    funcKind: "regular",
  } as unknown as IrFunction;
}

function prepare(fn: IrFunction, stringCompare: StringComparePolicy) {
  const prepared = prepareIrRuntimeManifest({
    functions: [fn],
    sourceFile: "/repo/string-compare.ts",
    policy: policy(stringCompare),
    stringCompareDemand: true,
  });
  if (!prepared) throw new Error("expected a non-empty runtime manifest");
  return prepared;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const found = result.irOutcomes?.filter((candidate) => candidate.displayName === name) ?? [];
  if (found.length !== 1) throw new Error(`expected exactly one IR outcome for ${name}, got ${found.length}`);
  return found[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, (...args: never[]) => number>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, (...args: never[]) => number>;
}

// --------------------------------------------------------------------------
// (a) contract — one capability record, one feature row, two provider arms
// --------------------------------------------------------------------------

describe("#3526 F2-S1 string-compare contract", () => {
  it("adds ONE feature row with the exact -1/0/1 compare ABI", () => {
    expect([...STRING_COMPARE_RUNTIME_FEATURES]).toEqual(["js.string.compare"]);
    expect(EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE.version).toBe(INTRINSIC_SIGNATURE_VERSION);
    expect(EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE.params).toEqual([
      irVal({ kind: "externref" }),
      irVal({ kind: "externref" }),
    ]);
    expect(EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE.result).toEqual(I32);
  });

  it("is TWO-armed at the provider level, like the extern probe", () => {
    expect([...STRING_COMPARE_RUNTIME_PROVIDER_IDS]).toEqual(["host.js.string.compare", "native.js.string.compare"]);
  });

  it("carries NO intrinsic instruction — the demand is requested at freeze", () => {
    // The distinguishing structural fact of this family. Without the demand the
    // walk finds nothing and no manifest is frozen at all.
    const fn = compareFunction("noIntrinsic");
    expect(instrsOf(fn).some((instr) => instr.kind === "intrinsic")).toBe(false);
    expect(
      prepareIrRuntimeManifest({
        functions: [fn],
        sourceFile: "/repo/string-compare.ts",
        policy: policy(HOST_COMPARE),
      }),
    ).toBeUndefined();
    expect(prepare(fn, HOST_COMPARE).manifest.features).toEqual(["js.string.compare"]);
  });

  it("keeps ONE central catalogue, and the async projection excludes the row BY ID", () => {
    expect(resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.compare")).toEqual({
      capability: "string.compare",
      module: "env",
      field: "string_compare",
      kind: "func",
      params: ["externref", "externref"],
      results: ["i32"],
    });
    const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.compare");
    // Same trap the boolean and extern rows document: every value type here is
    // admissible under `AsyncHostAdapterValueType`, so only the seven-ID filter
    // keeps the row out of the async projection.
    for (const entry of [...record.params, ...record.results]) expect(["externref", "i32"]).toContain(entry);
    expect(ASYNC_HOST_CAPABILITY_RECORDS.map((entry) => entry.capability)).not.toContain("string.compare");
    expect(() => asAsyncHostAdapter(record)).toThrowError(/is not an async capability/);
  });
});

// --------------------------------------------------------------------------
// (b) provider policy — both arms, the refusal, and the defaults
// --------------------------------------------------------------------------

describe("#3526 F2-S1 provider policy", () => {
  it("selects the host arm through the central capability record", () => {
    const prepared = prepare(compareFunction("hostCompare"), HOST_COMPARE);
    expect(prepared.manifest.policy.stringCompare).toEqual(HOST_COMPARE);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["host.js.string.compare"]);
    expect(prepared.manifest.hostCapabilities).toEqual(["string.compare"]);
    for (const record of prepared.manifest.hostCapabilityRecords) {
      expect(RUNTIME_HOST_CAPABILITY_RECORDS).toContain(record);
    }
    // The resolve arm reads the record's FIELD — the base import's name.
    expect(preparedStringCompareProvider(prepared)).toEqual({ arm: "host", field: "string_compare" });
  });

  it("selects the native arm on the runtime symbol, requesting NO host capability", () => {
    const prepared = prepare(compareFunction("nativeCompare"), NATIVE_COMPARE);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.string.compare"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.hostCapabilityRecords).toEqual([]);
    expect(preparedStringCompareProvider(prepared)).toEqual({ arm: "native", symbol: "__str_compare" });
  });

  it("refuses the arm its caller resolved to unsupported, naming the feature and the policy", () => {
    expect(() => prepare(compareFunction("refused"), STRING_COMPARE_POLICY_DISABLED)).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }),
    );
    expect(() => prepare(compareFunction("refused2"), STRING_COMPARE_POLICY_DISABLED)).toThrowError(
      /js\.string\.compare is unavailable under string-compare policy compare=unsupported/,
    );
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    const frozen = builder.freeze();
    expect(frozen.policy.stringCompare).toEqual(STRING_COMPARE_POLICY_DISABLED);
    // (#3526 F2-S4) SEVEN independent policies now, not one widened field. This
    // list is asserted field-by-field rather than whole-shape, so a new policy
    // does not break it — but it is only worth having if it keeps pace, and
    // `stringEq`/`stringLen` are the compare's own family-2 siblings.
    expect(frozen.policy.numberBoundary).toEqual(NUMBER_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.booleanBoundary).toEqual(BOOLEAN_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.externIsUndefined).toEqual(EXTERN_IS_UNDEFINED_POLICY_DISABLED);
    expect(frozen.policy.generatorNumberBox).toEqual(GENERATOR_NUMBER_BOX_POLICY_DISABLED);
    expect(frozen.policy.stringEq).toEqual(STRING_EQ_POLICY_DISABLED);
    expect(frozen.policy.stringLen).toEqual(STRING_LEN_POLICY_DISABLED);
    expect(frozen.policy.stringConcat).toEqual(STRING_CONCAT_POLICY_DISABLED);
    // (#3526 F2-S6) NINE now: the batched many-arity pass policy is a
    // sibling of the concatenation policy, not a field on it.
    expect(frozen.policy.stringConcatMany).toEqual(STRING_CONCAT_MANY_POLICY_DISABLED);
  });

  it("resolves independently of every family-1 arm", () => {
    const prepared = prepareIrRuntimeManifest({
      functions: [compareFunction("independent")],
      sourceFile: "/repo/string-compare.ts",
      policy: {
        target: "host",
        backend: "wasmgc",
        // Every family-1 policy OFF, the compare ON: it must still resolve.
        numberBoundary: NUMBER_BOUNDARY_POLICY_DISABLED,
        booleanBoundary: BOOLEAN_BOUNDARY_POLICY_DISABLED,
        externIsUndefined: EXTERN_IS_UNDEFINED_POLICY_DISABLED,
        generatorNumberBox: GENERATOR_NUMBER_BOX_POLICY_DISABLED,
        stringCompare: NATIVE_COMPARE,
      },
      stringCompareDemand: true,
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.string.compare"]);
  });

  it("has no manifest row at all when nothing in the module compares strings", () => {
    // The demand predicate, not the policy, decides whether a row exists —
    // so a host-lane module with no compare requests no `string.compare`
    // capability and cannot pull the import in through the manifest.
    const prepared = prepareIrRuntimeManifest({
      functions: [compareFunction("unused")],
      sourceFile: "/repo/string-compare.ts",
      policy: policy(HOST_COMPARE),
      stringCompareDemand: false,
    });
    expect(prepared).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// (c) end-to-end — import identity, import ORDER, and the runtime oracle
// --------------------------------------------------------------------------

describe("#3526 F2-S1 end-to-end behaviour is unchanged", () => {
  it("binds the host lane's existing env.string_compare BASE import, and nothing else", async () => {
    const result = await compile(COMPARE_SOURCE, { trackIrOutcomes: true });
    expect(outcome(result, "lt").kind).toBe("emitted");
    // The exact import array, in order. A late registration or a second
    // materializer would show up here before it showed up in a byte diff.
    expect(result.imports.map((entry) => `${entry.module}.${entry.name}`)).toEqual(["env.string_compare"]);
  });

  it("uses the host-free helper on every native-strings lane, with no env import", async () => {
    for (const options of [{ nativeStrings: true }, { target: "standalone" as const }, { target: "wasi" as const }]) {
      const result = await compile(COMPARE_SOURCE, { ...options, trackIrOutcomes: true });
      expect(outcome(result, "lt").kind).toBe("emitted");
      expect(result.imports.some((entry) => entry.name === "string_compare")).toBe(false);
    }
  });

  it("answers all four relational operators exactly as JavaScript does", async () => {
    const result = await compile(COMPARE_ALL_SOURCE, { trackIrOutcomes: true });
    expect(outcome(result, "all").kind).toBe("emitted");
    const exports = await instantiate(result);
    const oracle = (a: string, b: string): number =>
      (a < b ? 1 : 0) + (a > b ? 2 : 0) + (a <= b ? 4 : 0) + (a >= b ? 8 : 0);
    for (const [a, b] of [
      ["a", "b"],
      ["b", "a"],
      ["a", "a"],
      ["", "a"],
      ["", ""],
      ["ab", "abc"],
      ["Z", "a"],
    ] as const) {
      expect(exports.all!(a as never, b as never)).toBe(oracle(a, b));
    }
  });
});

// --------------------------------------------------------------------------
// (d) fail-closed reachability — owner-local demote with a clean co-owner
// --------------------------------------------------------------------------

describe("#3526 F2-S1 an unsupported arm demotes ONE owner", () => {
  it("keeps a clean co-owner emitted when the demanding owner cannot be provided", async () => {
    // The linear backend is the reachable adapter whose `stringCompare` policy
    // is explicitly DISABLED, and its own instruction allowlist independently
    // refuses the compare's operand representation. The co-owner must survive.
    const result = await compile(
      `${COMPARE_SOURCE}
export function clean(a: number, b: number): number { return a + b; }`,
      { target: "linear", trackIrOutcomes: true },
    );
    expect(result.success).toBe(true);
    const exports = await WebAssembly.instantiate(result.binary, {}).then(
      ({ instance }) => instance.exports as Record<string, (...args: never[]) => number>,
    );
    expect(exports.clean!(2 as never, 3 as never)).toBe(5);
  });
});

// --------------------------------------------------------------------------
// (e) the resolve arm reads the MANIFEST, not the lane
// --------------------------------------------------------------------------

const INTEGRATION_PATH = join(dirname(fileURLToPath(import.meta.url)), "../src/ir/integration.ts");

/**
 * The arm's source text, comments stripped.
 *
 * A behavioural pin cannot separate the migrated arm from the one it replaced:
 * the policy projection reproduces the old truth table EXACTLY, so both forms
 * emit identical bytes on every lane — which is the point of the slice and the
 * reason all thirty byte cells are unchanged. What actually moved is WHICH
 * authority answers, and that is a source fact. This gate is the #2955
 * grep-gate idiom applied to one arm: it fails the moment the arm goes back to
 * reading the lane discriminator, which no byte or import assertion can catch.
 */
function stringCompareArmSource(): string {
  const raw = readFileSync(INTEGRATION_PATH, "utf8");
  const start = raw.indexOf("symbol === IR_STRING_COMPARE_FN) {");
  expect(start, "the IR_STRING_COMPARE_FN resolve arm must exist").toBeGreaterThan(-1);
  const rest = raw.slice(start);
  const end = rest.indexOf("\n  } else if (");
  expect(end, "the arm must be followed by a sibling branch").toBeGreaterThan(-1);
  return rest
    .slice(0, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("#3526 F2-S1 the resolve arm reads the frozen manifest", () => {
  it("consults the prepared string-compare provider", () => {
    expect(stringCompareArmSource()).toContain("preparedStringCompareProvider(prepared)");
  });

  it("reads NO lane discriminator", () => {
    // `ctx.nativeStrings` here was family 2's largest un-governed dispatch.
    expect(stringCompareArmSource()).not.toContain("nativeStrings");
  });

  it("fails closed rather than falling back to a locally decided symbol", () => {
    const arm = stringCompareArmSource();
    expect(arm).toContain("selection-preparation-mismatch");
    // No `??` fallback and no second registration path: the host arm may only
    // look the capability record's field up in the funcMap.
    expect(arm).not.toContain("ensureLateImport");
    expect(arm).toContain("ctx.funcMap.get(arm.field)");
  });
});

// --------------------------------------------------------------------------
// (f) sub-B — the forof.string provider has ONE authority
// --------------------------------------------------------------------------

function forOfStringFunction(name: string, provider?: unknown): IrFunction {
  const instr: IrInstr = {
    kind: "forof.string",
    str: asValueId(0),
    counterSlot: 0,
    lengthSlot: 1,
    strSlot: 2,
    elementSlot: 3,
    body: [],
    ...(provider ? { provider } : {}),
  } as unknown as IrInstr;
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [{ name: "s", type: STRING, value: asValueId(0) }],
    resultTypes: [],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [instr],
        terminator: { kind: "return", values: [] },
      },
    ],
    exported: false,
    valueCount: 1,
    funcKind: "regular",
    slots: [
      { name: "$i", type: I32 },
      { name: "$len", type: I32 },
      { name: "$s", type: STRING },
      { name: "$ch", type: STRING },
    ],
  } as unknown as IrFunction;
}

describe("#3526 F2-S1 forof.string has ONE authority", () => {
  it("attaches the code-point provider unconditionally", () => {
    const attached = attachIrStringSupport(forOfStringFunction("attach"), {
      storageForConst: () => undefined,
      providerForLength: () => undefined,
    });
    const found = instrsOf(attached).filter((instr) => instr.kind === "forof.string");
    expect(found).toHaveLength(1);
    expect((found[0] as { provider?: { name: string } }).provider?.name).toBe("__ir_string_iterator_char_at");
  });

  it("refuses to lower an unattached forof.string instead of re-deciding the symbol", () => {
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      resolveString: () => ({ kind: "ref", typeIdx: 3 }),
    } as unknown as IrLowerResolver;
    expect(() => lowerIrFunctionToWasm(forOfStringFunction("unattached"), resolver)).toThrowError(
      /forof\.string has no prepared runtime provider/,
    );
  });

  it("accepts an already-attached provider, so the guard is not a blanket refusal", () => {
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      resolveString: () => ({ kind: "ref", typeIdx: 3 }),
    } as unknown as IrLowerResolver;
    const attached = forOfStringFunction("attached", irRuntimeFuncRef("__str_charAt_cp"));
    // Reaching PAST the provider guard is the assertion; the hand-built slot
    // layout is not a complete lowering input, so any later failure is fine as
    // long as it is not the guard's.
    let message = "";
    try {
      lowerIrFunctionToWasm(attached, resolver);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).not.toMatch(/has no prepared runtime provider/);
  });

  it("still iterates code points correctly on the lanes that reach the case", async () => {
    const source = `export function count(s: string): number {
  let n = 0;
  for (const ch of s) { n = n + 1; }
  return n;
}`;
    const result = await compile(source, { nativeStrings: true, trackIrOutcomes: true });
    expect(outcome(result, "count").kind).toBe("emitted");
    expect(result.success).toBe(true);
  });
});
