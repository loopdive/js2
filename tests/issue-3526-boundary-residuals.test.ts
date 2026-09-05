// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F1-S4 — the boundary residuals.
//
// Two of the plan's three sub-migrations landed; the third did not, and the
// reason is pinned here rather than left in prose:
//
//  * **sub-B** migrates `__extern_is_undefined` — the LAST surviving pre-F1
//    two-armed shape in from-ast, where the front-end chose between the `env`
//    host import and the host-free Wasm function by reading the
//    `externIsUndefinedIsNative` resolver predicate. That choice is now a
//    frozen-manifest decision under an `externIsUndefined` policy whose truth
//    table is a THIRD one again: native on every host-free lane INCLUDING GC
//    native-strings, where `numberBoundary` is unsupported and
//    `booleanBoundary` has no native arm at all. Three policies, three tables,
//    one central capability catalogue.
//
//  * **sub-C** retires the four `gen.*` `?? irRuntimeFuncRef(<spelling>)`
//    lowering fallbacks. F1-S3 retired the fifth (`boxProvider`) with a
//    totality proof; the same proof covers all four `provider` fields, because
//    `attachIrGeneratorSupport` attaches them UNCONDITIONALLY for every
//    `gen.*` kind on every generator owner. Before this slice NO test pinned
//    `gen.push` / `gen.epilogue` / `gen.yieldStar` attachment at all; the
//    tests below are that first pin.
//
//  * **sub-A** (the two remaining `__unbox_number` from-ast arms) is NOT in
//    this change-set. Pre-implementation verification V-A found the STOP
//    condition it was written to catch: on the GC native-strings lane the raw
//    runtime symbol resolves TODAY to the `env.__unbox_number` host import
//    (`addUnionImports` registers the host family on every non-native-first
//    lane), while `NumberBoundaryPolicy.unbox` calls that lane `unsupported`.
//    Migrating the arms would convert a compiling, IR-claimed owner into a
//    preparation demote. The two assertions at the bottom of this file pin
//    that divergence so the next slice inherits a measurement, not a memory.
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { ASYNC_HOST_CAPABILITY_RECORDS, asAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";
import { irImportFuncRef, irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { attachIrGeneratorSupport } from "../src/ir/generator-support.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import {
  BOOLEAN_BOUNDARY_INTRINSIC_IDS,
  EXTERN_BOUNDARY_INTRINSIC_IDS,
  EXTERN_BOUNDARY_RUNTIME_FEATURES,
  EXTERNREF_TO_I32_INTRINSIC_SIGNATURE,
  INTRINSIC_DEFINITIONS,
  INTRINSIC_SIGNATURE_VERSION,
  NUMBER_BOUNDARY_INTRINSIC_IDS,
} from "../src/ir/intrinsics.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import {
  asBlockId,
  asValueId,
  forEachInstrDeep,
  irVal,
  irVec,
  type IrFunction,
  type IrInstr,
  type IrInstrIntrinsic,
  type IrType,
} from "../src/ir/nodes.js";
import {
  BOOLEAN_BOUNDARY_POLICY_DISABLED,
  EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS,
  EXTERN_IS_UNDEFINED_POLICY_DISABLED,
  NUMBER_BOUNDARY_POLICY_DISABLED,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  type ExternIsUndefinedPolicy,
  type RuntimeManifestPolicy,
} from "../src/ir/runtime-manifest.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-boundary-residuals");
const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const EXTERNREF = irVal({ kind: "externref" });

const HOST_PROBE: ExternIsUndefinedPolicy = { probe: "host" };
const NATIVE_PROBE: ExternIsUndefinedPolicy = { probe: "native" };

/**
 * The measured shape that both IR-SELECTS and reaches the strict-undefined
 * arm: an element read out of an `any[]` (externref-element) vector compared
 * against `undefined`. It reaches the arm on gc-host, gc-native-strings,
 * standalone and WASI (linear rejects the shape at its own backend).
 */
const PROBE_SOURCE = `function probe(a: any[]): number { const v = a[0]; return v !== undefined ? 1 : 0; }`;

/** `probe` rides the IR path; the exported driver stays on legacy so the
 * module is callable from JS (an `any[]` parameter is a WasmGC vector). */
const RUNNABLE = `
${PROBE_SOURCE}
export function present(): number { const a: any[] = [7]; return probe(a); }
export function absent(): number { const a: any[] = [undefined]; return probe(a); }
`;

