// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  RuntimeManifestBuilder,
  BOOLEAN_BOUNDARY_POLICY_DISABLED,
  type BooleanBoundaryPolicy,
} from "../src/ir/runtime-manifest.js";
import { INTRINSIC_DEFINITIONS, EXTERNREF_TO_BOOLEAN_INTRINSIC_SIGNATURE } from "../src/ir/core/intrinsics.js";
import { BOOLEAN_BOUNDARY_RUNTIME_PROVIDERS } from "../src/ir/runtime/manifest.js";
import { irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { asBlockId, asValueId, irVal, type IrFunction } from "../src/ir/nodes.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
const identities = createTestIrFunctionIdentityFactory("native-boolean-boundary-contracts");
const native: BooleanBoundaryPolicy = { box: "native", unbox: "native" };
function builder(policy: BooleanBoundaryPolicy = native, backend: "wasmgc" | "linear" = "wasmgc") {
  return new RuntimeManifestBuilder({ target: "host", backend, booleanBoundary: policy });
}
function unboxFunction(): IrFunction {
  return {
    unitId: identities.next("extract").unitId,
    name: "extract",
    exported: false,
    funcKind: "regular",
    valueCount: 2,
    params: [{ name: "boxed", type: irVal({ kind: "externref" }), value: asValueId(0) }],
    resultTypes: [EXTERNREF_TO_BOOLEAN_INTRINSIC_SIGNATURE.result],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "intrinsic",
            id: "js.boolean.unbox",
            version: 1,
            args: [asValueId(0)],
            result: asValueId(1),
            resultType: EXTERNREF_TO_BOOLEAN_INTRINSIC_SIGNATURE.result,
          },
        ],
        terminator: { kind: "return", values: [asValueId(1)] },
      },
    ],
  };
}
describe("explicit native Boolean carrier contracts", () => {
  it("preserves the Boolean logical result brand independently of its physical i32", () => {
    const definition = INTRINSIC_DEFINITIONS["js.boolean.unbox"];
    expect(definition.signature).toBe(EXTERNREF_TO_BOOLEAN_INTRINSIC_SIGNATURE);
    expect(definition.signature.params).toEqual([irVal({ kind: "externref" })]);
    expect(definition.signature.result).toEqual(irVal({ kind: "i32", boolean: true }));
    expect(Object.isFrozen(definition.signature.result)).toBe(true);
    expect(Object.isFrozen(definition.signature.params)).toBe(true);
  });
  it("selects native box and extraction without host capabilities", () => {
    const b = builder();
    b.requestFeature("js.boolean.box");
    b.requestFeature("js.boolean.unbox");
    const manifest = b.freeze();
    expect(manifest.providers.map((p) => p.id).sort()).toEqual(["native.js.boolean.box", "native.js.boolean.unbox"]);
    expect(manifest.hostCapabilities).toEqual([]);
    expect(manifest.policy.booleanBoundary).toEqual(native);
  });
  it.each(["js.boolean.box", "js.boolean.unbox"] as const)("refuses disabled %s", (feature) => {
    const b = builder(BOOLEAN_BOUNDARY_POLICY_DISABLED);
    b.requestFeature(feature);
    expect(() => b.freeze()).toThrow();
  });
  it.each([{ box: "host" }, { box: "native" }] as const)("does not infer extraction from box policy %j", (policy) => {
    const b = builder(policy);
    b.requestFeature("js.boolean.unbox");
    expect(() => b.freeze()).toThrow(/unbox=unsupported/);
  });
  it("retains the exact existing host policy and capability", () => {
    const b = builder({ box: "host" });
    b.requestFeature("js.boolean.box");
    const manifest = b.freeze();
    expect(manifest.policy.booleanBoundary).toEqual({ box: "host" });
    expect(Object.hasOwn(manifest.policy.booleanBoundary, "unbox")).toBe(false);
    expect(manifest.providers.map((p) => p.id)).toEqual(["host.js.boolean.box"]);
    expect(manifest.hostCapabilities).toEqual(["boolean.box"]);
  });
  it("keeps extraction independent of boxing", () => {
    const b = builder({ box: "unsupported", unbox: "native" });
    b.requestFeature("js.boolean.unbox");
    expect(b.freeze().providers.map((p) => p.id)).toEqual(["native.js.boolean.unbox"]);
  });
  it.each(["js.boolean.box", "js.boolean.unbox"] as const)(
    "does not claim a linear native provider for %s",
    (feature) => {
      const b = builder(native, "linear");
      b.requestFeature(feature);
      expect(() => b.freeze()).toThrow();
    },
  );
  it("freezes a copy of caller policy", () => {
    const policy: { box: "native" | "unsupported"; unbox: "native" | "unsupported" } = { ...native } as typeof policy;
    const b = builder(policy);
    policy.unbox = "unsupported";
    policy.box = "unsupported";
    b.requestFeature("js.boolean.unbox");
    const manifest = b.freeze();
    expect(manifest.policy.booleanBoundary).toEqual(native);
    expect(Object.isFrozen(manifest.policy.booleanBoundary)).toBe(true);
  });
  it("publishes runtime symbols without inventing a truthiness host capability", () => {
    const providers = BOOLEAN_BOUNDARY_RUNTIME_PROVIDERS.filter((p) => p.id.startsWith("native."));
    expect(providers.map((p) => p.implementation)).toEqual([
      { kind: "runtime-callable", symbol: "__box_boolean" },
      { kind: "runtime-callable", symbol: "__unbox_boolean" },
    ]);
  });
  it("attaches exact native extraction while retaining its branded result", () => {
    const prepared = prepareIrRuntimeManifest({
      functions: [unboxFunction()],
      sourceFile: "/boolean.ts",
      policy: { target: "host", backend: "wasmgc", booleanBoundary: native },
    });
    expect(prepared).not.toBeNull();
    const instruction = prepared!.functions[0]!.blocks[0]!.instrs[0]!;
    expect(instruction).toMatchObject({
      resultType: irVal({ kind: "i32", boolean: true }),
      provider: { kind: "callable", target: irRuntimeFuncRef("__unbox_boolean", "__unbox_boolean") },
    });
  });
});

it("refuses a Boolean extraction whose logical brand was erased", () => {
  const fn = unboxFunction();
  const instr = fn.blocks[0]!.instrs[0]!;
  if (instr.kind !== "intrinsic") throw new Error("missing intrinsic");
  instr.resultType = irVal({ kind: "i32" });
  expect(() =>
    prepareIrRuntimeManifest({
      functions: [fn],
      sourceFile: "/boolean.ts",
      policy: { target: "host", backend: "wasmgc", booleanBoundary: native },
    }),
  ).toThrow(/Boolean carrier brand/);
});
it.each(["__box_boolean", "__unbox_number"])("refuses extraction crosswired to %s", (symbol) => {
  const fn = unboxFunction();
  const instr = fn.blocks[0]!.instrs[0]!;
  if (instr.kind !== "intrinsic") throw new Error("missing intrinsic");
  instr.provider = { kind: "callable", target: irRuntimeFuncRef(symbol, symbol) };
  expect(() =>
    prepareIrRuntimeManifest({
      functions: [fn],
      sourceFile: "/boolean.ts",
      policy: { target: "host", backend: "wasmgc", booleanBoundary: native },
    }),
  ).toThrow();
});
