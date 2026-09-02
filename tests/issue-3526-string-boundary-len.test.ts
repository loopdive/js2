// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F2-S4 — the string LENGTH seam moves under manifest authority.
//
// Two sub-migrations, one PR, the F2-S3 shape — but the structural edit is a
// different one, and that is the whole character of this slice:
//
//  * **sub-A** puts `s.length` under a frozen `stringLen` policy. Unlike the
//    compare and the eq there is NO resolve-table arm to migrate: `string.len`
//    is not a callable symbol, so nothing in `resolveAndObserveCallableProvider`
//    names it. The physical choice lives entirely on the
//    `IrStringLengthProvider` attached to the instruction, and that attachment
//    used to happen in `prepareStrings` — which runs BEFORE the manifest freeze.
//    So the migration has to MOVE the attachment behind the freeze, into
//    `prepareStringLength`. That move is byte-neutral by construction (nothing
//    between the two points reads `string.len.provider`) and was measured so:
//    60 of 60 byte cells identical, WAT text included.
//
//    The native arm also needs new provider vocabulary. It is not a callable at
//    all — it is a field read on the Program-ABI string carrier — so the
//    catalogue gains a `carrier-field` implementation kind. It is deliberately
//    SYMBOLIC (an ABI role plus a field index, never a physical type index),
//    because the manifest is frozen before the carrier's layout is planned.
//
//  * **sub-B** retires the emitter's no-provider fallback in `integration.ts`'s
//    WasmGC string runtime — the seam's SECOND un-governed `ctx.nativeStrings`
//    read. Measured dead before removal: a temporary throw in its place was
//    reached ZERO times across the 60-cell byte matrix (which stayed
//    byte-identical WITH the throw in) and 335 passing tests in 21 string
//    suites.
//
// What this slice does NOT move, deliberately: `string.concat` / `_OWNED`
// (F2-S5), `charCodeAt`, `string.const`, `stringForOfPlan` / `charReadPlan`,
// the linear `__str_length_utf16` path, and `src/ir/from-ast.ts`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { generateModule } from "../src/codegen/index.js";
import { ASYNC_HOST_CAPABILITY_RECORDS, asAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";
import { irImportFuncRef, irIntrinsicFuncRef } from "../src/ir/callable-bindings.js";
import { IR_STRING_REPEAT_COUNTED_NATIVE_FN } from "../src/ir/string-runtime.js";
import { irSupportTypeRef } from "../src/ir/abi-bindings.js";
import type { IrBindingOwnerId } from "../src/ir/identity.js";
import { prepareIrRuntimeManifest, preparedStringLenProvider } from "../src/ir/intrinsic-support.js";
import { EXTERNREF_TO_I32_INTRINSIC_SIGNATURE, INTRINSIC_SIGNATURE_VERSION } from "../src/ir/intrinsics.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import {
  asBlockId,
  asValueId,
  forEachInstrDeep,
  irVal,
  type IrFunction,
  type IrInstr,
  type IrStringLengthProvider,
  type IrType,
} from "../src/ir/nodes.js";
import {
  BOOLEAN_BOUNDARY_POLICY_DISABLED,
  EXTERN_IS_UNDEFINED_POLICY_DISABLED,
  GENERATOR_NUMBER_BOX_POLICY_DISABLED,
  NUMBER_BOUNDARY_POLICY_DISABLED,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  RUNTIME_PROVIDERS,
  STRING_COMPARE_POLICY_DISABLED,
  STRING_EQ_POLICY_DISABLED,
  STRING_LEN_POLICY_DISABLED,
  STRING_LEN_RUNTIME_FEATURES,
  STRING_LEN_RUNTIME_PROVIDER_IDS,
  type RuntimeManifestPolicy,
  type RuntimeProviderDefinition,
  type StringLenPolicy,
} from "../src/ir/runtime-manifest.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { attachIrStringLengthProvider, attachIrStringSupport } from "../src/ir/string-support.js";
import type { WasmModule } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-string-boundary-len");
const F64 = irVal({ kind: "f64" });
const STRING: IrType = { kind: "string" };

const HOST_LEN: StringLenPolicy = { len: "host" };
const NATIVE_LEN: StringLenPolicy = { len: "native" };

const LEN_SOURCE = `export function len(s: string): number { return s.length; }`;

