// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F2-S6 — the BATCHED many-arity string concatenation seam moves under
// manifest authority.
//
// The seam is the `batchStringConcat` pass and the two resolve arms that lower
// what it fuses: a single-use immutable `+` tree of three or more leaves
// becomes ONE call on the free-form symbol `string.concat$arityN` (or the fixed
// `async.string.concat$arity5` the prepared final main emits), lowered to
// `env.__concat_N` on the host lane and `__str_concat_N` on the native one.
//
// Three facts force this slice's shape, and each is a measured one:
//
//  * **The pass CREATES the demand.** Every family-2 predecessor scanned for a
//    demand and then froze; here there is nothing to scan until the pass has
//    run. So the pass gets a frozen decision of its own — `stringConcatMany`,
//    `{ batch: "host" | "native" | "off" }` — projected from the lane BEFORE it
//    runs, and the arity demand is scanned AFTER, off the batched IR.
//
//  * **`batch` is not the provider selector.** The two resolve arms read
//    `ctx.nativeStrings` alone today, i.e. exactly F2-S5's `stringConcat`
//    policy, and they are reachable independently of whether the pass ran —
//    the async5 producer is source-shape-driven and consults no lane flag. So
//    the provider ROW is selected by `stringConcat.concat`; `batch` only
//    decides whether a demand exists. A cross-policy rule refuses a hand-built
//    pair where the two disagree.
//
//  * **The capability is a FAMILY.** `env.__concat_3` … `env.__concat_9` differ
//    only in arity and the field is derived from it, so the record fixes the
//    derivation rule — a new `func-family` kind with an `arity-suffix` field
//    scheme and repeat-params — rather than a name.
//
// Acceptance is BYTE IDENTITY: 85/85 cells of the census matrix (84 grid cells
// plus the wasi edge cell) came back identical, batching cells included.
//
// Not moved, deliberately: the legacy twins (`compileBatchedConcat` and the
// native `string-ops.ts` twin) still mint `__concat_N` / `__str_concat_N` on
// DEMOTED functions on every lane, `batch: "off"` included — the policy
// describes the IR pipeline, not the module. Also out: `charCodeAt`,
// `string.const`, and unifying the async5 symbol into the family.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult } from "../src/index.js";
import { generateModule } from "../src/codegen/index.js";
import { ASYNC_HOST_CAPABILITY_RECORDS } from "../src/ir/async-runtime-providers.js";
import { prepareIrRuntimeManifest, preparedStringConcatManyProvider } from "../src/ir/intrinsic-support.js";
import { asBlockId, asValueId, irVal, type IrFunction, type IrInstr, type IrType } from "../src/ir/nodes.js";
import { irIntrinsicFuncRef } from "../src/ir/callable-bindings.js";
import {
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  RUNTIME_PROVIDERS,
  STRING_CONCAT_MANY_NATIVE_ARITY,
  STRING_CONCAT_MANY_POLICY_DISABLED,
  STRING_CONCAT_MANY_RUNTIME_FEATURES,
  STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS,
  stringConcatManyArityCap,
  type RuntimeManifestPolicy,
  type RuntimeProviderDefinition,
  type StringConcatManyPolicy,
  type StringConcatPolicy,
} from "../src/ir/runtime-manifest.js";
import {
  asCallableRuntimeHostCapabilityRecord,
  isRuntimeHostCapabilityFuncFamilyId,
  isRuntimeHostCapabilityFuncId,
  resolveRuntimeHostCapabilityFuncFamilyRecord,
  resolveRuntimeHostCapabilityFuncRecord,
  resolveRuntimeHostCapabilityRecord,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type RuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { IR_ASYNC_STRING_CONCAT_5_FN } from "../src/ir/async-semantic-runtime.js";
import { irStringConcatManySymbol } from "../src/ir/string-runtime.js";
import type { WasmModule } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-string-boundary-concat-many");
const STRING: IrType = { kind: "string" };
const FEATURE = STRING_CONCAT_MANY_RUNTIME_FEATURES[0];

const HOST_CONCAT: StringConcatPolicy = { concat: "host" };
const NATIVE_CONCAT: StringConcatPolicy = { concat: "native" };

const sha12 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 12);

