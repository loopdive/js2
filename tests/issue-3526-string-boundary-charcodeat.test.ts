// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F2-S7 — the guarded `s.charCodeAt(i)` READ moves under manifest
// authority. Family 2's fifth slice, and the first with TWO producers.
//
// The seam looks like its four predecessors and is not shaped like any of them:
//
//  * **two producers reach WasmGC codegen.** The PLAN path emits an `intrinsic`
//    call whose SYMBOL already names the lane (`__jsstr_charCodeAt` /
//    `__str_charCodeAt`, chosen by `stringMethodPlan` at plan time — 35 of the
//    census's 65 byte cells); the INSTR path emits a `string.char_code_at`
//    instruction, minted only with receiver-encoding evidence, carrying the
//    semantic provider `__ir_string_char_code_at` (5 cells, of which 4 reach
//    the WasmGC resolve arm). An instruction-only demand scan — the F2-S3 /
//    F2-S4 template — would freeze a row for those 4 cells and leave the 35
//    plan-path calls with no row to be checked against. So the demand counts
//    BOTH, and the migration splits in two:
//
//      - the INSTR path's arm is the R6-shaped decision: it stops reading
//        `ctx.nativeStrings` and materializes whichever authority the frozen
//        row names;
//      - the PLAN path's two arms keep their materializers and VERIFY the
//        plan-time symbol against the frozen row, fail-closed. The policy
//        refuses; it never re-lowers. Re-deciding there would be from-ast-side
//        vocabulary (#2955), and is named as a later slice.
//
//  * **neither authority is an import.** Both are DEFINED helpers minted on
//    demand — which is why both provider rows are `runtime-callable` and the
//    twin discriminates on the provider ID, not the implementation kind. The
//    host row carries TWO capabilities (`string.char_code_at`, `string.len`)
//    because `__jsstr_charCodeAt` CLOSES OVER both builtins to answer `NaN`
//    instead of trapping (#2003); they are what the helper needs registered,
//    not what the helper is.
//
//  * **the signature is not the record's ABI.** `wasm:js-string.charCodeAt` is
//    `(externref, i32) -> i32` and traps out of range; the seam both
//    authorities implement is the guarded `(externref, i32) -> f64`. This is
//    the first row in the catalogue where those differ on purpose.
//
//  * **sub-B**: the WasmGC `emitStringCharCodeAt` adapter's no-provider
//    fallback — the seam's second un-governed `ctx.nativeStrings` read — is
//    retired. Measured dead before removal: a temporary throw in its place was
//    reached ZERO times across the 65-cell byte matrix (which stayed
//    byte-identical WITH the throw in, WAT text included) and across 39 suites
//    / 604 passing tests.
//
// What this slice does NOT move, deliberately: the proof-licensed trusted /
// hoist feature (`__jsstr_charCodeAt_trusted`, and the `__str_flatten` +
// `__str_flat_charCodeAt` preheader PAIR) and its arms, `stringMethodPlan`,
// `charReadPlan`, `preferLegacyFlatSubstringCharCodeAt`, `charAt`,
// `char-code-at-helpers.ts`'s bodies, `src/ir/from-ast.ts`, and
// `string.const` (F2-S8).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { generateModule } from "../src/codegen/index.js";
import { ASYNC_HOST_CAPABILITY_RECORDS, asAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";
import { prepareIrRuntimeManifest, preparedStringCharCodeAtProvider } from "../src/ir/intrinsic-support.js";
import {
  EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE,
  INTRINSIC_DEFINITIONS,
  INTRINSIC_SIGNATURE_VERSION,
} from "../src/ir/intrinsics.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { irIntrinsicFuncRef } from "../src/ir/callable-bindings.js";
import { IR_STRING_CHAR_CODE_AT_FN } from "../src/ir/string-runtime.js";
import { asBlockId, asValueId, forEachInstrDeep, irVal, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import {
  BOOLEAN_BOUNDARY_POLICY_DISABLED,
  EXTERN_IS_UNDEFINED_POLICY_DISABLED,
  GENERATOR_NUMBER_BOX_POLICY_DISABLED,
  NUMBER_BOUNDARY_POLICY_DISABLED,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  projectRuntimeBackendRequirements,
  RUNTIME_PROVIDERS,
  STRING_CHAR_CODE_AT_POLICY_DISABLED,
  STRING_CHAR_CODE_AT_RUNTIME_FEATURES,
  STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS,
  STRING_COMPARE_POLICY_DISABLED,
  STRING_CONCAT_POLICY_DISABLED,
  STRING_CONST_POLICY_DISABLED,
  STRING_EQ_POLICY_DISABLED,
  STRING_LEN_POLICY_DISABLED,
  type RuntimeManifestPolicy,
  type RuntimeProviderDefinition,
  type StringCharCodeAtPolicy,
} from "../src/ir/runtime-manifest.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import type { WasmModule } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-string-boundary-charcodeat");
const F64 = irVal({ kind: "f64" });
const STRING = { kind: "string" } as const;

const HOST_CCA: StringCharCodeAtPolicy = { charCodeAt: "host" };
const NATIVE_CCA: StringCharCodeAtPolicy = { charCodeAt: "native" };

const READ_SOURCE = `export function read(s: string, i: number): number { return s.charCodeAt(i); }`;
const OOB_SOURCE = `export function oob(): number { return "abc".charCodeAt(10); }`;

/**
 * Every guarded shape the census found that reaches the seam — one exported
 * owner each, rather than one owner summing them.
 *
 * The sum shape is unusable as an oracle: `NaN` from the out-of-range read
 * poisons every other case, so a single wrong in-range answer would be
 * invisible. Four owners let each shape be compared to JavaScript on its own,
 * NaN included (`Object.is`).
 */
const CCA_ALL_SOURCE = `export function at(s: string, i: number): number { return s.charCodeAt(i); }
export function first(s: string): number { return s.charCodeAt(0); }
export function neg(s: string): number { return s.charCodeAt(-1); }
export function omit(s: string): number { return s.charCodeAt(); }`;

function instrsOf(fn: IrFunction): IrInstr[] {
  const found: IrInstr[] = [];
  const scan = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) forEachInstrDeep(root, (instr) => found.push(instr));
  };
  for (const block of fn.blocks) scan(block.instrs);
  for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  return found;
}

