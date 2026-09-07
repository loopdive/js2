// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { emitWasiErrorConstructor } from "../src/codegen/registry/error-types.js";
import { asAsyncStateId, canonicalPromiseAbi, createIrAsyncPlan } from "../src/ir/async-plan.js";
import {
  ASYNC_HOST_CAPABILITY_RECORDS,
  ASYNC_RUNTIME_FEATURES,
  asAsyncHostAdapter,
} from "../src/ir/async-runtime-providers.js";
import { irImportFuncRef, irIntrinsicFuncRef, irRuntimeFuncRef, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import {
  createDerivedIrUnitId,
  createIrSourceId,
  createIrUnitId,
  type IrSourceRecord,
  type IrTerminalUnitRecord,
} from "../src/ir/identity.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { asBlockId, asValueId, irVal, type IrFuncRef, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import type { PreparedIrProgramProducerInput } from "../src/ir/program.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime-callable-declarations.js";
import {
  resolveRuntimeHostCapabilityFuncRecord,
  RUNTIME_HOST_CAPABILITY_RECORDS,
} from "../src/ir/runtime-host-capabilities.js";
import {
  RUNTIME_FEATURE_SIGNATURES,
  RUNTIME_PROVIDERS,
  RuntimeManifestBuilder,
  type RuntimeManifestPolicy,
} from "../src/ir/runtime-manifest.js";
import { prepareWholeProgramRuntimeManifest } from "../src/ir/runtime-program-manifest.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { ts } from "../src/ts-api.js";

const FEATURE = "error.reference.construct";
const REF = irRuntimeFuncRef("__new_ReferenceError");
const EXTERN = irVal({ kind: "externref" });
const F64 = irVal({ kind: "f64" });
const HOST: RuntimeManifestPolicy = { target: "host", backend: "wasmgc" };

function source(sourceKey: string, order: number): IrSourceRecord {
  const kind = order === 0 ? "entry" : "source";
  return {
    id: createIrSourceId({ kind, order, sourceKey }),
    kind,
    order,
    sourceKey,
    displayName: sourceKey,
    originalFileName: `/build/${sourceKey}`,
  };
}
const ENTRY = source("entry.ts", 0);
const MATH = source("math.ts", 1);

function initializer(source: IrSourceRecord): IrTerminalUnitRecord {
  const id = createIrUnitId({ sourceId: source.id, lexicalOwnerId: null, kind: "module-init", ordinal: 0 });
  return {
    id,
    sourceId: source.id,
    lexicalOwnerId: null,
    kind: "module-init",
    ordinal: 0,
    displayName: "<module-init>",
    line: 17,
    column: 3,
    declarationStart: 42,
    declarationEnd: 91,
    terminal: true,
    terminalOwnerId: id,
    observedKind: "module-init",
    legacyKey: String(id),
    legacyMatchName: "<module-init>",
    legacyOrdinal: 0,
    staticClassMember: false,
    legacyBodyAvailable: true,
  };
}
const ENTRY_UNIT = initializer(ENTRY);
const MATH_UNIT = initializer(MATH);

function call(target = REF): IrInstr {
  return { kind: "call", target, args: [asValueId(0)], result: asValueId(1), resultType: EXTERN };
}

function body(unit: IrTerminalUnitRecord, instrs: readonly IrInstr[] = []): IrFunction {
  return {
    unitId: unit.id,
    name: unit.displayName,
    params: [{ name: "message", value: asValueId(0), type: EXTERN }],
    resultTypes: [],
    valueCount: 3,
    exported: false,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [] },
      },
    ],
  };
}

function program(functions: readonly IrFunction[], policy = HOST): PreparedIrProgramProducerInput {
  return {
    inventory: {
      sources: [ENTRY, MATH],
      classes: [],
      allUnits: [ENTRY_UNIT, MATH_UNIT],
      terminalUnits: [ENTRY_UNIT, MATH_UNIT],
    },
    ir: { functions },
    derivedUnits: [],
    abi: { get: () => undefined },
    policy,
  };
}

function prepareProgram(input: PreparedIrProgramProducerInput) {
  return prepareWholeProgramRuntimeManifest({
    ...input,
    demands: new Map(input.ir.functions.map((fn) => [fn.unitId, {}])),
  });
}

function asyncBody(): IrFunction {
  const param = { value: asValueId(0), type: EXTERN };
  return {
    ...body(MATH_UNIT),
    funcKind: "async",
    resultTypes: [EXTERN],
    asyncPlan: createIrAsyncPlan({
      schemaVersion: 1,
      ownerUnitId: MATH_UNIT.id,
      kind: "async-function",
      abi: canonicalPromiseAbi(EXTERN),
      entry: asAsyncStateId(0),
      params: [param],
      values: [param, { value: asValueId(1), type: EXTERN }],
      spills: [],
      handlers: [],
      states: [{ id: asAsyncStateId(0), body: [call()], terminator: { kind: "resolve", value: asValueId(1) } }],
      runtimeIntents: ASYNC_RUNTIME_FEATURES,
    }),
  };
}