/** The census fixtures, verbatim — the BEFORE bytes below were measured on these. */
const CAT3 = `export function cat3(a: string, b: string, c: string): string { return a + b + c; }`;
const CAT9 = `export function cat9(a: string, b: string, c: string, d: string, e: string, f: string, g: string, h: string, i: string): string { return a + b + c + d + e + f + g + h + i; }`;
const TPL6 = "export function tpl6(a: string, b: string, c: string): string { return `x${a}-${b}-${c}!`; }";
const TPLEQ = 'export function tpleq(a: string): boolean { return `${a}!` === "hi!"; }';
const CATNUM3 = `export function cn3(a: string, n: number, b: string): string { return a + n + b; }`;
const CAT = `export function cat(a: string, b: string): string { return a + b; }`;
const MULTIUSE = `export function multi(a: string, b: string, c: string): string { const t = a + b + c; return t + t; }`;

function policy(over: Partial<RuntimeManifestPolicy> = {}): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", ...over };
}

/**
 * One hand-built owner carrying the exact fused `call` the pass mints. It is a
 * `call` on a free-form intrinsic SYMBOL and not an `intrinsic` instruction —
 * which is why the demand has to be requested at freeze from a symbol scan.
 */
function fusedFunction(name: string, arity: number, symbol = irStringConcatManySymbol(arity)): IrFunction {
  const args = Array.from({ length: arity }, (_unused, index) => asValueId(index));
  const instr: IrInstr = {
    kind: "call",
    target: irIntrinsicFuncRef(symbol),
    args,
    result: asValueId(arity),
    resultType: STRING,
  } as unknown as IrInstr;
  return {
    unitId: identities.next(name).unitId,
    name,
    params: args.map((value, index) => ({ name: `p${index}`, type: STRING, value })),
    resultTypes: [STRING],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [instr],
        terminator: { kind: "return", values: [asValueId(arity)] },
      },
    ],
    exported: false,
    valueCount: arity + 1,
    funcKind: "regular",
  } as unknown as IrFunction;
}

function prepare(stringConcat: StringConcatPolicy, arities: readonly number[], fn?: IrFunction) {
  const prepared = prepareIrRuntimeManifest({
    functions: [fn ?? fusedFunction("fused", arities[0] ?? 3)],
    sourceFile: "/repo/string-concat-many.ts",
    policy: policy({ stringConcat }),
    stringConcatManyDemand: { arities },
  });
  if (!prepared) throw new Error("expected a non-empty runtime manifest");
  return prepared;
}

function rowOf(id: (typeof STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS)[number]): RuntimeProviderDefinition {
  const found = (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).find((entry) => entry.id === id);
  if (!found) throw new Error(`no provider row ${id}`);
  return found;
}

function familyRecord(): Extract<RuntimeHostCapabilityRecord, { kind: "func-family" }> {
  const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.concat.many");
  if (record.kind !== "func-family") throw new Error("string.concat.many is not a family record");
  return record;
}

function hostLaneModule(source: string, options: Parameters<typeof generateModule>[1] = {}): WasmModule {
  return generateModule(analyzeSource(source, "issue-3526-f2s6-concat-many.ts"), { experimentalIR: true, ...options })
    .module;
}

function orderedFuncImports(module: WasmModule): string[] {
  return module.imports.filter((entry) => entry.desc.kind === "func").map((entry) => `${entry.module}.${entry.name}`);
}

async function instantiate(result: CompileResult): Promise<Record<string, (...args: never[]) => unknown>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, (...args: never[]) => unknown>;
}

// --------------------------------------------------------------------------
// (a) contract — one feature, two family rows, no signature anywhere
// --------------------------------------------------------------------------