function instrsOf(fn: IrFunction): IrInstr[] {
  const found: IrInstr[] = [];
  const scan = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) forEachInstrDeep(root, (instr) => found.push(instr));
  };
  for (const block of fn.blocks) scan(block.instrs);
  for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  return found;
}

function intrinsicsOf(fn: IrFunction): IrInstrIntrinsic[] {
  return instrsOf(fn).filter((instr): instr is IrInstrIntrinsic => instr.kind === "intrinsic");
}

function callTargetNames(fn: IrFunction): string[] {
  return instrsOf(fn).flatMap((instr) => (instr.kind === "call" ? [instr.target.name] : []));
}

/**
 * Call targets WITH their binding kind. The name alone is not enough here: the
 * two arms this slice replaced spelled the SAME name (`__extern_is_undefined`)
 * and differed only in `import` vs `runtime` binding, so a name-only
 * comparison would pass against the un-migrated front-end.
 */
function callTargetBindings(fn: IrFunction): string[] {
  return instrsOf(fn).flatMap((instr) =>
    instr.kind === "call" ? [`${instr.target.binding.kind}:${instr.target.name}`] : [],
  );
}

/**
 * Lower `probe` with the exact externref-element vector shape the compiler
 * gives it. `externIsUndefinedIsNative` is passed on purpose: it is now an
 * UNREAD property, which is what the lane-freedom assertion below asserts.
 */
function lowerProbe(externIsUndefinedIsNative: boolean): IrFunction {
  const analysis = analyzeSource(PROBE_SOURCE);
  const declaration = analysis.sourceFile.statements
    .filter(ts.isFunctionDeclaration)
    .find((candidate) => candidate.name?.text === "probe");
  if (!declaration) throw new Error("missing probe declaration");
  return lowerFunctionAstToIr(declaration, {
    ownerUnitId: identities.next("probe").unitId,
    exported: false,
    paramTypeOverrides: [irVec(EXTERNREF) as IrType],
    resolver: {
      resolveVecForElement: (elementValType: unknown) => ({
        vecStructTypeIdx: 7,
        lengthFieldIdx: 0,
        dataFieldIdx: 1,
        arrayTypeIdx: 8,
        elementValType,
      }),
      externIsUndefinedIsNative: () => externIsUndefinedIsNative,
    },
  } as Parameters<typeof lowerFunctionAstToIr>[1]).main;
}

function policy(externIsUndefined: ExternIsUndefinedPolicy): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", externIsUndefined };
}

/** One hand-built owner carrying exactly one undefined-probe arm. */
function probeFunction(name: string, provider?: IrInstrIntrinsic["provider"]): IrFunction {
  const instr: IrInstr = {
    kind: "intrinsic",
    id: "js.extern.is_undefined",
    version: INTRINSIC_SIGNATURE_VERSION,
    args: [asValueId(0)],
    result: asValueId(1),
    resultType: I32,
    ...(provider ? { provider } : {}),
  };
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [{ name: "value", type: EXTERNREF, value: asValueId(0) }],
    resultTypes: [I32],
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
  };
}