function policy(stringCharCodeAt: StringCharCodeAtPolicy): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", stringCharCodeAt };
}

/**
 * One hand-built owner carrying the exact `string.char_code_at` instruction
 * `from-ast` emits for a literal receiver. It carries no `intrinsic`
 * instruction — which is why the demand has to be requested at freeze even
 * though the KIND exists.
 */
function charCodeAtFunction(name: string, attached = false): IrFunction {
  const instr = {
    kind: "string.char_code_at",
    value: asValueId(0),
    index: asValueId(1),
    inputEncoding: "utf16",
    result: asValueId(2),
    resultType: F64,
    ...(attached ? { provider: irIntrinsicFuncRef(IR_STRING_CHAR_CODE_AT_FN) } : {}),
  } as unknown as IrInstr;
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [
      { name: "s", type: STRING, value: asValueId(0) },
      { name: "i", type: irVal({ kind: "i32" }), value: asValueId(1) },
    ],
    resultTypes: [F64],
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

function prepare(fn: IrFunction, stringCharCodeAt: StringCharCodeAtPolicy) {
  const prepared = prepareIrRuntimeManifest({
    functions: [fn],
    sourceFile: "/repo/string-char-code-at.ts",
    policy: policy(stringCharCodeAt),
    stringCharCodeAtDemand: true,
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
 * The emitted module's own import section. `result.imports` covers only `env`
 * FUNC descriptors and is BLIND to `wasm:js-string`, so an `result.imports`-only
 * pin cannot see this seam's host arm at all.
 */
function hostLaneModule(source: string): WasmModule {
  return generateModule(analyzeSource(source, "issue-3526-f2s7-charcodeat.ts"), { experimentalIR: true }).module;
}

function orderedFuncImports(module: WasmModule): string[] {
  return module.imports.filter((entry) => entry.desc.kind === "func").map((entry) => `${entry.module}.${entry.name}`);
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// --------------------------------------------------------------------------
// (a) contract — one feature, one new signature, two runtime-callable rows
// --------------------------------------------------------------------------

const CHAR_CODE_AT_ROWS = (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).filter(
  (provider) => provider.feature === "js.string.char_code_at",
);

describe("#3526 F2-S7 string-char-code-at contract", () => {
  it("governs exactly ONE feature — the GUARDED read, not the proof-licensed arms", () => {
    expect([...STRING_CHAR_CODE_AT_RUNTIME_FEATURES]).toEqual(["js.string.char_code_at"]);
  });

  it("mints ONE new signature, and it is the only one with (externref, i32) params", () => {
    expect(EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE.version).toBe(INTRINSIC_SIGNATURE_VERSION);
    expect(EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE.params).toEqual([
      irVal({ kind: "externref" }),
      irVal({ kind: "i32" }),
    ]);
    expect(EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE.result).toEqual(F64);
    // No intrinsic definition carries those params — which is why the seam
    // could not reuse an existing constant. Unlike every predecessor the
    // signature is deliberately NOT the capability record's ABI: the record is
    // the raw builtin that TRAPS out of range, the seam is the guarded f64.
    const wanted = JSON.stringify(EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE.params);
    const sharing = Object.values(INTRINSIC_DEFINITIONS).filter(
      (definition) => JSON.stringify(definition.signature.params) === wanted,
    );
    expect(sharing).toEqual([]);
    const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.char_code_at");
    if (record.kind !== "func") throw new Error("string.char_code_at is not a func record");
    expect(record.results).toEqual(["i32"]);
    expect(EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE.result).not.toEqual(irVal({ kind: "i32" }));
  });

  it("is TWO-armed, and BOTH arms are runtime-callable defined helpers", () => {
    expect([...STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS]).toEqual([
      "host.js.string.char_code_at",
      "native.js.string.char_code_at",
    ]);
    expect(CHAR_CODE_AT_ROWS.map((provider) => provider.id)).toEqual([
      "host.js.string.char_code_at",
      "native.js.string.char_code_at",
    ]);
    // Neither authority is an IMPORT, so neither row can be `host-callable`.
    // The consequence the twin lives with: the ID, not the kind, discriminates.
    for (const provider of CHAR_CODE_AT_ROWS) {
      expect(provider.implementation.kind).toBe("runtime-callable");
      expect(provider.signature).toEqual(EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE);
    }
    expect(CHAR_CODE_AT_ROWS.map((provider) => (provider.implementation as { symbol: string }).symbol)).toEqual([
      "__jsstr_charCodeAt",
      "__str_charCodeAt",
    ]);
  });

  it("names TWO capability records on the host row and NONE on the native one", () => {
    // `__jsstr_charCodeAt` closes over both builtins: the raw read, and the
    // length it needs to answer NaN instead of trapping (#2003).
    expect([...CHAR_CODE_AT_ROWS[0]!.hostCapabilities]).toEqual(["string.char_code_at", "string.len"]);
    expect([...CHAR_CODE_AT_ROWS[1]!.hostCapabilities]).toEqual([]);
    for (const capability of ["string.char_code_at", "string.len"] as const) {
      const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, capability);
      expect(record.module).toBe("wasm:js-string");
      expect(record.kind).toBe("func");
    }
  });

  it("is excluded from the async projection TWICE, by two different mechanisms", () => {
    // (1) the capability RECORDS, by id — `asAsyncHostAdapter`'s seven-id
    // filter, the same trap the compare / eq / len rows document.
    for (const capability of ["string.char_code_at", "string.len"] as const) {
      const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, capability);
      expect(ASYNC_HOST_CAPABILITY_RECORDS.map((entry) => entry.capability)).not.toContain(capability);
      expect(() => asAsyncHostAdapter(record)).toThrowError(/is not an async capability/);
    }
    // (2) the provider ROWS, by kind — the backend-requirement projection
    // `continue`s past anything that is not host-capability / host-managed /
    // native-managed, so a `runtime-callable` row contributes nothing and can
    // never mix a host and a native async projection.
    expect(projectRuntimeBackendRequirements(CHAR_CODE_AT_ROWS)).toEqual([]);
  });

  it("carries NO intrinsic instruction — the demand is requested at freeze", () => {
    const fn = charCodeAtFunction("noIntrinsic");
    expect(instrsOf(fn).some((instr) => instr.kind === "intrinsic")).toBe(false);
    expect(instrsOf(fn).some((instr) => instr.kind === "string.char_code_at")).toBe(true);
    expect(
      prepareIrRuntimeManifest({
        functions: [fn],
        sourceFile: "/repo/string-char-code-at.ts",
        policy: policy(HOST_CCA),
      }),
    ).toBeUndefined();
    expect(prepare(fn, HOST_CCA).manifest.features).toEqual(["js.string.char_code_at"]);
  });

  it("publishes both records when host answers and neither when native does", () => {
    expect(prepare(charCodeAtFunction("pubHost"), HOST_CCA).manifest.hostCapabilities).toEqual([
      "string.char_code_at",
      "string.len",
    ]);
    expect(prepare(charCodeAtFunction("pubNative"), NATIVE_CCA).manifest.hostCapabilities).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// (b) provider policy — both arms, the refusal, and the defaults
// --------------------------------------------------------------------------

describe("#3526 F2-S7 provider policy", () => {
  it("selects the host helper and reports the two records it closes over", () => {
    const prepared = prepare(charCodeAtFunction("hostCca"), HOST_CCA);
    expect(prepared.manifest.policy.stringCharCodeAt).toEqual(HOST_CCA);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["host.js.string.char_code_at"]);
    for (const record of prepared.manifest.hostCapabilityRecords) {
      expect(RUNTIME_HOST_CAPABILITY_RECORDS).toContain(record);
    }
    // No MODULE half, unlike the eq / len / concat twins: this arm is a DEFINED
    // helper, so there is no import-section position to locate.
    expect(preparedStringCharCodeAtProvider(prepared)).toEqual({
      arm: "host",
      symbol: "__jsstr_charCodeAt",
      capabilities: ["string.char_code_at", "string.len"],
    });
  });

  it("selects the native helper, requesting NO host capability", () => {
    const prepared = prepare(charCodeAtFunction("nativeCca"), NATIVE_CCA);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.string.char_code_at"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.hostCapabilityRecords).toEqual([]);
    expect(preparedStringCharCodeAtProvider(prepared)).toEqual({ arm: "native", symbol: "__str_charCodeAt" });
  });

  it("refuses the arm its caller resolved to unsupported, naming the feature and the policy", () => {
    expect(() => prepare(charCodeAtFunction("refused"), STRING_CHAR_CODE_AT_POLICY_DISABLED)).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }),
    );
    expect(() => prepare(charCodeAtFunction("refused2"), STRING_CHAR_CODE_AT_POLICY_DISABLED)).toThrowError(
      /js\.string\.char_code_at is unavailable under string-char-code-at policy charCodeAt=unsupported/,
    );
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    const frozen = builder.freeze();
    expect(frozen.policy.stringCharCodeAt).toEqual(STRING_CHAR_CODE_AT_POLICY_DISABLED);
    // (#3526 F2-S7) NINE independent policies now, not one widened field.
    expect(frozen.policy.numberBoundary).toEqual(NUMBER_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.booleanBoundary).toEqual(BOOLEAN_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.externIsUndefined).toEqual(EXTERN_IS_UNDEFINED_POLICY_DISABLED);
    expect(frozen.policy.generatorNumberBox).toEqual(GENERATOR_NUMBER_BOX_POLICY_DISABLED);
    expect(frozen.policy.stringCompare).toEqual(STRING_COMPARE_POLICY_DISABLED);
    expect(frozen.policy.stringEq).toEqual(STRING_EQ_POLICY_DISABLED);
    expect(frozen.policy.stringLen).toEqual(STRING_LEN_POLICY_DISABLED);
    expect(frozen.policy.stringConcat).toEqual(STRING_CONCAT_POLICY_DISABLED);
    // (#3526 F2-S8) …and family 2's last: the literal-storage seam.
    expect(frozen.policy.stringConst).toEqual(STRING_CONST_POLICY_DISABLED);
  });

  it("resolves independently of compare, eq, len, concat and every family-1 arm", () => {
    const prepared = prepareIrRuntimeManifest({
      functions: [charCodeAtFunction("independent")],
      sourceFile: "/repo/string-char-code-at.ts",
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
        stringConcat: STRING_CONCAT_POLICY_DISABLED,
        stringCharCodeAt: NATIVE_CCA,
      },
      stringCharCodeAtDemand: true,
    });
    expect(prepared?.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.string.char_code_at"]);
  });

  it("adds no row when nothing calls charCodeAt", () => {
    const lenOnly = new RuntimeManifestBuilder({
      target: "host",
      backend: "wasmgc",
      stringLen: { len: "host" },
      stringCharCodeAt: HOST_CCA,
    });
    lenOnly.requestFeature("js.string.len");
    const frozen = lenOnly.freeze();
    expect(frozen.features).toEqual(["js.string.len"]);
    expect(frozen.hostCapabilities).toEqual(["string.len"]);
    expect(frozen.hostCapabilities).not.toContain("string.char_code_at");
  });
});

// --------------------------------------------------------------------------
// (c) end-to-end — import identity, helper identity, the runtime oracle,
//     and the hoist/trusted byte fence
// --------------------------------------------------------------------------

describe("#3526 F2-S7 end-to-end behaviour is unchanged", () => {
  it("keeps the host lane's two wasm:js-string builtins in the same positions", async () => {
    for (const source of [READ_SOURCE, OOB_SOURCE]) {
      const module = hostLaneModule(source);
      // The census pinned the order: `addStringImports` registers the block
      // `concat, length, equals, substring, charCodeAt` and dead-import
      // elimination compacts it to these two, length first.
      expect(orderedFuncImports(module)).toEqual(["wasm:js-string.length", "wasm:js-string.charCodeAt"]);
    }
    const result = await compile(READ_SOURCE, { trackIrOutcomes: true });
    expect(outcome(result, "read").kind).toBe("emitted");
    // The host arm is a DEFINED helper over those two imports, not an import.
    expect(result.wat).toContain("(func $__jsstr_charCodeAt");
  });

  it("defines __str_charCodeAt with no wasm:js-string import on every native lane", async () => {
    for (const options of [{ nativeStrings: true }, { target: "standalone" as const }, { target: "wasi" as const }]) {
      const result = await compile(READ_SOURCE, { ...options, trackIrOutcomes: true });
      expect(outcome(result, "read").kind).toBe("emitted");
      expect(result.wat).toContain("(func $__str_charCodeAt");
      expect(result.wat).not.toContain('(import "wasm:js-string"');
    }
  });

  it("answers charCodeAt exactly as JavaScript does on the host lane", async () => {
    const result = await compile(CCA_ALL_SOURCE, { trackIrOutcomes: true });
    for (const name of ["at", "first", "neg", "omit"]) expect(outcome(result, name).kind).toBe("emitted");
    const exports = await instantiate(result);
    const inputs = [
      "abc", // ASCII
      "\u{1f600}", // a surrogate PAIR — both halves are read below
      "héllo", // BMP non-ASCII code units
      "", // every read is out of range
    ];
    for (const input of inputs) {
      // In-range, out of range (NaN), negative, and a FRACTIONAL index, which
      // must round through ToIntegerOrInfinity rather than truncating the
      // f64 differently.
      for (const index of [0, 1, 2, 10, -1, 0.9, 1.5]) {
        expect(
          Object.is(exports.at!(input as never, index as never), input.charCodeAt(index)),
          `at(${JSON.stringify(input)}, ${index})`,
        ).toBe(true);
      }
      expect(Object.is(exports.first!(input as never), input.charCodeAt(0)), `first(${JSON.stringify(input)})`).toBe(
        true,
      );
      expect(Object.is(exports.neg!(input as never), input.charCodeAt(-1)), `neg(${JSON.stringify(input)})`).toBe(true);
      // An omitted argument is index 0 — the plan pads an i32 zero.
      expect(
        Object.is(
          exports.omit!(input as never),
          (input as unknown as { charCodeAt: (index?: number) => number }).charCodeAt(),
        ),
        `omit(${JSON.stringify(input)})`,
      ).toBe(true);
    }
  });

  it("compiles and validates the same source on a native-strings lane", async () => {
    const result = await compile(CCA_ALL_SOURCE, { nativeStrings: true, trackIrOutcomes: true });
    for (const name of ["at", "first", "neg", "omit"]) expect(outcome(result, name).kind).toBe("emitted");
    expect(result.success).toBe(true);
  });

  it("still lowers charCodeAt on the linear backend, which ignores the frozen row", async () => {
    // The linear adapter resolves `__linear_ir_str_char_code_at` through its
    // OWN resolver and never consults the frozen provider; its explicitly
    // DISABLED `stringCharCodeAt` policy is therefore inert — stated so the
    // frozen policy is total, not because it decides anything. This pin makes
    // that claim falsifiable. Only the shapes the census measured as reaching
    // linear are used (READ / CONST / NEG / OMIT / OOB).
    const result = await compile(
      `export function read(s: string, i: number): number { return s.charCodeAt(i); }
export function first(s: string): number { return s.charCodeAt(0); }
export function oob(): number { return "abc".charCodeAt(10); }
export function clean(a: number, b: number): number { return a + b; }`,
      { target: "linear", trackIrOutcomes: true },
    );
    expect(result.success).toBe(true);
    const exports = await WebAssembly.instantiate(result.binary, {}).then(
      ({ instance }) => instance.exports as Record<string, (...args: never[]) => number>,
    );
    expect(exports.clean!(2 as never, 3 as never)).toBe(5);
    expect(exports.oob!()).toBeNaN();
  });

  it("leaves the hoist/trusted arms byte-for-byte alone", async () => {
    // The two proof-licensed loops from the census matrix. They freeze NO
    // charCodeAt row (their symbols are not demand) and their arms are not
    // touched, so their bytes must not move at all.
    //
    // gc-host is pinned by exact sha: those modules are ~310 bytes and contain
    // only the trusted helper, so the pin is specific and stable. The three
    // native-strings lanes are pinned STRUCTURALLY rather than by sha —
    // divergence from the plan's "all four GC lanes", following F2-S5's
    // divergence 5: those modules carry the whole ~22 KB native-string runtime,
    // where a sha pin goes red on any unrelated runtime edit. The 65-cell byte
    // matrix in this PR is where their byte identity is established.
    const LOOP = `export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}`;
    const LOOPSUM = `export function sum(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) { n = n + s.charCodeAt(i); }
  return n;
}`;
    const HOST_SHA: Readonly<Record<string, readonly [number, string]>> = {
      LOOP: [313, "d05f4670b1971be3"],
      LOOPSUM: [309, "df45ced9493b984e"],
    };
    for (const [name, source] of [
      ["LOOP", LOOP],
      ["LOOPSUM", LOOPSUM],
    ] as const) {
      const host = await compile(source, { trackIrOutcomes: true });
      expect(host.binary.length, `${name} gc-host bytes`).toBe(HOST_SHA[name]![0]);
      expect(sha256(host.binary).slice(0, 16), `${name} gc-host sha`).toBe(HOST_SHA[name]![1]);
      expect(host.wat).toContain("(func $__jsstr_charCodeAt_trusted");
      expect(host.wat).not.toContain("(func $__jsstr_charCodeAt ");
      for (const options of [{ nativeStrings: true }, { target: "standalone" as const }, { target: "wasi" as const }]) {
        const native = await compile(source, { ...options, trackIrOutcomes: true });
        expect(native.success, `${name} ${JSON.stringify(options)}`).toBe(true);
        expect(native.wat).toContain("(func $__str_flatten");
        expect(native.wat).toContain("(func $__str_flat_charCodeAt");
        expect(native.wat).not.toContain("(func $__str_charCodeAt ");
      }
    }
  });
});

// --------------------------------------------------------------------------
// (d) the arms read the MANIFEST, not the lane
// --------------------------------------------------------------------------

const INTEGRATION_PATH = join(dirname(fileURLToPath(import.meta.url)), "../src/ir/integration.ts");

/**
 * A slice of `integration.ts` between two markers, comments stripped.
 *
 * A behavioural pin cannot separate the migrated arm from the one it replaced:
 * the policy projection reproduces the old truth table EXACTLY, so both forms
 * emit identical bytes on every lane — which is the point of the slice and the
 * reason all 65 byte cells are unchanged. What moved is WHICH authority
 * answers, and that is a source fact. This is the #2955 grep-gate idiom.
 */
function integrationSlice(startMarker: string, endMarker: string): string {
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

function instrArmSource(): string {
  return integrationSlice("symbol === IR_STRING_CHAR_CODE_AT_FN) {", "symbol === IR_STRING_ITERATOR_CHAR_AT_FN");
}

describe("#3526 F2-S7 the instr arm reads the frozen manifest", () => {
  it("consults the prepared charCodeAt provider", () => {
    expect(instrArmSource()).toContain("preparedStringCharCodeAtProvider(prepared)");
  });

  it("reads NO lane discriminator", () => {
    expect(instrArmSource()).not.toContain("nativeStrings");
  });

  it("keeps both materializers and never reaches through funcMap or a late import", () => {
    const source = instrArmSource();
    // The row's symbol is binding-aware and these are DEFINED helpers: a
    // `funcMap.get(arm.symbol)` would let a same-named user export steal the
    // call (#1072 — the #3520 preregistration pin), and `ensureLateImport`
    // would shift every defined funcidx.
    expect(source).toContain("ensureNativeCharCodeAtHelper(ctx)");
    expect(source).toContain("ensureHostCharCodeAtGuarded(ctx)");
    expect(source).not.toContain("funcMap");
    expect(source).not.toContain("ensureLateImport");
  });

  it("fails closed when the frozen row is missing", () => {
    const source = instrArmSource();
    expect(source).toContain("selection-preparation-mismatch");
    expect(source).toContain("charCodeAt has no frozen provider under the string-char-code-at policy");
  });

  it("counts BOTH producers in the demand scan", () => {
    const source = integrationSlice("function irStringCharCodeAtDemand(", "\n}\n");
    expect(source).toContain('instr.kind === "string.char_code_at"');
    expect(source).toContain("JSSTR_CHARCODEAT_FN");
    expect(source).toContain("NATIVE_CHARCODEAT_FN");
    // The proof-licensed symbols are a different, plan-time feature: counting
    // them would freeze a row for loops whose arms this slice does not govern.
    expect(source).not.toContain("JSSTR_CHARCODEAT_TRUSTED_FN");
    expect(source).not.toContain("NATIVE_FLAT_CHARCODEAT_FN");
  });

  it("partitions an unsupported charCodeAt policy owner-locally, naming the policy", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    expect(raw).toContain(
      'stringCharCodeAtPolicy.charCodeAt === "unsupported" && irStringCharCodeAtDemand([entry.fn])',
    );
    expect(raw).toContain("charCodeAt has no provider under string-char-code-at policy ");
  });
});

// --------------------------------------------------------------------------
// (e) sub-B — the string.char_code_at emitter has ONE authority
// --------------------------------------------------------------------------

function lowerResolver(): IrLowerResolver {
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => 0,
    resolveType: () => 3,
    resolveString: () => ({ kind: "ref", typeIdx: 3 }),
  } as unknown as IrLowerResolver;
}

describe("#3526 F2-S7 string.char_code_at has ONE emit authority", () => {
  it("refuses to lower an unattached string.char_code_at instead of re-deciding the lane", () => {
    // Honest scope, the F2-S3/F2-S4 disclosure repeated because it applies
    // verbatim: this pin holds on BOTH trees. A hand-built resolver carries no
    // string runtime, so the emitter refuses one frame earlier with its own
    // "runtime is unavailable" message and the retired fallback is never
    // reached — the alternation below says so rather than hiding it. The
    // DISCRIMINATOR for sub-B is the source-shape pin below.
    expect(() => lowerIrFunctionToWasm(charCodeAtFunction("unattached"), lowerResolver())).toThrowError(
      /string\.char_code_at (has no prepared runtime provider|runtime is unavailable)/,
    );
  });

  it("accepts an already-attached provider, so the guard is not a blanket refusal", () => {
    let message = "";
    try {
      lowerIrFunctionToWasm(charCodeAtFunction("attached", true), lowerResolver());
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).not.toMatch(/has no prepared runtime provider/);
  });

  it("keeps the retired fallback's lane read and both materializers out of the emitter", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    const start = raw.indexOf("emitStringCharCodeAt(_inputEncoding, provider): readonly Instr[] {");
    expect(start, "the WasmGC emitStringCharCodeAt adapter must exist").toBeGreaterThan(-1);
    const end = raw.slice(start).indexOf("\n    // ---");
    expect(end, "the adapter must be followed by the next section banner").toBeGreaterThan(-1);
    const body = raw
      .slice(start, start + end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(body).not.toContain("ctx.nativeStrings");
    expect(body).not.toContain("ensureNativeCharCodeAtHelper");
    expect(body).not.toContain("ensureHostCharCodeAtGuarded");
    expect(body).toContain("string.char_code_at has no prepared runtime provider");
  });
});

// --------------------------------------------------------------------------
// (f) the PLAN path verifies rather than re-decides
// --------------------------------------------------------------------------
//
// These are source-text pins, not a behavioural fence, and that is a measured
// decision (probe P6): no entry point lets a test inject a manifest policy into
// `resolveFunc`. The policy is derived from `ctx` inside `compile()`, and the
// only two adapters that pass one — the linear backend and the self-hosted
// stdlib — pass DISABLED with no demand, so plan-time symbol and frozen row can
// never disagree from outside. The family's one existing mismatch pin
// (eq.test.ts) and F2-S4's partition/verify pins are source-text for exactly
// the same reason.

describe("#3526 F2-S7 the plan path verifies against the frozen row", () => {
  function planArmSource(symbolConst: string, endMarker: string): string {
    return integrationSlice(`symbol === ${symbolConst}) {`, endMarker);
  }

  it("verifies the host plan symbol and keeps its materializer", () => {
    const source = planArmSource("JSSTR_CHARCODEAT_FN", "symbol === JSSTR_SUBSTRING_FN");
    expect(source).toContain("preparedStringCharCodeAtProvider(prepared)");
    expect(source).toContain("arm.symbol !== symbol");
    expect(source).toContain("selection-preparation-mismatch");
    expect(source).toContain("plan-time charCodeAt symbol disagrees with the frozen string-char-code-at row");
    expect(source).toContain("ensureHostCharCodeAtGuarded(ctx)");
  });

  it("verifies the native plan symbol and keeps its materializer", () => {
    const source = planArmSource("NATIVE_CHARCODEAT_FN", "NATIVE_FLATTEN_FN");
    expect(source).toContain("preparedStringCharCodeAtProvider(prepared)");
    expect(source).toContain("arm.symbol !== symbol");
    expect(source).toContain("selection-preparation-mismatch");
    expect(source).toContain("ensureNativeCharCodeAtHelper(ctx)");
  });

  it("leaves the plan-time decision and the proof-licensed arms untouched", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    // `stringMethodPlan` still bakes the lane into the symbol — this slice
    // VERIFIES that decision, it does not move it (named as a later slice).
    expect(raw).toContain('funcName: native ? "__str_charCodeAt" : "__jsstr_charCodeAt"');
    // The trusted / hoist arms still read their own plan-time evidence.
    expect(raw).toContain("index = ensureHostCharCodeAtTrusted(ctx);");
    expect(raw).toContain("ensureNativeFlatCharCodeAtHelper(ctx)");
  });
});
