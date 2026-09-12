// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3518 package C — a hand-assembled, COMPLETE `PreparedIrProgram` used by the
// codec/consumer tests and the fresh-process replay runner. It is test DATA
// built only from package A's published types, A's contract helpers and the
// existing IR builders, and it must pass A's complete validator; it is not a
// producer and does not stand in for A's preparation driver or for D's
// application fixtures. It touches every codec-relevant shape: cross-unit
// calls, ReadonlyMaps (units, providers), a recursive class shape (exported for the
// codec-only data probe), i64 (bigint), NaN/Infinity/-0 f64 constants, a present-but-
// undefined optional property, and one runtime projection per backend.

import { AllocSiteRegistry } from "../../src/ir/alloc-registry.js";
import { IrFunctionBuilder } from "../../src/ir/builder.js";
import { irCallableBindingKey, irUnitCallableBindingId, irUnitFuncRef } from "../../src/ir/callable-bindings.js";
import {
  createIrBindingId,
  createIrClassId,
  createIrSourceId,
  createIrUnitId,
  type IrFunctionIdentity,
  type IrSourceRecord,
  type IrTerminalUnitRecord,
  type IrUnitId,
} from "../../src/ir/identity.js";
import type { IrModuleInitPlan } from "../../src/ir/module-init-plan.js";
import { IR_CLASS_SHAPE_CELL, irVal, type IrClassShape, type IrFunction, type IrType } from "../../src/ir/nodes.js";
import { preparedIrCallableSignature, preparedIrDraftAbiLookup } from "../../src/ir/program-abi-contracts.js";
import { irProgramRuntimeDemands } from "../../src/ir/program-runtime-demands.js";
import {
  freezePreparedIrRuntimeValue,
  freezePreparedIrValue,
  preparedIrReadonlyMap,
  type PreparedIrAbiEntry,
  type PreparedIrProgram,
  type PreparedIrProgramRuntimeProjection,
} from "../../src/ir/program.js";
import type { RuntimeManifestPolicy } from "../../src/ir/runtime-manifest.js";
import { prepareWholeProgramRuntimeManifest } from "../../src/ir/runtime-program-manifest.js";

export const CODEC_FIXTURE_SOURCE_KEY = "@test/ir-whole-program-codec";

/** Native oracle for the runnable bodies, in the replay runner's oracle format. */
export const CODEC_FIXTURE_ORACLE = Object.freeze({
  calls: [
    { export: "main", args: [], expected: 42 },
    { export: "helper", args: [21], expected: 42 },
    { export: "big", args: [], expected: { $bigint: "9007199254740993" } },
    { export: "special", args: [], expected: { $number: "Infinity" } },
    { export: "nan", args: [], expected: { $number: "NaN" } },
    { export: "negZero", args: [], expected: { $number: "-0" } },
  ],
});

export const CODEC_FIXTURE_POLICIES: readonly RuntimeManifestPolicy[] = Object.freeze([
  { target: "host", backend: "wasmgc" },
  { target: "host", backend: "linear" },
]);

export interface CodecFixture {
  readonly program: PreparedIrProgram;
  readonly functions: readonly IrFunction[];
  readonly classShape: IrClassShape;
}

function terminal(record: {
  readonly id: IrUnitId;
  readonly sourceId: IrSourceRecord["id"];
  readonly name: string;
  readonly ordinal: number;
}): IrTerminalUnitRecord {
  return {
    id: record.id,
    sourceId: record.sourceId,
    lexicalOwnerId: null,
    kind: "top-level-function",
    ordinal: record.ordinal,
    displayName: record.name,
    line: record.ordinal + 1,
    column: 0,
    declarationStart: record.ordinal * 100,
    declarationEnd: record.ordinal * 100 + 50,
    terminal: true,
    terminalOwnerId: record.id,
    observedKind: "function",
    legacyKey: `${CODEC_FIXTURE_SOURCE_KEY}::${record.name}`,
    legacyMatchName: record.name,
    legacyOrdinal: record.ordinal,
    staticClassMember: false,
    legacyBodyAvailable: false,
  };
}

