// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  forEachNestedBuffer,
  type AllocSiteId,
  type IrInstr,
  type IrInstrCall,
  type IrInstrStringConst,
} from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import type { AllocRegistryMetadataSnapshot } from "../analysis/contracts/allocations.js";
import {
  irNativeAsyncCallableDeclaration,
  nativeAsyncCallablePolicyMismatch,
  nativeAsyncProviderMismatch,
} from "../runtime/native-async-callables.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import {
  collectNativeStringValueDemands,
  type NativeStringValueBuffer,
  type NativeStringValuePresence,
} from "./native-string-value-demands.js";
import { assertIrRuntimeSupport, type IrNumberFormatRadixSupport } from "./runtime-support.js";
import { preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export interface NativeNumberFormatRequirementInput {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly integerBeforeScratch: boolean;
}

export interface NativeNumberFormatCallUse {
  readonly ownerUnitId: IrUnitId;
  readonly view: NativeStringValueBuffer["view"];
  readonly root: NativeStringValueBuffer["root"];
  readonly path: NativeStringValueBuffer["path"];
  readonly instructionIndex: number;
  readonly instruction: IrInstrCall;
}

export interface NativeNumberFormatSupportBuffer {
  readonly ownerUnitId: IrUnitId;
  readonly blockIndex: number;
  readonly blockId: number;
  readonly path: NativeStringValueBuffer["path"];
  readonly instructions: readonly IrInstr[];
}

export interface NativeNumberFormatLiteralUse {
  readonly bufferIndex: number;
  readonly instructionIndex: number;
  readonly instruction: IrInstrStringConst;
  readonly allocation: AllocSiteId;
  readonly canonicalAllocation: AllocSiteId;
  readonly metadataRow: NativeStringValuePresence<AllocRegistryMetadataSnapshot>;
  readonly representation: "inline-wtf16";
}

/** Borrowed descriptive evidence, never an acceptance or resource capability. */
export interface NativeNumberFormatRequirements extends NativeNumberFormatRequirementInput {
  readonly batch: IrNumberFormatRadixSupport;
  readonly calls: readonly NativeNumberFormatCallUse[];
  readonly supportBuffers: readonly NativeNumberFormatSupportBuffer[];
  readonly literals: readonly NativeNumberFormatLiteralUse[];
}

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native number format requirements: ${detail}`);
}

function supportEvidence(
  program: PreparedIrProgram,
  batch: IrNumberFormatRadixSupport,
): {
  supportBuffers: readonly NativeNumberFormatSupportBuffer[];
  literals: readonly NativeNumberFormatLiteralUse[];
} {
  const registry = AllocSiteRegistry.fromSnapshot(program.allocations);
  const metadata = new Map(program.allocations.metadata.map((row) => [row.id, row]));
  const supportBuffers: NativeNumberFormatSupportBuffer[] = [];
  const literals: NativeNumberFormatLiteralUse[] = [];
  const body = batch.implementation.body;
  const ownerUnitId = body.unitId;
  if (!ownerUnitId) fail("missing support owner");
  const active = new Set<readonly IrInstr[]>();
  function visit(
    instructions: readonly IrInstr[],
    blockIndex: number,
    blockId: number,
    path: NativeStringValueBuffer["path"],
  ): void {
    if (!Array.isArray(instructions) || active.has(instructions)) fail("missing or cyclic support buffer");
    active.add(instructions);
    const bufferIndex = supportBuffers.length;
    supportBuffers.push(Object.freeze({ ownerUnitId: ownerUnitId!, blockIndex, blockId, path, instructions }));
    for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex++) {
      const instruction = instructions[instructionIndex];
      if (!Object.hasOwn(instructions, instructionIndex) || !instruction) fail("sparse support buffer");
      if (instruction.kind === "string.const") {
        if (Object.hasOwn(instruction, "storage") || Object.hasOwn(instruction, "materializer"))
          fail("support literal has an unsupported physical attachment");
        const allocation = instruction.alloc;
        if (allocation === undefined || !Number.isSafeInteger(allocation) || allocation < 0)
          fail("missing support literal allocation");
        const site = registry.resolve(allocation);
        if (!site || site.kind !== "string") fail("support literal allocation is not live string storage");
        const row = metadata.get(site.id);
        literals.push(
          Object.freeze({
            bufferIndex,
            instructionIndex,
            instruction,
            allocation,
            canonicalAllocation: site.id,
            metadataRow: row
              ? Object.freeze({ present: true as const, value: row })
              : Object.freeze({ present: false as const }),
            representation: "inline-wtf16",
          }),
        );
      }
      let childBufferIndex = 0;
      forEachNestedBuffer(instruction, (child) => {
        const coordinate = Object.freeze({ instructionIndex, childBufferIndex: childBufferIndex++ });
        visit(child, blockIndex, blockId, Object.freeze([...path, coordinate]));
      });
    }
    active.delete(instructions);
  }
  for (let index = 0; index < body.blocks.length; index++) {
    const block = body.blocks[index];
    if (!Object.hasOwn(body.blocks, index) || !block) fail("sparse support block population");
    visit(block.instrs, index, block.id, Object.freeze([]));
  }
  return { supportBuffers: Object.freeze(supportBuffers), literals: Object.freeze(literals) };
}

/** Full program authentication remains the caller's prerequisite. */
export function deriveNativeNumberFormatRequirements(
  input: NativeNumberFormatRequirementInput,
): NativeNumberFormatRequirements | undefined {
  const { program, projection, integerBeforeScratch } = input;
  const census = collectNativeStringValueDemands(program, projection);
  assertIrRuntimeSupport(program, program.runtimeSupport);
  const calls: NativeNumberFormatCallUse[] = [];
  for (const occurrence of census.occurrences) {
    const instruction = occurrence.instruction;
    if (instruction.kind !== "call") continue;
    const declaration = irNativeAsyncCallableDeclaration(instruction.target);
    if (declaration?.feature !== "async.native.number-to-string") continue;
    const buffer = census.buffers[occurrence.bufferIndex];
    if (!buffer) fail("formatter call has no buffer coordinate");
    if (
      preparedIrDataMismatch(instruction.target, declaration.ref) !== undefined ||
      instruction.args.length !== declaration.params.length ||
      preparedIrDataMismatch(instruction.resultType, declaration.results[0]) !== undefined
    )
      fail("formatter call does not match its canonical declaration");
    calls.push(
      Object.freeze({
        ownerUnitId: buffer.ownerUnitId,
        view: buffer.view,
        root: buffer.root,
        path: buffer.path,
        instructionIndex: occurrence.instructionIndex,
        instruction,
      }),
    );
  }
  if (calls.length === 0) {
    if (program.runtimeSupport !== undefined) fail("support remains without formatter calls");
    return undefined;
  }
  if (typeof integerBeforeScratch !== "boolean") fail("formatter option must be explicitly resolved");
  const manifest = projection.prepared.manifest;
  const policyMismatch = nativeAsyncCallablePolicyMismatch("async.native.number-to-string", manifest.policy);
  if (policyMismatch !== undefined) fail(policyMismatch);
  const providers = manifest.providers.filter((provider) => provider.feature === "async.native.number-to-string");
  if (providers.length !== 1) fail("missing or duplicate formatter provider");
  const mismatch = nativeAsyncProviderMismatch(providers[0]!);
  if (mismatch !== undefined) fail(mismatch);
  const batch = program.runtimeSupport?.batches[0];
  if (!batch) fail("missing formatter support batch");
  for (const view of ["program", "projection"] as const) {
    const owners = [...new Set(calls.filter((call) => call.view === view).map((call) => call.ownerUnitId))];
    if (preparedIrDataMismatch(owners, batch.demandOwners) !== undefined)
      fail(`${view} formatter demand owners disagree with support`);
  }
  const evidence = supportEvidence(program, batch);
  return Object.freeze({ program, projection, integerBeforeScratch, batch, calls: Object.freeze(calls), ...evidence });
}

export function assertNativeNumberFormatRequirementsCurrent(
  input: NativeNumberFormatRequirementInput,
  requirements: NativeNumberFormatRequirements,
): void {
  if (requirements.program !== input.program || requirements.projection !== input.projection)
    fail("foreign borrowed program or projection");
  const current = deriveNativeNumberFormatRequirements(input);
  if (
    !current ||
    current.batch !== requirements.batch ||
    current.integerBeforeScratch !== requirements.integerBeforeScratch
  )
    fail("stale formatter batch or option");
  for (const key of ["calls", "supportBuffers", "literals"] as const)
    if (preparedIrDataMismatch(current[key], requirements[key]) !== undefined) fail(`stale ${key}`);
  if (
    current.calls.some((row, i) => row.instruction !== requirements.calls[i]?.instruction) ||
    current.supportBuffers.some((row, i) => row.instructions !== requirements.supportBuffers[i]?.instructions) ||
    current.literals.some(
      (row, i) =>
        row.instruction !== requirements.literals[i]?.instruction ||
        (row.metadataRow.present &&
          (!requirements.literals[i]?.metadataRow.present ||
            row.metadataRow.value !== requirements.literals[i]?.metadataRow.value)),
    )
  )
    fail("detached borrowed formatter evidence");
}