/** Every shape the census found that reaches the seam, in one owner. */
const LEN_ALL_SOURCE = `export function all(s: string): number {
  let n = s.length;
  if (n === 0) n = n - 1;
  n = n + \`\${s}!\`.length;
  n = n + (s + s).length;
  n = n + "hello".length;
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

function policy(stringLen: StringLenPolicy): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", stringLen };
}

/**
 * One hand-built owner carrying the exact `string.len` instruction from-ast
 * emits for `s.length`. It carries no `intrinsic` instruction — which is why
 * the demand has to be requested at freeze even though the KIND exists.
 */
function lenFunction(name: string, provider?: IrStringLengthProvider): IrFunction {
  const instr: IrInstr = {
    kind: "string.len",
    value: asValueId(0),
    result: asValueId(1),
    resultType: F64,
    ...(provider ? { provider } : {}),
  } as unknown as IrInstr;
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [{ name: "s", type: STRING, value: asValueId(0) }],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [instr],
        terminator: { kind: "return", values: [asValueId(1)] },
      },
    ],
    exported: false,
    valueCount: 2,
    funcKind: "regular",
  } as unknown as IrFunction;
}

/**
 * One owner carrying a counted-native `string.repeat` ALREADY bound to its
 * helper, beside an unattached `string.len`.
 *
 * This is the exact shape the corpus failed on, reduced: the omnibus attach
 * pass re-derives the repeat provider on every run, so running it a second time
 * for the length seam rebinds a counted-native repeat to the generic helper.
 * No fixture in the 60-cell byte matrix carries this shape, which is why the
 * matrix was green while four corpus cells were not.
 */
function repeatAndLenFunction(name: string): IrFunction {
  const repeat: IrInstr = {
    kind: "string.repeat",
    value: asValueId(0),
    count: asValueId(1),
    encodingEvidence: "utf16",
    countedStringAppendTripCount: 4,
    provider: irIntrinsicFuncRef(IR_STRING_REPEAT_COUNTED_NATIVE_FN),
    result: asValueId(2),
    resultType: { kind: "string" },
  } as unknown as IrInstr;
  const len: IrInstr = {
    kind: "string.len",
    value: asValueId(2),
    result: asValueId(3),
    resultType: F64,
  } as unknown as IrInstr;
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [
      { name: "s", type: STRING, value: asValueId(0) },
      { name: "n", type: F64, value: asValueId(1) },
    ],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [repeat, len],
        terminator: { kind: "return", values: [asValueId(3)] },
      },
    ],
    exported: false,
    valueCount: 4,
    funcKind: "regular",
  } as unknown as IrFunction;
}

function prepare(fn: IrFunction, stringLen: StringLenPolicy) {
  const prepared = prepareIrRuntimeManifest({
    functions: [fn],
    sourceFile: "/repo/string-len.ts",
    policy: policy(stringLen),
    stringLenDemand: true,
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

/**
 * The emitted module's own import section.
 *
 * `result.imports` covers only `env` FUNC descriptors and is BLIND to
 * `wasm:js-string` — so an `result.imports`-only pin cannot see this seam's
 * host arm at all, exactly as for the equality.
 */
function hostLaneModule(source: string): WasmModule {
  return generateModule(analyzeSource(source, "issue-3526-f2s4-len.ts"), { experimentalIR: true }).module;
}

function orderedFuncImports(module: WasmModule): string[] {
  return module.imports.filter((entry) => entry.desc.kind === "func").map((entry) => `${entry.module}.${entry.name}`);
}

// --------------------------------------------------------------------------
// (a) contract — one feature row, two arms, a reused signature
// --------------------------------------------------------------------------

describe("#3526 F2-S4 string-len contract", () => {
  it("adds ONE feature row and REUSES an existing ABI, minting no new signature", () => {
    expect([...STRING_LEN_RUNTIME_FEATURES]).toEqual(["js.string.len"]);
    // `(externref) -> i32` — F1-S4's `__extern_is_undefined` row, which is
    // EXACTLY the `wasm:js-string.length` record ABI. The native arm reuses it
    // nominally, the way `native.js.string.eq` reuses the externref pair for
    // `__str_equals`: the signature is the seam's SEMANTIC shape, not the
    // physical `struct.get`. A second constant would be two names for one fact.
    expect(EXTERNREF_TO_I32_INTRINSIC_SIGNATURE.version).toBe(INTRINSIC_SIGNATURE_VERSION);
    expect(EXTERNREF_TO_I32_INTRINSIC_SIGNATURE.params).toEqual([irVal({ kind: "externref" })]);
    expect(EXTERNREF_TO_I32_INTRINSIC_SIGNATURE.result).toEqual(irVal({ kind: "i32" }));
  });

  it("is TWO-armed at the provider level, like both family-2 predecessors", () => {
    expect([...STRING_LEN_RUNTIME_PROVIDER_IDS]).toEqual(["host.js.string.len", "native.js.string.len"]);
  });

  it("carries NO intrinsic instruction — the demand is requested at freeze", () => {
    const fn = lenFunction("noIntrinsic");
    expect(instrsOf(fn).some((instr) => instr.kind === "intrinsic")).toBe(false);
    expect(instrsOf(fn).some((instr) => instr.kind === "string.len")).toBe(true);
    // Without the demand a length-only module freezes NO manifest, and
    // `prepareStringLength` would have nothing to read. That matters more here
    // than for either predecessor: this seam has no callable symbol to fall
    // back to.
    expect(
      prepareIrRuntimeManifest({
        functions: [fn],
        sourceFile: "/repo/string-len.ts",
        policy: policy(HOST_LEN),
      }),
    ).toBeUndefined();
    expect(prepare(fn, HOST_LEN).manifest.features).toEqual(["js.string.len"]);
  });

  it("names the F2-S2 wasm:js-string record, and the async projection excludes it BY ID", () => {
    const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.len");
    expect(record).toEqual({
      capability: "string.len",
      module: "wasm:js-string",
      field: "length",
      kind: "func",
      params: ["externref"],
      results: ["i32"],
    });
    // Every value type here is admissible under `AsyncHostAdapterValueType`, so
    // only the seven-ID filter keeps it out of the async projection — the same
    // trap the compare and eq rows document.
    for (const entry of [...record.params, ...record.results]) expect(["externref", "i32"]).toContain(entry);
    expect(ASYNC_HOST_CAPABILITY_RECORDS.map((entry) => entry.capability)).not.toContain("string.len");
    expect(() => asAsyncHostAdapter(record)).toThrowError(/is not an async capability/);
  });
});

// --------------------------------------------------------------------------
// (b) provider policy — both arms, the refusal, and the defaults
// --------------------------------------------------------------------------

describe("#3526 F2-S4 provider policy", () => {
  it("selects the host arm through the central capability record, MODULE included", () => {
    const prepared = prepare(lenFunction("hostLen"), HOST_LEN);
    expect(prepared.manifest.policy.stringLen).toEqual(HOST_LEN);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["host.js.string.len"]);
    expect(prepared.manifest.hostCapabilities).toEqual(["string.len"]);
    for (const record of prepared.manifest.hostCapabilityRecords) {
      expect(RUNTIME_HOST_CAPABILITY_RECORDS).toContain(record);
    }
    // The module half is load-bearing: `length` alone does not name a builtin
    // import, and `ctx.funcMap` keys it on the bare field (#1072 shadowing).
    expect(preparedStringLenProvider(prepared)).toEqual({
      arm: "host",
      module: "wasm:js-string",
      field: "length",
    });
  });

  it("selects the native carrier-field arm, requesting NO host capability", () => {
    const prepared = prepare(lenFunction("nativeLen"), NATIVE_LEN);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.string.len"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.hostCapabilityRecords).toEqual([]);
    // The catalogue's first non-callable native arm. It names an ABI ROLE and a
    // field index — never a physical type index, which the frozen manifest
    // could not honestly carry because the carrier's layout is planned later.
    expect(prepared.manifest.providers[0]!.implementation).toEqual({
      kind: "carrier-field",
      carrier: "string",
      fieldIndex: 0,
    });
    expect(preparedStringLenProvider(prepared)).toEqual({ arm: "native", carrier: "string", fieldIndex: 0 });
  });

  it("refuses the arm its caller resolved to unsupported, naming the feature and the policy", () => {
    expect(() => prepare(lenFunction("refused"), STRING_LEN_POLICY_DISABLED)).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }),
    );
    expect(() => prepare(lenFunction("refused2"), STRING_LEN_POLICY_DISABLED)).toThrowError(
      /js\.string\.len is unavailable under string-len policy len=unsupported/,
    );
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    const frozen = builder.freeze();
    expect(frozen.policy.stringLen).toEqual(STRING_LEN_POLICY_DISABLED);
    // SEVEN independent policies now, not one widened field.
    expect(frozen.policy.numberBoundary).toEqual(NUMBER_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.booleanBoundary).toEqual(BOOLEAN_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.externIsUndefined).toEqual(EXTERN_IS_UNDEFINED_POLICY_DISABLED);
    expect(frozen.policy.generatorNumberBox).toEqual(GENERATOR_NUMBER_BOX_POLICY_DISABLED);
    expect(frozen.policy.stringCompare).toEqual(STRING_COMPARE_POLICY_DISABLED);
    expect(frozen.policy.stringEq).toEqual(STRING_EQ_POLICY_DISABLED);
  });

  it("resolves independently of the eq, the compare, and every family-1 arm", () => {
    // The three family-2 policies are SIBLINGS. A disabled eq or compare must
    // not drag the length down with it — that is the whole reason they are
    // separate fields rather than one widened string policy.
    const prepared = prepareIrRuntimeManifest({
      functions: [lenFunction("independent")],
      sourceFile: "/repo/string-len.ts",
      policy: {
        target: "host",
        backend: "wasmgc",
        numberBoundary: NUMBER_BOUNDARY_POLICY_DISABLED,
        booleanBoundary: BOOLEAN_BOUNDARY_POLICY_DISABLED,
        externIsUndefined: EXTERN_IS_UNDEFINED_POLICY_DISABLED,
        generatorNumberBox: GENERATOR_NUMBER_BOX_POLICY_DISABLED,
        stringCompare: STRING_COMPARE_POLICY_DISABLED,
        stringEq: STRING_EQ_POLICY_DISABLED,
        stringLen: NATIVE_LEN,
      },
      stringLenDemand: true,
    });
    expect(prepared?.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.string.len"]);
  });

  it("adds no row when nothing reads .length", () => {
    const compareOnly = new RuntimeManifestBuilder({
      target: "host",
      backend: "wasmgc",
      stringCompare: { compare: "host" },
      stringLen: HOST_LEN,
    });
    compareOnly.requestFeature("js.string.compare");
    const frozen = compareOnly.freeze();
    expect(frozen.features).toEqual(["js.string.compare"]);
    expect(frozen.hostCapabilities).toEqual(["string.compare"]);
    expect(frozen.hostCapabilities).not.toContain("string.len");
  });
});

// --------------------------------------------------------------------------
// (c) end-to-end — import identity, import ORDER, and the runtime oracle
// --------------------------------------------------------------------------

describe("#3526 F2-S4 end-to-end behaviour is unchanged", () => {
  it("binds the host lane's existing wasm:js-string.length builtin, in the same position", async () => {
    const result = await compile(LEN_SOURCE, { trackIrOutcomes: true });
    expect(outcome(result, "len").kind).toBe("emitted");
    expect(result.imports.map((entry) => `${entry.module}.${entry.name}`)).toEqual([]);
    expect(orderedFuncImports(hostLaneModule(LEN_SOURCE))).toEqual(["wasm:js-string.length"]);
  });

  it("keeps length at its registered position when concat precedes it", () => {
    // The census pinned this: `length` is func #0 in nine fixtures and #1 in
    // CONCATLEN, because `addStringImports` registers the five builtins as one
    // block (`concat, length, equals, substring, charCodeAt`) and dead-import
    // elimination compacts it. A late registration from the moved attachment
    // would surface here before it surfaced in a byte diff.
    const module = hostLaneModule(`export function cl(a: string, b: string): number { return (a + b).length; }`);
    expect(orderedFuncImports(module)).toEqual(["wasm:js-string.concat", "wasm:js-string.length"]);
  });

  it("reads the carrier field on every native-strings lane, with no wasm:js-string import", async () => {
    for (const options of [{ nativeStrings: true }, { target: "standalone" as const }, { target: "wasi" as const }]) {
      const result = await compile(LEN_SOURCE, { ...options, trackIrOutcomes: true });
      expect(outcome(result, "len").kind).toBe("emitted");
      expect(result.wat).not.toContain('(import "wasm:js-string"');
      // Field 0 of the native `$AnyString` carrier — the physical shape the
      // `carrier-field` provider names symbolically.
      expect(result.wat).toContain("struct.get");
    }
  });

  it("answers .length exactly as JavaScript does", async () => {
    const result = await compile(LEN_ALL_SOURCE, { trackIrOutcomes: true });
    expect(outcome(result, "all").kind).toBe("emitted");
    const exports = await instantiate(result);
    const oracle = (s: string): number => {
      let n = s.length;
      if (n === 0) n = n - 1;
      n = n + `${s}!`.length;
      n = n + (s + s).length;
      n = n + "hello".length;
      return n;
    };
    for (const input of [
      "",
      "abc",
      // A surrogate pair counts TWO UTF-16 code units, not one code point.
      "\u{1f600}",
      "héllo wörld",
      "x".repeat(1000),
      "ab" + "cd",
      `t${1}`,
    ]) {
      expect(exports.all!(input as never)).toBe(oracle(input));
    }
  });

  it("answers .length identically on a native-strings lane", async () => {
    const result = await compile(LEN_ALL_SOURCE, { nativeStrings: true, trackIrOutcomes: true });
    expect(outcome(result, "all").kind).toBe("emitted");
    expect(result.success).toBe(true);
  });

  it("still lowers .length on the linear backend, which ignores the provider", async () => {
    // `string.len` IS on the linear instruction allowlist, so that lane resolves
    // `__str_length_utf16` through its own resolver and never consults the
    // frozen provider. Its explicitly disabled `stringLen` policy is therefore
    // INERT — stated so the frozen policy is total, not because it decides
    // anything. This pin is what makes that claim falsifiable.
    const result = await compile(
      `${LEN_SOURCE}
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
// (d) the attachment reads the MANIFEST, not the lane
// --------------------------------------------------------------------------

