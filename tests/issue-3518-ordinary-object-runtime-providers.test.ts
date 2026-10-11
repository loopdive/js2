// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { RUNTIME_PROVIDERS, RuntimeManifestBuilder } from "../src/ir/runtime/manifest.js";
import {
  ORDINARY_OBJECT_RUNTIME_FEATURES,
  ORDINARY_OBJECT_RUNTIME_PROVIDER_IDS,
  type RuntimeProviderDefinition,
} from "../src/ir/runtime/contracts/manifest.js";
import {
  ORDINARY_OBJECT_RUNTIME_PROVIDERS,
  irOrdinaryObjectCallableDeclaration,
} from "../src/ir/runtime/ordinary-object-callables.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
const policy = { backend: "wasmgc", target: "standalone" } as const;

describe("ordinary object symbolic provider obligations", () => {
  it.each(ORDINARY_OBJECT_RUNTIME_FEATURES)("resolves exact %s without granting a host capability", (feature) => {
    const builder = new RuntimeManifestBuilder(policy);
    builder.requestFeature(feature);
    builder.freeze();
    const row = builder.resolveProvider(feature);
    expect(row).toEqual({
      id: `native.${feature}`,
      feature,
      dependencies: [],
      hostCapabilities: [],
      supportedTargets: ["standalone"],
      supportedBackends: ["wasmgc"],
      implementation: { kind: "runtime-callable", symbol: feature },
    });
    expect(builder.manifest.features).toEqual([feature]);
    expect(builder.manifest.hostCapabilities).toEqual([]);
    expect(irOrdinaryObjectCallableDeclaration(irIntrinsicFuncRef(feature))?.feature).toBe(feature);
    expect(irOrdinaryObjectCallableDeclaration(irRuntimeFuncRef(feature))).toBeUndefined();
    expect(Object.isFrozen(ORDINARY_OBJECT_RUNTIME_PROVIDERS.find((p) => p.feature === feature))).toBe(true);
  });
  it("pins all eight identifiers without duplicates", () => {
    expect(ORDINARY_OBJECT_RUNTIME_PROVIDER_IDS).toEqual(ORDINARY_OBJECT_RUNTIME_FEATURES.map((f) => `native.${f}`));
    expect(new Set(ORDINARY_OBJECT_RUNTIME_PROVIDER_IDS).size).toBe(8);
  });
  for (const feature of ORDINARY_OBJECT_RUNTIME_FEATURES) {
    it.each([
      { target: "host", backend: "wasmgc" },
      { target: "wasi", backend: "wasmgc" },
      { target: "standalone", backend: "linear" },
    ] as const)(`refuses ${feature} under $target/$backend`, (other) => {
      const builder = new RuntimeManifestBuilder(other);
      builder.requestFeature(feature);
      expect(() => builder.freeze()).toThrow(expect.objectContaining({ code: "provider-target-unavailable" }));
    });
    it.each([
      "missing",
      "duplicate",
      "id",
      "feature",
      "symbol",
      "dependencies",
      "capabilities",
      "targets",
      "backends",
      "signature",
    ])(`refuses ${feature} %s evidence`, (mutation) => {
      const row = ORDINARY_OBJECT_RUNTIME_PROVIDERS.find((p) => p.feature === feature)!;
      let replacement: RuntimeProviderDefinition = row;
      if (mutation === "id") replacement = { ...row, id: "native.js.vector.elem-set.externref" };
      if (mutation === "feature") replacement = { ...row, feature: "js.number.from-value" };
      if (mutation === "symbol")
        replacement = { ...row, implementation: { kind: "runtime-callable", symbol: "__fake_object_get" } };
      if (mutation === "dependencies") replacement = { ...row, dependencies: ["promise.resolve"] };
      if (mutation === "capabilities") replacement = { ...row, hostCapabilities: ["error.reference.construct"] };
      if (mutation === "targets") replacement = { ...row, supportedTargets: ["host"] };
      if (mutation === "backends") replacement = { ...row, supportedBackends: ["linear"] };
      if (mutation === "signature")
        replacement = { ...row, signature: { version: 1, params: [], result: { kind: "val", val: { kind: "i32" } } } };
      let providers = RUNTIME_PROVIDERS.map((p) => (p.id === row.id ? replacement : p));
      if (mutation === "missing") providers = providers.filter((p) => p.id !== row.id);
      if (mutation === "duplicate") providers.push(row);
      const builder = new RuntimeManifestBuilder(policy, { providers });
      builder.requestFeature(feature);
      expect(() => builder.freeze()).toThrow(
        expect.objectContaining({
          code:
            mutation === "missing"
              ? "missing-runtime-provider"
              : mutation === "duplicate"
                ? "duplicate-runtime-provider"
                : "provider-signature-mismatch",
        }),
      );
    });
  }
});

