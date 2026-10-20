// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AcceptedPreparedIrProgram } from "./program.js";
import type { PhysicalSetupPlan } from "./program-physical-plan.js";
import type { NativeVectorCarrierProducers } from "./program-body-resources.js";
import type {
  NativeVectorTypeReservations,
  reserveNativeVectorHelper,
  fillNativeVectorHelper,
  reserveNativeNumericAppend,
  nativeNumericAppendFunction,
  fillNativeNumericAppend,
  requireCompletedNativeNumericAppend,
} from "../backend/wasmgc/resources/native-vectors.js";
import type {
  PreparedLinearMemoryReservations,
  preparedLinearNumericAppendReservation,
} from "../backend/linear/program/memory.js";
import type {
  FunctionReservation,
  TagReservation,
  TagImportReservation,
  PhysicalModuleReservations,
  CallableReservation,
  GlobalReservation,
  GlobalImportReservation,
  TypeReservation,
} from "../wasm/physical/module-reservations.js";
import type { WasmFunction } from "../wasm/model/module-records.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
import type { IrValueId } from "./core/nodes.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./program/data.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import { collectLinearVectorFlow } from "./program/linear-vector-flow.js";

interface NativeVectorEmissionContext {
  readonly reservations: PhysicalModuleReservations;
  readonly functionsByKey: Map<string, CallableReservation>;
  readonly resourcesByBinding: Map<
    IrBindingId,
    CallableReservation | GlobalReservation | GlobalImportReservation | TypeReservation
  >;
}
export interface NativeVectorEmissionProducers extends NativeVectorCarrierProducers {
  readonly reserveExternref: typeof reserveNativeVectorHelper;
  readonly fillExternref: typeof fillNativeVectorHelper;
  readonly reserveAppend: typeof reserveNativeNumericAppend;
  readonly appendFunction: typeof nativeNumericAppendFunction;
  readonly fillAppend: typeof fillNativeNumericAppend;
  readonly completeAppend: typeof requireCompletedNativeNumericAppend;
  readonly linearAppendFunction: typeof preparedLinearNumericAppendReservation;
}
function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", `vector emission: ${detail}`);
}
/** Coordinate original resource owners; never mint ABI, recipe or completed-emission authority. */
export function createNativeVectorEmission(
  accepted: AcceptedPreparedIrProgram,
  plan: PhysicalSetupPlan,
  context: NativeVectorEmissionContext,
  producers: NativeVectorEmissionProducers,
) {
  let reserved = false;
  return Object.freeze({
    reserve: (
      types: NativeVectorTypeReservations,
      tag: TagReservation | TagImportReservation | undefined,
      support: Map<WasmFunction, FunctionReservation>,
      active: () => void,
    ) => {
      active();
      if (reserved) fail("duplicate vector reservation phase");
      reserved = true;
      const { reservations: tx, functionsByKey, resourcesByBinding } = context;
      if (tx.state !== "reserving") fail("vector reservation requires reserving phase");
      const externref = producers.reserveExternref(tx, plan.vectors, types, tag);
      if (externref) {
        if (!plan.vectors.helper) fail("externref helper has no authenticated binding plan");
        support.set(externref.function.object, externref.function);
        functionsByKey.set(plan.vectors.helper.referenceKey, externref.function);
        resourcesByBinding.set(plan.vectors.helper.bindingId, externref.function);
      } else if (plan.vectors.helper) fail("planned externref helper was not reserved");
      const append = plan.backend === "wasmgc" ? producers.reserveAppend(tx, plan.vectors, types, active) : undefined;
      let bound = false;
      return Object.freeze({
        externref,
        bind: (linear?: PreparedLinearMemoryReservations) => {
          active();
          if (tx.state !== "filling") fail("vector binding requires frozen reservation space");
          if (bound) fail("duplicate vector binding phase");
          bound = true;
          const read = () =>
            append
              ? producers.appendFunction(tx, append)
              : linear
                ? producers.linearAppendFunction(tx, linear)
                : undefined;
          const inputs = append
            ? { program: accepted.program, runtime: accepted.runtime, options: accepted.options }
            : undefined;
          const snapshot = inputs ? freezePreparedIrValue(inputs) : undefined;
          const origins = append
            ? collectLinearVectorFlow({ ...accepted.program.ir, functions: accepted.runtime.prepared.functions })
            : undefined;
          const fn = read(),
            binding = plan.vectors.numericAppendHelper;
          if (Boolean(fn) !== Boolean(binding)) fail("numeric append resource/binding population differs");
          if (!fn || !binding) return undefined;
          if (functionsByKey.has(binding.referenceKey) || resourcesByBinding.has(binding.bindingId))
            fail("competing numeric append owners");
          functionsByKey.set(binding.referenceKey, fn);
          resourcesByBinding.set(binding.bindingId, fn);
          support.set(fn.object, fn);
          return Object.freeze({
            referenceKey: binding.referenceKey,
            requireFunction: () => {
              active();
              const current = read();
              if (
                current !== fn ||
                resourcesByBinding.get(binding.bindingId) !== current ||
                functionsByKey.get(binding.referenceKey) !== current
              )
                fail("numeric append lost its exact issued callable/ABI owner");
              return fn;
            },
            requestedCapacity: (unitId: IrUnitId, value: IrValueId) => {
              active();
              if (!inputs || preparedIrDataMismatch(inputs, snapshot) !== undefined)
                fail("numeric append original extent inputs changed");
              read();
              const rows = origins?.get(unitId)?.get(value);
              if (!rows?.length) fail("numeric receiver lost its complete original construction origins");
              const capacities = rows.map(({ instruction }) => instruction.capacity ?? instruction.elements.length);
              if (new Set(capacities).size !== 1) fail("numeric receiver has mixed original requested extents");
              return capacities[0]!;
            },
          });
        },
        fill: () => {
          active();
          if (externref) producers.fillExternref(tx, externref);
          if (append) producers.fillAppend(tx, append);
        },
        complete: () => {
          active();
          if (append) producers.completeAppend(tx, append);
        },
      });
    },
  });
}