describe("#3526 F2-S6 batched many-arity concat contract", () => {
  it("adds ONE feature for an unbounded family of arities", () => {
    expect([...STRING_CONCAT_MANY_RUNTIME_FEATURES]).toEqual(["js.string.concat.many"]);
    // The arity is a property of the CALL, not of the crossing: a module that
    // fuses a 3-leaf and a 7-leaf tree needs one authority twice, not two.
    expect([...STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS]).toEqual([
      "host.js.string.concat.many",
      "native.js.string.concat.many",
    ]);
  });

  it("carries NO signature on either row, and registers no feature signature", () => {
    // `IntrinsicSignature` is fixed-arity while this family is not, and the
    // symbols it answers are free-form rather than closed `IntrinsicId`s. The
    // record's params SCHEME plus the native row's range are the whole shape
    // statement — and because the host arm derives its import's params from the
    // record, the record IS the checked contract.
    for (const id of STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS) {
      const row = rowOf(id);
      expect(row.signature).toBeUndefined();
      expect(Object.keys(row)).not.toContain("signature");
      expect(row.feature).toBe(FEATURE);
    }
  });

  it("names the family capability from the host row, and only from there", () => {
    const host = rowOf("host.js.string.concat.many");
    expect(host.implementation).toEqual({ kind: "host-callable-family", capability: "string.concat.many" });
    expect(host.hostCapabilities).toEqual(["string.concat.many"]);
    // The id is spellable ONLY on the family half. A plain `host-callable`
    // naming it is a compile error, which is the whole reason for a third list.
    expect(isRuntimeHostCapabilityFuncFamilyId("string.concat.many")).toBe(true);
    expect(isRuntimeHostCapabilityFuncId("string.concat.many")).toBe(false);
    // @ts-expect-error a family id is not a `host-callable` capability
    const illegal: RuntimeProviderDefinition["implementation"] = {
      kind: "host-callable",
      capability: "string.concat.many",
    };
    expect(illegal.kind).toBe("host-callable");
  });

  it("describes the host crossing as a DERIVATION RULE, not a name", () => {
    const record = familyRecord();
    expect(record).toEqual({
      capability: "string.concat.many",
      module: "env",
      field: { scheme: "arity-suffix", prefix: "__concat_" },
      kind: "func-family",
      params: { repeat: "externref", min: 3, max: null },
      results: ["externref"],
    });
    // `max: null` is the measured host fact: the JS provider matches the
    // `__concat_` prefix and answers any N (the census observed `__concat_9`).
    expect(record.params.max).toBeNull();
  });

  it("synthesizes the concrete row from the family record and an arity", () => {
    const row = resolveRuntimeHostCapabilityFuncFamilyRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.concat.many", 7);
    expect(row).toEqual({
      module: "env",
      field: "__concat_7",
      params: ["externref", "externref", "externref", "externref", "externref", "externref", "externref"],
      results: ["externref"],
    });
    // The floor is the producer's own: `batchStringConcat` never fuses fewer
    // than three leaves, and `irStringConcatManySymbol` throws below three.
    expect(() =>
      resolveRuntimeHostCapabilityFuncFamilyRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.concat.many", 2),
    ).toThrowError(/does not cover arity 2/);
  });

  it("refuses a family record where a concrete callable row is required", () => {
    // The plain resolver's parameter type already rejects the family id; this
    // is its runtime twin, for catalogues arriving through an `unknown` edge.
    expect(() =>
      resolveRuntimeHostCapabilityFuncRecord(
        RUNTIME_HOST_CAPABILITY_RECORDS,
        "string.concat.many" as never as "string.concat",
      ),
    ).toThrowError(/is not a callable host capability/);
    expect(() => asCallableRuntimeHostCapabilityRecord(familyRecord())).toThrowError(
      /is not a callable host capability/,
    );
  });

  it("keeps the family rows out of the async projection and out of admitted callable targets", () => {
    expect(ASYNC_HOST_CAPABILITY_RECORDS.map((entry) => entry.capability)).not.toContain("string.concat.many");
    // `ADMITTED_CALLABLE_TARGETS` is built from `host-callable`/`runtime-callable`
    // rows only, and it keys on `IntrinsicId`; the family answers a free-form
    // symbol, so nothing may map it to an import before the resolve arm.
    // Both guards are asserted through their observable consequence: no
    // intrinsic definition claims this feature.
    const intrinsicCarriers = (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).filter(
      (row) => row.feature === FEATURE && row.signature !== undefined,
    );
    expect(intrinsicCarriers).toEqual([]);
  });

  it("keeps the native arity range in ONE place, read by the pass cap and by codegen", () => {
    const native = rowOf("native.js.string.concat.many");
    expect(native.implementation).toEqual({
      kind: "runtime-callable-family",
      symbolPrefix: "__str_concat_",
      arity: { min: 3, max: 8 },
    });
    expect(native.hostCapabilities).toEqual([]);
    expect(STRING_CONCAT_MANY_NATIVE_ARITY).toEqual({ min: 3, max: 8 });
    // The pass ceiling is DERIVED from the rows, not copied beside them.
    expect(stringConcatManyArityCap("native")).toBe(8);
    expect(stringConcatManyArityCap("host")).toBe(Number.POSITIVE_INFINITY);
    // And `native-batched-concat.ts` imports the bound rather than restating
    // it — the literal `8` that used to live there (and a third copy at the
    // pass call site) is gone.
    const nativeConcatSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/codegen/native-batched-concat.ts"),
      "utf8",
    );
    expect(nativeConcatSource).toContain("STRING_CONCAT_MANY_NATIVE_ARITY.max");
    expect(nativeConcatSource).not.toMatch(/MAX_BATCHED_CONCAT_ARITY\s*=\s*8/);
  });
});