function prepare(fn: IrFunction, externIsUndefined: ExternIsUndefinedPolicy) {
  const prepared = prepareIrRuntimeManifest({
    functions: [fn],
    sourceFile: "/repo/extern-is-undefined.ts",
    policy: policy(externIsUndefined),
  });
  if (!prepared) throw new Error("expected a non-empty runtime manifest");
  return prepared;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const found = result.irOutcomes?.filter((candidate) => candidate.displayName === name) ?? [];
  if (found.length !== 1) throw new Error(`expected exactly one IR outcome for ${name}, got ${found.length}`);
  return found[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, () => number>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, () => number>;
  (imports as { setExports?: (value: Record<string, () => number>) => void }).setExports?.(exports);
  return exports;
}

describe("#3526 F1-S4 extern-is-undefined contract", () => {
  it("adds exactly ONE versioned ID with a 1:1 feature row and the exact probe ABI", () => {
    expect(EXTERN_BOUNDARY_INTRINSIC_IDS).toEqual(["js.extern.is_undefined"]);
    expect([...EXTERN_BOUNDARY_RUNTIME_FEATURES]).toEqual([...EXTERN_BOUNDARY_INTRINSIC_IDS]);
    expect(INTRINSIC_DEFINITIONS["js.extern.is_undefined"].feature).toBe("js.extern.is_undefined");
    expect(INTRINSIC_DEFINITIONS["js.extern.is_undefined"].signature).toBe(EXTERNREF_TO_I32_INTRINSIC_SIGNATURE);
    expect(EXTERNREF_TO_I32_INTRINSIC_SIGNATURE.version).toBe(INTRINSIC_SIGNATURE_VERSION);
    expect(EXTERNREF_TO_I32_INTRINSIC_SIGNATURE.params).toEqual([EXTERNREF]);
    expect(EXTERNREF_TO_I32_INTRINSIC_SIGNATURE.result).toEqual(I32);

    // A SIBLING of the number and boolean families, never a widening of them.
    expect([...(NUMBER_BOUNDARY_INTRINSIC_IDS as readonly string[])]).not.toContain("js.extern.is_undefined");
    expect([...(BOOLEAN_BOUNDARY_INTRINSIC_IDS as readonly string[])]).not.toContain("js.extern.is_undefined");
  });

  it("is TWO-armed at the provider level, unlike the one-armed boolean family", () => {
    expect([...EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS]).toEqual([
      "host.js.extern.is_undefined",
      "native.js.extern.is_undefined",
    ]);
  });

  it("keeps ONE central catalogue, and the async projection excludes the row BY ID", () => {
    expect(resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "extern.is_undefined")).toEqual({
      capability: "extern.is_undefined",
      module: "env",
      field: "__extern_is_undefined",
      kind: "func",
      params: ["externref"],
      results: ["i32"],
    });
    const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "extern.is_undefined");
    // Same trap the boolean row documents: every value type on this record is
    // admissible under `AsyncHostAdapterValueType`, so only the seven-ID
    // filter keeps it out of the async projection.
    for (const entry of [...record.params, ...record.results]) expect(["externref", "i32"]).toContain(entry);
    expect(ASYNC_HOST_CAPABILITY_RECORDS.map((entry) => entry.capability)).not.toContain("extern.is_undefined");
    expect(() => asAsyncHostAdapter(record)).toThrowError(/is not an async capability/);
  });
});