describe("ordinary getter source symbolic preparation", () => {
  it.each([
    { label: "getter", members: "get value() {return 7;}", setters: 0 },
    { label: "getter and setter", members: "get value() {return 7;}, set value(value: number) {}", setters: 1 },
  ])(
    "transports genuine $label obligations through the codec while refusing physical materialization",
    ({ members, setters }) => {
      const files = {
        "./entry.ts": `export function run() {const object = {${members}}; return object.value;}`,
      };
      const nativePolicy = {
        ...policy,
        numberBoundary: { box: "unsupported", unbox: "native" },
        stringConst: { storage: "native" },
      } as const;
      const prepared = prepareWholeIrProgram({
        ...sourceInput(files),
        policy: nativePolicy,
        runtimePolicies: [nativePolicy],
        nativeStringValueProjection: "standalone-native",
      });
      expect(prepared.kind, JSON.stringify(prepared)).toBe("prepared");
      if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
      const encoded = encodePreparedIrProgram(prepared.program);
      const decoded = decodePreparedIrProgram(encoded);
      const expectedFeatures = ["js.object.create-default", "js.object.define-accessor", "js.object.get"];
      for (const program of [prepared.program, decoded]) {
        expect(program.inventory.allUnits.filter((unit) => unit.kind === "object-getter")).toHaveLength(1);
        expect(program.inventory.allUnits.filter((unit) => unit.kind === "object-setter")).toHaveLength(setters);
        const accessorUnits = program.inventory.allUnits.filter(
          (unit) => unit.kind === "object-getter" || unit.kind === "object-setter",
        );
        for (const unit of accessorUnits) {
          const fn = program.ir.functions.find((candidate) => candidate.unitId === unit.id)!;
          expect(fn.closureSubtype?.parameters).toEqual({
            kind: "fixed",
            count: unit.kind === "object-getter" ? 0 : 1,
            publicLength: unit.kind === "object-getter" ? 0 : 1,
          });
        }
        const instructions = program.ir.functions.flatMap((fn) => fn.blocks.flatMap((block) => block.instrs));
        expect(instructions.some((instruction) => instruction.kind === "closure.new")).toBe(true);
        const calls = instructions
          .filter((instruction) => instruction.kind === "call")
          .filter(
            (instruction) =>
              instruction.target.binding.kind === "intrinsic" && instruction.target.name.startsWith("js.object."),
          );
        expect(calls.map((call) => call.target.name)).toEqual([
          "js.object.create-default",
          ...Array.from({ length: 1 + setters }, () => "js.object.define-accessor"),
          "js.object.get",
        ]);
        expect(program.runtime).toHaveLength(1);
        const manifest = program.runtime[0]!.prepared.manifest;
        expect(
          manifest.providers
            .filter((row) => expectedFeatures.includes(row.feature))
            .map((row) => row.id)
            .sort(),
        ).toEqual(expectedFeatures.map((feature) => `native.${feature}`).sort());
        expect(manifest.hostCapabilities).toEqual([]);
        const result = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
        expect(result.kind, JSON.stringify(result)).toBe("unsupported");
        if (result.kind !== "unsupported")
          throw new Error("symbolic ordinary providers must not grant physical execution");
        expect(result.code).toBe("body-shape-rejected");
        for (const feature of expectedFeatures)
          expect(result.detail).toContain(`intrinsic callable ${feature} needs runtime function materialization`);
      }
    },
  );
});

describe("empty void closure bodies", () => {
  it.each(["function (): void {}", "(): void => {}"])(
    "executes %s before and after codec transport",
    async (literal) => {
      const text = `export function run(): number {const empty = ${literal}; empty.call(null); return 7;}`;
      const result = prepareWholeIrProgram({
        ...sourceInput({ "./entry.ts": text }),
        policy: { target: "standalone", backend: "wasmgc", numberBoundary: { box: "native", unbox: "native" } },
      });
      expect(result.kind, JSON.stringify(result)).toBe("prepared");
      if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
      for (const program of [result.program, decodePreparedIrProgram(encodePreparedIrProgram(result.program))]) {
        const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
        expect(outcome.kind).toBe("ran");
        if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome));
        expect(outcome.run.exports.run()).toBe(7);
        expect(outcome.run.emitted.module.imports).toEqual([]);
      }
    },
  );
});