// --------------------------------------------------------------------------
// (b) policy — the projection table, the cross-policy rule, the demand
// --------------------------------------------------------------------------

const BATCH_LANES: ReadonlyArray<readonly [string, Parameters<typeof compile>[1], StringConcatManyPolicy["batch"]]> = [
  ["gc-host", {}, "host"],
  ["gc-native-strings", { nativeStrings: true }, "off"],
  ["standalone", { target: "standalone" }, "native"],
  ["wasi", { target: "wasi" }, "off"],
  ["gc-strict", { strictNoHostImports: true }, "off"],
  // The EDGE cell. `nativeStrings: false` is an accepted override on target
  // wasi, and with `strictNoHostImports: false` too the module compiles on the
  // host string backend — only the projection's wasi term keeps the pass off
  // there. Measured: 1000 bytes, pairwise `wasm:js-string.concat`.
  ["wasi-host-strings", { target: "wasi", nativeStrings: false, strictNoHostImports: false }, "off"],
];

describe("#3526 F2-S6 batch policy", () => {
  it("projects the two selector predicates verbatim, wasi term included", async () => {
    for (const [lane, options, batch] of BATCH_LANES) {
      const result = await compile(CAT3, { ...options, trackIrOutcomes: true });
      expect(result.success, lane).toBe(true);
      const wat = result.wat ?? "";
      if (batch === "host") expect(wat, lane).toContain("__concat_3");
      if (batch === "native") expect(wat, lane).toContain("__str_concat_3");
      if (batch === "off") expect(wat, lane).not.toContain("__concat_3");
    }
  });

  it("keeps the wasi EDGE cell on the pairwise arm — the wasi term is live, not redundant", async () => {
    const result = await compile(CAT3, { target: "wasi", nativeStrings: false, strictNoHostImports: false });
    expect(result.success).toBe(true);
    expect(result.binary.length).toBe(1000);
    expect(result.wat).toContain("wasm:js-string");
    expect(result.wat).not.toContain("__concat_");
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    expect(builder.freeze().policy.stringConcatMany).toEqual(STRING_CONCAT_MANY_POLICY_DISABLED);
    expect(STRING_CONCAT_MANY_POLICY_DISABLED).toEqual({ batch: "off" });
  });

  it("selects the ROW by the concatenation policy, not by the batch policy", () => {
    // The two arms are reachable independently of whether the pass ran, so the
    // authority question is the concatenation policy's — this is the fact that
    // makes the async5 arm safe on a lane where `batch` is `off`.
    expect(preparedStringConcatManyProvider(prepare(HOST_CONCAT, [3]), 3)).toEqual({
      arm: "host",
      module: "env",
      field: "__concat_3",
      params: ["externref", "externref", "externref"],
      results: ["externref"],
    });
    expect(preparedStringConcatManyProvider(prepare(NATIVE_CONCAT, [5]), 5)).toEqual({
      arm: "native",
      symbol: "__str_concat_5",
    });
  });

  it("refuses a hand-built policy whose batch authority disagrees with the concat authority", () => {
    // Unreachable from the integration projections — `concat` is
    // `nativeStrings ? native : host` and `batch` is `native` only under
    // `nativeStrings`, `host` only under `!nativeStrings` — so this rule exists
    // for hand-built policies, which is exactly where a wrong pair would
    // otherwise reach lowering unchallenged.
    expect(
      () => new RuntimeManifestBuilder(policy({ stringConcat: NATIVE_CONCAT, stringConcatMany: { batch: "host" } })),
    ).toThrowError(expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }));
    // `off` never disagrees: it says the pass did not run, not who answers.
    expect(
      () => new RuntimeManifestBuilder(policy({ stringConcat: NATIVE_CONCAT, stringConcatMany: { batch: "off" } })),
    ).not.toThrow();
  });

  it("refuses the arm its caller resolved to unsupported, naming the policy and the family", () => {
    const builder = new RuntimeManifestBuilder(policy({ stringConcat: { concat: "unsupported" } }));
    builder.requestFeature(FEATURE);
    expect(() => builder.freeze()).toThrowError(
      /runtime feature js\.string\.concat\.many is unavailable under string-concat policy concat=unsupported \(many-arity family\)/,
    );
  });

  it("freezes no family row when nothing fuses", async () => {
    // CAT has two leaves and MULTIUSE's temporary is used twice, so neither
    // reaches the pass — and a module with no fused root must not carry a row
    // nothing will ever call.
    for (const source of [CAT, MULTIUSE]) {
      const result = await compile(source, { trackIrOutcomes: true });
      expect(result.success).toBe(true);
      expect(result.wat).not.toContain("__concat_");
    }
    expect(
      prepareIrRuntimeManifest({
        functions: [fusedFunction("none", 3)],
        sourceFile: "/repo/none.ts",
        policy: policy({ stringConcat: HOST_CONCAT }),
        stringConcatManyDemand: { arities: [] },
      }),
    ).toBeUndefined();
  });

  it("freezes exactly the one family feature for a fused module", () => {
    const prepared = prepare(HOST_CONCAT, [3, 7]);
    expect(prepared.manifest.features).toEqual([FEATURE]);
    expect(prepared.manifest.providers.map((row) => row.id)).toEqual(["host.js.string.concat.many"]);
    expect(prepared.manifest.hostCapabilities).toEqual(["string.concat.many"]);
    // ONE frozen row answers BOTH arities.
    expect(preparedStringConcatManyProvider(prepared, 3)?.arm).toBe("host");
    expect(preparedStringConcatManyProvider(prepared, 7)).toMatchObject({ field: "__concat_7" });
  });
});

