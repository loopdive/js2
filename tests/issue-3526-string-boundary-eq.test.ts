// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F2-S3 — the string EQUALITY seam moves under manifest authority.
//
// Two sub-migrations, one PR, the F2-S1 shape:
//
//  * **sub-A** puts `a === b` / `a !== b` on two strings under a frozen
//    `stringEq` policy. The resolve-time provider table used to serve THREE
//    symbols from one branch (`__ir_string_concat`, `__ir_string_concat_owned`,
//    `__ir_string_equals`) behind a single `ctx.nativeStrings` read. The first
//    move is therefore a SPLIT, not a rewrite: `string.eq` is lifted into its
//    own `else if` (byte-inert — the three symbols are disjoint, so `else if`
//    order between them cannot change which branch a symbol takes) and only the
//    lifted arm is migrated. The concat pair stays on the lane read, which
//    `issue-3526-string-boundary-schema.test.ts` still pins.
//
//    One thing makes this seam unlike F2-S1's compare, and it is why the schema
//    widening had to land first: the host arm's import is
//    `wasm:js-string.equals`, a BUILTIN, not an `env` one. `ctx.funcMap` keys it
//    on the bare field `equals`, which a same-named user function shadows
//    (#1072) — so the arm has never used `funcMap` and does not start now. It
//    locates the import by SECTION POSITION (`exactCallableImportIndex`), which
//    needs the record's module as well as its field. That is why
//    `preparedStringEqProvider` returns `{arm, module, field}` where the
//    compare's twin returns `{arm, field}`.
//
//  * **sub-B** retires the emitter's no-provider fallback in
//    `integration.ts`'s WasmGC string runtime — the seam's SECOND un-governed
//    `ctx.nativeStrings` read. Measured dead before removal: a temporary throw
//    in its place was reached ZERO times across the 55-cell byte matrix and 337
//    tests in 22 string suites.
//
// What this slice does NOT move, deliberately: `string.concat` / `_OWNED`
// (F2-S5), `string.len` (F2-S4), `charCodeAt`, `string.const`,
// `stringForOfPlan`, and `src/ir/from-ast.ts`, which was already lane-free.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { generateModule } from "../src/codegen/index.js";
import { ASYNC_HOST_CAPABILITY_RECORDS, asAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";
import { irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { prepareIrRuntimeManifest, preparedStringEqProvider } from "../src/ir/intrinsic-support.js";
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
  STRING_EQ_POLICY_DISABLED,
  STRING_EQ_RUNTIME_FEATURES,
  STRING_EQ_RUNTIME_PROVIDER_IDS,
  type RuntimeManifestPolicy,
  type StringEqPolicy,
} from "../src/ir/runtime-manifest.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { attachIrStringSupport } from "../src/ir/string-support.js";
import type { WasmModule } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-string-boundary-eq");
const I32 = irVal({ kind: "i32" });
const STRING: IrType = { kind: "string" };

const HOST_EQ: StringEqPolicy = { eq: "host" };
const NATIVE_EQ: StringEqPolicy = { eq: "native" };

const EQ_SOURCE = `export function eq(a: string, b: string): boolean { return a === b; }`;

/** Both polarities plus a literal operand — the seam, exhaustively. */
const EQ_ALL_SOURCE = `export function all(a: string, b: string): number {
  let n = 0;
  if (a === b) n = n + 1;
  if (a !== b) n = n + 2;
  if (a === "x") n = n + 4;
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

function policy(stringEq: StringEqPolicy): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", stringEq };
}

/**
 * One hand-built owner carrying the exact `string.eq` instruction from-ast
 * emits for `a === b`. It carries no `intrinsic` instruction — which is why the
 * demand has to be requested at freeze even though the KIND exists.
 */
function eqFunction(name: string, negate = false, provider?: unknown): IrFunction {
  const instr: IrInstr = {
    kind: "string.eq",
    lhs: asValueId(0),
    rhs: asValueId(1),
    negate,
    result: asValueId(2),
    resultType: I32,
    ...(provider ? { provider } : {}),
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

function prepare(fn: IrFunction, stringEq: StringEqPolicy) {
  const prepared = prepareIrRuntimeManifest({
    functions: [fn],
    sourceFile: "/repo/string-eq.ts",
    policy: policy(stringEq),
    stringEqDemand: true,
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
 * `wasm:js-string` — so an `result.imports`-only pin cannot see this seam's host
 * arm at all. The compare suite could use `result.imports` because
 * `env.string_compare` is an `env` row; this one cannot.
 */
function hostLaneModule(source: string): WasmModule {
  return generateModule(analyzeSource(source, "issue-3526-f2s3-eq.ts"), { experimentalIR: true }).module;
}

function orderedFuncImports(module: WasmModule): string[] {
  return module.imports.filter((entry) => entry.desc.kind === "func").map((entry) => `${entry.module}.${entry.name}`);
}

// --------------------------------------------------------------------------
// (a) contract — one capability record, one feature row, two provider arms
// --------------------------------------------------------------------------

describe("#3526 F2-S3 string-eq contract", () => {
  it("adds ONE feature row and REUSES the compare's ABI, minting no new signature", () => {
    expect([...STRING_EQ_RUNTIME_FEATURES]).toEqual(["js.string.eq"]);
    // The same `(externref, externref) -> i32` row F2-S1 introduced. Equality
    // and lexicographic compare have the same physical shape; a second
    // signature constant would have been two names for one fact.
    expect(EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE.version).toBe(INTRINSIC_SIGNATURE_VERSION);
    expect(EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE.params).toEqual([
      irVal({ kind: "externref" }),
      irVal({ kind: "externref" }),
    ]);
    expect(EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE.result).toEqual(I32);
  });

  it("is TWO-armed at the provider level, like the compare", () => {
    expect([...STRING_EQ_RUNTIME_PROVIDER_IDS]).toEqual(["host.js.string.eq", "native.js.string.eq"]);
  });

  it("carries NO intrinsic instruction — the demand is requested at freeze", () => {
    // `string.eq` IS an IR instruction kind, unlike the compare's plain `call`.
    // That does NOT make it an `intrinsic`: the manifest walk collects
    // `kind === "intrinsic"` uses only, so without the freeze-time demand an
    // eq-only module freezes no manifest at all and the arm has nothing to read.
    const fn = eqFunction("noIntrinsic");
    expect(instrsOf(fn).some((instr) => instr.kind === "intrinsic")).toBe(false);
    expect(instrsOf(fn).some((instr) => instr.kind === "string.eq")).toBe(true);
    expect(
      prepareIrRuntimeManifest({
        functions: [fn],
        sourceFile: "/repo/string-eq.ts",
        policy: policy(HOST_EQ),
      }),
    ).toBeUndefined();
    expect(prepare(fn, HOST_EQ).manifest.features).toEqual(["js.string.eq"]);
  });

  it("names the F2-S2 wasm:js-string record, and the async projection excludes it BY ID", () => {
    expect(resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.eq")).toEqual({
      capability: "string.eq",
      module: "wasm:js-string",
      field: "equals",
      kind: "func",
      params: ["externref", "externref"],
      results: ["i32"],
    });
    const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.eq");
    // (#3526 F2-S2) This is the FIRST provider-selected record in a non-`env`
    // module namespace. Every value type is admissible under
    // `AsyncHostAdapterValueType`, so only the seven-ID filter keeps it out of
    // the async projection — the same trap the compare row documents.
    for (const entry of [...record.params, ...record.results]) expect(["externref", "i32"]).toContain(entry);
    expect(ASYNC_HOST_CAPABILITY_RECORDS.map((entry) => entry.capability)).not.toContain("string.eq");
    expect(() => asAsyncHostAdapter(record)).toThrowError(/is not an async capability/);
  });
});

// --------------------------------------------------------------------------
// (b) provider policy — both arms, the refusal, and the defaults
// --------------------------------------------------------------------------

describe("#3526 F2-S3 provider policy", () => {
  it("selects the host arm through the central capability record, MODULE included", () => {
    const prepared = prepare(eqFunction("hostEq"), HOST_EQ);
    expect(prepared.manifest.policy.stringEq).toEqual(HOST_EQ);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["host.js.string.eq"]);
    expect(prepared.manifest.hostCapabilities).toEqual(["string.eq"]);
    for (const record of prepared.manifest.hostCapabilityRecords) {
      expect(RUNTIME_HOST_CAPABILITY_RECORDS).toContain(record);
    }
    // The module half is load-bearing, not decoration: the resolve arm locates
    // the import by section POSITION, and `equals` alone does not name it.
    expect(preparedStringEqProvider(prepared)).toEqual({
      arm: "host",
      module: "wasm:js-string",
      field: "equals",
    });
  });

  it("selects the native arm on the runtime symbol, requesting NO host capability", () => {
    const prepared = prepare(eqFunction("nativeEq"), NATIVE_EQ);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.string.eq"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.hostCapabilityRecords).toEqual([]);
    expect(preparedStringEqProvider(prepared)).toEqual({ arm: "native", symbol: "__str_equals" });
  });

  it("refuses the arm its caller resolved to unsupported, naming the feature and the policy", () => {
    expect(() => prepare(eqFunction("refused"), STRING_EQ_POLICY_DISABLED)).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }),
    );
    expect(() => prepare(eqFunction("refused2"), STRING_EQ_POLICY_DISABLED)).toThrowError(
      /js\.string\.eq is unavailable under string-eq policy eq=unsupported/,
    );
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    const frozen = builder.freeze();
    expect(frozen.policy.stringEq).toEqual(STRING_EQ_POLICY_DISABLED);
    // SIX independent policies now, not one widened field.
    expect(frozen.policy.numberBoundary).toEqual(NUMBER_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.booleanBoundary).toEqual(BOOLEAN_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.externIsUndefined).toEqual(EXTERN_IS_UNDEFINED_POLICY_DISABLED);
    expect(frozen.policy.generatorNumberBox).toEqual(GENERATOR_NUMBER_BOX_POLICY_DISABLED);
    expect(frozen.policy.stringCompare).toEqual(STRING_COMPARE_POLICY_DISABLED);
  });

  it("resolves independently of the compare and of every family-1 arm", () => {
    // The two string policies are SIBLINGS. A disabled compare must not drag the
    // equality down with it — that is the whole reason they are separate fields.
    const prepared = prepareIrRuntimeManifest({
      functions: [eqFunction("independent")],
      sourceFile: "/repo/string-eq.ts",
      policy: {
        target: "host",
        backend: "wasmgc",
        numberBoundary: NUMBER_BOUNDARY_POLICY_DISABLED,
        booleanBoundary: BOOLEAN_BOUNDARY_POLICY_DISABLED,
        externIsUndefined: EXTERN_IS_UNDEFINED_POLICY_DISABLED,
        generatorNumberBox: GENERATOR_NUMBER_BOX_POLICY_DISABLED,
        stringCompare: STRING_COMPARE_POLICY_DISABLED,
        stringEq: NATIVE_EQ,
      },
      stringEqDemand: true,
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.string.eq"]);
  });

  it("has no manifest row at all when nothing in the module compares strings for equality", () => {
    // The demand predicate, not the policy, decides whether a row exists — so a
    // host-lane module with no `string.eq` requests no `string.eq` capability
    // and cannot pull the builtin import in through the manifest.
    const prepared = prepareIrRuntimeManifest({
      functions: [eqFunction("unused")],
      sourceFile: "/repo/string-eq.ts",
      policy: policy(HOST_EQ),
      stringEqDemand: false,
    });
    expect(prepared).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// (c) end-to-end — import identity, import ORDER, and the runtime oracle
// --------------------------------------------------------------------------

describe("#3526 F2-S3 end-to-end behaviour is unchanged", () => {
  it("binds the host lane's existing wasm:js-string.equals builtin, in the same position", async () => {
    const result = await compile(EQ_SOURCE, { trackIrOutcomes: true });
    expect(outcome(result, "eq").kind).toBe("emitted");
    // `result.imports` is blind here — it lists only `env` func descriptors —
    // so the order pin has to read the module's own import section.
    expect(result.imports.map((entry) => `${entry.module}.${entry.name}`)).toEqual([]);
    const module = hostLaneModule(EQ_SOURCE);
    expect(orderedFuncImports(module)).toEqual(["wasm:js-string.equals"]);
  });

  it("keeps the ordered import list intact when the compare and concat share the module", async () => {
    // The registration ORDER is `addStringImports`'s five-import block, filtered
    // by dead-import elimination. A late registration from the migrated arm — or
    // a second materializer — would show up here before it showed up in a byte
    // diff. `env.string_compare` leads because the legacy collector's pre-pass
    // mints it before the builtin block.
    const source = `export function mix(a: string, b: string): number {
  let n = 0;
  if (a < b) n = n + 1;
  if (a === b) n = n + 2;
  const c = a + b;
  if (c.length > 3) n = n + 4;
  return n;
}`;
    const module = hostLaneModule(source);
    expect(orderedFuncImports(module)).toEqual([
      "env.string_compare",
      "wasm:js-string.concat",
      "wasm:js-string.length",
      "wasm:js-string.equals",
    ]);
  });

  it("uses the host-free helper on every native-strings lane, with no wasm:js-string import", async () => {
    for (const options of [{ nativeStrings: true }, { target: "standalone" as const }, { target: "wasi" as const }]) {
      const result = await compile(EQ_SOURCE, { ...options, trackIrOutcomes: true });
      expect(outcome(result, "eq").kind).toBe("emitted");
      expect(result.wat).not.toContain('(import "wasm:js-string"');
    }
  });

  it("answers === and !== exactly as JavaScript does", async () => {
    const result = await compile(EQ_ALL_SOURCE, { trackIrOutcomes: true });
    expect(outcome(result, "all").kind).toBe("emitted");
    const exports = await instantiate(result);
    const oracle = (a: string, b: string): number => (a === b ? 1 : 0) + (a !== b ? 2 : 0) + (a === "x" ? 4 : 0);
    for (const [a, b] of [
      ["a", "b"],
      ["a", "a"],
      ["", ""],
      ["", "a"],
      ["x", "x"],
      ["ab", "abc"],
      ["Z", "z"],
    ] as const) {
      expect(exports.all!(a as never, b as never)).toBe(oracle(a, b));
    }
  });

  it("answers === and !== identically on a native-strings lane", async () => {
    const result = await compile(EQ_ALL_SOURCE, { nativeStrings: true, trackIrOutcomes: true });
    expect(outcome(result, "all").kind).toBe("emitted");
    expect(result.success).toBe(true);
  });

  it("still lowers string equality on the linear backend, which ignores the provider", async () => {
    // (#3526 F2-S3) `string.eq` IS on the linear instruction allowlist, so the
    // linear demote trick the compare suite uses does NOT carry here: that lane
    // resolves `__str_eq` through its own resolver and never consults the
    // frozen provider. Its explicitly disabled `stringEq` policy is therefore
    // INERT — stated so the frozen policy is total, not because it decides
    // anything. This pin is what makes that claim falsifiable.
    const result = await compile(
      `${EQ_SOURCE}
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
// (d) the resolve arm reads the MANIFEST, not the lane
// --------------------------------------------------------------------------

const INTEGRATION_PATH = join(dirname(fileURLToPath(import.meta.url)), "../src/ir/integration.ts");

/**
 * The lifted arm's source text, comments stripped.
 *
 * A behavioural pin cannot separate the migrated arm from the one it replaced:
 * the policy projection reproduces the old truth table EXACTLY, so both forms
 * emit identical bytes on every lane — which is the point of the slice and the
 * reason all 55 byte cells are unchanged. What actually moved is WHICH authority
 * answers, and that is a source fact. This gate is the #2955 grep-gate idiom
 * applied to one arm: it fails the moment the arm goes back to reading the lane
 * discriminator, which no byte or import assertion can catch.
 */
function stringEqArmSource(): string {
  const raw = readFileSync(INTEGRATION_PATH, "utf8");
  const start = raw.indexOf("symbol === IR_STRING_EQUALS_FN) {");
  expect(start, "the IR_STRING_EQUALS_FN resolve arm must exist as its OWN branch").toBeGreaterThan(-1);
  const rest = raw.slice(start);
  const end = rest.indexOf("\n  } else if (");
  expect(end, "the arm must be followed by a sibling branch").toBeGreaterThan(-1);
  return rest
    .slice(0, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("#3526 F2-S3 the resolve arm reads the frozen manifest", () => {
  it("consults the prepared string-eq provider", () => {
    expect(stringEqArmSource()).toContain("preparedStringEqProvider(prepared)");
  });

  it("reads NO lane discriminator", () => {
    expect(stringEqArmSource()).not.toContain("nativeStrings");
  });

  it("fails closed rather than falling back to a locally decided symbol", () => {
    const arm = stringEqArmSource();
    expect(arm).toContain("selection-preparation-mismatch");
    // No `??` fallback, no new registration, and never `funcMap` — the host arm
    // may only locate the record's module/field by import-section position.
    expect(arm).not.toContain("ensureLateImport");
    expect(arm).not.toContain("funcMap");
    expect(arm).toContain("exactCallableImportIndex(ctx, arm.module, arm.field)");
  });

  it("is its OWN branch — the eq symbol has left the concat pair", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    // The three-symbol condition is gone; the concat pair now names two.
    expect(raw).not.toContain("symbol === IR_STRING_CONCAT_OWNED_FN || symbol === IR_STRING_EQUALS_FN");
    expect(raw).toContain("(symbol === IR_STRING_CONCAT_FN || symbol === IR_STRING_CONCAT_OWNED_FN)");
  });
});

// --------------------------------------------------------------------------
// (e) sub-B — the string.eq emitter has ONE authority
// --------------------------------------------------------------------------

describe("#3526 F2-S3 string.eq has ONE emit authority", () => {
  it("attaches the equality provider unconditionally, both polarities", () => {
    for (const negate of [false, true]) {
      const attached = attachIrStringSupport(eqFunction(`attach${negate}`, negate), {
        storageForConst: () => undefined,
        providerForLength: () => undefined,
      });
      const found = instrsOf(attached).filter((instr) => instr.kind === "string.eq");
      expect(found).toHaveLength(1);
      expect((found[0] as { provider?: { name: string } }).provider?.name).toBe("__ir_string_equals");
      expect((found[0] as { negate: boolean }).negate).toBe(negate);
    }
  });

  it("refuses to lower an unattached string.eq instead of re-deciding the lane", () => {
    // Honest scope: this pin holds on BOTH trees and is deliberately NOT the
    // non-vacuity signal for the retirement. A hand-built resolver carries no
    // string runtime, so `WasmGcEmitter` refuses one frame earlier with its own
    // "runtime is unavailable" message and the retired fallback is never
    // reached — the alternation below says so rather than hiding it. What this
    // asserts is the weaker but still load-bearing fact that an unattached
    // instruction cannot silently mint a body. The DISCRIMINATOR for sub-B is
    // the source-shape pin at the end of this section (measured: reverting only
    // the retirement fails exactly that one test).
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      resolveString: () => ({ kind: "ref", typeIdx: 3 }),
    } as unknown as IrLowerResolver;
    expect(() => lowerIrFunctionToWasm(eqFunction("unattached"), resolver)).toThrowError(
      /string\.eq (has no prepared runtime provider|runtime is unavailable)/,
    );
  });

  it("accepts an already-attached provider, so the guard is not a blanket refusal", () => {
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      resolveString: () => ({ kind: "ref", typeIdx: 3 }),
    } as unknown as IrLowerResolver;
    const attached = eqFunction("attached", false, irRuntimeFuncRef("__str_equals"));
    let message = "";
    try {
      lowerIrFunctionToWasm(attached, resolver);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).not.toMatch(/has no prepared runtime provider/);
  });

  it("keeps the retired fallback's lane read out of the emitter", () => {
    // The seam's SECOND un-governed `ctx.nativeStrings` read. Measured dead
    // before removal (0 reaches, 55 cells + 337 tests), so a demote is the only
    // correct outcome for an unattached instruction.
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    const start = raw.indexOf("emitStringEquals(provider): readonly Instr[] {");
    expect(start, "the WasmGC emitStringEquals adapter must exist").toBeGreaterThan(-1);
    const end = raw.slice(start).indexOf("\n    emitStringLen");
    expect(end, "the adapter must be followed by emitStringLen").toBeGreaterThan(-1);
    // Comments stripped: the retirement's own rationale NAMES the read it
    // removed, and a naive text scan would read that prose as the read itself.
    const body = raw
      .slice(start, start + end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(body).not.toContain("ctx.nativeStrings");
    expect(body).not.toContain('nativeHelpers.get("__str_equals")');
    expect(body).not.toContain('hostImports.get("equals")');
    expect(body).toContain("string.eq has no prepared runtime provider");
  });
});
