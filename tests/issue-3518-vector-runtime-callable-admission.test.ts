// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import * as canonical from "../src/ir/core/vector-runtime.js";
import * as compatibility from "../src/ir/vector-runtime.js";
import { asBlockId, asValueId, type IrFunction, type IrInstrCall } from "../src/ir/core/nodes.js";
import type { IrType } from "../src/ir/core/types.js";
import { irCallableBindingKey, irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { createIrSourceId, createIrUnitId } from "../src/ir/identity.js";
import { createIrAsyncPlan, canonicalPromiseAbi, asAsyncStateId } from "../src/ir/analysis/async-plan.js";
import { ASYNC_RUNTIME_FEATURES } from "../src/ir/core/async-intents.js";
import {
  VECTOR_CALLABLE_DECLARATION,
  VECTOR_CALLABLE_RUNTIME_PROVIDERS,
  irVectorCallableDeclaration,
  collectVectorCallableDemands,
  assertVectorCallableDemands,
  vectorCallablePolicyMismatch,
  vectorProviderMismatch,
} from "../src/ir/runtime/vector-callables.js";
import {
  NATIVE_ASYNC_CALLABLE_DECLARATIONS,
  collectNativeAsyncCallableDemands,
  nativeAsyncCallMismatch,
  nativeAsyncCallableValueTypes,
  irRuntimeCallableHasNoSlot,
} from "../src/ir/runtime/native-async-callables.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import { RuntimeManifestBuilder, RUNTIME_PROVIDERS } from "../src/ir/runtime/manifest.js";
import {
  VECTOR_CALLABLE_RUNTIME_FEATURES,
  VECTOR_CALLABLE_RUNTIME_PROVIDER_IDS,
  type RuntimeProviderDefinition,
} from "../src/ir/runtime/contracts/manifest.js";
import type { RuntimeManifestPolicy } from "../src/runtime/contracts/provider-policy.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import {
  prepareIrProgramRuntimeCallables,
  assertPreparedIrRuntimeCallableDeclaration,
} from "../src/ir/program-runtime-abi.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import type { TypedIrProgramInput } from "../src/ir/program/input-contracts.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { sourcePacket, typedOptions } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";

const SYMBOL = "__ir_vec_elem_set_externref";
const FEATURE = "js.vector.elem-set.externref";
const PROVIDER = "native.js.vector.elem-set.externref";
const POLICY: RuntimeManifestPolicy = { backend: "wasmgc", target: "standalone" };
const I32: IrType = { kind: "val", val: { kind: "i32" } };
const EXTERNREF: IrType = { kind: "val", val: { kind: "externref" } };
const VECTOR: IrType = { kind: "vec", elementType: EXTERNREF, nullable: true };
const PARAMS: readonly IrType[] = [VECTOR, I32, EXTERNREF];
const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "logical-vector-fixture.ts" });

/** Explicit source-free logical fixture; not public-source or physical execution evidence. */
function body(ordinal = 0): IrFunction {
  return {
    unitId: createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "function", ordinal }),
    name: `logicalVector${ordinal}`,
    params: PARAMS.map((type, value) => ({ name: `p${value}`, value: asValueId(value), type })),
    resultTypes: [],
    exported: false,
    valueCount: 3,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "call",
            target: irIntrinsicFuncRef(SYMBOL),
            args: [asValueId(0), asValueId(1), asValueId(2)],
            result: null,
            resultType: null,
          },
        ],
        terminator: { kind: "return", values: [] },
      },
    ],
  };
}

function call(fn: IrFunction): IrInstrCall {
  const result = fn.blocks[0]!.instrs[0]!;
  if (result.kind !== "call") throw new Error("fixture must contain a call");
  return result;
}

function withCall(fn: IrFunction, next: IrInstrCall): IrFunction {
  return { ...fn, blocks: [{ ...fn.blocks[0]!, instrs: [next] }] };
}