describe("#3526 F1-S4 provider policy", () => {
  it("selects the host arm through the central capability record", () => {
    const prepared = prepare(probeFunction("hostProbe"), HOST_PROBE);
    expect(prepared.manifest.policy.externIsUndefined).toEqual(HOST_PROBE);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["host.js.extern.is_undefined"]);
    expect(prepared.manifest.hostCapabilities).toEqual(["extern.is_undefined"]);
    for (const record of prepared.manifest.hostCapabilityRecords) {
      expect(RUNTIME_HOST_CAPABILITY_RECORDS).toContain(record);
    }
    // The physical target stays the exact `ensureLateImport` registration.
    expect(intrinsicsOf(prepared.functions[0]!).map((instr) => instr.provider)).toEqual([
      { kind: "callable", target: irImportFuncRef("env", "__extern_is_undefined", "__extern_is_undefined") },
    ]);
  });

  it("selects the native arm on the runtime symbol, requesting NO host capability", () => {
    const prepared = prepare(probeFunction("nativeProbe"), NATIVE_PROBE);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.extern.is_undefined"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.hostCapabilityRecords).toEqual([]);
    expect(intrinsicsOf(prepared.functions[0]!).map((instr) => instr.provider)).toEqual([
      { kind: "callable", target: irRuntimeFuncRef("__extern_is_undefined") },
    ]);
  });

  it("refuses the arm its caller resolved to unsupported, naming the intrinsic and the policy", () => {
    expect(() => prepare(probeFunction("refused"), EXTERN_IS_UNDEFINED_POLICY_DISABLED)).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }),
    );
    expect(() => prepare(probeFunction("refused2"), EXTERN_IS_UNDEFINED_POLICY_DISABLED)).toThrowError(
      /js\.extern\.is_undefined is unavailable under extern-is-undefined policy probe=unsupported/,
    );
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    const frozen = builder.freeze();
    expect(frozen.policy.externIsUndefined).toEqual(EXTERN_IS_UNDEFINED_POLICY_DISABLED);
    // Three independent policies, not one widened field.
    expect(frozen.policy.numberBoundary).toEqual(NUMBER_BOUNDARY_POLICY_DISABLED);
    expect(frozen.policy.booleanBoundary).toEqual(BOOLEAN_BOUNDARY_POLICY_DISABLED);
  });

  it("resolves the probe independently of the number and boolean arms", () => {
    const prepared = prepareIrRuntimeManifest({
      functions: [probeFunction("independent")],
      sourceFile: "/repo/extern-is-undefined.ts",
      policy: {
        target: "host",
        backend: "wasmgc",
        // Numbers and booleans OFF, the probe ON: it must still resolve.
        numberBoundary: NUMBER_BOUNDARY_POLICY_DISABLED,
        booleanBoundary: BOOLEAN_BOUNDARY_POLICY_DISABLED,
        externIsUndefined: NATIVE_PROBE,
      },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.extern.is_undefined"]);
  });

  it("its truth table is a THIRD one — native where numberBoundary is unsupported", () => {
    // The GC native-strings lane: `numberBoundary` resolves BOTH arms
    // unsupported there (F1-S1), `booleanBoundary` has no native member at
    // all (F1-S2), and this probe is answered NATIVELY. Merging any two of the
    // three would change behaviour on that lane.
    const prepared = prepareIrRuntimeManifest({
      functions: [probeFunction("nativeStringsLane")],
      sourceFile: "/repo/extern-is-undefined.ts",
      policy: {
        target: "host",
        backend: "wasmgc",
        numberBoundary: NUMBER_BOUNDARY_POLICY_DISABLED,
        booleanBoundary: BOOLEAN_BOUNDARY_POLICY_DISABLED,
        externIsUndefined: NATIVE_PROBE,
      },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");
    expect(prepared.manifest.policy.numberBoundary.unbox).toBe("unsupported");
    expect(prepared.manifest.policy.booleanBoundary.box).toBe("unsupported");
    expect(prepared.manifest.policy.externIsUndefined.probe).toBe("native");
  });
});

describe("#3526 F1-S4 the front-end reads no lane fact", () => {
  it("lowers the strict-undefined arm to the provider-free intrinsic", () => {
    const fn = lowerProbe(false);
    expect(intrinsicsOf(fn).map((instr) => instr.id)).toEqual(["js.extern.is_undefined"]);
    expect(intrinsicsOf(fn).map((instr) => instr.provider)).toEqual([undefined]);
    // The raw two-armed call is gone from BOTH spellings.
    expect(callTargetNames(fn)).not.toContain("__extern_is_undefined");
  });

  it("emits the SAME body under either answer to the deleted predicate", () => {
    const asHost = lowerProbe(false);
    const asNative = lowerProbe(true);
    expect(intrinsicsOf(asNative).map((instr) => instr.id)).toEqual(intrinsicsOf(asHost).map((instr) => instr.id));
    expect(callTargetBindings(asNative)).toEqual(callTargetBindings(asHost));
    expect(instrsOf(asNative).map((instr) => instr.kind)).toEqual(instrsOf(asHost).map((instr) => instr.kind));
  });

  it("normalises the operand through coerce.to_externref, which lowering elides", () => {
    // The intrinsic ABI admits only a `val` externref while the arm's own gate
    // also admits `extern` / `callable` / host-mode `string` carriers. The
    // normalisation is a TYPE fact: `lower.ts` skips `extern.convert_any` for
    // exactly that already-externref population, which is why every byte cell
    // below is unchanged.
    const kinds = instrsOf(lowerProbe(false)).map((instr) => instr.kind);
    expect(kinds).toContain("coerce.to_externref");
    expect(kinds.indexOf("coerce.to_externref")).toBeLessThan(kinds.indexOf("intrinsic"));
  });
});

describe("#3526 F1-S4 end-to-end behaviour is unchanged", () => {
  it("answers the probe correctly on the host lane, through the env import", async () => {
    const result = await compile(RUNNABLE, { trackIrOutcomes: true });
    expect(outcome(result, "probe").kind).toBe("emitted");
    expect(result.imports.some((entry) => entry.name === "__extern_is_undefined")).toBe(true);
    const exports = await instantiate(result);
    expect(exports.present!()).toBe(1);
    expect(exports.absent!()).toBe(0);
  });

  it("uses the host-free Wasm function on standalone, with no env import", async () => {
    // The exported bare probe, not `RUNNABLE`: its JS drivers build an `any[]`
    // literal, which demotes the whole module at IR SELECTION on standalone
    // (`call-graph-closure` / `body-shape-rejected`) for reasons unrelated to
    // this seam. The bare owner IR-claims there and reaches the arm.
    const result = await compile(`export ${PROBE_SOURCE}`, { target: "standalone", trackIrOutcomes: true });
    expect(outcome(result, "probe").kind).toBe("emitted");
    expect(result.imports.some((entry) => entry.name === "__extern_is_undefined")).toBe(false);
  });

  it("keeps the host lane's env import on the exported bare probe too", async () => {
    const result = await compile(`export ${PROBE_SOURCE}`, { trackIrOutcomes: true });
    expect(outcome(result, "probe").kind).toBe("emitted");
    expect(result.imports.some((entry) => entry.name === "__extern_is_undefined")).toBe(true);
  });
});

// --------------------------------------------------------------------------
// sub-C — the four `gen.*` lowering fallbacks
// --------------------------------------------------------------------------

const GEN_KINDS = [
  { kind: "gen.push", symbol: "__gen_push_ref" },
  { kind: "gen.epilogue", symbol: "__create_generator" },
  { kind: "gen.yieldStar", symbol: "__gen_yield_star" },
  { kind: "gen.setReturn", symbol: "__gen_set_return" },
] as const;

function generatorWith(name: string, instr: IrInstr, resultTypes: readonly IrType[] = []): IrFunction {
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [{ name: "value", type: EXTERNREF, value: asValueId(0) }],
    resultTypes,
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
    valueCount: 2,
    funcKind: "generator",
    generatorBufferSlot: 0,
    slots: [{ name: "$__gen_buffer", type: EXTERNREF }],
  } as unknown as IrFunction;
}

function genInstr(kind: (typeof GEN_KINDS)[number]["kind"]): IrInstr {
  if (kind === "gen.epilogue") {
    return { kind, result: asValueId(1), resultType: EXTERNREF } as unknown as IrInstr;
  }
  if (kind === "gen.yieldStar") {
    return { kind, inner: asValueId(0), result: null, resultType: null } as unknown as IrInstr;
  }
  return { kind, value: asValueId(0), result: null, resultType: null } as unknown as IrInstr;
}

describe("#3526 F1-S4 every gen.* callable has ONE authority", () => {
  it.each(GEN_KINDS)("attaches $kind's provider unconditionally on a generator owner", ({ kind, symbol }) => {
    const attached = attachIrGeneratorSupport(generatorWith(`attach-${kind}`, genInstr(kind)), undefined);
    const found = instrsOf(attached).filter((instr) => instr.kind === kind);
    expect(found).toHaveLength(1);
    expect((found[0] as { provider?: { name: string } }).provider?.name).toBe(symbol);
  });

  it.each(GEN_KINDS)("refuses to lower an unattached $kind instead of re-deciding the symbol", ({ kind }) => {
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
    } as unknown as IrLowerResolver;
    const fn = generatorWith(`unattached-${kind}`, genInstr(kind));
    expect(() => lowerIrFunctionToWasm(fn, resolver)).toThrowError(
      new RegExp(`${kind.replace(".", "\\.")} has no prepared runtime provider`),
    );
  });

  it("leaves a NON-generator owner's gen.* untouched — the buffer-slot guard owns that case", () => {
    const regular = { ...generatorWith("regular", genInstr("gen.push")), funcKind: "regular" } as IrFunction;
    expect(attachIrGeneratorSupport(regular, undefined)).toBe(regular);
  });
});

