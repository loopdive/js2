// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteRegistry } from "./alloc-registry.js";
import { analyzeOwnership } from "./analysis/ownership.js";
import { analyzeEscape } from "./analysis/escape.js";
import { analyzeEncoding } from "./analysis/encoding.js";
import type { IrFunction, IrModule } from "./nodes.js";
import { constantFold } from "./passes/constant-fold.js";
import { gvnFromEnv } from "./passes/gvn.js";
import { deadCode } from "./passes/dead-code.js";
import { simplifyCFG } from "./passes/simplify-cfg.js";
import { inlineSmall } from "./passes/inline-small.js";
import { monomorphize } from "./passes/monomorphize.js";
import { runTaggedUnions } from "./passes/tagged-unions.js";
import { batchStringConcat } from "./passes/batch-string-concat.js";
import { stringConcatManyArityCap } from "./runtime-manifest.js";
import { verifyIrFunction } from "./verify.js";
import { assertAllocProvenance } from "./verify-alloc.js";
import { assertPreparedIrProgramPopulation } from "./program-population.js";
import {
  preparedIrProgramOwner,
  PreparedIrProgramInvariantError,
  type PreparedIrProgramProducerInput,
} from "./program.js";
import type { ProgramAbiDerivedUnitRecord } from "./program-abi.js";

/** The existing hygiene round, shared by historical and whole-program integration. */
export function runHygienePasses(fn: IrFunction, registry?: AllocSiteRegistry): IrFunction {
  let current = fn;
  for (let iteration = 0; iteration < 10; iteration++) {
    const next = simplifyCFG(deadCode(gvnFromEnv(constantFold(current, registry)), registry));
    if (next === current) return current;
    current = next;
  }
  return current;
}

export function optimizePreparedIrProgram(
  input: PreparedIrProgramProducerInput,
  allocations: AllocSiteRegistry,
): { readonly ir: IrModule; readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[] } {
  assertPreparedIrProgramPopulation(input);
  const validate = (fn: IrFunction): IrFunction => {
    const errors = verifyIrFunction(fn);
    if (errors.length)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `${fn.unitId}: ${errors.map((error) => error.message).join("; ")}`,
      );
    assertAllocProvenance(fn, allocations);
    return fn;
  };
  const hygienic = input.ir.functions.map((fn) => validate(runHygienePasses(fn, allocations)));
  for (const fn of hygienic) analyzeEncoding(fn, allocations);
  const inlined = { ...input.ir, ...inlineSmall({ ...input.ir, functions: hygienic }, allocations) };
  assertPreparedIrProgramPopulation({ ...input, ir: inlined });
  const mono = monomorphize(
    { ...inlined, functions: inlined.functions.map((fn) => validate(runHygienePasses(fn, allocations))) },
    allocations,
  );
  const derivedUnits = [...input.derivedUnits];
  for (const [unitId, record] of mono.cloneUnitProvenance) {
    if (record.id !== unitId || mono.cloneOrigins.get(unitId) !== record.parentId || !mono.cloneSignatures.has(unitId))
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `monomorphization clone ${unitId} has contradictory provenance`,
      );
    const owner = preparedIrProgramOwner({ inventory: input.inventory, derivedUnits }, record.parentId);
    if (!owner)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `monomorphization clone ${unitId} has no original owner`,
      );
    derivedUnits.push({ ...record, sourceId: owner.location.sourceId, terminalOwnerId: owner.unitId });
  }
  const tagged = runTaggedUnions({ ...inlined, ...mono.module });
  if (tagged.errors.length)
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      tagged.errors.map((error) => `${error.unitId}: ${error.message}`).join("; "),
    );
  const batch = input.policy.stringConcatMany?.batch ?? "off";
  const ir = {
    ...inlined,
    ...tagged.module,
    functions: tagged.module.functions.map((fn) => {
      const optimized = runHygienePasses(fn, allocations);
      return validate(
        batch === "off"
          ? optimized
          : runHygienePasses(batchStringConcat(optimized, allocations, stringConcatManyArityCap(batch)), allocations),
      );
    }),
  };
  assertPreparedIrProgramPopulation({ inventory: input.inventory, ir, derivedUnits });
  const wantOwnership = process.env.JS2WASM_IR_OWNERSHIP === "1" || process.env.JS2WASM_IR_OWNERSHIP === "true";
  const wantEscape = process.env.JS2WASM_IR_ESCAPE === "1" || process.env.JS2WASM_IR_ESCAPE === "true";
  for (const fn of ir.functions) {
    analyzeEncoding(fn, allocations);
    if (wantOwnership || wantEscape) {
      const ownership = analyzeOwnership(fn, allocations);
      if (wantEscape) analyzeEscape(fn, allocations, ownership);
    }
  }
  return { ir, derivedUnits };
}
