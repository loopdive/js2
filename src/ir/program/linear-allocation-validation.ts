import { nativeJsClassProgramEvidence } from "./native-js-class-allocation-validation.js";
import { verifyNativeNumberUndefinedEvidence } from "../runtime/native-number-undefined-profile.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createVerifiedAllocationSnapshot } from "../analysis/allocations/snapshot.js";
import { assertFinalAllocProvenance } from "../analysis/alloc-verification.js";
import { verifyNativeAllocationEvidence } from "../analysis/allocation-evidence/structured-vector-profile.js";
import { nativeModuleGlobalEvidence } from "./native-module-vector-context.js";
import {
  checkRegistryEvidenceMetadataDomain,
  indexRegistryEvidence,
} from "../analysis/allocation-evidence/metadata.js";
import type { AllocationEvidenceCheck } from "../analysis/allocation-evidence/contracts.js";
import { verifyLinearPreparedAllocationFacts } from "../analysis/linear/allocation-facts.js";
import type { LinearPreparedAllocationFacts } from "../analysis/linear/contracts/allocation-facts.js";
import type { PreparedIrModule } from "../runtime/contracts/prepared.js";
import { forEachInstrDeep } from "../core/nodes.js";
import { IrUnsupportedError } from "../../shared/contracts/ir-preparation-errors.js";
import { assertPreparedIrFunctionAllocationTypesAndStates } from "./allocation-body-validation.js";
import { assertPreparedIrProgramAllocations } from "./allocations.js";
import { assertPreparedIrData, preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import { irRuntimeSupportFunctions } from "./runtime-support.js";

export interface PreparedLinearMemoryInput {
  readonly module: PreparedIrModule;
  readonly facts: LinearPreparedAllocationFacts;
}

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `linear allocation facts: ${detail}`);
}

/** Called before any prepared-program field read; absence is descriptor absence. */
export function screenPreparedIrLinearAllocationEntry(program: PreparedIrProgram, required: boolean): boolean {
  if (!program || typeof program !== "object") invalid("expected a complete prepared program");
  const descriptor = Object.getOwnPropertyDescriptor(program, "linearAllocationFacts");
  if (descriptor && (!("value" in descriptor) || descriptor.value === undefined))
    invalid("attachment must be an own DATA value, not an accessor or undefined");
  if (descriptor || required) assertPreparedIrData(program);
  return descriptor !== undefined;
}

function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("expected a DATA record");
  const keys = Reflect.ownKeys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key))
  )
    invalid("missing or unknown attachment field");
}

function assertFactsShape(program: PreparedIrProgram): LinearPreparedAllocationFacts {
  const attachment = program.linearAllocationFacts!;
  fields(attachment, ["schema", "facts"]);
  if (attachment.schema !== "linear-allocation-facts-v1") invalid("unknown attachment schema");
  const facts = attachment.facts;
  fields(facts, ["registry", "allocations"]);
  if (!Array.isArray(facts.allocations)) invalid("allocation facts must be an array");
  for (const fact of facts.allocations) {
    fields(fact, ["id", "site", "ownership", "accesses", "escape", "stackCandidate", "evidence"], ["encoding"]);
    if (!Number.isSafeInteger(fact.id) || fact.id < 0) invalid("invalid allocation fact identity");
    if (!["owned", "borrowed", "shared", "escaped"].includes(fact.ownership))
      invalid("unknown ownership classification");
    if (!["local", "returned", "stored", "captured", "opaque"].includes(fact.escape))
      invalid("unknown escape classification");
    if (!Array.isArray(fact.accesses) || fact.accesses.some((op: unknown) => typeof op !== "string"))
      invalid("allocation accesses must be strings");
    if (typeof fact.stackCandidate !== "boolean") invalid("stack candidate must be boolean");
    if (fact.encoding !== undefined && !["ascii", "utf8-guaranteed", "wtf16"].includes(fact.encoding))
      invalid("unknown encoding classification");
    fields(fact.evidence, ["ownership", "escape", "encoding"]);
    for (const evidence of [fact.evidence.ownership, fact.evidence.escape, fact.evidence.encoding]) {
      fields(evidence, ["present", "value"]);
      if (typeof evidence.present !== "boolean") invalid("evidence presence must be boolean");
    }
  }
  const mismatch = preparedIrDataMismatch(program.allocations, facts.registry);
  if (mismatch !== undefined) invalid(`registry differs from complete program allocations at ${mismatch}`);
  return facts;
}