// --------------------------------------------------------------------------
// sub-A — the recorded STOP
// --------------------------------------------------------------------------

/**
 * The two arms V-A stopped: `emitUnaryToNumber`'s ToPrimitive-adjacent
 * `__unbox_number` calls. Reached by unary `+`/`-` on an OrdinaryToPrimitive
 * object literal whose methods are property-assigned FUNCTION EXPRESSIONS
 * (the open `extern:Object` protocol).
 */
const OTP_SOURCE = `export function f(n: number): number {
  const o = { valueOf: function (): string { return "7"; } };
  return +o + n;
}`;

describe("#3526 F1-S4 sub-A is stopped, and the divergence is pinned", () => {
  it("still emits the RAW runtime symbol — the arms are unmigrated", async () => {
    const result = await compile(OTP_SOURCE, { trackIrOutcomes: true });
    expect(outcome(result, "f").kind).toBe("emitted");
    expect(result.imports.some((entry) => entry.name === "__unbox_number")).toBe(true);
  });

  it("the raw symbol resolves on gc-native-strings, where the policy says unsupported", async () => {
    // THIS is the STOP condition. The owner compiles and is IR-claimed on a
    // lane whose `NumberBoundaryPolicy.unbox` is `unsupported`, because
    // `addUnionImports` registers the host family on every non-native-first
    // lane. Emitting `js.number.unbox` here would demote it in preparation —
    // a behaviour change, not a neutral migration.
    const result = await compile(OTP_SOURCE, { nativeStrings: true, trackIrOutcomes: true });
    expect(outcome(result, "f").kind).toBe("emitted");
    expect(result.imports.some((entry) => entry.name === "__unbox_number")).toBe(true);
  });
});