const INTEGRATION_PATH = join(dirname(fileURLToPath(import.meta.url)), "../src/ir/integration.ts");

/**
 * A named function's source text in `integration.ts`, comments stripped.
 *
 * A behavioural pin cannot separate the migrated attachment from the one it
 * replaced: the policy projection reproduces the old truth table EXACTLY, so
 * both forms emit identical bytes on every lane — which is the point of the
 * slice and the reason all 60 byte cells are unchanged. What actually moved is
 * WHICH authority answers, and that is a source fact. This gate is the #2955
 * grep-gate idiom applied to one function.
 */
function integrationFunctionSource(startMarker: string, endMarker: string): string {
  const raw = readFileSync(INTEGRATION_PATH, "utf8");
  const start = raw.indexOf(startMarker);
  expect(start, `the ${startMarker} site must exist`).toBeGreaterThan(-1);
  const rest = raw.slice(start);
  const end = rest.indexOf(endMarker);
  expect(end, `the ${startMarker} site must be followed by ${endMarker}`).toBeGreaterThan(-1);
  return rest
    .slice(0, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function prepareStringLengthSource(): string {
  return integrationFunctionSource("function prepareStringLength(", "\n}\n");
}

describe("#3526 F2-S4 the attachment reads the frozen manifest", () => {
  it("consults the prepared string-len provider", () => {
    expect(prepareStringLengthSource()).toContain("preparedStringLenProvider(runtime)");
  });

  it("attaches through the LENGTH-only pass, not the omnibus one", () => {
    // Not a style preference — measured. The omnibus `attachIrStringSupport`
    // re-derives the provider for five other string seams on every run, so a
    // second run with only `providerForLength` supplied rebinds a counted-native
    // `string.repeat` to the generic helper and throws. See
    // `attachIrStringLengthProvider`'s own doc comment for the corpus cells.
    const source = prepareStringLengthSource();
    expect(source).toContain("attachIrStringLengthProvider(entry.fn, provider)");
    expect(source).not.toContain("attachIrStringSupport(");
  });

  it("reads NO lane discriminator and no physical carrier index", () => {
    const source = prepareStringLengthSource();
    expect(source).not.toContain("nativeStrings");
    // The native arm resolves the ABI role through the registry; it must never
    // reach for the raw type index the way the retired decision block could.
    expect(source).not.toContain("anyStrTypeIdx");
    expect(source).toContain("registry.stringCarrierRef()");
  });

  it("fails closed on a missing host import rather than registering a new one", () => {
    const source = prepareStringLengthSource();
    expect(source).toContain("ir/integration: prepared string.len has no exact wasm:js-string.length import");
    expect(source).not.toContain("ensureLateImport");
  });

  it("has left prepareStrings — that pass decides no length provider at all", () => {
    // (#3526 F2-S4) This INVERTS the F2-S2 fence
    // `issue-3526-string-boundary-schema.test.ts` used to carry ("keeps the
    // string.len provider on ctx.nativeStrings and the raw import ref"). That
    // pin is gone rather than shrunk, because the whole `if (usesStringLen)`
    // decision block it fenced was deleted; this is its replacement.
    const source = integrationFunctionSource("function prepareStrings(", "\nfunction prepareVectors(");
    expect(source).not.toContain("lengthProvider");
    expect(source).not.toContain('irImportFuncRef("wasm:js-string", "length", "length")');
    // The host pre-registration still lives here — only the DECISION moved.
    expect(source).toContain("usesStringLen");
    expect(source).toContain("providerForLength: () => undefined");
  });

  it("partitions an unsupported length policy owner-locally, naming the policy", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    expect(raw).toContain('stringLenPolicy.len === "unsupported" && irStringLenDemand([entry.fn])');
    expect(raw).toContain("has no provider under string-len policy ");
  });
});

// --------------------------------------------------------------------------
// (e) sub-B — the string.len emitter has ONE authority
// --------------------------------------------------------------------------

const TEST_CARRIER = irSupportTypeRef("issue-3526-f2s4" as IrBindingOwnerId, "string-carrier", "__string_carrier");

function lowerResolver(): IrLowerResolver {
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => 0,
    resolveType: () => 3,
    resolveString: () => ({ kind: "ref", typeIdx: 3 }),
  } as unknown as IrLowerResolver;
}

