// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { assertNativeJsClassAllocations } from "./program/native-js-class-allocation-validation.js";
import { hasOrdinaryNumberUndefinedPopulation } from "./analysis/allocation-evidence/ordinary-number-undefined-body.js";
import { irRuntimeSupportFunctions } from "./program/runtime-support.js";
import type { IrFunction, IrInstr, IrModule } from "./core/nodes.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./program/prepared-contracts.js";
import {
  collectNativeNumberUndefinedRequirements,
  type NativeNumberUndefinedRequirements,
} from "./program/native-number-undefined-requirements.js";
import type {
  NativeNumberUndefinedInstruction,
  NativeNumberUndefinedLowering,
} from "./backend/native-number-undefined.js";
import type { PhysicalModuleReservations } from "../wasm/physical/module-reservations.js";
import {
  emitNativeNumberUndefinedGc,
  requireCompletedNativeNumberUndefinedGc,
  requireNativeNumberUndefinedGcSignatureCarrier,
  type NativeNumberUndefinedGcReservations,
} from "../backend/wasmgc/resources/native-number-undefined.js";
import {
  emitNativeNumberUndefinedLinear,
  requirePreparedLinearNumberUndefinedSignatureCarrier,
  requirePreparedLinearNumberUndefinedBindings,
  type PreparedLinearMemoryReservations,
  type NativeNumberUndefinedLinearBindings,
} from "../backend/linear/program/native-number-undefined.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./program/data.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import type { ValType } from "../wasm/model/instructions.js";
import { nativeNumberUndefinedDeclarations } from "./program/native-number-undefined-abi.js";
import { preparedIrTypeKey } from "./program/abi-signatures.js";
import { irGlobalBindingKey } from "./abi-bindings.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import type { IrGlobalRef } from "./core/value-references.js";
import { verifyNativeNumberUndefinedEvidence } from "./runtime/native-number-undefined-profile.js";
import {
  issueNativeNumberUndefinedRepresentability,
  assertNativeNumberUndefinedLegalityCurrent,
  nativeNumberUndefinedInstructionIsAdmitted,
  nativeNumberUndefinedSignatureResultIsAdmitted,
  type NativeNumberUndefinedLegalityUse,
} from "./analysis/allocation-evidence/native-number-undefined-legality.js";
import { assertPreparedIrData } from "./program/data.js";
import type { PhysicalFunctionSlot } from "./program-physical-plan.js";
import { irUnitCallableBindingId } from "./callable-bindings.js";

import { IrUnsupportedError } from "../shared/contracts/ir-preparation-errors.js";

export interface NativeNumberUndefinedPhysicalPlan {
  readonly key: string;
  readonly units: NativeNumberUndefinedRequirements["units"];
  readonly singletonRef: IrGlobalRef;
  readonly singletonBindingId: IrBindingId;
}
function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native Number/Undefined resources: " + detail);
}

/** Final ABI/public/startup closure is separate from portable module equations. */
function assertOrdinaryProgramCarrier(program: PreparedIrProgram): void {
  const entries = new Map(program.abi.entries.map((row) => [row.plan.id, row]));
  if (irRuntimeSupportFunctions(program.runtimeSupport).length)
    throw new IrUnsupportedError(
      "array-representation-unsupported",
      "resolve",
      "ordinary runtime support transport is not closed",
    );
  for (const module of [
    program.ir,
    ...program.runtime.map((view) => ({ ...program.ir, functions: view.prepared.functions })),
  ]) {
    for (const fn of module.functions) {
      const owners = program.abi.entries.filter(
        (row) =>
          row.contract.kind === "callable" &&
          row.contract.ref.binding.kind === "unit" &&
          row.contract.ref.binding.unitId === fn.unitId &&
          row.plan.slotPolicy !== "alias",
      );
      if (owners.length !== 1) fail("ordinary callable lacks unique canonical ABI owner");
      const contract = owners[0]!.contract;
      if (
        contract.kind !== "callable" ||
        preparedIrDataMismatch(
          contract.params,
          fn.params.map((param) => param.type),
        ) !== undefined ||
        preparedIrDataMismatch(contract.results, fn.resultTypes) !== undefined
      )
        fail("ordinary callable ABI/body signature changed");
    }
  }
  for (const row of program.abi.entries) {
    if (row.contract.kind !== "export") continue;
    const seen = new Set<IrBindingId>();
    let actual = entries.get(row.contract.targetId);
    while (actual?.plan.slotPolicy === "alias") {
      if (seen.has(actual.plan.id)) fail("ordinary export alias cycle");
      seen.add(actual.plan.id);
      actual = entries.get(actual.plan.aliasOf);
    }
    if (!actual) fail("ordinary export target vanished");
    if (
      actual.contract.kind === "callable" &&
      [...actual.contract.params, ...actual.contract.results].some((type) => type.kind === "dynamic")
    )
      throw new IrUnsupportedError(
        "array-representation-unsupported",
        "resolve",
        "public dynamic Number/Undefined transport is not issued",
      );
  }
  if (
    program.startup.some((plan) => plan.executable || plan.bindings.length || plan.liveSeeds.length || plan.gaps.length)
  )
    throw new IrUnsupportedError(
      "array-representation-unsupported",
      "resolve",
      "ordinary startup/global transport is not closed",
    );
}

