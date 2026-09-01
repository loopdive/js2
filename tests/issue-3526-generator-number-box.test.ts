// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F1-S3 — the generator `return <number>` boxing seam under frozen
// manifest authority.
//
// Before this slice `attachIrGeneratorSupport` pinned `__box_number` by
// spelling a runtime symbol at the seam and choosing it by value-type
// presence, outside the frozen manifest. This suite pins the migrated
// contract: a resolved `generatorNumberBox` policy picks a provider, the
// frozen manifest carries the row, and the attachment consumes THAT provider's
// physical symbol rather than one written at the seam.
//
// Two measured facts shape the design and are asserted here rather than
// assumed:
//
//  1. The seam's truth table is WIDER than `numberBoundary`'s. This boxing is
//     performed natively on the GC native-strings lane, whereas
//     `numberBoundary.box` is host-only by design (F1-S1 deliberately excluded
//     a native member so helper presence could not widen it). The two policies
//     name the same physical symbol and must stay separate.
//  2. The attached reference must stay `runtime`-bound. Generator providers
//     are observed through `resolveAndObserveCallableProvider`, which admits
//     only `runtime` and `intrinsic` bindings; attaching the host arm's
//     canonical `env.__box_number` IMPORT reference instead fails every
//     generator owner with `unexpected-internal-throw` on both host lanes
//     (measured before implementation). The manifest therefore decides WHICH
//     symbol answers the seam, and the seam binds that symbol the only way its
//     observation path accepts.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";
import { irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import {
  attachIrGeneratorSupport,
  collectAttachedGeneratorProviders,
  irGeneratorNumberBoxDemand,
  irGeneratorSetReturnNeedsBoxing,
} from "../src/ir/generator-support.js";
import { prepareIrRuntimeManifest, preparedGeneratorNumberBoxProvider } from "../src/ir/intrinsic-support.js";
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
  GENERATOR_NUMBER_BOX_POLICY_DISABLED,
  GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,
  GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS,
  NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS,
  RUNTIME_PROVIDERS,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  type GeneratorNumberBoxPolicy,
  type RuntimeManifestPolicy,
} from "../src/ir/runtime-manifest.js";
import { resolveRuntimeHostCapabilityRecord } from "../src/ir/runtime-host-capabilities.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-generator-number-box");
const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const EXTERNREF = irVal({ kind: "externref" });
const FEATURE = GENERATOR_NUMBER_BOX_RUNTIME_FEATURES[0];

const HOST: GeneratorNumberBoxPolicy = { box: "host" };
const NATIVE: GeneratorNumberBoxPolicy = { box: "native" };

/** One hand-built generator owner whose `return` stashes a `type`d value. */
function generatorFunction(name: string, type: IrType, wrap: "flat" | "nested" = "flat"): IrFunction {
  const setReturn: IrInstr = { kind: "gen.setReturn", value: asValueId(0), result: null, resultType: null };
  const instrs: readonly IrInstr[] =
    wrap === "flat"
      ? [setReturn]
      : [
          {
            kind: "if.stmt",
            cond: asValueId(1),
            then: [setReturn],
            else: [],
            result: null,
            resultType: null,
          } as unknown as IrInstr,
        ];
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [
      { name: "value", type, value: asValueId(0) },
      { name: "flag", type: I32, value: asValueId(1) },
    ],
    resultTypes: [],
    blocks: [
      { id: asBlockId(0), blockArgs: [], blockArgTypes: [], instrs, terminator: { kind: "return", values: [] } },
    ],
    exported: false,
    valueCount: 2,
    funcKind: "generator",
  } as unknown as IrFunction;
}

function policy(generatorNumberBox?: GeneratorNumberBoxPolicy): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", ...(generatorNumberBox ? { generatorNumberBox } : {}) };
}

function prepare(generatorNumberBox: GeneratorNumberBoxPolicy, demand = true) {
  const prepared = prepareIrRuntimeManifest({
    functions: [generatorFunction("g", F64)],
    sourceFile: "/repo/generator-number-box.ts",
    policy: policy(generatorNumberBox),
    generatorNumberBoxDemand: demand,
  });
  return prepared;
}

