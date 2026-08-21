// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ProgramAbiPlanEntry } from "../ir/program-abi.js";

type ProgramAbiIntent = ProgramAbiPlanEntry["intent"];

/** Exact equality for replayed Program-ABI intent records. */
export function programAbiIntentsEqual(a: ProgramAbiIntent, b: ProgramAbiIntent): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "callable" && b.kind === "callable") {
    return (
      a.origin === b.origin &&
      a.unitId === b.unitId &&
      a.classId === b.classId &&
      a.sourceId === b.sourceId &&
      a.capabilityId === b.capabilityId &&
      a.providerId === b.providerId &&
      a.signature.params.length === b.signature.params.length &&
      a.signature.params.every((value, index) => value === b.signature.params[index]) &&
      a.signature.results.length === b.signature.results.length &&
      a.signature.results.every((value, index) => value === b.signature.results[index])
    );
  }
  if (a.kind === "global" && b.kind === "global") {
    return (
      a.origin === b.origin &&
      a.valueType === b.valueType &&
      a.mutable === b.mutable &&
      a.capability === b.capability &&
      a.sourceId === b.sourceId &&
      a.unitId === b.unitId
    );
  }
  if (a.kind === "type" && b.kind === "type") return a.shapeKey === b.shapeKey;
  if (a.kind === "export" && b.kind === "export") {
    return a.externalName === b.externalName && a.targetId === b.targetId;
  }
  if (a.kind === "class" && b.kind === "class") return a.classId === b.classId && a.layoutKey === b.layoutKey;
  return a.kind === "support" && b.kind === "support" && a.role === b.role;
}
