// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
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
  type NativeNumberUndefinedGcReservations,
} from "../backend/wasmgc/resources/native-number-undefined.js";
import {
  emitNativeNumberUndefinedLinear,
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
  type NativeNumberUndefinedLegalityUse,
} from "./analysis/allocation-evidence/native-number-undefined-legality.js";
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

function requirements(program: PreparedIrProgram, projection: PreparedIrProgramRuntimeProjection) {
  if (!program.runtime.includes(projection)) fail("foreign native runtime projection");
  if (!["standalone", "wasi"].includes(projection.target) || !["wasmgc", "linear"].includes(projection.backend))
    return undefined;
  const module: IrModule = {
    ...program.ir,
    functions: projection.prepared.functions,
  };
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
    if (linear) linear.assertCurrent();
    return use;
  };
  const carrier: ValType = Object.freeze(gc ? { kind: "ref_null", typeIdx: gc.carrier.typeIndex } : { kind: "i32" });
  assertEmissionActive();
  current();
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