// --------------------------------------------------------------------------
// (c) end-to-end — the census's BEFORE bytes, unchanged
// --------------------------------------------------------------------------

describe("#3526 F2-S6 end-to-end behaviour is unchanged", () => {
  it("reproduces the census's gc-host bytes for every batching shape", async () => {
    // Measured on this lane's own base (85/85 cells identical to the census
    // record). CAT3 is deliberately the same cell F2-S5's fence pins, so a red
    // here is attributable to whichever slice landed last.
    for (const [source, bytes, sha, imports] of [
      [CAT3, 149, "4677a84a2dcd", ["env.__concat_3"]],
      [CAT9, 167, "c11957fc8004", ["env.__concat_9"]],
      [TPL6, 235, "1d7f766908cf", ["env.__concat_7"]],
      [TPLEQ, 246, "7e6dac42d3c7", ["wasm:js-string.equals", "env.__concat_3"]],
      // The legacy-twin control: `a + n + b` demotes on
      // `operand-coercion-unsupported`, so `compileBatchedConcat` — NOT the IR
      // arm — mints `__concat_3`, after `number_toString`. This slice does not
      // govern that producer and the cell proves it did not move.
      [CATNUM3, 199, "a4af808e0009", ["env.number_toString", "env.__concat_3"]],
    ] as const) {
      const result = await compile(source, { trackIrOutcomes: true });
      expect(result.success).toBe(true);
      expect(result.binary.length, source.slice(0, 30)).toBe(bytes);
      expect(sha12(result.binary), source.slice(0, 30)).toBe(sha);
      // Import POSITION is the byte-identity lever here, not funcidx: the host
      // arm mints late, so `__concat_N` lands after every earlier import.
      expect(orderedFuncImports(hostLaneModule(source))).toEqual([...imports]);
    }
  });

  it("keeps the async five-part arm on the host lane, in its measured position", async () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../website/playground/examples/js/async.ts"),
      "utf8",
    );
    const result = await compile(source, {
      trackIrOutcomes: true,
      fileName: "website/playground/examples/js/async.ts",
    });
    expect(result.success).toBe(true);
    expect(result.binary.length).toBe(10021);
    expect(sha12(result.binary)).toBe("3c072b5822b4");
    // Minted inside an already-open late-import batch, at index 21 of 27.
    // This fixture's imports are all `env` func imports, so the compile
    // result's own ordered descriptor list IS the import section here.
    const imports = result.imports.filter((entry) => entry.kind === "func").map((entry) => entry.name);
    expect(imports).toHaveLength(27);
    expect(imports[21]).toBe("__concat_5");
  });

  it("keeps the standalone lane on the native helper family, capped at eight", async () => {
    // Pinned STRUCTURALLY, not by sha: a standalone module carries the whole
    // native-strings runtime, so a byte pin there would go red on any unrelated
    // runtime edit.
    for (const [source, helper] of [
      [CAT3, "$__str_concat_3"],
      [TPL6, "$__str_concat_7"],
    ] as const) {
      const result = await compile(source, { target: "standalone", trackIrOutcomes: true });
      expect(result.success).toBe(true);
      expect(result.wat).toContain(helper);
    }
    // Nine leaves exceed the native family's ceiling, so the tree stays
    // pairwise rather than requesting a helper that does not exist.
    const nine = await compile(CAT9, { target: "standalone", trackIrOutcomes: true });
    expect(nine.success).toBe(true);
    expect(nine.wat).not.toContain("__str_concat_9");
    expect(nine.wat).toContain("$__str_concat");
  });

  it("answers batched chains and templates exactly as JavaScript does — host lane", async () => {
    const source = `export function three(a: string, b: string, c: string): string { return a + b + c; }
export function six(a: string, b: string, c: string, d: string, e: string, f: string): string { return a + b + c + d + e + f; }
export function nine(a: string, b: string, c: string, d: string, e: string, f: string, g: string, h: string, i: string): string { return a + b + c + d + e + f + g + h + i; }
export function tpl(a: string, b: string, c: string): string { return \`x\${a}-\${b}-\${c}!\`; }`;
    const result = await compile(source, { trackIrOutcomes: true });
    expect(result.success).toBe(true);
    const exports = await instantiate(result);
    // Empty leaves, lone surrogate halves, non-ASCII BMP and astral, and a
    // numeric-looking leaf — the shapes a length-summing helper is most likely
    // to get wrong.
    const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["three", ["", "\uD800", "42"]],
      ["three", ["ä", "", "\uDC00"]],
      ["six", ["", "a", "", "é", "0", "😀"]],
      ["nine", ["1", "2", "3", "", "中", "\uD800", "\uDFFF", "x", "9"]],
      ["tpl", ["", "é", "7"]],
    ];
    for (const [name, args] of cases) {
      const expected = name === "tpl" ? `x${args[0]}-${args[1]}-${args[2]}!` : args.join("");
      expect((exports[name] as (...rest: never[]) => string)(...(args as readonly never[]))).toBe(expected);
    }
  });

  it("answers batched chains and templates exactly as JavaScript does — native-strings lane", async () => {
    // A native-strings module's string params and results are `(ref $AnyString)`
    // carriers, which cannot cross the JS boundary — so the chain is built from
    // literals INSIDE the module and only its UTF-16 code-unit length comes
    // back. That still exercises the batched helper end to end: the helper sums
    // the operand lengths and copies each one, which is exactly what a wrong
    // answer would corrupt.
    const source = `const A = "";
const B = "\uD800";
const C = "42";
const D = "é";
const E = "😀";
export function three(): number { return (A + B + C).length; }
export function six(): number { return (A + B + C + D + E + "x").length; }
export function nine(): number { return (A + B + C + D + E + "x" + "yy" + "" + "zzz").length; }
export function tpl(): number { return \`x\${A}-\${D}-\${C}!\`.length; }`;
    const result = await compile(source, { nativeStrings: true, trackIrOutcomes: true });
    expect(result.success).toBe(true);
    const exports = await instantiate(result);
    const a = "";
    const b = "\uD800";
    const c = "42";
    const d = "é";
    const e = "😀";
    expect((exports.three as () => number)()).toBe((a + b + c).length);
    expect((exports.six as () => number)()).toBe((a + b + c + d + e + "x").length);
    expect((exports.nine as () => number)()).toBe((a + b + c + d + e + "x" + "yy" + "" + "zzz").length);
    expect((exports.tpl as () => number)()).toBe(`x${a}-${d}-${c}!`.length);
  });
});

