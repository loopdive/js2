// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import {
  F64_BINARY_INTRINSIC_SIGNATURE,
  INTRINSIC_DEFINITIONS,
  PURE_MATH_HOST_CAPABILITIES,
  PURE_MATH_INTRINSIC_IDS,
  PURE_MATH_RUNTIME_FEATURES,
  intrinsicEffectEvidence,
  type IntrinsicId,
  type IntrinsicUse,
  type RuntimeFeature,
} from "../src/ir/intrinsics.js";
import { asValueId, irVal, type IrInstr } from "../src/ir/nodes.js";
import {
  PURE_MATH_RUNTIME_PROVIDERS,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  type FrozenRuntimeManifest,
  type RuntimeBackend,
  type RuntimeManifestPolicy,
  type RuntimeProviderDefinition,
  type RuntimeTarget,
} from "../src/ir/runtime-manifest.js";
import { IR_MATH_METHOD_TABLE } from "../src/ir/select.js";

const F64 = irVal({ kind: "f64" });

const PURE_INSTRUCTION: IrInstr = {
  kind: "unary",
  op: "f64.abs",
  rand: asValueId(0),
  result: asValueId(1),
  resultType: F64,
};

const IMPURE_INSTRUCTION: IrInstr = {
  kind: "call",
  target: { kind: "func", name: "impure", binding: { kind: "runtime", symbol: "impure" } },
  args: [],
  result: asValueId(0),
  resultType: F64,
};

const PURE_EFFECTS = intrinsicEffectEvidence(PURE_INSTRUCTION);
const IMPURE_EFFECTS = intrinsicEffectEvidence(IMPURE_INSTRUCTION);

function intrinsicUse(id: IntrinsicId, line = 1, file = "/repo/entry.ts"): IntrinsicUse {
  const definition = INTRINSIC_DEFINITIONS[id];
  return {
    id,
    version: definition.signature.version,
    argumentTypes: definition.signature.params,
    resultType: definition.signature.result,
    location: { file, line, column: line - 1 },
  };
}

function policy(target: RuntimeTarget = "host", backend: RuntimeBackend = "wasmgc"): RuntimeManifestPolicy {
  return { target, backend };
}

function addUses(builder: RuntimeManifestBuilder, ids: readonly IntrinsicId[]): void {
  const lineById = new Map(PURE_MATH_INTRINSIC_IDS.map((id, index) => [id, index + 1]));
  for (const id of ids) builder.addIntrinsicUse(intrinsicUse(id, lineById.get(id)!), PURE_EFFECTS);
}

function thrown(code: RuntimeManifestInvariantError["code"]): object {
  return expect.objectContaining<RuntimeManifestInvariantError>({ code });
}

function providerWith(
  id: RuntimeProviderDefinition["id"],
  update: (provider: RuntimeProviderDefinition) => RuntimeProviderDefinition,
): readonly RuntimeProviderDefinition[] {
  return PURE_MATH_RUNTIME_PROVIDERS.map((provider) => (provider.id === id ? update(provider) : provider));
}

function semanticView(manifest: FrozenRuntimeManifest): object {
  return {
    intrinsicUses: manifest.intrinsicUses,
    features: manifest.features,
    providerComponents: manifest.providerComponents,
    hostCapabilities: manifest.hostCapabilities,
  };
}