function boxProvidersOf(fn: IrFunction): (string | undefined)[] {
  const found: (string | undefined)[] = [];
  for (const block of fn.blocks) {
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.kind === "gen.setReturn") found.push(instr.boxProvider?.name);
      });
    }
  }
  return found;
}

describe("#3526 F1-S3 generator-number-box policy and providers", () => {
  it("defaults to a frozen disabled policy and publishes it resolved on the frozen manifest", () => {
    expect(Object.isFrozen(GENERATOR_NUMBER_BOX_POLICY_DISABLED)).toBe(true);
    expect(GENERATOR_NUMBER_BOX_POLICY_DISABLED).toEqual({ box: "unsupported" });
    const frozen = new RuntimeManifestBuilder(policy()).freeze();
    expect(frozen.policy.generatorNumberBox).toEqual(GENERATOR_NUMBER_BOX_POLICY_DISABLED);
    expect(Object.isFrozen(frozen.policy.generatorNumberBox)).toBe(true);
  });

  it("is a SIBLING of the number boundary, not a widening of it", () => {
    // The number box arm still has no native member; only the generator seam
    // does. If these two ever merge, a native `__box_number` becomes able to
    // widen the from-ast number arm that F1-S1 deliberately kept host-only.
    expect([...NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS]).toEqual([
      "host.js.number.box",
      "host.js.number.unbox",
      "native.js.number.unbox",
    ]);
    expect([...GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS]).toEqual([
      "host.js.generator.number-box",
      "native.js.generator.number-box",
    ]);
    expect(GENERATOR_NUMBER_BOX_RUNTIME_FEATURES).toEqual(["js.generator.number-box"]);
  });

  it("host policy selects the host-callable provider on the central number.box capability", () => {
    const prepared = prepare(HOST);
    const provider = prepared?.manifest.providers.find((candidate) => candidate.feature === FEATURE);
    expect(provider?.id).toBe("host.js.generator.number-box");
    expect(provider?.implementation).toEqual({ kind: "host-callable", capability: "number.box" });
    const record = resolveRuntimeHostCapabilityRecord(prepared!.manifest.hostCapabilityRecords, "number.box");
    expect([record.module, record.field]).toEqual(["env", "__box_number"]);
  });

  it("native policy selects the runtime-callable provider on the union-native symbol", () => {
    const prepared = prepare(NATIVE);
    const provider = prepared?.manifest.providers.find((candidate) => candidate.feature === FEATURE);
    expect(provider?.id).toBe("native.js.generator.number-box");
    expect(provider?.implementation).toEqual({ kind: "runtime-callable", symbol: "__box_number" });
    // No host capability is acquired on this arm — the native lane must not
    // pull `env.__box_number` into the manifest's capability closure.
    expect(prepared!.manifest.hostCapabilityRecords.map((entry) => entry.capability)).not.toContain("number.box");
  });

  it("an unsupported policy with demand is a typed provider-target-unavailable naming the policy", () => {
    let caught: unknown;
    try {
      prepare(GENERATOR_NUMBER_BOX_POLICY_DISABLED);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeManifestInvariantError);
    expect((caught as RuntimeManifestInvariantError).code).toBe("provider-target-unavailable");
    expect((caught as Error).message).toContain(FEATURE);
    expect((caught as Error).message).toContain("box=unsupported");
  });

  it("no demand means no row — an unsupported policy freezes cleanly", () => {
    expect(prepare(GENERATOR_NUMBER_BOX_POLICY_DISABLED, false)).toBeUndefined();
  });
});