// --------------------------------------------------------------------------
// (d) source pins — the lane reads are gone, the late mint stays
// --------------------------------------------------------------------------

const INTEGRATION_PATH = join(dirname(fileURLToPath(import.meta.url)), "../src/ir/integration.ts");

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The fusion-pass selection, from the anchor comment to the verify call. */
function batchSelectionSource(): string {
  const raw = readFileSync(INTEGRATION_PATH, "utf8");
  const start = raw.indexOf("      const batched =");
  expect(start, "the batch selection must exist").toBeGreaterThan(-1);
  const rest = raw.slice(start);
  const end = rest.indexOf("const verifyErrors");
  expect(end, "the selection must be followed by the verifier call").toBeGreaterThan(-1);
  return stripComments(rest.slice(0, end));
}

/** The single lowering both family arms delegate to. */
function batchedConcatArmSource(): string {
  const raw = readFileSync(INTEGRATION_PATH, "utf8");
  const start = raw.indexOf("function batchedConcatProviderIndex(");
  expect(start, "the shared family lowering must exist").toBeGreaterThan(-1);
  const rest = raw.slice(start);
  const end = rest.indexOf("\nfunction resolveAndObserveCallableProvider(");
  expect(end, "the lowering must be followed by the resolve table").toBeGreaterThan(-1);
  return stripComments(rest.slice(0, end));
}