describe("#3526 typed IR runtime manifest foundation", () => {
  it("is exhaustive for the exact twelve certified pure Math methods and excludes random", () => {
    const certifiedMethods = Object.keys(IR_MATH_METHOD_TABLE).sort();
    const intrinsicMethods = PURE_MATH_INTRINSIC_IDS.map((id) => id.slice("math.".length)).sort();

    expect(intrinsicMethods).toEqual(certifiedMethods);
    expect(intrinsicMethods).toHaveLength(12);
    expect(intrinsicMethods).not.toContain("random");
    expect(PURE_MATH_RUNTIME_FEATURES).toEqual([...PURE_MATH_RUNTIME_FEATURES].sort());
    expect(PURE_MATH_RUNTIME_FEATURES).toEqual(expect.arrayContaining(["math.atan", "math.reduce-trig"]));
    expect(PURE_MATH_HOST_CAPABILITIES).toEqual([]);

    for (const [method, plan] of Object.entries(IR_MATH_METHOD_TABLE)) {
      const id = `math.${method}` as IntrinsicId;
      expect(INTRINSIC_DEFINITIONS[id].signature.params).toHaveLength(plan.arity);
      expect(INTRINSIC_DEFINITIONS[id].signature.result).toEqual(F64);
    }
  });

  it("builds one canonical fixed point regardless of use, map, and provider traversal order", () => {
    const forward = new RuntimeManifestBuilder(policy());
    const reverse = new RuntimeManifestBuilder(policy(), { providers: [...PURE_MATH_RUNTIME_PROVIDERS].reverse() });
    addUses(forward, PURE_MATH_INTRINSIC_IDS);
    addUses(reverse, [...PURE_MATH_INTRINSIC_IDS].reverse());

    const first = forward.freeze();
    const second = reverse.freeze();
    expect(second).toEqual(first);
    expect(first.intrinsicUses).toHaveLength(12);
    expect(first.features).toEqual(PURE_MATH_RUNTIME_FEATURES);
    expect(new Set(first.providers.map((provider) => provider.id)).size).toBe(first.providers.length);
    expect(first.hostCapabilities).toEqual([]);

    const dependencies = Object.fromEntries(
      first.providers.map((provider) => [provider.feature, provider.dependencies]),
    );
    expect(dependencies["math.pow"]).toEqual(["math.exp", "math.log"]);
    expect(dependencies["math.atan2"]).toEqual(["math.atan"]);
    expect(dependencies["math.sin"]).toEqual(["math.reduce-trig"]);
    expect(dependencies["math.cos"]).toEqual(["math.reduce-trig"]);
    expect(first.features.filter((feature) => feature === "math.reduce-trig")).toHaveLength(1);
  });

  it("keeps the pure fixed point host-free in every target/backend policy", () => {
    const targets: readonly RuntimeTarget[] = ["host", "strict-no-host", "standalone", "wasi"];
    const backends: readonly RuntimeBackend[] = ["wasmgc", "linear"];
    const semanticClosures: RuntimeFeature[][] = [];

    for (const target of targets) {
      for (const backend of backends) {
        const builder = new RuntimeManifestBuilder(policy(target, backend));
        addUses(builder, ["math.sin", "math.pow", "math.atan2"]);
        const manifest = builder.freeze();
        semanticClosures.push([...manifest.features]);
        expect(manifest.hostCapabilities, `${target}/${backend}`).toEqual([]);
      }
    }

    expect(new Set(semanticClosures.map((features) => features.join("|")))).toHaveLength(1);
    expect(semanticClosures[0]).toEqual([
      "math.atan",
      "math.atan2",
      "math.exp",
      "math.log",
      "math.pow",
      "math.reduce-trig",
      "math.sin",
    ]);
  });

  it("terminates declared cycles as one canonical dependency-first provider component", () => {
    const build = (declaration: readonly RuntimeFeature[]): FrozenRuntimeManifest => {
      const builder = new RuntimeManifestBuilder(policy());
      builder.addIntrinsicUse(intrinsicUse("math.sin"), PURE_EFFECTS);
      builder.addProviderDependency("math.reduce-trig", "math.sin");
      builder.declareProviderCycle(declaration);
      return builder.freeze();
    };

    const forward = build(["math.sin", "math.reduce-trig"]);
    const reverse = build(["math.reduce-trig", "math.sin"]);
    expect(reverse).toEqual(forward);
    expect(forward.providerComponents).toEqual([
      {
        features: ["math.reduce-trig", "math.sin"],
        providers: ["selfhost.math.reduce-trig", "selfhost.math.sin"],
        cyclic: true,
      },
    ]);

    const undeclared = new RuntimeManifestBuilder(policy());
    undeclared.addIntrinsicUse(intrinsicUse("math.sin"), PURE_EFFECTS);
    undeclared.addProviderDependency("math.reduce-trig", "math.sin");
    expect(() => undeclared.freeze()).toThrowError(thrown("undeclared-provider-cycle"));
  });

  it("rejects unknown IDs, bad signatures, impure evidence, missing providers, and missing adapters", () => {
    const unknown = {
      ...intrinsicUse("math.sin"),
      id: "math.random",
    } as unknown as IntrinsicUse;
    expect(() => new RuntimeManifestBuilder(policy()).addIntrinsicUse(unknown, PURE_EFFECTS)).toThrowError(
      thrown("unknown-intrinsic"),
    );

    const badSignature = { ...intrinsicUse("math.pow"), argumentTypes: [F64] };
    expect(() => new RuntimeManifestBuilder(policy()).addIntrinsicUse(badSignature, PURE_EFFECTS)).toThrowError(
      thrown("intrinsic-signature-mismatch"),
    );
    expect(() =>
      new RuntimeManifestBuilder(policy()).addIntrinsicUse(intrinsicUse("math.sin"), IMPURE_EFFECTS),
    ).toThrowError(thrown("intrinsic-effect-mismatch"));

    const missing = new RuntimeManifestBuilder(policy(), {
      providers: PURE_MATH_RUNTIME_PROVIDERS.filter((provider) => provider.id !== "selfhost.math.sin"),
    });
    missing.addIntrinsicUse(intrinsicUse("math.sin"), PURE_EFFECTS);
    expect(() => missing.freeze()).toThrowError(thrown("missing-runtime-provider"));

    const badProviderSignature = new RuntimeManifestBuilder(policy(), {
      providers: providerWith("selfhost.math.sin", (provider) => ({
        ...provider,
        signature: F64_BINARY_INTRINSIC_SIGNATURE,
      })),
    });
    badProviderSignature.addIntrinsicUse(intrinsicUse("math.sin"), PURE_EFFECTS);
    expect(() => badProviderSignature.freeze()).toThrowError(thrown("provider-signature-mismatch"));

    const missingLinearAdapter = new RuntimeManifestBuilder(policy("standalone", "linear"), {
      providers: providerWith("selfhost.math.sin", (provider) => ({
        ...provider,
        supportedBackends: ["wasmgc"],
      })),
    });
    missingLinearAdapter.addIntrinsicUse(intrinsicUse("math.sin"), PURE_EFFECTS);
    expect(() => missingLinearAdapter.freeze()).toThrowError(thrown("missing-backend-adapter"));
  });

  it("freezes deeply and turns all late registration or lookup misses into invariants", () => {
    const builder = new RuntimeManifestBuilder(policy());
    builder.addIntrinsicUse(intrinsicUse("math.sin"), PURE_EFFECTS);
    const manifest = builder.freeze();
    const sinProvider = builder.resolveProvider("math.sin");

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.features)).toBe(true);
    expect(Object.isFrozen(sinProvider)).toBe(true);
    expect(Object.isFrozen(sinProvider.dependencies)).toBe(true);
    expect(builder.manifest).toBe(manifest);
    expect(() => builder.assertIntrinsicPlanned("math.sin")).not.toThrow();
    expect(() => builder.assertProviderPlanned("selfhost.math.sin")).not.toThrow();
    expect(() => builder.resolveProvider("math.reduce-trig")).not.toThrow();

    expect(() => builder.addIntrinsicUse(intrinsicUse("math.cos"), PURE_EFFECTS)).toThrowError(
      thrown("manifest-frozen"),
    );
    expect(() => builder.registerProvider(PURE_MATH_RUNTIME_PROVIDERS[0]!)).toThrowError(thrown("manifest-frozen"));
    expect(() => builder.addProviderDependency("math.sin", "math.cos")).toThrowError(thrown("manifest-frozen"));
    expect(() => builder.declareProviderCycle(["math.sin"])).toThrowError(thrown("manifest-frozen"));
    expect(() => builder.assertIntrinsicPlanned("math.cos")).toThrowError(thrown("late-unplanned-intrinsic"));
    expect(() => builder.resolveProvider("math.cos")).toThrowError(thrown("late-unplanned-feature"));
    expect(() => builder.assertProviderPlanned("backend.f64.abs")).toThrowError(thrown("late-unplanned-provider"));
    expect(() => builder.assertHostCapabilityPlanned("host.random")).toThrowError(
      thrown("late-unplanned-host-capability"),
    );
    expect(() => (manifest.features as RuntimeFeature[]).push("math.abs")).toThrow(TypeError);
    expect(() => (sinProvider.dependencies as RuntimeFeature[]).push("math.cos")).toThrow(TypeError);
  });

  it("keeps semantic identity stable when a concrete provider spelling changes", () => {
    const original = new RuntimeManifestBuilder(policy());
    original.addIntrinsicUse(intrinsicUse("math.sin"), PURE_EFFECTS);

    const renamed = new RuntimeManifestBuilder(policy(), {
      providers: providerWith("selfhost.math.sin", (provider) => ({
        ...provider,
        implementation: { kind: "self-hosted", symbol: "renamed_sine_provider" },
      })),
    });
    renamed.addIntrinsicUse(intrinsicUse("math.sin"), PURE_EFFECTS);

    const before = original.freeze();
    const after = renamed.freeze();
    expect(semanticView(after)).toEqual(semanticView(before));
    expect(after.providers.find((provider) => provider.feature === "math.sin")!.implementation).toEqual({
      kind: "self-hosted",
      symbol: "renamed_sine_provider",
    });
    expect(after.providers).not.toEqual(before.providers);
  });
});
