// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F2-S5 — the string CONCATENATION seam moves under manifest authority.
//
// Two sub-migrations, one PR, the F2-S3 shape — with one structural first:
//
//  * **sub-A** puts `a + b` (and the `+=` builder append) under a frozen
//    `stringConcat` policy. The resolve-table arm that read `ctx.nativeStrings`
//    directly now reads `preparedStringConcatProvider`. What is new is that ONE
//    policy answers TWO features: the policy picks the AUTHORITY (host builtin
//    vs. native helper), and the instruction's `concatMode` — `immutable` for
//    `a + b`, `owned-append` for the #3744 builder-loop license — picks WHICH
//    helper on that authority. The host lane has no owned append builtin and
//    collapses both modes onto `wasm:js-string.concat`; that collapse is a
//    provider-ROW fact, stated by two host rows naming one capability, not a
//    policy fact.
//
//  * **sub-B** retires the emitter's no-provider fallback in `integration.ts`'s
//    WasmGC string runtime — the seam's SECOND un-governed `ctx.nativeStrings`
//    read, which carried its own private mode-to-helper mapping. Measured dead
//    before removal: a temporary throw in its place was reached ZERO times
//    across the 65-cell byte matrix (which stayed byte-identical WITH the throw
//    in) and 352 passing tests in 22 string suites.
//
// What this slice does NOT move, deliberately: the BATCHED many-arity family
// (`string.concat$arityN`, `env.__concat_N`, `ensureNativeBatchedConcat` and
// the pass selection that mints them) — that is F2-S6, and the CAT3/TPL pins
// in section (c) are its regression fence. Also out: `charCodeAt`,
// `string.const`, `stringMethodPlan`, and `src/ir/from-ast.ts`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { generateModule } from "../src/codegen/index.js";
import { ASYNC_HOST_CAPABILITY_RECORDS, asAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";
import { irIntrinsicFuncRef } from "../src/ir/callable-bindings.js";
import { prepareIrRuntimeManifest, preparedStringConcatProvider } from "../src/ir/intrinsic-support.js";
import * as intrinsics from "../src/ir/intrinsics.js";
import {
  EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE,
  INTRINSIC_SIGNATURE_VERSION,
  type IntrinsicSignature,
} from "../src/ir/intrinsics.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import {
  asBlockId,
  asValueId,
  forEachInstrDeep,
  irVal,
  type IrFuncRef,
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
  STRING_CONCAT_RUNTIME_FEATURES,
  STRING_CONCAT_RUNTIME_PROVIDER_IDS,
  STRING_EQ_POLICY_DISABLED,
  STRING_LEN_POLICY_DISABLED,
  type RuntimeManifestPolicy,
  type StringConcatPolicy,
} from "../src/ir/runtime-manifest.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { IR_STRING_CONCAT_FN, IR_STRING_CONCAT_OWNED_FN, type IrStringConcatMode } from "../src/ir/string-runtime.js";
import { attachIrStringSupport } from "../src/ir/string-support.js";
import type { WasmModule } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-string-boundary-concat");
const STRING: IrType = { kind: "string" };

const HOST_CONCAT: StringConcatPolicy = { concat: "host" };
const NATIVE_CONCAT: StringConcatPolicy = { concat: "native" };

const CAT_SOURCE = `export function cat(a: string, b: string): string { return a + b; }`;
const APPEND_SOURCE = `export function build(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) { s += "x"; }
  return s;
}`;
/**
 * The three census shapes that reach the seam, as three owners in one module.
 *
 * They are deliberately NOT fused into one function, and the builder appends a
 * LITERAL: a `let s = a + b` followed by `s += …`, or an append of a string
 * PARAMETER, loses the producer's encoding evidence for `s`, so from-ast
 * demotes the whole owner with `string-evidence-unsupported` and the seam is
 * never reached. Both demotes are pre-existing and are the string-builder shape
 * gate's business (`src/ir/string-builder-shape.ts`), not this slice's — the
 * census recorded the same thing for its APPENDREAD and APPENDPLUS fixtures.
 */
const CONCAT_ALL_SOURCE = `export function cat(a: string, b: string): string { return a + b; }
export function build(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) { s += "x"; }
  return s;
}
export function tpl(a: string): string { return \`\${a}!\`; }`;