/** J2 supplies indexing; the prepared DATA entry owns its complete record domain. */
function assertSnapshotDomain(program: PreparedIrProgram): void {
  const snapshot = program.allocations;
  fields(snapshot, ["size", "entries", "metadata"]);
  if (!Array.isArray(snapshot.entries) || !Array.isArray(snapshot.metadata)) invalid("invalid snapshot arrays");
  for (const entry of snapshot.entries) {
    fields(entry, ["state"], ["site", "to"]);
    if (entry.state === "live") {
      fields(entry, ["state", "site"]);
      fields(entry.site, ["id", "kind", "type"], ["origin"]);
      if (
        !["object", "array", "string", "closure", "refcell", "box", "extern", "iterator", "generator"].includes(
          entry.site.kind,
        )
      )
        invalid("live site has an unknown allocation kind");
      if (!entry.site.type || typeof entry.site.type !== "object") invalid("live site lacks its type");
    } else if (entry.state === "aliased") {
      fields(entry, ["state", "to"]);
      if (!Number.isSafeInteger(entry.to)) invalid("alias target is not an exact site ID");
    } else if (entry.state === "retired") fields(entry, ["state"]);
    else invalid("unknown snapshot provenance state");
  }
  for (const row of snapshot.metadata) {
    fields(row, ["id", "entries"]);
    if (!Array.isArray(row.entries) || snapshot.entries[row.id]?.state !== "live")
      invalid(`metadata ${row.id} has no exact live owner`);
    for (const cell of row.entries)
      if (!Array.isArray(cell) || cell.length !== 2 || typeof cell[0] !== "string")
        invalid(`metadata ${row.id} has an unverifiable namespace`);
  }
}

/** Preserve complete semantic/support authority and the original declaration tables. */
function completeModule(program: PreparedIrProgram, projection?: PreparedIrProgramRuntimeProjection): PreparedIrModule {
  const functions = projection === undefined ? program.ir.functions : projection.prepared.functions;
  const support = irRuntimeSupportFunctions(program.runtimeSupport);
  if (support.length === 0 && projection === undefined) return program.ir;
  return { ...program.ir, functions: [...functions, ...support] };
}

export function unsupportedPreparedLinearAllocationEvidence(
  program: PreparedIrProgram,
  detail: string,
  check?: AllocationEvidenceCheck,
): never {
  const reportedUnit = check && check.kind !== "verified" && "unitId" in check.at ? check.at.unitId : undefined;
  const reportedSite = check && check.kind !== "verified" && check.at.kind === "site" ? check.at.site : undefined;
  const allocating = completeModule(program).functions.find((fn) => {
    let found = false;
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ])
      for (const instr of buffer)
        forEachInstrDeep(instr, (item) => {
          found ||= item.alloc !== undefined && (reportedSite === undefined || item.alloc === reportedSite);
        });
    return found;
  });
  const unitId = reportedUnit ?? allocating?.unitId;
  const sourceOwner = program.inventory.allUnits.find((unit) => unit.id === unitId);
  const derivedOwner = program.derivedUnits.find((unit) => unit.id === unitId);
  const terminalId = sourceOwner?.terminalOwnerId ?? derivedOwner?.terminalOwnerId ?? unitId;
  const owner =
    program.inventory.terminalUnits.find((unit) => unit.id === terminalId) ?? program.inventory.terminalUnits[0];
  const source = program.inventory.sources.find((record) => record.id === owner?.sourceId);
  throw new IrUnsupportedError("array-representation-unsupported", "resolve", detail, {
    ...(owner === undefined
      ? {}
      : {
          unitId: owner.id,
          location: {
            sourceId: owner.sourceId,
            line: owner.line,
            column: owner.column,
            declarationStart: owner.declarationStart,
            declarationEnd: owner.declarationEnd,
          },
        }),
    ...(source === undefined ? {} : { sourceFile: source.originalFileName }),
    ...(check === undefined ? {} : { evidence: check }),
  });
}