/** Invalid required views take precedence over any finite ordinary coverage refusal. */
function assertOrdinaryViews(program: PreparedIrProgram): void {
  const reports = [
    program.ir,
    ...program.runtime.map((view) => ({ ...program.ir, functions: view.prepared.functions })),
  ].map((module) => verifyNativeNumberUndefinedEvidence(module, program.allocations));
  for (const report of reports) if (report?.kind === "invalid") fail("ordinary all-view replay " + report.code);
  for (const report of reports)
    if (
      report?.kind !== "verified" ||
      report.profile !== "native-ordinary-number-undefined-v1" ||
      report.namespaces !== "ownership-and-escape"
    )
      throw new IrUnsupportedError(
        "array-representation-unsupported",
        "resolve",
        "ordinary all-view family/evidence closure is not issued",
      );
  assertOrdinaryProgramCarrier(program);
}

function requirements(program: PreparedIrProgram, projection: PreparedIrProgramRuntimeProjection) {
  if (!program.runtime.includes(projection)) fail("foreign native runtime projection");
  if (!["standalone", "wasi"].includes(projection.target) || !["wasmgc", "linear"].includes(projection.backend))
    return undefined;
  if (assertNativeJsClassAllocations(program)) return undefined;
  const module: IrModule = {
    ...program.ir,
    functions: projection.prepared.functions,
  };
  if (hasOrdinaryNumberUndefinedPopulation(program.ir)) assertOrdinaryViews(program);
  const original = collectNativeNumberUndefinedRequirements(program.ir, program.allocations);
  const selected = collectNativeNumberUndefinedRequirements(module, program.allocations);
  if (Boolean(original) !== Boolean(selected)) fail("semantic/runtime carrier population differs");
  if (selected) {
    for (const body of [program.ir, module]) {
      const evidence = verifyNativeNumberUndefinedEvidence(body, program.allocations);
      if (evidence?.kind === "invalid") fail("independent carrier allocation evidence " + evidence.code);
      if (!evidence || evidence.kind !== "verified" || evidence.namespaces !== "ownership-and-escape")
        throw new IrUnsupportedError(
          "array-representation-unsupported",
          "resolve",
          "native Number/Undefined requires complete independent ownership and escape evidence",
        );
    }
  }
  return selected ? { module, selected } : undefined;
}