function nested(): IrFunction {
  const fn = body();
  return {
    ...fn,
    blocks: [
      { ...fn.blocks[0]!, instrs: [{ kind: "if.stmt", cond: asValueId(1), then: fn.blocks[0]!.instrs, else: [] }] },
    ],
  };
}

function stateOnly(): IrFunction {
  const fn = body(2),
    params = fn.params.map(({ value, type }) => ({ value, type }));
  return {
    ...fn,
    funcKind: "async",
    blocks: [],
    resultTypes: [I32],
    asyncPlan: createIrAsyncPlan({
      schemaVersion: 1,
      ownerUnitId: fn.unitId,
      kind: "async-function",
      abi: canonicalPromiseAbi(I32),
      entry: asAsyncStateId(0),
      params,
      values: params,
      spills: [],
      handlers: [],
      states: [{ id: asAsyncStateId(0), body: [call(fn)], terminator: { kind: "resolve", value: asValueId(1) } }],
      runtimeIntents: [...ASYNC_RUNTIME_FEATURES, "promise.number.bridge"],
    }),
  };
}

function explicit(functions: readonly IrFunction[], policy = POLICY) {
  return prepareIrRuntimeManifest({
    functions,
    sourceFile: "logical-vector-fixture.ts",
    policy,
    vectorDemands: collectVectorCallableDemands(functions),
    includeEmpty: true,
  });
}

const DECLARATION_RECEIPTS = [
  ["IR_VEC_ELEM_SET_PREFIX", "739fe8bf10acb498184732ab50d4b3a99036fa31b2ce8ef7955eb8d45748dfd4"],
  ["IR_VEC_NEW_SIZED_PREFIX", "6fff0037e9beccc31897482fbdfabf7540f231151abfb685395c649ca120ce65"],
  ["IR_HOLEY_ARRAY_NEW", "8f15ee4532a19ae673e4fabf0de3451d6f2ef81d4e06e09693ab1984d1c9ca1e"],
  ["IR_HOLEY_ARRAY_ELEM_SET", "9989929f36af788b17483bf0e8d0df859d8b016735fa85a3e7c4e3f035590c13"],
  ["IrVectorRuntimeElementKind", "7fae78f87f13e4b6180bedd0e9f003e664801d2f4ca19f0e14ed6b62ea17776e"],
  ["irVectorRuntimeElementKind", "b103846e09e107fc9f6d82ffcfa14a188f4e2e91532edd4508b0afc2e54927e3"],
  ["requireRuntimeElementKind", "848958e5cf72e6119388e73e68ce0f30ddcde1e1a0d1d310909b871497e76391"],
  ["irVecElemSetSymbol", "c13146a551898526c60dc24a287577e37d8cb2d42019638e3e8dd46c08e444bc"],
  ["irVecNewSizedSymbol", "2039f7485ccb34e3641ef9ded2ad39a15243f13f99778494d00f7b42d7bdcb0a"],
  ["parseIrVectorRuntimeElement", "f0ec803130a5dbcbd2a390c1f7df4b83632655c1c362f4e00074dd0258475dfb"],
] as const;

function receipts(text: string) {
  const sf = ts.createSourceFile("vector.ts", text, ts.ScriptTarget.Latest, true);
  return sf.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => {
      const name = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations[0]!.name
        : ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
          ? statement.name
          : undefined;
      return [name?.getText(sf), createHash("sha256").update(statement.getFullText(sf)).digest("hex")];
    });
}