describe("#3518 ReferenceError runtime callable declaration", () => {
  it("recognizes exact runtime identity and returns one deeply immutable canonical contract", () => {
    const declaration = irRuntimeCallableDeclaration(REF)!;
    expect(declaration).toEqual({ feature: FEATURE, ref: REF, params: [EXTERN], results: [EXTERN] });
    expect(irRuntimeCallableDeclaration(irRuntimeFuncRef("__new_ReferenceError", "different display name"))).toBe(
      declaration,
    );
    for (const value of [
      declaration,
      declaration.ref,
      declaration.ref.binding,
      declaration.params,
      declaration.results,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    for (const type of [...declaration.params, ...declaration.results]) {
      expect(Object.isFrozen(type)).toBe(true);
      expect(type.kind).toBe("val");
      if (type.kind === "val") expect(Object.isFrozen(type.val)).toBe(true);
    }
    expect(Reflect.set(declaration, "feature", "math.sqrt")).toBe(false);
    expect(declaration.feature).toBe(FEATURE);
  });

  it.each<IrFuncRef>([
    irRuntimeFuncRef("__new_ReferenceError_extra", "__new_ReferenceError"),
    irRuntimeFuncRef("__new_TypeError", "__new_ReferenceError"),
    irIntrinsicFuncRef("__new_ReferenceError"),
    irImportFuncRef("env", "__new_ReferenceError"),
    irUnitFuncRef({ unitId: MATH_UNIT.id, name: "__new_ReferenceError" }),
  ])("declines another structural binding even with the constructor display name: %j", (ref) => {
    expect(irRuntimeCallableDeclaration(ref)).toBeUndefined();
    expect(
      prepareIrRuntimeManifest({ functions: [body(MATH_UNIT, [call(ref)])], sourceFile: "math.ts", policy: HOST }),
    ).toBeUndefined();
  });

  it("derives its signature from the single canonical non-async host function record", () => {
    const record = resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, FEATURE);
    expect(record).toEqual({
      capability: FEATURE,
      kind: "func",
      module: "env",
      field: "__new_ReferenceError",
      params: ["externref"],
      results: ["externref"],
    });
    const declaration = irRuntimeCallableDeclaration(REF)!;
    expect(RUNTIME_FEATURE_SIGNATURES[FEATURE]?.params).toBe(declaration.params);
    expect(RUNTIME_FEATURE_SIGNATURES[FEATURE]?.result).toBe(declaration.results[0]);
    expect(ASYNC_HOST_CAPABILITY_RECORDS).toHaveLength(8);
    expect(ASYNC_HOST_CAPABILITY_RECORDS).not.toContain(record);
    expect(() => asAsyncHostAdapter(record)).toThrow(/not an async capability/);
  });
});

describe("#3518 ReferenceError manifest provider admission", () => {
  it.each(["host", "standalone", "wasi"] as const)("selects the exact existing WasmGC constructor for %s", (target) => {
    const builder = new RuntimeManifestBuilder({ target, backend: "wasmgc" });
    builder.requestFeature(FEATURE);
    const frozen = builder.freeze();
    expect(frozen.features).toEqual([FEATURE]);
    const provider = builder.resolveProvider(FEATURE);
    expect(frozen.providers).toEqual([provider]);
    expect(provider.signature).toEqual({ version: 1, params: [EXTERN], result: EXTERN });
    expect(provider.id).toBe(`${target === "host" ? "host" : "native"}.${FEATURE}`);
    expect(provider.implementation).toEqual(
      target === "host"
        ? { kind: "host-callable", capability: FEATURE }
        : { kind: "runtime-callable", symbol: "__new_ReferenceError" },
    );
    expect(frozen.hostCapabilities).toEqual(target === "host" ? [FEATURE] : []);
    expect(frozen.hostCapabilityRecords).toEqual(
      target === "host" ? [resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, FEATURE)] : [],
    );
  });

  it.each(["host", "standalone", "wasi"] as const)("does not claim a linear adapter for %s", (target) => {
    const builder = new RuntimeManifestBuilder({ target, backend: "linear" });
    builder.requestFeature(FEATURE);
    expect(() => builder.freeze()).toThrow(
      expect.objectContaining({ code: "missing-backend-adapter", feature: FEATURE, requestedFeature: FEATURE }),
    );
  });

  it("refuses strict-no-host without inventing a different target or a host import", () => {
    const builder = new RuntimeManifestBuilder({ target: "strict-no-host", backend: "wasmgc" });
    builder.requestFeature(FEATURE);
    expect(() => builder.freeze()).toThrow(
      expect.objectContaining({ code: "provider-target-unavailable", requestedFeature: FEATURE }),
    );
  });

  it.each(["standalone", "wasi"] as const)(
    "measures the existing %s helper's exact ABI and WasmGC operations",
    (target) => {
      const module = createEmptyModule();
      const ctx = createCodegenContext(module, {} as ts.TypeChecker, { target });
      emitWasiErrorConstructor(ctx, "ReferenceError", 1);
      const constructors = module.functions.filter((fn) => fn.name === "__new_ReferenceError");
      expect(constructors).toHaveLength(1);
      const constructorFn = constructors[0]!;
      expect(module.types[constructorFn.typeIdx]).toMatchObject({
        kind: "func",
        params: [{ kind: "externref" }],
        results: [{ kind: "externref" }],
      });
      expect(constructorFn.body.map((instr) => instr.op)).toContain("struct.new");
      expect(constructorFn.body.map((instr) => instr.op)).toContain("extern.convert_any");
    },
  );

  it.each(["params", "result"] as const)("rejects a provider with contradictory %s before publication", (axis) => {
    const builder = new RuntimeManifestBuilder(HOST, {
      providers: RUNTIME_PROVIDERS.map((provider) =>
        provider.id === "host.error.reference.construct"
          ? {
              ...provider,
              signature: {
                version: 1,
                params: axis === "params" ? [F64] : [EXTERN],
                result: axis === "result" ? F64 : EXTERN,
              },
            }
          : provider,
      ),
    });
    builder.requestFeature(FEATURE);
    expect(() => builder.freeze()).toThrow(
      expect.objectContaining({ code: "provider-signature-mismatch", requestedFeature: FEATURE }),
    );
  });

  it("rejects a missing provider and a changed canonical import ABI", () => {
    const missing = new RuntimeManifestBuilder(HOST, {
      providers: RUNTIME_PROVIDERS.filter((provider) => provider.feature !== FEATURE),
    });
    missing.requestFeature(FEATURE);
    expect(() => missing.freeze()).toThrow(
      expect.objectContaining({ code: "missing-runtime-provider", requestedFeature: FEATURE }),
    );
    const changed = new RuntimeManifestBuilder(HOST, {
      hostCapabilityRecords: RUNTIME_HOST_CAPABILITY_RECORDS.map((record) =>
        record.capability === FEATURE && record.kind === "func" ? { ...record, params: ["i32"] } : record,
      ),
    });
    changed.requestFeature(FEATURE);
    expect(() => changed.freeze()).toThrow(expect.objectContaining({ code: "invalid-host-capability-catalog" }));
  });
});