export function planNativeNumberUndefinedPhysical(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeNumberUndefinedPhysicalPlan | undefined {
  const checked = requirements(program, projection);
  if (!checked) return undefined;
  const anchor = program.inventory.sources.find((source) => source.kind === "entry");
  if (!anchor) fail("missing canonical entry owner");
  const owner = program.inventory.allUnits.find((unit) => unit.id === checked.selected.units[0]);
  if (!owner) fail("missing actual singleton unit owner");
  const declarations = nativeNumberUndefinedDeclarations(owner.id);
  const singletonRef = declarations.undefinedRoot;
  const singletonBindingId = singletonRef.binding.bindingId;
  const singletonEntry = program.abi.entries.find((row) => row.plan.id === singletonBindingId);
  if (
    !singletonEntry ||
    singletonEntry.contract.kind !== "global" ||
    singletonEntry.contract.mutable ||
    singletonEntry.plan.slotSpace !== "global" ||
    singletonEntry.plan.slotPolicy !== "required" ||
    preparedIrDataMismatch(singletonEntry.plan.intent, {
      kind: "global",
      origin: "support",
      valueType: preparedIrTypeKey(declarations.carrier),
      mutable: false,
      unitId: owner.id,
      sourceId: owner.sourceId,
    }) !== undefined ||
    preparedIrDataMismatch(singletonEntry.contract.ref, singletonRef) !== undefined ||
    preparedIrDataMismatch(singletonEntry.contract.type, declarations.carrier) !== undefined ||
    singletonEntry.plan.structuralReferenceKey !== irGlobalBindingKey(singletonRef.binding)
  )
    fail("canonical carrier ABI roots are absent or changed");
  return freezePreparedIrValue({
    key: "native:number-undefined:" + anchor.id,
    units: checked.selected.units,
    singletonRef,
    singletonBindingId,
  }) as NativeNumberUndefinedPhysicalPlan;
}

export function nativeNumberUndefinedLegality(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  fn: IrFunction,
): NativeNumberUndefinedLegalityUse | undefined {
  const checked = requirements(program, projection);
  if (!checked || !checked.selected.units.includes(fn.unitId)) return undefined;
  if (projection.backend !== "wasmgc" && projection.backend !== "linear") fail("foreign carrier backend");
  const context = Object.freeze({
    original: program.ir,
    selected: checked.module,
    registry: program.allocations,
    function: fn,
    backend: projection.backend,
  });
  const proof = issueNativeNumberUndefinedRepresentability(context);
  if (!proof) fail("canonical population lacks neutral representation proof");
  return Object.freeze({ proof, context });
}

export function nativeNumberUndefinedLowering(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  fn: IrFunction,
  tx: PhysicalModuleReservations,
  assertEmissionActive: () => void,
  gc?: NativeNumberUndefinedGcReservations,
  linear?: NativeNumberUndefinedLinearBindings,
): NativeNumberUndefinedLowering | undefined {
  const checked = nativeNumberUndefinedLegality(program, projection, fn);
  if (!checked) return undefined;
  if ((projection.backend === "wasmgc") !== Boolean(gc) || (projection.backend === "linear") !== Boolean(linear))
    fail("missing or foreign physical carrier pack");
  const current = () => {
    // Canonical full runtime IR/JS/evidence proof is required before every physical use.
    const actual = requirements(program, projection);
    if (!actual || !projection.prepared.functions.includes(fn)) fail("current physical body vanished");
    const use = { proof: checked.proof, context: { ...checked.context, selected: actual.module } };
    assertNativeNumberUndefinedLegalityCurrent(use, fn, projection.backend);
    if (gc) requireCompletedNativeNumberUndefinedGc(tx, gc);
    if (linear) {
      requirePreparedLinearNumberUndefinedBindings(tx, linear);
      linear.assertCurrent();
    }
    return use;
  };
  assertEmissionActive();
  current();
  const carrier: ValType = Object.freeze(gc ? { kind: "ref_null", typeIdx: gc.carrier.typeIndex } : { kind: "i32" });
  return Object.freeze({
    carrier,
    legality: checked,
    assertFunction(actual: IrFunction) {
      assertEmissionActive();
      if (actual !== fn) fail("foreign physical function");
      current();
    },
    owns(instr: IrInstr): instr is NativeNumberUndefinedInstruction {
      assertEmissionActive();
      return nativeNumberUndefinedInstructionIsAdmitted(current(), fn, projection.backend, instr);
    },
    emit(instr, operands, scratch) {
      assertEmissionActive();
      if (!nativeNumberUndefinedInstructionIsAdmitted(current(), fn, projection.backend, instr))
        fail("instruction is absent from the issued owner census");
      return gc
        ? emitNativeNumberUndefinedGc(tx, gc, instr, operands, scratch)
        : emitNativeNumberUndefinedLinear(linear!, instr, operands, scratch);
    },
  } satisfies NativeNumberUndefinedLowering);
}

/** A result-position query, never permission for a parameter or a copied logical type. */
export function nativeNumberUndefinedSignatureResult(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  fn: IrFunction,
  index: number,
): boolean {
  assertPreparedIrData(program);
  if (!program.runtime.includes(projection) || !projection.prepared.functions.includes(fn))
    fail("foreign signature owner");
  if (!Number.isSafeInteger(index) || index < 0 || index >= fn.resultTypes.length) return false;
  if (!hasOrdinaryNumberUndefinedPopulation(program.ir)) return false;
  if (!planNativeNumberUndefinedPhysical(program, projection)) return false;
  const use = nativeNumberUndefinedLegality(program, projection, fn);
  return Boolean(
    use && nativeNumberUndefinedSignatureResultIsAdmitted(use, fn, projection.backend, index, fn.resultTypes[index]!),
  );
}

export interface NativeNumberUndefinedSignatureUse {
  readonly kind: "native-number-undefined-signature-use";
}
interface SignatureRecord {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly functions: PreparedIrProgramRuntimeProjection["prepared"]["functions"];
  readonly tx: PhysicalModuleReservations;
  readonly gc?: NativeNumberUndefinedGcReservations;
  readonly linear?: PreparedLinearMemoryReservations;
  readonly carrier: Readonly<ValType>;
  readonly slots: ReadonlyMap<PhysicalFunctionSlot, { fn: IrFunction; use: NativeNumberUndefinedLegalityUse }>;
}
const signatureUses = new WeakMap<NativeNumberUndefinedSignatureUse, SignatureRecord>();
function signatureCarrier(record: Pick<SignatureRecord, "tx" | "gc" | "linear" | "projection">): Readonly<ValType> {
  if (record.projection.backend === "wasmgc" && record.gc && !record.linear)
    return requireNativeNumberUndefinedGcSignatureCarrier(record.tx, record.gc);
  if (record.projection.backend === "linear" && record.linear && !record.gc)
    return requirePreparedLinearNumberUndefinedSignatureCarrier(record.tx, record.linear);
  return fail("missing or foreign signature reservation issuer");
}
function assertSignatureSlot(slot: PhysicalFunctionSlot, fn: IrFunction): void {
  const convert = (types: IrFunction["resultTypes"]) => types.map((type) => (type.kind === "val" ? type.val : type));
  if (
    slot.unitId !== fn.unitId ||
    slot.bindingId !== irUnitCallableBindingId(fn.unitId) ||
    slot.name !== fn.name ||
    slot.dynamicCarrier !== undefined ||
    preparedIrDataMismatch(slot.params, convert(fn.params.map((p) => p.type))) !== undefined ||
    preparedIrDataMismatch(slot.results, convert(fn.resultTypes)) !== undefined
  )
    fail("signature slot differs from actual canonical body");
}
/** Bind exact plan slot identities to whole-program semantic proof and an actual reservation issuer. */
export function issueNativeNumberUndefinedSignatureUse(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  slots: readonly PhysicalFunctionSlot[],
  tx: PhysicalModuleReservations,
  gc?: NativeNumberUndefinedGcReservations,
  linear?: PreparedLinearMemoryReservations,
): NativeNumberUndefinedSignatureUse | undefined {
  assertPreparedIrData(program);
  if (!program.runtime.includes(projection)) fail("foreign signature projection");
  if (!hasOrdinaryNumberUndefinedPopulation(program.ir)) return undefined;
  if (!planNativeNumberUndefinedPhysical(program, projection)) return undefined;
  assertPreparedIrData(slots);
  if (
    slots.length !== projection.prepared.functions.length ||
    new Set(slots.map((s) => s.unitId)).size !== slots.length
  )
    fail("incomplete signature slot census");
  const joined = new Map<PhysicalFunctionSlot, { fn: IrFunction; use: NativeNumberUndefinedLegalityUse }>();
  for (const slot of slots) {
    const fn = projection.prepared.functions.find((f) => f.unitId === slot.unitId);
    if (!fn) fail("signature slot has no actual selected owner");
    assertSignatureSlot(slot, fn);
    if (!fn.resultTypes.some((type) => type.kind === "dynamic")) continue;
    const use = nativeNumberUndefinedLegality(program, projection, fn);
    if (
      !use ||
      fn.params.some((p) => p.type.kind === "dynamic") ||
      !fn.resultTypes.every(
        (type, index) =>
          type.kind !== "dynamic" ||
          nativeNumberUndefinedSignatureResultIsAdmitted(use, fn, projection.backend, index, type),
      )
    )
      fail("signature result lacks independent field proof");
    joined.set(slot, { fn, use });
  }
  if (!joined.size) return undefined;
  const base = { program, projection, functions: projection.prepared.functions, tx, gc, linear, slots: joined };
  const carrier = signatureCarrier(base);
  const token = Object.freeze({ kind: "native-number-undefined-signature-use" } as const);
  signatureUses.set(token, { ...base, carrier });
  return token;
}
/** Outsider slot identities are rejected before any caller field/getter is observed. */
export function nativeNumberUndefinedPhysicalSignature(
  token: NativeNumberUndefinedSignatureUse,
  slot: unknown,
): { params: ValType[]; results: ValType[] } | undefined {
  const record = signatureUses.get(token);
  if (!record) fail("unissued/copied signature token");
  const joined = record.slots.get(slot as PhysicalFunctionSlot);
  if (!joined) return undefined;
  const { program, projection } = record;
  const checked = requirements(program, projection);
  if (!checked || projection.prepared.functions !== record.functions) fail("stale selected signature population");
  assertPreparedIrData(slot);
  assertSignatureSlot(slot as PhysicalFunctionSlot, joined.fn);
  assertNativeNumberUndefinedLegalityCurrent(
    { proof: joined.use.proof, context: { ...joined.use.context, selected: checked.module } },
    joined.fn,
    projection.backend,
  );
  const carrier = signatureCarrier(record);
  if (preparedIrDataMismatch(carrier, record.carrier) !== undefined) fail("signature carrier changed across phases");
  return {
    params: joined.fn.params.map((p) => {
      if (p.type.kind !== "val") return fail("non-scalar signature parameter");
      return p.type.val;
    }),
    results: joined.fn.resultTypes.map((type, index) => {
      if (type.kind === "val") return type.val;
      if (!nativeNumberUndefinedSignatureResultIsAdmitted(joined.use, joined.fn, projection.backend, index, type))
        return fail("stale result-position proof");
      return carrier;
    }),
  };
}