describe("complete canonical vector identity relocation", () => {
  const text = readFileSync(new URL("../src/ir/core/vector-runtime.ts", import.meta.url), "utf8");
  it("pins all ten complete declarations, docs, initializers, five bodies and order without historical git", () => {
    expect(receipts(text)).toEqual(DECLARATION_RECEIPTS);
    const sf = ts.createSourceFile("vector.ts", text, ts.ScriptTarget.Latest, true);
    expect(sf.statements.filter(ts.isFunctionDeclaration)).toHaveLength(5);
    expect(sf.statements.filter(ts.isImportDeclaration).map((s) => s.moduleSpecifier.getText(sf))).toEqual([
      '"./types.js"',
      '"../../wasm/model/instructions.js"',
    ]);
  });
  it.each(["IR_VEC_ELEM_SET_PREFIX", "irVecElemSetSymbol", "IrVectorRuntimeElementKind"])(
    "rejects live receipt mutation of %s",
    (name) => {
      expect(receipts(text.replace(name, `${name}Changed`))).not.toEqual(DECLARATION_RECEIPTS);
    },
  );
  it("forwards all eight runtime objects and the ninth type export explicitly, without wrappers", () => {
    expect(Object.keys(compatibility).sort()).toEqual(Object.keys(canonical).sort());
    expect(Object.keys(canonical)).toHaveLength(8);
    for (const key of Object.keys(canonical) as (keyof typeof canonical)[])
      expect(compatibility[key]).toBe(canonical[key]);
    const sf = ts.createSourceFile(
      "facade.ts",
      readFileSync(new URL("../src/ir/vector-runtime.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(sf.statements.every(ts.isExportDeclaration)).toBe(true);
    const exports = sf.statements.filter(ts.isExportDeclaration).flatMap((statement) => {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause))
        throw new Error("explicit forwards required");
      expect(statement.moduleSpecifier?.getText(sf)).toBe('"./core/vector-runtime.js"');
      return statement.exportClause.elements.map((specifier) => ({
        name: specifier.name.text,
        source: specifier.propertyName?.text ?? specifier.name.text,
        type: statement.isTypeOnly || specifier.isTypeOnly,
      }));
    });
    expect(exports).toHaveLength(9);
    for (const item of exports) {
      expect(item.source).toBe(item.name);
      expect(item.type).toBe(item.name === "IrVectorRuntimeElementKind");
    }
  });
  it.each(["f64", "i32", "externref"] as const)(
    "retains parsing/sized/store identities for %s without admitting extra helpers",
    (kind) => {
      const type: IrType = { kind: "val", val: { kind } };
      expect(canonical.irVecElemSetSymbol(type)).toBe(`__ir_vec_elem_set_${kind}`);
      expect(canonical.irVecNewSizedSymbol(type)).toBe(`__ir_vec_new_sized_${kind}`);
      expect(
        canonical.parseIrVectorRuntimeElement(`__ir_vec_new_sized_${kind}`, canonical.IR_VEC_NEW_SIZED_PREFIX),
      ).toEqual({ kind });
    },
  );
});

describe("one closed vector declaration and exact occurrences", () => {
  it("pins the independent binding/signature/feature oracle and leaves the async denominator six", () => {
    expect(VECTOR_CALLABLE_DECLARATION).toEqual({
      feature: FEATURE,
      ref: irIntrinsicFuncRef(SYMBOL),
      params: PARAMS,
      results: [],
    });
    expect(irRuntimeCallableDeclaration(irIntrinsicFuncRef(SYMBOL))).toBe(VECTOR_CALLABLE_DECLARATION);
    expect(irVectorCallableDeclaration(irRuntimeFuncRef(SYMBOL))).toBeUndefined();
    expect(irRuntimeCallableHasNoSlot(irIntrinsicFuncRef(SYMBOL))).toBe(false);
    expect(NATIVE_ASYNC_CALLABLE_DECLARATIONS).toHaveLength(6);
    expect(collectNativeAsyncCallableDemands([body()])[0]!.uses).toEqual([]);
  });
  it.each([true, false])("admits exact externref vector with nullable=%s", (nullable) => {
    const fn = body();
    const changed = {
      ...fn,
      params: fn.params.map((p, i) =>
        i === 0 ? { ...p, type: { kind: "vec" as const, elementType: EXTERNREF, nullable } } : p,
      ),
    };
    expect(collectVectorCallableDemands([changed])[0]!.uses).toEqual([
      {
        region: "block:0",
        ordinal: 0,
        bindingKey: irCallableBindingKey({ kind: "intrinsic", symbol: SYMBOL }),
        feature: FEATURE,
      },
    ]);
  });
  it("rejects reverse nullable widening through the same argument checker", () => {
    const fn = body();
    expect(
      nativeAsyncCallMismatch(
        call(fn),
        {
          ...VECTOR_CALLABLE_DECLARATION,
          params: [{ kind: "vec", elementType: EXTERNREF, nullable: false }, I32, EXTERNREF],
        },
        nativeAsyncCallableValueTypes(fn),
      ),
    ).toContain("argument 0");
  });
  it.each(["element", "index", "value", "order", "count", "unknown-value", "result", "result-type", "binding-kind"])(
    "rejects actual malformed vector occurrence: %s",
    (mutation) => {
      let fn = body(),
        instruction = call(fn);
      if (mutation === "element")
        fn = {
          ...fn,
          params: fn.params.map((p, i) =>
            i === 0 ? { ...p, type: { kind: "vec", elementType: I32, nullable: true } } : p,
          ),
        };
      if (mutation === "index" || mutation === "value")
        fn = {
          ...fn,
          params: fn.params.map((p, i) =>
            i === (mutation === "index" ? 1 : 2) ? { ...p, type: { kind: "val", val: { kind: "f64" } } } : p,
          ),
        };
      if (mutation === "order") instruction = { ...instruction, args: [asValueId(1), asValueId(0), asValueId(2)] };
      if (mutation === "count") instruction = { ...instruction, args: instruction.args.slice(0, 2) };
      if (mutation === "unknown-value")
        instruction = { ...instruction, args: [asValueId(0), asValueId(9), asValueId(2)] };
      if (mutation === "result") instruction = { ...instruction, result: asValueId(3), resultType: I32 };
      if (mutation === "result-type") instruction = { ...instruction, resultType: I32 };
      if (mutation === "binding-kind") instruction = { ...instruction, target: irRuntimeFuncRef(SYMBOL) };
      expect(() => collectVectorCallableDemands([withCall(fn, instruction)])).toThrow();
    },
  );
  it("retains nested, semantic-state and zero-call owner population", () => {
    const fn = nested(),
      empty = { ...body(1), blocks: [] },
      state = stateOnly();
    const demands = collectVectorCallableDemands([fn, empty, state]);
    expect(demands.map((d) => d.unitId)).toEqual([fn.unitId, empty.unitId, state.unitId]);
    expect(demands.map((d) => d.uses.map((u) => [u.region, u.ordinal]))).toEqual([
      [["block:0", 1]],
      [],
      [["state:0", 0]],
    ]);
    expect(Object.isFrozen(demands[0]!.uses[0])).toBe(true);
    expect(() => assertVectorCallableDemands([fn, empty, state], demands)).not.toThrow();
  });
  it.each([
    "missing-empty-owner",
    "duplicate-owner",
    "missing-use",
    "wrong-position",
    "wrong-feature",
    "wrong-binding",
  ])("rejects incomplete demand data: %s", (mutation) => {
    const functions = [nested(), { ...body(1), blocks: [] }],
      original = collectVectorCallableDemands(functions),
      demands = [...original];
    if (mutation === "missing-empty-owner") demands.pop();
    if (mutation === "duplicate-owner") demands[1] = original[0]!;
    if (mutation === "missing-use") demands[0] = { ...original[0]!, uses: [] };
    if (mutation === "wrong-position")
      demands[0] = { ...original[0]!, uses: [{ ...original[0]!.uses[0]!, ordinal: 0 }] };
    if (mutation === "wrong-feature")
      demands[0] = { ...original[0]!, uses: [{ ...original[0]!.uses[0]!, feature: "async.native.all" }] };
    if (mutation === "wrong-binding")
      demands[0] = { ...original[0]!, uses: [{ ...original[0]!.uses[0]!, bindingKey: `runtime:${SYMBOL}` }] };
    expect(() => assertVectorCallableDemands(functions, demands)).toThrow();
  });
  it("rejects stale pre-transform population and a deleted nested occurrence", () => {
    const original = nested(),
      demands = collectVectorCallableDemands([original]);
    expect(() => assertVectorCallableDemands([original, body(1)], demands)).toThrow("population");
    expect(() =>
      assertVectorCallableDemands([{ ...original, blocks: [{ ...original.blocks[0]!, instrs: [] }] }], demands),
    ).toThrow("semantic population");
    expect(() => collectVectorCallableDemands([original, original])).toThrow("duplicate");
  });
  it("rejects using the actual vector binding as a lifted closure body", () => {
    const fn = body();
    const changed: IrFunction = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0]!,
          instrs: [
            {
              kind: "closure.new",
              liftedFunc: irIntrinsicFuncRef(SYMBOL),
              signature: { params: PARAMS, returnType: null },
              captureFieldTypes: [],
              captures: [],
              result: asValueId(3),
              resultType: EXTERNREF,
            },
          ],
        },
      ],
    };
    expect(() => collectVectorCallableDemands([changed])).toThrow("lifted closure");
  });
  it("uses the structural binding rather than the diagnostic display name", () => {
    const fn = body(),
      original = call(fn);
    const renamed = withCall(fn, { ...original, target: { ...original.target, name: "unrelated label" } });
    expect(collectVectorCallableDemands([renamed])).toEqual(collectVectorCallableDemands([fn]));
    const shadow = withCall(fn, {
      ...original,
      target: { ...irIntrinsicFuncRef("unrelated.intrinsic"), name: SYMBOL },
    });
    expect(collectVectorCallableDemands([shadow])[0]!.uses).toEqual([]);
  });
  it.each([
    "__ir_vec_elem_set_f64",
    "__ir_vec_elem_set_i32",
    "__ir_vec_new_sized_externref",
    "__ir_holey_array_new",
    "__ir_holey_array_elem_set",
    "__ir_vec_elem_set_externref_extra",
  ])("does not prefix-admit %s", (symbol) => {
    expect(irVectorCallableDeclaration(irIntrinsicFuncRef(symbol))).toBeUndefined();
    expect(irRuntimeCallableDeclaration(irIntrinsicFuncRef(symbol))).toBeUndefined();
  });
});