describe("#3526 F1-S3 attachment consumes the manifest's decision", () => {
  it("derives a RUNTIME-bound ref naming the provider's physical symbol on both arms", () => {
    for (const arm of [HOST, NATIVE]) {
      const ref = preparedGeneratorNumberBoxProvider(prepare(arm));
      expect(ref?.binding.kind).toBe("runtime");
      expect(ref?.name).toBe("__box_number");
    }
  });

  it("follows the manifest's SELECTED PROVIDER, not a symbol spelled at the seam", () => {
    // The load-bearing assertion for this slice. The catalogue's own canonical
    // identity check makes a relocated `number.box` record unrepresentable, so
    // authority is proved the other way: point the host arm's provider at a
    // different central capability and the attached callable follows it. An
    // attachment that spells `__box_number` itself passes every byte-parity
    // cell and fails exactly here.
    const providers = RUNTIME_PROVIDERS.map((provider) =>
      provider.id === "host.js.generator.number-box"
        ? Object.freeze({
            ...provider,
            hostCapabilities: Object.freeze(["async.value.undefined" as const]),
            implementation: Object.freeze({ kind: "host-callable" as const, capability: "async.value.undefined" }),
          })
        : provider,
    );
    const builder = new RuntimeManifestBuilder(policy(HOST), { providers });
    builder.requestFeature(FEATURE);
    const manifest = builder.freeze();
    const ref = preparedGeneratorNumberBoxProvider({ functions: [], manifest, providers: new Map() });
    expect(ref?.name).toBe("__get_undefined");
    expect(ref?.binding.kind).toBe("runtime");
  });

  it("follows the native arm's runtime symbol the same way", () => {
    const providers = RUNTIME_PROVIDERS.map((provider) =>
      provider.id === "native.js.generator.number-box"
        ? Object.freeze({
            ...provider,
            implementation: Object.freeze({ kind: "runtime-callable" as const, symbol: "__box_number_native_alt" }),
          })
        : provider,
    );
    const builder = new RuntimeManifestBuilder(policy(NATIVE), { providers });
    builder.requestFeature(FEATURE);
    const ref = preparedGeneratorNumberBoxProvider({
      functions: [],
      manifest: builder.freeze(),
      providers: new Map(),
    });
    expect(ref?.name).toBe("__box_number_native_alt");
    expect(ref?.binding.kind).toBe("runtime");
  });

  it("attaches THAT ref as the boxProvider, and observes it alongside the setReturn provider", () => {
    const ref = irRuntimeFuncRef("__box_number_relocated");
    const attached = attachIrGeneratorSupport(generatorFunction("g", F64), ref);
    expect(boxProvidersOf(attached)).toEqual(["__box_number_relocated"]);
    expect(collectAttachedGeneratorProviders([attached]).map((entry) => entry.name)).toEqual([
      "__gen_set_return",
      "__box_number_relocated",
    ]);
  });

  it("attaches nothing for an already-externref stash, on either arm", () => {
    const attached = attachIrGeneratorSupport(generatorFunction("g", EXTERNREF), irRuntimeFuncRef("__box_number"));
    expect(boxProvidersOf(attached)).toEqual([undefined]);
    expect(collectAttachedGeneratorProviders([attached]).map((entry) => entry.name)).toEqual(["__gen_set_return"]);
  });

  it("fails closed when a numeric stash has no manifest-selected provider", () => {
    expect(() => attachIrGeneratorSupport(generatorFunction("g", F64), undefined)).toThrowError(
      /no manifest-selected provider/,
    );
    // A ref-typed stash needs none, so it is unaffected.
    expect(() => attachIrGeneratorSupport(generatorFunction("g", EXTERNREF), undefined)).not.toThrow();
  });
});