describe("#3518 complete runtime call demand and owner scans", () => {
  it("publishes a call-only manifest without requiring includeEmpty or a parallel demand field", () => {
    const fn = body(MATH_UNIT, [call()]);
    const before = JSON.stringify(fn);
    const result = prepareIrRuntimeManifest({ functions: [fn], sourceFile: "math.ts", policy: HOST })!;
    expect(result.manifest.features).toEqual([FEATURE]);
    expect(result.manifest.intrinsicUses).toEqual([]);
    expect(JSON.stringify(fn)).toBe(before);
    const complete = prepareProgram(program([body(ENTRY_UNIT), fn]));
    expect(complete.kind).toBe("prepared");
    if (complete.kind === "prepared") expect(complete.runtime.manifest.features).toEqual([FEATURE]);
  });

  it("keeps closure target declarations in the same feature and request-owner population", () => {
    const signature = { params: [], returnType: EXTERN };
    const fn = body(MATH_UNIT, [
      {
        kind: "closure.new",
        liftedFunc: REF,
        signature,
        captureFieldTypes: [],
        captures: [],
        result: asValueId(1),
        resultType: { kind: "closure", signature },
      },
    ]);
    const runtime = prepareIrRuntimeManifest({ functions: [fn], sourceFile: "math.ts", policy: HOST })!;
    expect(runtime.manifest.features).toEqual([FEATURE]);
    expect(prepareProgram(program([body(ENTRY_UNIT), fn], { target: "host", backend: "linear" }))).toMatchObject({
      kind: "unsupported",
      unitId: MATH_UNIT.id,
      sourceFile: "math.ts",
      detail: "runtime feature error.reference.construct has no linear adapter",
    });
  });

  it("finds nested runtime calls in a later block and deduplicates requesting functions", () => {
    const fn = body(MATH_UNIT);
    const nested: IrInstr[] = [
      { kind: "const", value: { kind: "i32", value: 1 }, result: asValueId(2), resultType: irVal({ kind: "i32" }) },
      { kind: "if.stmt", cond: asValueId(2), then: [call()], else: [] },
    ];
    const later: IrFunction = {
      ...fn,
      blocks: [
        { ...fn.blocks[0]!, terminator: { kind: "br", branch: { target: asBlockId(1), args: [] } } },
        { ...fn.blocks[0]!, id: asBlockId(1), instrs: nested },
      ],
    };
    const result = prepareIrRuntimeManifest({
      functions: [later, body(ENTRY_UNIT, [call()])],
      sourceFile: "math.ts",
      policy: HOST,
    })!;
    expect(result.manifest.features).toEqual([FEATURE]);
    expect(result.manifest.providers).toHaveLength(1);
  });

  it("finds calls only in async states while retaining the async-only attachment", () => {
    const fn = asyncBody();
    const result = prepareIrRuntimeManifest({ functions: [fn], sourceFile: "math.ts", policy: HOST })!;
    expect(result.manifest.features).toContain(FEATURE);
    const runtime = result.functions[0]!.asyncRuntime!;
    expect(runtime.providers!.map((provider) => provider.feature)).toEqual([...ASYNC_RUNTIME_FEATURES].sort());
    expect(runtime.adapters).toHaveLength(7);
    expect(runtime.adapters.map((adapter) => adapter.capability)).not.toContain(FEATURE);
    expect(result.functions[0]!.asyncPlan).toEqual(fn.asyncPlan);
  });

  it.each(["original", "derived", "async-state"] as const)(
    "locates an unavailable call by its %s owner's math.ts initializer",
    (kind) => {
      const derived = {
        parentId: MATH_UNIT.id,
        role: "ir-async-state" as const,
        ordinal: 0,
        terminalOwnerId: MATH_UNIT.id,
        sourceId: MATH.id,
      };
      const derivedId = createDerivedIrUnitId(derived);
      const fn = kind === "async-state" ? asyncBody() : body(MATH_UNIT, kind === "original" ? [call()] : []);
      const functions = [
        body(ENTRY_UNIT),
        fn,
        ...(kind === "derived" ? [{ ...body(MATH_UNIT, [call()]), unitId: derivedId }] : []),
      ];
      const input = {
        ...program(functions, { target: "host", backend: "linear" }),
        derivedUnits: kind === "derived" ? [{ ...derived, id: derivedId }] : [],
      };
      expect(prepareProgram(input)).toEqual({
        kind: "unsupported",
        code: "body-shape-rejected",
        stage: "build",
        detail: "runtime feature error.reference.construct has no linear adapter",
        unitId: MATH_UNIT.id,
        sourceFile: "math.ts",
        location: { sourceId: MATH.id, line: 17, column: 3, declarationStart: 42, declarationEnd: 91 },
      });
    },
  );

  it("rejects missing owner data instead of inventing a first-source location", () => {
    const input = program([body(ENTRY_UNIT), body(MATH_UNIT, [call()])]);
    expect(() => prepareProgram({ ...input, inventory: { ...input.inventory, sources: [ENTRY] } })).toThrow(
      /has no source record/,
    );
  });
});