describe("exact vector provider and explicit independent manifest demand", () => {
  it("pins the complete dependency-free provider and standalone policy without native strings", () => {
    expect(VECTOR_CALLABLE_RUNTIME_FEATURES).toEqual([FEATURE]);
    expect(VECTOR_CALLABLE_RUNTIME_PROVIDER_IDS).toEqual([PROVIDER]);
    expect(VECTOR_CALLABLE_RUNTIME_PROVIDERS).toEqual([
      {
        id: PROVIDER,
        feature: FEATURE,
        dependencies: [],
        hostCapabilities: [],
        supportedTargets: ["standalone"],
        supportedBackends: ["wasmgc"],
        implementation: { kind: "runtime-callable", symbol: SYMBOL },
      },
    ]);
    const builder = new RuntimeManifestBuilder(POLICY);
    builder.requestFeature(FEATURE);
    builder.freeze();
    expect(builder.manifest.features).toEqual([FEATURE]);
    expect(builder.resolveProvider(FEATURE)).toMatchObject(VECTOR_CALLABLE_RUNTIME_PROVIDERS[0]!);
    expect(vectorCallablePolicyMismatch(FEATURE, POLICY)).toBeUndefined();
  });
  it.each([
    { target: "host", backend: "wasmgc" },
    { target: "wasi", backend: "wasmgc" },
    { target: "standalone", backend: "linear" },
  ] as const)("rejects policy $target/$backend", (policy) => {
    const builder = new RuntimeManifestBuilder(policy);
    builder.requestFeature(FEATURE);
    expect(() => builder.freeze()).toThrow(expect.objectContaining({ code: "provider-target-unavailable" }));
  });
  it.each([
    "missing",
    "duplicate",
    "feature",
    "implementation",
    "dependencies",
    "host",
    "target",
    "backend",
    "signature",
  ])("rejects %s provider evidence", (mutation) => {
    const row = VECTOR_CALLABLE_RUNTIME_PROVIDERS[0]!;
    let replacement: RuntimeProviderDefinition = row;
    if (mutation === "feature") replacement = { ...row, feature: "async.native.all" };
    if (mutation === "implementation")
      replacement = { ...row, implementation: { kind: "runtime-callable", symbol: "__ir_vec_elem_set_i32" } };
    if (mutation === "dependencies") replacement = { ...row, dependencies: ["promise.resolve"] };
    if (mutation === "host") replacement = { ...row, hostCapabilities: ["error.reference.construct"] };
    if (mutation === "target") replacement = { ...row, supportedTargets: ["host"] };
    if (mutation === "backend") replacement = { ...row, supportedBackends: ["linear"] };
    if (mutation === "signature") replacement = { ...row, signature: { version: 1, params: PARAMS, result: I32 } };
    let providers = RUNTIME_PROVIDERS.map((p) => (p.id === PROVIDER ? replacement : p));
    if (mutation === "missing") providers = providers.filter((p) => p.id !== PROVIDER);
    if (mutation === "duplicate") providers.push(row);
    if (mutation !== "missing" && mutation !== "duplicate")
      expect(vectorProviderMismatch(replacement)).toBeTypeOf("string");
    const builder = new RuntimeManifestBuilder(POLICY, { providers });
    builder.requestFeature(FEATURE);
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
  it("joins explicit vector demands while omitted-demand compatibility does not auto-request the family", () => {
    expect(explicit([body()]).manifest.features).toEqual([FEATURE]);
    expect(
      prepareIrRuntimeManifest({
        functions: [body()],
        sourceFile: "logical-vector-fixture.ts",
        policy: POLICY,
        includeEmpty: true,
      }).manifest.features,
    ).toEqual([]);
  });
  it("independently rejects a missing owner at the actual manifest join", () => {
    const functions = [body(), { ...body(1), blocks: [] }];
    expect(() =>
      prepareIrRuntimeManifest({
        functions,
        sourceFile: "logical-vector-fixture.ts",
        policy: POLICY,
        vectorDemands: collectVectorCallableDemands(functions).slice(0, 1),
      }),
    ).toThrow("population");
  });
});

describe("logical ABI and typed replay, not physical vector materialization", () => {
  let packet: TypedIrProgramInput;
  beforeAll(() => {
    const source = sourcePacket({ "./entry.ts": "export function logical(): void { return; }" }).packet;
    const owner = source.ir.functions[0]!,
      logical = body();
    packet = {
      ...source,
      ir: { functions: [{ ...owner, params: logical.params, valueCount: logical.valueCount, blocks: logical.blocks }] },
    };
  });
  function prepared(): PreparedIrProgram {
    const result = prepareTypedIrProgram(packet, typedOptions);
    expect(result.kind, JSON.stringify(result.kind === "prepared" ? {} : result)).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    return result.program;
  }
  it("collects the canonical declaration through the real collector and requires a function ABI slot", () => {
    const result = prepareIrProgramRuntimeCallables(packet);
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    expect(result.declarations).toEqual([VECTOR_CALLABLE_DECLARATION]);
    const entries = prepareIrProgramAbiEntries(packet, result.declarations);
    const runtime = entries.filter(
      (entry) => entry.contract.kind === "callable" && entry.contract.ref.binding.kind === "intrinsic",
    );
    expect(runtime).toHaveLength(1);
    expect(runtime[0]!.plan).toMatchObject({
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "intrinsic" },
    });
    expect(prepareIrProgramAbiEntries(decodeTypedPacket(encodeTypedPacket(packet)), result.declarations)).toEqual(
      entries,
    );
    expect(() =>
      prepareIrProgramAbiEntries(packet, [VECTOR_CALLABLE_DECLARATION, VECTOR_CALLABLE_DECLARATION]),
    ).toThrow("duplicates declaration");
    expect(() =>
      assertPreparedIrRuntimeCallableDeclaration({ ...VECTOR_CALLABLE_DECLARATION, results: [I32] }),
    ).toThrow("contradicts");
  });
  it("turns a wrong structural kind into an exact located collector refusal", () => {
    const fn = packet.ir.functions[0]!;
    const result = prepareIrProgramRuntimeCallables({
      ...packet,
      ir: { functions: [withCall(fn, { ...call(fn), target: irRuntimeFuncRef(SYMBOL) })] },
    });
    expect(result).toMatchObject({
      kind: "invariant",
      code: "verifier-failure",
      stage: "verify",
      unitId: fn.unitId,
      sourceFile: "entry.ts",
    });
  });
  it.each(["off", "on"] as const)("retains logical input and prepared canonical codec equality, GVN %s", (gvnMode) => {
    const options = { ...typedOptions, controls: { ...typedOptions.controls, gvnMode } };
    const original = prepareTypedIrProgram(packet, options),
      decoded = prepareTypedIrProgram(decodeTypedPacket(encodeTypedPacket(packet)), options);
    expect(original.kind).toBe("prepared");
    expect(decoded.kind).toBe("prepared");
    if (original.kind !== "prepared" || decoded.kind !== "prepared")
      throw new Error("logical vector preparation refused");
    const encoded = encodePreparedIrProgram(original.program);
    expect(encodePreparedIrProgram(decoded.program)).toBe(encoded);
    const replayed = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(replayed)).toBe(encoded);
    expect(() => assertPreparedIrProgram(replayed)).not.toThrow();
    expect(replayed.runtime[0]!.prepared.manifest.features).toEqual([FEATURE]);
  });
  it.each(["missing", "duplicate", "signature", "slot"])(
    "rejects %s ABI evidence through actual prepared validation",
    (mutation) => {
      const program = prepared(),
        entries = [...program.abi.entries];
      const index = entries.findIndex(
        (entry) => entry.contract.kind === "callable" && entry.contract.ref.binding.kind === "intrinsic",
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const entry = entries[index]!;
      if (entry.contract.kind !== "callable" || entry.plan.intent.kind !== "callable")
        throw new Error("missing vector ABI row");
      if (mutation === "missing") entries.splice(index, 1);
      if (mutation === "duplicate") entries.push(entry);
      if (mutation === "signature") entries[index] = { ...entry, contract: { ...entry.contract, results: [I32] } };
      if (mutation === "slot")
        entries[index] = {
          ...entry,
          plan: {
            id: entry.plan.id,
            order: entry.plan.order,
            displayName: entry.plan.displayName,
            structuralReferenceKey: entry.plan.structuralReferenceKey,
            intent: entry.plan.intent,
            slotPolicy: "none",
          },
        };
      expect(() => assertPreparedIrProgram({ ...program, abi: { ...program.abi, entries } })).toThrow();
    },
  );
  it("keeps the all-call ABI check for a helper outside the closed catalog", () => {
    const program = prepared(),
      fn = program.ir.functions[0]!;
    // Retain the declared vector occurrence so declaration-population validation
    // cannot reject before the independent all-call ABI check under test.
    const changed = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0]!,
          instrs: [...fn.blocks[0]!.instrs, { ...call(fn), target: irIntrinsicFuncRef("__ir_vec_elem_set_i32") }],
        },
      ],
    };
    expect(() => assertPreparedIrProgram({ ...program, ir: { functions: [changed] } })).toThrow("undeclared callable");
  });
});
