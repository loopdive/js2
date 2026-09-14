// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { assertPreparedIrAsyncRuntimeCurrent } from "./async-plan.js";
import { forEachInstrDeep, forEachNestedBuffer, type IrInstr } from "./nodes.js";
import { IR_ASYNC_CLOCK_SNAPSHOT_FN } from "./core/async-callables.js";
import { nativeAsyncCallablePolicyMismatch, nativeAsyncProviderMismatch } from "./runtime/native-async-callables.js";
import { preparedIrDraftAbiLookup } from "./program-abi-contracts.js";
import { irProgramRuntimeDemands } from "./program-runtime-demands.js";
import { prepareWholeProgramRuntimeManifest } from "./runtime-program-manifest.js";
import {
  preparedIrDataMismatch,
  PreparedIrProgramInvariantError,
  type PreparedIrProgram,
  type PreparedIrProgramRuntimeProjection,
} from "./program.js";

/** The shared IR owns meaning; provider and runtime attachments belong only to projections. */
export function assertPreparedIrSemanticRuntimeSeparation(program: Pick<PreparedIrProgram, "ir">): void {
  for (const fn of program.ir.functions) {
    if (fn.asyncRuntime)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `semantic body ${fn.unitId} contains a runtime attachment`,
      );
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ]) {
      for (const root of buffer)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "intrinsic" && instruction.provider !== undefined) {
            throw new PreparedIrProgramInvariantError(
              "invalid-prepared-data",
              `semantic body ${fn.unitId} contains a physical intrinsic provider`,
            );
          }
        });
    }
  }
}

/** Independent positional witness; reproduction alone shares the producer's blind spots. */
function assertClockProjection(program: PreparedIrProgram, projection: PreparedIrProgramRuntimeProjection): void {
  const fail = (position: string, detail: string): never => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", `clock projection ${position}: ${detail}`);
  };
  const manifest = projection.prepared.manifest;
  let providerChecked = false;
  const checkProvider = (position: string): void => {
    if (providerChecked) return;
    const mismatch = nativeAsyncCallablePolicyMismatch("async.native.clock-zero", manifest.policy);
    if (mismatch) fail(position, mismatch);
    const providers = manifest.providers.filter(
      (provider) =>
        provider.feature === "async.native.clock-zero" ||
        provider.id === "native.async.clock-zero" ||
        provider.implementation.kind === "standalone-clock-zero",
    );
    if (providers.length !== 1 || nativeAsyncProviderMismatch(providers[0]!) !== undefined)
      fail(position, "missing or foreign canonical frozen clock provider");
    providerChecked = true;
  };
  const isClock = (instr: IrInstr): boolean =>
    instr.kind === "call" &&
    instr.target.binding.kind === "intrinsic" &&
    instr.target.binding.symbol === IR_ASYNC_CLOCK_SNAPSHOT_FN;
  const compare = (before: readonly IrInstr[], after: readonly IrInstr[], position: string): void => {
    if (before.length !== after.length) fail(position, "instruction population differs");
    for (let index = 0; index < before.length; index++) {
      const original = before[index]!,
        selected = after[index]!;
      const path = `${position}/instruction:${index}`;
      if (isClock(original)) {
        checkProvider(path);
        if (
          original.kind !== "call" ||
          original.args.length !== 0 ||
          original.result === null ||
          original.resultType?.kind !== "val" ||
          original.resultType.val.kind !== "f64" ||
          Object.hasOwn(original, "alloc")
        )
          fail(path, "inconsistent non-allocating semantic clock");
        const expected = {
          kind: "const",
          value: { kind: "f64", value: 0 },
          result: original.result,
          resultType: original.resultType,
          ...(Object.hasOwn(original, "site") ? { site: original.site } : {}),
        };
        if (
          selected.kind !== "const" ||
          selected.value.kind !== "f64" ||
          !Object.is(selected.value.value, 0) ||
          preparedIrDataMismatch(expected, selected) !== undefined
        )
          fail(path, "semantic clock lacks its exact positive-zero/result/type/site projection");
      } else {
        if (isClock(selected)) fail(path, "surviving physical clock");
        if (original.kind !== selected.kind) fail(path, "instruction kind differs");
      }
      const originalBuffers: (readonly IrInstr[])[] = [],
        selectedBuffers: (readonly IrInstr[])[] = [];
      forEachNestedBuffer(original, (buffer) => originalBuffers.push(buffer));
      forEachNestedBuffer(selected, (buffer) => selectedBuffers.push(buffer));
      if (originalBuffers.length !== selectedBuffers.length) fail(path, "nested-buffer population differs");
      originalBuffers.forEach((buffer, nested) =>
        compare(buffer, selectedBuffers[nested]!, `${path}/buffer:${nested}`),
      );
    }
  };
  const before = program.ir.functions,
    after = projection.prepared.functions;
  if (before.length !== after.length) fail("owners", "function population differs");
  before.forEach((fn, index) => {
    const selected = after[index]!;
    const path = `owner:${index}:${fn.unitId}`;
    if (fn.unitId !== selected.unitId) fail(path, "owner identity/order differs");
    if (fn.blocks.length !== selected.blocks.length) fail(path, "block population differs");
    fn.blocks.forEach((block, blockIndex) => {
      const physical = selected.blocks[blockIndex]!;
      if (block.id !== physical.id) fail(path, "block identity/order differs");
      compare(block.instrs, physical.instrs, `${path}/block:${blockIndex}:${block.id}`);
    });
    const states = fn.asyncPlan?.states ?? [],
      runtimeStates = selected.asyncRuntime?.states ?? [];
    if (states.length !== runtimeStates.length) fail(path, "runtime state population differs");
    states.forEach((state, stateIndex) => {
      const physical = runtimeStates[stateIndex]!;
      if (state.id !== physical.id) fail(path, "runtime state identity/order differs");
      compare(state.body, physical.body, `${path}/state:${stateIndex}:${state.id}`);
    });
  });
}

/** Reuse B's deterministic pure producer to check every field; never replace contradictory evidence. */
export function assertPreparedIrRuntimeProjection(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): void {
  const key = `${projection.backend}:${projection.target}`;
  assertClockProjection(program, projection);
  const expected = prepareWholeProgramRuntimeManifest({
    inventory: program.inventory,
    ir: program.ir,
    derivedUnits: program.derivedUnits,
    // The caller validated the complete ABI already. Re-entering the public lookup would recurse.
    abi: preparedIrDraftAbiLookup(program.abi.entries),
    policy: projection.prepared.manifest.policy,
    demands: new Map(program.ir.functions.map((fn) => [fn.unitId, irProgramRuntimeDemands(fn)])),
  });
  if (expected.kind !== "prepared")
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `runtime projection ${key} cannot be reproduced: ${expected.detail}`,
    );
  const mismatch = preparedIrDataMismatch(expected.runtime, projection.prepared);
  if (mismatch !== undefined)
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `runtime projection ${key} contradicts complete semantic/provider data at ${mismatch}`,
    );
  for (const fn of projection.prepared.functions) {
    if (!fn.asyncPlan && !fn.asyncRuntime) continue;
    const current = assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, fn.asyncRuntime);
    if (current.manifest !== projection.prepared.manifest)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `runtime owner ${fn.unitId} is attached to a foreign manifest`,
      );
  }
}