/**
 * Narrow allocation hook, invoked only after the shared validator completes
 * canonical context, ABI, support and exact runtime reproduction. It never
 * recursively acquires the program and does not run producer work for covered
 * attached evidence. No result is cached across calls.
 */
export function validatePreparedIrLinearAllocationEvidence(
  program: PreparedIrProgram,
  required: boolean,
  projection?: PreparedIrProgramRuntimeProjection,
): PreparedLinearMemoryInput | undefined {
  if (
    projection !== undefined &&
    (!program.runtime.includes(projection) ||
      projection.backend !== "linear" ||
      !["standalone", "wasi"].includes(projection.target))
  )
    invalid("selected native Linear projection is not an original current program attachment");
  const linear = program.runtime.filter((view) => view.backend === "linear");
  if (required && !linear.some((view) => view.target === "standalone" || view.target === "wasi"))
    invalid("required entry lacks a native Linear projection");
  const semantic = completeModule(program);
  const views = [semantic, ...linear.map((view) => completeModule(program, view))];
  // J2 is read-only. Canonical J1 still diagnoses mandatory IDs, kinds, retired
  // IDs, main/state result types and missing state entry before coverage refusal.
  let lookup: ReturnType<typeof createVerifiedAllocationSnapshot>;
  assertSnapshotDomain(program);
  try {
    lookup = createVerifiedAllocationSnapshot(program.allocations);
  } catch (error) {
    invalid(`snapshot: ${String(error)}`);
  }
  for (const module of [semantic, ...program.runtime.map((view) => completeModule(program, view))])
    for (const fn of module.functions) {
      assertFinalAllocProvenance(fn, lookup);
      assertPreparedIrFunctionAllocationTypesAndStates(fn, lookup);
    }
  // Domain validity precedes coverage and missing-native-evidence decisions.
  // This never infers or authenticates metadata truth for an unsupported body.
  const domainFailure = checkRegistryEvidenceMetadataDomain(indexRegistryEvidence(program.allocations));
  if (domainFailure) invalid(`metadata DATA domain ${domainFailure.code} at ${JSON.stringify(domainFailure.at)}`);
  if (!Object.hasOwn(program, "linearAllocationFacts")) {
    if (program.allocations.size !== 0)
      unsupportedPreparedLinearAllocationEvidence(
        program,
        "allocating native Linear program has no final linear-allocation-facts-v1 attachment",
      );
    // Historical scalar acquisition remains a genuine generic analysis route.
    assertPreparedIrProgramAllocations(program);
    return undefined;
  }
  if (linear.length === 0) invalid("attachment lacks a Linear projection");
  const facts = assertFactsShape(program);
  for (const module of views) {
    try {
      verifyLinearPreparedAllocationFacts(module, facts);
    } catch (error) {
      invalid(String(error));
    }
  }
  let uncovered: AllocationEvidenceCheck | undefined;
  const globals = nativeModuleGlobalEvidence(program);
  const reports = views.map(
    (module) =>
      nativeJsClassProgramEvidence(program, module) ??
      verifyNativeNumberUndefinedEvidence(module, program.allocations) ??
      verifyNativeAllocationEvidence(module, program.allocations, globals),
  );
  // Examine every required view before acting on a coverage refusal. Covered
  // contradictions must never turn into a fallback analysis or unsupported.
  for (const report of reports) {
    if (report.kind === "invalid") invalid(`semantic evidence ${report.code} at ${JSON.stringify(report.at)}`);
    if (report.kind === "not-covered") uncovered ??= report;
  }
  if (uncovered !== undefined) {
    if (required && program.allocations.size !== 0)
      unsupportedPreparedLinearAllocationEvidence(
        program,
        "native Linear allocation evidence is outside the finite semantic profile",
        uncovered,
      );
    assertPreparedIrProgramAllocations(program);
    return undefined;
  }
  if (
    required &&
    program.allocations.size !== 0 &&
    reports.some((report) => report.kind === "verified" && report.namespaces !== "ownership-and-escape")
  )
    unsupportedPreparedLinearAllocationEvidence(
      program,
      "native Linear allocation evidence requires both ownership and escape namespaces",
    );
  return { module: projection === undefined ? semantic : completeModule(program, projection), facts };
}