it("loads the callable declaration in a fresh process with an effective frontend import barrier", () => {
  const declarationUrl = new URL("../src/ir/runtime-callable-declarations.ts", import.meta.url).href;
  const frontendUrl = new URL("../src/ts-api.ts", import.meta.url).href;
  const loader = `export async function load(url, context, next) {
    const path = decodeURIComponent(url);
    if (/\\/src\\/(?:ts-api|checker\\/|compiler\\/|ir\\/(?:from-ast|integration))|\\/node_modules\\/typescript\\//.test(path)) throw new Error('blocked frontend module: ' + url);
    const result = await next(url, context);
    if (/\\/src\\//.test(path)) process.stderr.write('REFERENCE_DECLARATION_LOADED:' + JSON.stringify(url) + '\\n');
    return result;
  }`;
  const script = `
    import assert from 'node:assert/strict';
    import { register } from 'node:module';
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
    const { irRuntimeCallableDeclaration } = await import(${JSON.stringify(declarationUrl)});
    const declaration = irRuntimeCallableDeclaration({kind:'func',name:'ignored',binding:{kind:'runtime',symbol:'__new_ReferenceError'}});
    assert.equal(declaration.feature, 'error.reference.construct');
    await assert.rejects(import(${JSON.stringify(frontendUrl)}), /blocked frontend module/);
    console.log(JSON.stringify({ feature: declaration.feature, barrierControl: true }));
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ feature: FEATURE, barrierControl: true });
  const loaded = child.stderr
    .split("\n")
    .filter((line) => line.startsWith("REFERENCE_DECLARATION_LOADED:"))
    .map((line) => JSON.parse(line.slice("REFERENCE_DECLARATION_LOADED:".length)));
  expect(loaded).toContain(declarationUrl);
  expect(loaded).toContain(new URL("../src/ir/runtime-host-capabilities.ts", import.meta.url).href);
});
