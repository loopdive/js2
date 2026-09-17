// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { TypeDef } from "../model/module-records.js";
import type { ValType } from "../model/instructions.js";

export interface PhysicalTypeEntry {
  readonly typeIndex: number;
  readonly recordIndex: number;
  readonly memberIndex?: number;
  readonly definition: Exclude<TypeDef, { kind: "rec" }>;
}

export interface PhysicalTypeRange {
  readonly start: number;
  readonly end: number;
  readonly recordIndex: number;
}

export interface PhysicalTypeTable {
  readonly entries: readonly PhysicalTypeEntry[];
  readonly recordRanges: readonly PhysicalTypeRange[];
  readonly explicitGroups: readonly PhysicalTypeRange[];
}

export interface PhysicalTypeSectionPlan {
  readonly groups: readonly {
    readonly start: number;
    readonly end: number;
    readonly recursive: boolean;
    readonly explicitRecordIndex?: number;
  }[];
}

/** Index shapes only: reservations may still refer to types reserved later. */
export function indexPhysicalTypes(types: readonly TypeDef[]): PhysicalTypeTable {
  const entries: PhysicalTypeEntry[] = [];
  const recordRanges: PhysicalTypeRange[] = [];
  const explicitGroups: PhysicalTypeRange[] = [];
  for (let recordIndex = 0; recordIndex < types.length; recordIndex++) {
    const record = types[recordIndex];
    if (!Object.hasOwn(types, recordIndex) || !record) throw new Error("missing type record");
    const members = record.kind === "rec" ? record.types : [record];
    if (!members.length) throw new Error("empty recursive type reservation has no physical member");
    const start = entries.length;
    for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
      const definition = members[memberIndex];
      if (!Object.hasOwn(members, memberIndex) || !definition) throw new Error("missing recursive type member");
      if (definition.kind === "rec") throw new Error("nested rec wrappers are not Wasm subtype members");
      if (definition.kind === "sub" && !["func", "struct", "array"].includes(definition.type?.kind))
        throw new Error("nested rec/sub wrappers are not Wasm subtype members");
      if (
        definition.kind === "sub" &&
        definition.type.kind === "struct" &&
        definition.type.superTypeIdx !== undefined
      ) {
        throw new Error("double subtype wrappers are not Wasm subtype members");
      }
      entries.push({
        typeIndex: entries.length,
        recordIndex,
        ...(record.kind === "rec" ? { memberIndex } : {}),
        definition,
      });
    }
    const range = { start, end: entries.length - 1, recordIndex };
    recordRanges.push(range);
    if (record.kind === "rec") explicitGroups.push(range);
  }
  return { entries, recordRanges, explicitGroups };
}

/** Plan vector entries without changing any flattened reference or explicit identity. */
export function planPhysicalTypeSection(
  table: PhysicalTypeTable,
  forcedGroups: ReadonlyArray<readonly [number, number]> = [],
): PhysicalTypeSectionPlan {
  const { entries, explicitGroups } = table;
  const checkIndex = (index: number): void => {
    if (!Number.isInteger(index) || index < 0 || index >= entries.length)
      throw new RangeError(`type index out of range: ${index} (count ${entries.length})`);
  };
  const references = entries.map(({ definition, typeIndex }) => {
    const refs: number[] = [];
    const value = (v: ValType): void => {
      if (v.kind === "ref" || v.kind === "ref_null") {
        checkIndex(v.typeIdx);
        refs.push(v.typeIdx);
      }
    };
    const parent = (index: number): void => {
      checkIndex(index);
      if (index >= typeIndex) throw new Error(`supertype ${index} must precede subtype ${typeIndex}`);
    };
    if (definition.kind === "sub" && definition.superType !== null) parent(definition.superType);
    const payload = definition.kind === "sub" ? definition.type : definition;
    switch (payload.kind) {
      case "func":
        payload.params.forEach(value);
        payload.results.forEach(value);
        break;
      case "struct":
        if (payload.superTypeIdx !== undefined && payload.superTypeIdx !== -1) parent(payload.superTypeIdx);
        for (const field of payload.fields) value(field.type);
        break;
      case "array":
        value(payload.element);
        break;
      default:
        throw new Error("nested rec/sub wrappers are not Wasm subtype members");
    }
    return refs;
  });
  for (const [start, end] of forcedGroups) {
    checkIndex(start);
    checkIndex(end);
    if (end < start) throw new Error("invalid forced type group interval");
    for (const explicit of explicitGroups) {
      if (start <= explicit.end && end >= explicit.start && (start !== explicit.start || end !== explicit.end))
        throw new Error("forced group would split or merge an explicit rec group");
    }
  }
  const groups: PhysicalTypeSectionPlan["groups"][number][] = [];
  for (let start = 0; start < entries.length; ) {
    const explicit = explicitGroups.find((group) => group.start === start);
    let end = explicit?.end ?? start;
    for (let scan = start; scan <= end; scan++) {
      for (const target of references[scan]!) end = Math.max(end, target);
      for (const [forcedStart, forcedEnd] of forcedGroups) {
        if (forcedStart <= end && forcedEnd >= start) end = Math.max(end, forcedEnd);
      }
      if (explicit && end !== explicit.end) throw new Error("reference would merge an explicit rec group");
      if (!explicit && explicitGroups.some((group) => start <= group.end && end >= group.start))
        throw new Error("reference would merge an explicit rec group");
    }
    groups.push({
      start,
      end,
      recursive: !!explicit || end > start,
      ...(explicit ? { explicitRecordIndex: explicit.recordIndex } : {}),
    });
    start = end + 1;
  }
  for (const [start, end] of forcedGroups) {
    if (!groups.some((group) => group.start === start && group.end === end))
      throw new Error("canonical runtime rec-group merged with an adjacent type");
  }
  return { groups };
}