describe("#3526 F2-S4 string.len has ONE emit authority", () => {
  it("attaches whichever provider the caller supplies, and only when unattached", () => {
    for (const provider of [
      { kind: "callable", target: irImportFuncRef("wasm:js-string", "length", "length") },
      { kind: "struct-field", ownerType: TEST_CARRIER, fieldIndex: 0 },
    ] as readonly IrStringLengthProvider[]) {
      const attached = attachIrStringLengthProvider(lenFunction(`attach-${provider.kind}`), provider);
      const found = instrsOf(attached).filter((instr) => instr.kind === "string.len");
      expect(found).toHaveLength(1);
      expect((found[0] as { provider?: IrStringLengthProvider }).provider).toEqual(provider);
      // Idempotent: a second pass with the same provider is a no-op, and a
      // DIFFERENT one is a hard error rather than a silent overwrite.
      expect(attachIrStringLengthProvider(attached, provider)).toBe(attached);
    }
    expect(() =>
      attachIrStringLengthProvider(
        lenFunction("conflict", { kind: "struct-field", ownerType: TEST_CARRIER, fieldIndex: 0 }),
        { kind: "struct-field", ownerType: TEST_CARRIER, fieldIndex: 1 },
      ),
    ).toThrowError(/string\.len already carries a different prepared provider binding/);
  });

  it("touches ONLY string.len — the omnibus pass would re-decide five other seams", () => {
    // The defect that forced the focused pass into existence, pinned end-to-end
    // rather than by source shape. `attachIrStringSupport` binds a counted
    // native `string.repeat` to `__ir_string_repeat_counted_native`; running it
    // again with only `providerForLength` supplied re-derives the GENERIC
    // `__ir_string_repeat` and throws. The length-only pass leaves it alone.
    const withRepeat = repeatAndLenFunction("repeatAndLen");
    expect(() =>
      attachIrStringSupport(withRepeat, {
        storageForConst: () => undefined,
        providerForLength: () => undefined,
      }),
    ).toThrowError(/string\.repeat already carries a different prepared provider binding/);
    const attached = attachIrStringLengthProvider(withRepeat, {
      kind: "struct-field",
      ownerType: TEST_CARRIER,
      fieldIndex: 0,
    });
    const repeat = instrsOf(attached).find((instr) => instr.kind === "string.repeat");
    expect((repeat as { provider?: { name: string } }).provider?.name).toBe("__ir_string_repeat_counted_native");
    const len = instrsOf(attached).find((instr) => instr.kind === "string.len");
    expect((len as { provider?: IrStringLengthProvider }).provider?.kind).toBe("struct-field");
  });

  it("refuses to lower an unattached string.len instead of re-deciding the lane", () => {
    // Honest scope, the F2-S3 disclosure repeated because it applies verbatim:
    // this pin holds on BOTH trees and is deliberately NOT the non-vacuity
    // signal for the retirement. A hand-built resolver carries no string
    // runtime, so `WasmGcEmitter` refuses one frame earlier with its own
    // "runtime is unavailable" message and the retired fallback is never
    // reached — the alternation below says so rather than hiding it. The
    // DISCRIMINATOR for sub-B is the source-shape pin below.
    expect(() => lowerIrFunctionToWasm(lenFunction("unattached"), lowerResolver())).toThrowError(
      /string\.len (has no prepared runtime provider|runtime is unavailable)/,
    );
  });

  it("accepts an already-attached provider of EITHER kind, so the guard is not a blanket refusal", () => {
    for (const provider of [
      { kind: "callable", target: irImportFuncRef("wasm:js-string", "length", "length") },
      { kind: "struct-field", ownerType: TEST_CARRIER, fieldIndex: 0 },
    ] as readonly IrStringLengthProvider[]) {
      let message = "";
      try {
        lowerIrFunctionToWasm(lenFunction(`attached-${provider.kind}`, provider), lowerResolver());
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).not.toMatch(/has no prepared runtime provider/);
    }
  });

  it("keeps the retired fallback's lane read out of the emitter", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    const start = raw.indexOf("emitStringLen(_inputEncoding, provider): readonly Instr[] {");
    expect(start, "the WasmGC emitStringLen adapter must exist").toBeGreaterThan(-1);
    const end = raw.slice(start).indexOf("\n    emitStringCharAt");
    expect(end, "the adapter must be followed by emitStringCharAt").toBeGreaterThan(-1);
    // Comments stripped: the retirement's own rationale NAMES the read it
    // removed, and a naive text scan would read that prose as the read itself.
    const body = raw
      .slice(start, start + end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(body).not.toContain("ctx.nativeStrings");
    expect(body).not.toContain("anyStrTypeIdx");
    expect(body).not.toContain('hostImports.get("length")');
    expect(body).toContain("string.len has no prepared runtime provider");
  });
});