describe("#3526 F2-S6 the pass and the arms read the frozen manifest", () => {
  it("selects the fusion pass from the frozen policy, with no lane read and no literal cap", () => {
    const selection = batchSelectionSource();
    expect(selection).toContain("batchPolicy.batch");
    expect(selection).toContain("stringConcatManyArityCap(");
    for (const flag of ["nativeStrings", "standalone", "wasi", "strictNoHostImports"]) {
      expect(selection, flag).not.toContain(flag);
    }
    // The hand-copied native ceiling is gone; the row is the authority.
    expect(selection).not.toMatch(/,\s*8\)/);
  });

  it("resolves both family symbols through the prepared provider, with no lane read", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    // Both arms keep their conditions and both delegate to one lowering.
    expect(raw).toContain("symbol === IR_ASYNC_STRING_CONCAT_5_FN");
    expect(raw).toContain("parseIrStringConcatManyArity(symbol) !== null");
    expect(raw).toContain("batchedConcatProviderIndex(ctx, prepared, 5)");
    const arm = batchedConcatArmSource();
    expect(arm).toContain("preparedStringConcatManyProvider(");
    expect(arm).not.toContain("nativeStrings");
  });

  it("fails closed rather than falling back to a locally decided symbol", () => {
    const arm = batchedConcatArmSource();
    expect(arm).toContain("selection-preparation-mismatch");
    // No `??` fallback and no second authority: an owner that reaches lowering
    // with no frozen family row must throw, not mint from a lane read.
    expect(arm).not.toContain("??");
    expect(arm).not.toContain("funcMap");
  });

  it("keeps LATE minting — it is the contract, not an implementation detail", () => {
    // The emitted bytes depend on the import's POSITION (`__concat_5` at index
    // 21 of 27 on the async fixture), so a freeze-time registration would move
    // every batching cell by design.
    const arm = batchedConcatArmSource();
    expect(arm).toContain("ensureLateImport(");
    expect(arm).toContain("ensureNativeBatchedConcat(ctx, arity)");
    expect(arm).toContain("arm.field");
    expect(arm).toContain("arm.module");
  });

  it("partitions an unsupported concat policy owner-locally, naming the policy", () => {
    const raw = readFileSync(INTEGRATION_PATH, "utf8");
    expect(raw).toContain("ir/integration: batched string concatenation has no provider under string-concat policy ");
  });
});

// --------------------------------------------------------------------------
// (e) fail-closed — an unfrozen family, and an out-of-range native arity
// --------------------------------------------------------------------------