export function buildCodecFixture(policies: readonly RuntimeManifestPolicy[] = CODEC_FIXTURE_POLICIES): CodecFixture {
  const f64: IrType = irVal({ kind: "f64" });
  const i64: IrType = irVal({ kind: "i64" });
  const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: CODEC_FIXTURE_SOURCE_KEY });
  const source: IrSourceRecord = {
    id: sourceId,
    kind: "entry",
    order: 0,
    sourceKey: CODEC_FIXTURE_SOURCE_KEY,
    displayName: "codec-fixture.ts",
    originalFileName: "codec-fixture.ts",
  };
  const identity = (name: string, ordinal: number): IrFunctionIdentity => ({
    unitId: createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "top-level-function", ordinal }),
    name,
  });
  const helperId = identity("helper", 0);
  const mainId = identity("main", 1);
  const bigId = identity("big", 2);
  const specialId = identity("special", 3);
  const nanId = identity("nan", 4);
  const negZeroId = identity("negZero", 5);
  const registry = new AllocSiteRegistry();

  // helper(x: f64): f64 = x * 2
  const helperBuilder = new IrFunctionBuilder(helperId, [f64], true, registry);
  const x = helperBuilder.addParam("x", f64);
  helperBuilder.openBlock();
  const two = helperBuilder.emitConst({ kind: "f64", value: 2 }, f64);
  helperBuilder.terminate({ kind: "return", values: [helperBuilder.emitBinary("f64.mul", x, two, f64)] });
  const helper = helperBuilder.finish();

  // main(): f64 = helper(20) + 2   (cross-unit call)
  const mainBuilder = new IrFunctionBuilder(mainId, [f64], true, registry);
  mainBuilder.openBlock();
  const twenty = mainBuilder.emitConst({ kind: "f64", value: 20 }, f64);
  const doubled = mainBuilder.emitCall(irUnitFuncRef(helperId), [twenty], f64)!;
  const plusTwo = mainBuilder.emitConst({ kind: "f64", value: 2 }, f64);
  mainBuilder.terminate({ kind: "return", values: [mainBuilder.emitBinary("f64.add", doubled, plusTwo, f64)] });
  const main = mainBuilder.finish();

  // big(): i64 = 2^53 + 1   (bigint constant)
  const bigBuilder = new IrFunctionBuilder(bigId, [i64], true, registry);
  bigBuilder.openBlock();
  bigBuilder.terminate({
    kind: "return",
    values: [bigBuilder.emitConst({ kind: "i64", value: 9007199254740993n }, i64)],
  });
  const big = bigBuilder.finish();

  // special(): f64 = (-0) + Infinity   (non-finite and negative-zero constants)
  const specialBuilder = new IrFunctionBuilder(specialId, [f64], true, registry);
  specialBuilder.openBlock();
  const negativeZero = specialBuilder.emitConst({ kind: "f64", value: -0 }, f64);
  const infinity = specialBuilder.emitConst({ kind: "f64", value: Number.POSITIVE_INFINITY }, f64);
  specialBuilder.terminate({
    kind: "return",
    values: [specialBuilder.emitBinary("f64.add", negativeZero, infinity, f64)],
  });
  const special = specialBuilder.finish();

  // nan(): f64 = NaN and negZero(): f64 = -0   (positive controls for the tagged oracle spellings)
  const nanBuilder = new IrFunctionBuilder(nanId, [f64], true, registry);
  nanBuilder.openBlock();
  nanBuilder.terminate({ kind: "return", values: [nanBuilder.emitConst({ kind: "f64", value: Number.NaN }, f64)] });
  const nan = nanBuilder.finish();
  const negZeroBuilder = new IrFunctionBuilder(negZeroId, [f64], true, registry);
  negZeroBuilder.openBlock();
  negZeroBuilder.terminate({ kind: "return", values: [negZeroBuilder.emitConst({ kind: "f64", value: -0 }, f64)] });
  const negZero = negZeroBuilder.finish();

  const functions = [helper, main, big, special, nan, negZero];
  const terminals = [
    terminal({ id: helperId.unitId, sourceId, name: "helper", ordinal: 0 }),
    terminal({ id: mainId.unitId, sourceId, name: "main", ordinal: 1 }),
    terminal({ id: bigId.unitId, sourceId, name: "big", ordinal: 2 }),
    terminal({ id: specialId.unitId, sourceId, name: "special", ordinal: 3 }),
    terminal({ id: nanId.unitId, sourceId, name: "nan", ordinal: 4 }),
    terminal({ id: negZeroId.unitId, sourceId, name: "negZero", ordinal: 5 }),
  ];

  // A recursive class shape: `next` points back at the shape itself.
  const classId = createIrClassId({ sourceId, lexicalOwnerId: null, declarationKind: "declaration", ordinal: 0 });
  const mutableShape = {
    [IR_CLASS_SHAPE_CELL]: true as const,
    classId,
    className: "Node",
    fields: [] as { readonly name: string; readonly type: IrType }[],
    methods: [],
    constructorParams: [f64],
  };
  mutableShape.fields = [
    { name: "value", type: f64 },
    { name: "next", type: { kind: "class", shape: mutableShape as unknown as IrClassShape } },
  ];
  const classShape = mutableShape as unknown as IrClassShape;

  const callableEntry = (fn: IrFunction, id: IrFunctionIdentity, ordinal: number): PreparedIrAbiEntry => {
    const ref = irUnitFuncRef(id);
    const params = fn.params.map((param) => param.type);
    const results = fn.resultTypes;
    return {
      plan: {
        id: irUnitCallableBindingId(id.unitId),
        order: { sourceOrder: source.order, declarationOrder: ordinal },
        displayName: id.name,
        structuralReferenceKey: irCallableBindingKey(ref.binding),
        intent: {
          kind: "callable",
          origin: "source",
          signature: preparedIrCallableSignature(params, results),
          unitId: id.unitId,
        },
        slotPolicy: "required",
        slotSpace: "function",
      },
      contract: { kind: "callable", ref, params, results },
    };
  };
  // Module exports are ABI export aliases, never a body flag: emission exports only what the ABI says.
  const exportEntry = (id: IrFunctionIdentity, ordinal: number): PreparedIrAbiEntry => {
    const targetId = irUnitCallableBindingId(id.unitId);
    return {
      plan: {
        id: createIrBindingId({ ownerId: id.unitId, domain: "export", role: id.name }),
        order: { sourceOrder: source.order, declarationOrder: ordinal },
        displayName: id.name,
        intent: { kind: "export", externalName: id.name, targetId },
        slotPolicy: "alias",
        aliasOf: targetId,
      },
      contract: { kind: "export", externalName: id.name, targetId },
    };
  };
  const entries = [
    callableEntry(helper, helperId, 0),
    callableEntry(main, mainId, 1),
    callableEntry(big, bigId, 2),
    callableEntry(special, specialId, 3),
    callableEntry(nan, nanId, 4),
    callableEntry(negZero, negZeroId, 5),
    exportEntry(helperId, 6),
    exportEntry(mainId, 7),
    exportEntry(bigId, 8),
    exportEntry(specialId, 9),
    exportEntry(nanId, 10),
    exportEntry(negZeroId, 11),
  ];

  const startup: IrModuleInitPlan = {
    sourceId,
    unitId: null,
    executable: false,
    bindings: [],
    liveSeeds: [],
    evaluations: [],
    exports: functions.map((fn, index) => ({
      externalName: fn.name,
      localName: fn.name,
      targetBindingId: null,
      start: index * 100,
      end: index * 100 + 50,
    })),
    invocation: { target: "host", kind: "none", exactlyOnce: true },
    gaps: [],
  };

  const semantic = freezePreparedIrValue({
    inventory: {
      sources: [source],
      classes: [
        {
          id: classId,
          sourceId,
          lexicalOwnerId: null,
          declarationKind: "declaration" as const,
          ordinal: 0,
          displayName: "Node",
          line: 5,
          column: 0,
          declarationStart: 400,
          declarationEnd: 480,
          // Present-but-undefined optional property: the codec must keep the key.
          syntheticRole: undefined,
        },
      ],
      allUnits: terminals,
      terminalUnits: terminals,
    },
    ir: { functions },
    abi: { entries },
    derivedUnits: [],
    startup: [startup],
    allocations: registry.snapshot(),
  }) as Pick<PreparedIrProgram, "inventory" | "ir" | "abi" | "derivedUnits" | "startup" | "allocations">;

  const demands = new Map(semantic.ir.functions.map((fn) => [fn.unitId, irProgramRuntimeDemands(fn)]));
  const runtime: PreparedIrProgramRuntimeProjection[] = [];
  for (const policy of policies) {
    const projection = prepareWholeProgramRuntimeManifest({
      ...semantic,
      abi: preparedIrDraftAbiLookup(semantic.abi.entries),
      policy,
      demands,
    });
    if (projection.kind !== "prepared") {
      throw new Error(
        `codec fixture runtime projection ${policy.backend}:${policy.target} failed: ${projection.detail}`,
      );
    }
    freezePreparedIrRuntimeValue(projection.runtime);
    runtime.push(Object.freeze({ backend: policy.backend, target: policy.target, prepared: projection.runtime }));
  }

  const program: PreparedIrProgram = Object.freeze({
    schema: "prepared-ir-program-v1",
    ...semantic,
    units: preparedIrReadonlyMap(semantic.inventory.terminalUnits.map((unit) => [unit.id, unit] as const)),
    runtime: Object.freeze(runtime),
    reconciliation: "complete",
    sealed: true,
  });
  return { program, functions: semantic.ir.functions, classShape };
}