describe("#3526 F1-S3 freeze scan and attachment classify ONE population", () => {
  // Verification 3, asserted rather than argued: the freeze-time demand scan
  // and the attachment pass share the `funcKind` gate, the value-type map, the
  // deep walk and the predicate, so they cannot disagree about which owners
  // need a provider row.
  const cases: ReadonlyArray<readonly [string, IrFunction]> = [
    ["f64 stash", generatorFunction("f64", F64)],
    ["i32 stash", generatorFunction("i32", I32)],
    ["externref stash", generatorFunction("ref", EXTERNREF)],
    ["f64 stash nested in a statement buffer", generatorFunction("nested-f64", F64, "nested")],
    ["externref stash nested in a statement buffer", generatorFunction("nested-ref", EXTERNREF, "nested")],
  ];

  for (const [label, fn] of cases) {
    it(`agrees on ${label}`, () => {
      const attached = attachIrGeneratorSupport(fn, irRuntimeFuncRef("__box_number"));
      const attachedDemand = boxProvidersOf(attached).some((name) => name !== undefined);
      expect(irGeneratorNumberBoxDemand([fn])).toBe(attachedDemand);
    });
  }

  it("ignores non-generator owners on both sides", () => {
    const regular = { ...generatorFunction("regular", F64), funcKind: "regular" } as IrFunction;
    expect(irGeneratorNumberBoxDemand([regular])).toBe(false);
    expect(attachIrGeneratorSupport(regular, undefined)).toBe(regular);
  });

  it("keeps the boxing predicate exactly the f64/i32 pair", () => {
    expect(irGeneratorSetReturnNeedsBoxing(F64)).toBe(true);
    expect(irGeneratorSetReturnNeedsBoxing(I32)).toBe(true);
    expect(irGeneratorSetReturnNeedsBoxing(EXTERNREF)).toBe(false);
    expect(irGeneratorSetReturnNeedsBoxing(undefined)).toBe(false);
  });
});

describe("#3526 F1-S3 lowering has no second authority", () => {
  it("refuses to lower a numeric stash whose boxing provider was never attached", () => {
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
    } as unknown as IrLowerResolver;
    // (#3526 F1-S4) The `gen.setReturn` PROVIDER is attached here so this test
    // keeps isolating the BOXING authority. F1-S4 retired the `?? __gen_set_return`
    // fallback this arm used to fall through, so an entirely unattached instr now
    // fails on the seam provider first — a different assertion, pinned separately
    // in the F1-S4 suite.
    const base = generatorFunction("unattached", F64);
    const block = base.blocks[0]!;
    const fn = {
      ...base,
      blocks: [
        {
          ...block,
          instrs: block.instrs.map((instr) =>
            instr.kind === "gen.setReturn" ? { ...instr, provider: irRuntimeFuncRef("__gen_set_return") } : instr,
          ),
        },
      ],
      generatorBufferSlot: 0,
      slots: [{ name: "$__gen_buffer", type: EXTERNREF }],
    } as unknown as IrFunction;
    expect(() => lowerIrFunctionToWasm(fn, resolver)).toThrowError(/no prepared boxing provider/);
  });
});

describe("#3526 F1-S3 end-to-end behavior is unchanged", () => {
  it("a value-returning host generator still boxes through env.__box_number and drains", async () => {
    process.env.JS2WASM_IR_FIRST = "1";
    const res = await compile(`export function* g(){ yield 1; yield 2; return 3; }`, {
      fileName: "test.ts",
      emitWat: true,
    });
    expect(res.success).toBe(true);
    expect(res.irFirstSkipped ?? []).toContain("g");
    expect(res.wat).toContain('(import "env" "__box_number"');
    const imports = buildImports(res.imports, undefined, res.stringPool) as Record<string, unknown>;
    const { instance } = await WebAssembly.instantiate(res.binary!, imports as never);
    (imports as { setExports?: (value: unknown) => void }).setExports?.(instance.exports);
    const gen = (instance.exports as { g: () => Iterator<number, number> }).g();
    gen.next();
    gen.next();
    const terminal = gen.next();
    expect([terminal.done, terminal.value]).toEqual([true, 3]);
  });

  it("the i32 arm takes the convert-then-box path on the IR route", async () => {
    process.env.JS2WASM_IR_FIRST = "1";
    const res = await compile(`export function* g(n: number) { yield 1; return n | 0; }`, {
      fileName: "test.ts",
      emitWat: true,
      trackIrOutcomes: true,
    });
    expect(res.success).toBe(true);
    // Anti-vacuity for the i32 parity cell: the owner must actually ride the
    // IR path, or the `f64.convert_i32_s` below would be legacy's.
    expect(res.irOutcomes?.find((entry) => entry.displayName === "g")?.legacyBodyEmitted).toBe(false);
    expect(res.wat).toContain("f64.convert_i32_s");
    expect(res.wat).toContain('(import "env" "__box_number"');
  });
});