function instrsOf(fn: IrFunction): IrInstr[] {
  const found: IrInstr[] = [];
  const scan = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) forEachInstrDeep(root, (instr) => found.push(instr));
  };
  for (const block of fn.blocks) scan(block.instrs);
  for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  return found;
}

function policy(stringConcat: StringConcatPolicy): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", stringConcat };
}

/**
 * One hand-built owner carrying the exact `string.concat` instruction from-ast
 * emits for `a + b` (or, in `owned-append` mode, for a licensed `s += x`).
 * It carries no `intrinsic` instruction — which is why the demand has to be
 * requested at freeze even though the KIND exists.
 */
function concatFunction(name: string, mode?: IrStringConcatMode, provider?: IrFuncRef): IrFunction {
  const instr: IrInstr = {
    kind: "string.concat",
    lhs: asValueId(0),
    rhs: asValueId(1),
    result: asValueId(2),
    resultType: STRING,
    ...(mode ? { concatMode: mode } : {}),
    ...(provider ? { provider } : {}),
  } as unknown as IrInstr;
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [
      { name: "a", type: STRING, value: asValueId(0) },
      { name: "b", type: STRING, value: asValueId(1) },
    ],
    resultTypes: [STRING],
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

function demandOf(mode: IrStringConcatMode): { readonly immutable: boolean; readonly owned: boolean } {
  return mode === "owned-append" ? { immutable: false, owned: true } : { immutable: true, owned: false };
}

function prepare(fn: IrFunction, stringConcat: StringConcatPolicy, mode: IrStringConcatMode = "immutable") {
  const prepared = prepareIrRuntimeManifest({
    functions: [fn],
    sourceFile: "/repo/string-concat.ts",
    policy: policy(stringConcat),
    stringConcatDemand: demandOf(mode),
  });
  if (!prepared) throw new Error("expected a non-empty runtime manifest");
  return prepared;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const found = result.irOutcomes?.filter((candidate) => candidate.displayName === name) ?? [];
  if (found.length !== 1) throw new Error(`expected exactly one IR outcome for ${name}, got ${found.length}`);
  return found[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, (...args: never[]) => unknown>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, (...args: never[]) => unknown>;
}

/**
 * The emitted module's own import section.
 *
 * `result.imports` covers only `env` FUNC descriptors and is BLIND to
 * `wasm:js-string` — so a `result.imports`-only pin cannot see this seam's host
 * arm at all, exactly as for the equality and the length.
 */
function hostLaneModule(source: string, options: Parameters<typeof generateModule>[1] = {}): WasmModule {
  return generateModule(analyzeSource(source, "issue-3526-f2s5-concat.ts"), { experimentalIR: true, ...options })
    .module;
}

function orderedFuncImports(module: WasmModule): string[] {
  return module.imports.filter((entry) => entry.desc.kind === "func").map((entry) => `${entry.module}.${entry.name}`);
}

// --------------------------------------------------------------------------
// (a) contract — two feature rows, four providers, one new signature
// --------------------------------------------------------------------------

describe("#3526 F2-S5 string-concat contract", () => {
  it("adds TWO feature rows — one per concat mode", () => {
    // The catalogue's first seam with more than one feature. The producer
    // already maps `concatMode` onto one of two callable symbols; the features
    // mirror that mapping so the frozen manifest can say which of the two
    // helpers a module actually needs.
    expect([...STRING_CONCAT_RUNTIME_FEATURES]).toEqual(["js.string.concat", "js.string.concat.owned"]);
  });

  it("mints ONE new signature, and it is the only one whose result is a non-null ref extern", () => {
    expect(EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE.version).toBe(INTRINSIC_SIGNATURE_VERSION);
    expect(EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE.params).toEqual([
      irVal({ kind: "externref" }),
      irVal({ kind: "externref" }),
    ]);
    expect(EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE.result).toEqual(irVal({ kind: "ref_extern" }));
    // No existing signature carries that result — which is exactly why this
    // seam could not reuse one the way `string.len` reused F1-S4's. The pin
    // mirrors the schema suite's "only concat uses ref_extern" capability fence
    // one level up, at the signature catalogue.
    const named = Object.entries(intrinsics as Record<string, unknown>).filter(
      ([name, value]) =>
        name.endsWith("_INTRINSIC_SIGNATURE") && typeof value === "object" && value !== null && "result" in value,
    ) as Array<[string, IntrinsicSignature]>;
    const refExtern = named
      .filter(([, signature]) => JSON.stringify(signature.result).includes('"ref_extern"'))
      .map(([name]) => name);
    expect(refExtern).toEqual(["EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE"]);
  });

  it("is FOUR-armed at the provider level — two authorities times two modes", () => {
    expect([...STRING_CONCAT_RUNTIME_PROVIDER_IDS]).toEqual([
      "host.js.string.concat",
      "host.js.string.concat.owned",
      "native.js.string.concat",
      "native.js.string.concat.owned",
    ]);
  });

  it("names the F2-S2 wasm:js-string record from BOTH host rows, and the async projection excludes it BY ID", () => {
    const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.concat");
    expect(record).toEqual({
      capability: "string.concat",
      module: "wasm:js-string",
      field: "concat",
      kind: "func",
      params: ["externref", "externref"],
      results: ["ref_extern"],
    });
    // The documented collapse: `wasm:js-string` has no owned append builtin, so
    // both host rows point at this one record and it freezes to ONE import.
    for (const mode of ["immutable", "owned-append"] as const) {
      expect(
        preparedStringConcatProvider(prepare(concatFunction(`host-${mode}`, mode), HOST_CONCAT, mode), mode),
      ).toEqual({ arm: "host", module: "wasm:js-string", field: "concat" });
    }
    expect(ASYNC_HOST_CAPABILITY_RECORDS.map((entry) => entry.capability)).not.toContain("string.concat");
    expect(() => asAsyncHostAdapter(record)).toThrowError(/is not an async capability/);
  });

  it("carries NO intrinsic instruction — the demand is requested at freeze, per mode", () => {
    const fn = concatFunction("noIntrinsic");
    expect(instrsOf(fn).some((instr) => instr.kind === "intrinsic")).toBe(false);
    expect(instrsOf(fn).some((instr) => instr.kind === "string.concat")).toBe(true);
    // Without the demand an `a + b`-only module freezes NO manifest at all.
    expect(
      prepareIrRuntimeManifest({
        functions: [fn],
        sourceFile: "/repo/string-concat.ts",
        policy: policy(HOST_CONCAT),
      }),
    ).toBeUndefined();
    // With it, exactly the mode's row — never both.
    expect(prepare(fn, HOST_CONCAT).manifest.features).toEqual(["js.string.concat"]);
    expect(prepare(concatFunction("owned"), HOST_CONCAT, "owned-append").manifest.features).toEqual([
      "js.string.concat.owned",
    ]);
    // A builder loop that also concatenates freezes BOTH.
    const both = prepareIrRuntimeManifest({
      functions: [concatFunction("bothImmutable"), concatFunction("bothOwned", "owned-append")],
      sourceFile: "/repo/string-concat.ts",
      policy: policy(HOST_CONCAT),
      stringConcatDemand: { immutable: true, owned: true },
    });
    expect(both?.manifest.features).toEqual(["js.string.concat", "js.string.concat.owned"]);
  });
});

// --------------------------------------------------------------------------
// (b) provider policy — both arms, both modes, the refusal, and the defaults
// --------------------------------------------------------------------------

describe("#3526 F2-S5 provider policy", () => {
  it("selects the host arm through the central capability record, MODULE included, for both modes", () => {
    for (const mode of ["immutable", "owned-append"] as const) {
      const prepared = prepare(concatFunction(`hostArm-${mode}`, mode), HOST_CONCAT, mode);
      expect(prepared.manifest.policy.stringConcat).toEqual(HOST_CONCAT);
      expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual([
        mode === "owned-append" ? "host.js.string.concat.owned" : "host.js.string.concat",
      ]);
      // Two rows, ONE capability — the freeze projects host capabilities
      // through a set, so the owned row drags in no second import.
      expect(prepared.manifest.hostCapabilities).toEqual(["string.concat"]);
      for (const record of prepared.manifest.hostCapabilityRecords) {
        expect(RUNTIME_HOST_CAPABILITY_RECORDS).toContain(record);
      }
      // The module half is load-bearing: `concat` alone does not name a builtin
      // import, and `ctx.funcMap` keys it on the bare field (#1072 shadowing).
      expect(preparedStringConcatProvider(prepared, mode)).toEqual({
        arm: "host",
        module: "wasm:js-string",
        field: "concat",
      });
    }
  });

  it("selects the native helper per mode, requesting NO host capability", () => {
    for (const [mode, symbol] of [
      ["immutable", "__str_concat"],
      ["owned-append", "__str_concat_owned"],
    ] as const) {
      const prepared = prepare(concatFunction(`nativeArm-${mode}`, mode), NATIVE_CONCAT, mode);
      expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual([
        mode === "owned-append" ? "native.js.string.concat.owned" : "native.js.string.concat",
      ]);
      expect(prepared.manifest.hostCapabilities).toEqual([]);
      expect(prepared.manifest.hostCapabilityRecords).toEqual([]);
      expect(prepared.manifest.providers[0]!.implementation).toEqual({ kind: "runtime-callable", symbol });
      expect(preparedStringConcatProvider(prepared, mode)).toEqual({ arm: "native", symbol });
    }
  });

  it("refuses the arm its caller resolved to unsupported, naming the feature and the policy", () => {
    for (const mode of ["immutable", "owned-append"] as const) {
      expect(() => prepare(concatFunction(`refused-${mode}`, mode), STRING_CONCAT_POLICY_DISABLED, mode)).toThrowError(
        expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }),
      );
    }
    expect(() => prepare(concatFunction("refusedText"), STRING_CONCAT_POLICY_DISABLED)).toThrowError(
      /js\.string\.concat is unavailable under string-concat policy concat=unsupported/,
    );
    expect(() =>
      prepare(concatFunction("refusedOwnedText", "owned-append"), STRING_CONCAT_POLICY_DISABLED, "owned-append"),
    ).toThrowError(/js\.string\.concat\.owned is unavailable under string-concat policy concat=unsupported/);
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    const frozen = builder.freeze();
    expect(frozen.policy.stringConcat).toEqual(STRING_CONCAT_POLICY_DISABLED);
    // EIGHT independent policies now, not one widened field.
    expect(frozen.policy.numberBoundary).toEqual(NUMBER_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.booleanBoundary).toEqual(BOOLEAN_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.externIsUndefined).toEqual(EXTERN_IS_UNDEFINED_POLICY_DISABLED);
    expect(frozen.policy.generatorNumberBox).toEqual(GENERATOR_NUMBER_BOX_POLICY_DISABLED);
    expect(frozen.policy.stringCompare).toEqual(STRING_COMPARE_POLICY_DISABLED);
    expect(frozen.policy.stringEq).toEqual(STRING_EQ_POLICY_DISABLED);
    expect(frozen.policy.stringLen).toEqual(STRING_LEN_POLICY_DISABLED);
  });

  it("resolves independently of the eq, the len, the compare, and every family-1 arm", () => {
    // The four family-2 policies are SIBLINGS. A disabled eq, len or compare
    // must not drag the concatenation down with it.
    const prepared = prepareIrRuntimeManifest({
      functions: [concatFunction("independent")],
      sourceFile: "/repo/string-concat.ts",
      policy: {
        target: "host",
        backend: "wasmgc",
        numberBoundary: NUMBER_BOUNDARY_POLICY_DISABLED,
        booleanBoundary: BOOLEAN_BOUNDARY_POLICY_DISABLED,
        externIsUndefined: EXTERN_IS_UNDEFINED_POLICY_DISABLED,
        generatorNumberBox: GENERATOR_NUMBER_BOX_POLICY_DISABLED,
        stringCompare: STRING_COMPARE_POLICY_DISABLED,
        stringEq: STRING_EQ_POLICY_DISABLED,
        stringLen: STRING_LEN_POLICY_DISABLED,
        stringConcat: NATIVE_CONCAT,
      },
      stringConcatDemand: { immutable: true, owned: false },
    });
    expect(prepared?.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.string.concat"]);
  });

  it("adds no row when nothing concatenates", () => {
    const compareOnly = new RuntimeManifestBuilder({
      target: "host",
      backend: "wasmgc",
      stringCompare: { compare: "host" },
      stringConcat: HOST_CONCAT,
    });
    compareOnly.requestFeature("js.string.compare");
    const frozen = compareOnly.freeze();
    expect(frozen.features).toEqual(["js.string.compare"]);
    expect(frozen.hostCapabilities).toEqual(["string.compare"]);
    expect(frozen.hostCapabilities).not.toContain("string.concat");
  });

  it("requests NO owned provider for a module that only concatenates immutably", () => {
    // The reason the seam has two features rather than one: an `a + b`-only
    // module must not carry a row for a helper it never calls.
    const prepared = prepare(concatFunction("immutableOnly"), NATIVE_CONCAT);
    expect(prepared.manifest.providers).toHaveLength(1);
    expect(prepared.manifest.providers[0]!.id).toBe("native.js.string.concat");
    expect(prepared.manifest.features).toEqual(["js.string.concat"]);
    expect(preparedStringConcatProvider(prepared, "owned-append")).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// (c) end-to-end — import identity, the batched fence, and the runtime oracle
// --------------------------------------------------------------------------

const sha12 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 12);

describe("#3526 F2-S5 end-to-end behaviour is unchanged", () => {
  it("binds the host lane's existing wasm:js-string.concat builtin for BOTH modes, in the same position", async () => {
    for (const source of [CAT_SOURCE, APPEND_SOURCE]) {
      const result = await compile(source, { trackIrOutcomes: true });
      expect(result.success).toBe(true);
      expect(result.imports.map((entry) => `${entry.module}.${entry.name}`)).toEqual([]);
      // `concat` is func #0 in both — the immutable `a + b` and the
      // `owned-append` builder loop resolve to the SAME import, which is the
      // host-side collapse the two feature rows document.
      expect(orderedFuncImports(hostLaneModule(source))).toEqual(["wasm:js-string.concat"]);
    }
    expect(outcome(await compile(CAT_SOURCE, { trackIrOutcomes: true }), "cat").kind).toBe("emitted");
    expect(outcome(await compile(APPEND_SOURCE, { trackIrOutcomes: true }), "build").kind).toBe("emitted");
  });

  it("calls the mode's native helper on every native-strings lane, with no wasm:js-string import", async () => {
    for (const options of [{ nativeStrings: true }, { target: "standalone" as const }, { target: "wasi" as const }]) {
      const cat = await compile(CAT_SOURCE, { ...options, trackIrOutcomes: true });
      expect(cat.success).toBe(true);
      expect(cat.wat).not.toContain('(import "wasm:js-string"');
      expect(cat.wat).toContain("$__str_concat");

      const append = await compile(APPEND_SOURCE, { ...options, trackIrOutcomes: true });
      expect(append.success).toBe(true);
      expect(append.wat).not.toContain('(import "wasm:js-string"');
      expect(append.wat).toContain("$__str_concat_owned");
    }
  });

  it("leaves the BATCHED many-arity family byte-identical — the F2-S6 fence", async () => {
    // The census (13 fixtures × 5 lanes at `a7edf000ee`, re-measured on this
    // lane's own base) recorded these two cells going through the batched
    // `env.__concat_N` / `__str_concat_N` seam, NOT through the pairwise arm
    // this slice migrated. F2-S6 owns that seam; this slice must not move it,
    // and these are the exact BEFORE bytes.
    //
    // If this pin goes red without an intentional change to the batched family,
    // read it as "the batching decision moved", not as a stale expectation.
    const CAT3 = `export function cat3(a: string, b: string, c: string): string { return a + b + c; }`;
    const TPL = "export function tpl(a: string): string { return `${a}!`; }";
    for (const [source, bytes, sha] of [
      [CAT3, 149, "4677a84a2dcd"],
      [TPL, 173, "a6702c76db07"],
    ] as const) {
      const result = await compile(source, { trackIrOutcomes: true });
      expect(result.success).toBe(true);
      expect(result.binary.length).toBe(bytes);
      expect(sha12(result.binary)).toBe(sha);
    }
    // The batched arm mints its `env.__concat_N` import LATE and is untouched
    // by this slice; the pairwise `wasm:js-string.concat` never appears.
    expect(orderedFuncImports(hostLaneModule(CAT3))).toEqual(["env.__concat_3"]);
    expect(orderedFuncImports(hostLaneModule(TPL))).toEqual(["env.__concat_3"]);
    // On standalone the same trees batch to the native arity family. The bytes
    // are not pinned there: that module carries the whole native-strings
    // runtime, so a sha pin would go red on any unrelated runtime edit.
    for (const source of [CAT3, TPL]) {
      const standalone = await compile(source, { target: "standalone", trackIrOutcomes: true });
      expect(standalone.success).toBe(true);
      expect(standalone.wat).toContain("$__str_concat_3");
    }
  });

  it("answers +, += and a template exactly as JavaScript does", async () => {
    const result = await compile(CONCAT_ALL_SOURCE, { trackIrOutcomes: true });
    for (const name of ["cat", "build", "tpl"]) expect(outcome(result, name).kind).toBe("emitted");
    const exports = await instantiate(result);
    const inputs: Array<readonly [string, string, number]> = [
      ["", "", 0],
      ["", "abc", 3],
      // Two lone surrogate halves that combine into one astral code point.
      ["\ud83d", "\ude00", 1],
      ["", "x", 1000],
      ["héllo", "wörld", 2],
      ["12", "34", 4],
      ["ab", "cd", 0],
    ];
    for (const [a, b, n] of inputs) {
      expect(exports.cat!(a as never, b as never)).toBe(a + b);
      expect(exports.build!(n as never)).toBe("x".repeat(n));
      expect(exports.tpl!(a as never)).toBe(`${a}!`);
    }
  });

  it("compiles the same owner on a native-strings lane and on linear", async () => {
    for (const options of [{ nativeStrings: true }, { target: "linear" as const }]) {
      const result = await compile(CONCAT_ALL_SOURCE, { ...options, trackIrOutcomes: true });
      expect(result.success).toBe(true);
    }
  });

  it("still lowers BOTH modes on the linear backend, which ignores the provider", async () => {
    // The linear adapter lowers `+` through its own `concatenate` operation and
    // `+=` through `LINEAR_IR_STRING_APPEND_ASCII_FN`, never consulting the
    // frozen provider. Its explicitly disabled `stringConcat` policy is
    // therefore INERT — stated so the frozen policy is total, not because it
    // decides anything. This pin is what makes that claim falsifiable.
    const result = await compile(
      `${CAT_SOURCE}
${APPEND_SOURCE}
export function clean(a: number, b: number): number { return a + b; }`,
      { target: "linear", trackIrOutcomes: true },
    );
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, (...args: never[]) => number>;
    expect(exports.clean!(2 as never, 3 as never)).toBe(5);
  });
});

// --------------------------------------------------------------------------
// (d) the resolve arm reads the MANIFEST, not the lane
// --------------------------------------------------------------------------

const INTEGRATION_PATH = join(dirname(fileURLToPath(import.meta.url)), "../src/ir/integration.ts");

/**
 * The concat resolve arm's source text, comments stripped.
 *
 * A behavioural pin cannot separate the migrated arm from the one it replaced:
 * the policy projection reproduces the old truth table EXACTLY, so both forms
 * emit identical bytes on every lane — which is the point of the slice and the
 * reason all 65 byte cells are unchanged. What actually moved is WHICH
 * authority answers, and that is a source fact. This gate is the #2955
 * grep-gate idiom applied to one arm.
 */
function stringConcatArmSource(): string {
  const raw = readFileSync(INTEGRATION_PATH, "utf8");
  const start = raw.indexOf("(symbol === IR_STRING_CONCAT_FN || symbol === IR_STRING_CONCAT_OWNED_FN)");
  expect(start, "the concat pair resolve arm must exist").toBeGreaterThan(-1);
  const rest = raw.slice(start);
  const end = rest.indexOf("\n  } else if (");
  expect(end, "the arm must be followed by a sibling branch").toBeGreaterThan(-1);
  return rest
    .slice(0, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("#3526 F2-S5 the resolve arm reads the frozen manifest", () => {
  it("consults the prepared string-concat provider, recovering the MODE from the symbol", () => {
    // (#3526 F2-S5) This INVERTS the F2-S2/F2-S3 fence
    // `issue-3526-string-boundary-schema.test.ts` used to carry ("keeps the
    // CONCAT resolve arm on ctx.nativeStrings and the raw import lookup"),
    // whose stated purpose was to stop this slice from being mistaken for
    // having landed. It has landed; that pin is deleted and this replaces it.
    const arm = stringConcatArmSource();
    expect(arm).toContain("preparedStringConcatProvider(");
    // The resolve table receives the intrinsic SYMBOL and nothing else, so the
    // mode has to be recovered from it here.
    expect(arm).toContain('symbol === IR_STRING_CONCAT_OWNED_FN ? "owned-append" : "immutable"');
  });

  it("reads NO lane discriminator", () => {
    expect(stringConcatArmSource()).not.toContain("nativeStrings");
  });

  it("fails closed rather than falling back to a locally decided symbol", () => {
    const arm = stringConcatArmSource();
    expect(arm).toContain("selection-preparation-mismatch");
    // No `??` fallback, no new registration, and never `funcMap` — the host arm
    // may only locate the record's module/field by import-section position.
    expect(arm).not.toContain("ensureLateImport");
    expect(arm).not.toContain("funcMap");
    expect(arm).not.toContain("hostImports");
    expect(arm).toContain("exactCallableImportIndex(ctx, arm.module, arm.field)");
  });

  it("still names BOTH concat symbols in its condition", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    expect(raw).toContain("(symbol === IR_STRING_CONCAT_FN || symbol === IR_STRING_CONCAT_OWNED_FN)");
  });

  it("partitions an unsupported concat policy owner-locally, naming the policy", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    expect(raw).toContain('stringConcatPolicy.concat === "unsupported"');
    expect(raw).toContain("has no provider under string-concat policy ");
  });
});

// --------------------------------------------------------------------------
// (e) sub-B — the string.concat emitter has ONE authority
// --------------------------------------------------------------------------

describe("#3526 F2-S5 string.concat has ONE emit authority", () => {
  it("attaches the mode's callable provider unconditionally, both modes", () => {
    for (const [mode, symbol] of [
      [undefined, IR_STRING_CONCAT_FN],
      ["immutable", IR_STRING_CONCAT_FN],
      ["owned-append", IR_STRING_CONCAT_OWNED_FN],
    ] as const) {
      const attached = attachIrStringSupport(concatFunction(`attach-${String(mode)}`, mode), {
        storageForConst: () => undefined,
        providerForLength: () => undefined,
      });
      const found = instrsOf(attached).filter((instr) => instr.kind === "string.concat");
      expect(found).toHaveLength(1);
      expect((found[0] as { provider?: { name: string } }).provider?.name).toBe(symbol);
    }
  });

  it("refuses to lower an unattached string.concat instead of re-deciding the lane", () => {
    // Honest scope, the F2-S3/F2-S4 disclosure repeated because it applies
    // verbatim: this pin holds on BOTH trees and is deliberately NOT the
    // non-vacuity signal for the retirement. A hand-built resolver carries no
    // string runtime, so `WasmGcEmitter` refuses one frame earlier with its own
    // "runtime is unavailable" message and the retired fallback is never
    // reached — the alternation below says so rather than hiding it. The
    // DISCRIMINATOR for sub-B is the source-shape pin at the end of this
    // section (measured: reverting only the retirement fails exactly that one).
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      resolveString: () => ({ kind: "ref", typeIdx: 3 }),
    } as unknown as IrLowerResolver;
    expect(() => lowerIrFunctionToWasm(concatFunction("unattached"), resolver)).toThrowError(
      /string\.concat (has no prepared runtime provider|runtime is unavailable)/,
    );
  });

  it("accepts an already-attached provider in EITHER mode, so the guard is not a blanket refusal", () => {
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      resolveString: () => ({ kind: "ref", typeIdx: 3 }),
    } as unknown as IrLowerResolver;
    for (const [mode, symbol] of [
      ["immutable", IR_STRING_CONCAT_FN],
      ["owned-append", IR_STRING_CONCAT_OWNED_FN],
    ] as const) {
      let message = "";
      try {
        lowerIrFunctionToWasm(concatFunction(`attached-${mode}`, mode, irIntrinsicFuncRef(symbol)), resolver);
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).not.toMatch(/has no prepared runtime provider/);
    }
  });

  it("keeps the retired fallback's lane read and its private mode mapping out of the emitter", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    const start = raw.indexOf("emitStringConcat(_alloc, _mode, provider): readonly Instr[] {");
    expect(start, "the WasmGC emitStringConcat adapter must exist").toBeGreaterThan(-1);
    const end = raw.slice(start).indexOf("\n    emitStringRepeat");
    expect(end, "the adapter must be followed by emitStringRepeat").toBeGreaterThan(-1);
    // Comments stripped: the retirement's own rationale NAMES the reads it
    // removed, and a naive text scan would read that prose as the reads
    // themselves.
    const body = raw
      .slice(start, start + end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(body).not.toContain("ctx.nativeStrings");
    expect(body).not.toContain("__str_concat_owned");
    expect(body).not.toContain('hostImports.get("concat")');
    expect(body).toContain("string.concat has no prepared runtime provider");
  });
});