// --------------------------------------------------------------------------
// (f) validation — the new implementation kind is checked, not trusted
// --------------------------------------------------------------------------

function withStringLenImplementation(implementation: unknown): RuntimeProviderDefinition[] {
  return (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).map((provider) =>
    provider.id === "native.js.string.len" ? ({ ...provider, implementation } as RuntimeProviderDefinition) : provider,
  );
}

function freezeWith(providers: RuntimeProviderDefinition[]): void {
  const builder = new RuntimeManifestBuilder(
    { target: "host", backend: "wasmgc", stringLen: NATIVE_LEN },
    { providers },
  );
  builder.requestFeature("js.string.len");
  builder.freeze();
}

describe("#3526 F2-S4 carrier-field validation", () => {
  it("refuses a carrier-field provider that requests a host capability", () => {
    // A carrier read imports nothing. Letting it declare a capability would let
    // a native arm silently drag a host import into a host-free lane.
    const providers = (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).map((provider) =>
      provider.id === "native.js.string.len"
        ? ({ ...provider, hostCapabilities: ["string.len"] } as RuntimeProviderDefinition)
        : provider,
    );
    expect(() => freezeWith(providers)).toThrowError(
      /carrier-field provider native\.js\.string\.len cannot request concrete host capabilities/,
    );
  });

  it("refuses an unknown carrier role", () => {
    expect(() =>
      freezeWith(withStringLenImplementation({ kind: "carrier-field", carrier: "vec", fieldIndex: 0 })),
    ).toThrowError(/carrier-field provider native\.js\.string\.len names unknown carrier vec/);
  });

  it("refuses a negative or non-integral field index", () => {
    for (const fieldIndex of [-1, 1.5, Number.NaN]) {
      expect(() =>
        freezeWith(withStringLenImplementation({ kind: "carrier-field", carrier: "string", fieldIndex })),
      ).toThrowError(/carrier-field provider native\.js\.string\.len has an invalid field index/);
    }
  });

  it("keeps the carrier role closed at the TYPE level too", () => {
    // The runtime rule above catches a table that arrived through an
    // `unknown`/`as` boundary; this one catches the ordinary edit.
    const bad = {
      kind: "carrier-field" as const,
      // @ts-expect-error — "vec" is not an admitted carrier role.
      carrier: "vec" as const,
      fieldIndex: 0,
    };
    expect(bad.kind).toBe("carrier-field");
  });
});