describe("#3526 F2-S6 the arms fail closed", () => {
  it("throws rather than re-deciding the lane when no family row is frozen", () => {
    // A prepared manifest that froze some OTHER feature carries no family row.
    const prepared = prepareIrRuntimeManifest({
      functions: [fusedFunction("other", 3)],
      sourceFile: "/repo/other.ts",
      policy: policy({ stringConcat: HOST_CONCAT }),
      stringConcatDemand: { immutable: true, owned: false },
    });
    expect(prepared).toBeDefined();
    expect(preparedStringConcatManyProvider(prepared, 3)).toBeUndefined();
    expect(preparedStringConcatManyProvider(undefined, 3)).toBeUndefined();
  });

  it("refuses an arity the native family does not cover", () => {
    expect(() => preparedStringConcatManyProvider(prepare(NATIVE_CONCAT, [8]), 9)).toThrowError(
      /IR string-concat-many provider native\.js\.string\.concat\.many does not cover arity 9/,
    );
    expect(() => preparedStringConcatManyProvider(prepare(NATIVE_CONCAT, [3]), 2)).toThrowError(
      /does not cover arity 2/,
    );
    // The HOST family is unbounded above, so a large arity resolves.
    expect(preparedStringConcatManyProvider(prepare(HOST_CONCAT, [12]), 12)).toMatchObject({ field: "__concat_12" });
  });

  it("covers the async5 symbol through the same row as the pass's symbols", () => {
    const prepared = prepare(HOST_CONCAT, [5], fusedFunction("async5", 5, IR_ASYNC_STRING_CONCAT_5_FN));
    expect(prepared.manifest.features).toEqual([FEATURE]);
    expect(preparedStringConcatManyProvider(prepared, 5)).toMatchObject({ field: "__concat_5" });
  });
});

// --------------------------------------------------------------------------
// (f) validation — the two family kinds are closed at the type and the runtime
// --------------------------------------------------------------------------

describe("#3526 F2-S6 family rows are validated", () => {
  function freezeWith(implementation: RuntimeProviderDefinition["implementation"]) {
    const rows = (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).map((row) =>
      row.id === "host.js.string.concat.many" ? { ...row, implementation } : row,
    );
    return () => {
      const builder = new RuntimeManifestBuilder(policy({ stringConcat: HOST_CONCAT }), { providers: rows });
      builder.requestFeature(FEATURE);
      builder.freeze();
    };
  }

  it("refuses a host-callable-family naming a non-family capability", () => {
    expect(freezeWith({ kind: "host-callable-family", capability: "string.concat" as never })).toThrowError(
      /host-callable-family provider .* names non-family host capability string\.concat/,
    );
  });

  it("refuses a runtime-callable-family that requests a host capability", () => {
    const rows = (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).map((row) =>
      row.id === "native.js.string.concat.many" ? { ...row, hostCapabilities: ["string.concat.many"] as const } : row,
    );
    expect(() => {
      const builder = new RuntimeManifestBuilder(policy({ stringConcat: NATIVE_CONCAT }), { providers: rows });
      builder.requestFeature(FEATURE);
      builder.freeze();
    }).toThrowError(/runtime-callable-family provider .* cannot request concrete host capabilities/);
  });

  it("refuses a family whose arity range is empty, inverted or below the fusion floor", () => {
    for (const [arity, pattern] of [
      [{ min: 2, max: 8 }, /invalid minimum arity 2/],
      [{ min: 3, max: 2 }, /invalid maximum arity 2/],
      [{ min: 3, max: 8.5 }, /invalid maximum arity 8\.5/],
    ] as const) {
      const rows = (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).map((row) =>
        row.id === "native.js.string.concat.many"
          ? {
              ...row,
              implementation: { kind: "runtime-callable-family" as const, symbolPrefix: "__str_concat_", arity },
            }
          : row,
      );
      expect(() => {
        const builder = new RuntimeManifestBuilder(policy({ stringConcat: NATIVE_CONCAT }), { providers: rows });
        builder.requestFeature(FEATURE);
        builder.freeze();
      }).toThrowError(pattern);
    }
  });

  it("refuses a family record with an unknown scheme, an empty prefix, or a floor below three", () => {
    const record = familyRecord();
    for (const [update, pattern] of [
      [{ field: { scheme: "literal", prefix: "__concat_" } }, /unknown host capability .* field scheme literal/],
      [{ field: { scheme: "arity-suffix", prefix: "" } }, /field prefix .* does not match/],
      [{ params: { repeat: "externref", min: 2, max: null } }, /params min 2 is below the 3-operand floor/],
    ] as const) {
      const catalogue = RUNTIME_HOST_CAPABILITY_RECORDS.map((entry) =>
        entry.capability === "string.concat.many" ? { ...record, ...update } : entry,
      ) as readonly RuntimeHostCapabilityRecord[];
      expect(() => {
        const builder = new RuntimeManifestBuilder(policy(), { hostCapabilityRecords: catalogue });
        builder.requestFeature("math.sqrt");
        builder.freeze();
      }).toThrowError(pattern);
    }
  });
});
