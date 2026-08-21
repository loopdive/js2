#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IR_CUTOVER_AUDIT_SCHEMA = "js2-ir-cutover-audit-v1";
export const IR_CUTOVER_CORPUS_MANIFEST_SCHEMA = "js2-ir-cutover-corpus-manifest-v1";
export const IR_CUTOVER_CORPUS_RECEIPT_SCHEMA = "js2-ir-cutover-corpus-receipt-v1";

const CORPUS_COUNT_FIELDS = Object.freeze([
  "sourceCount",
  "classCount",
  "allUnitCount",
  "terminalUnitCount",
  "ownedSupportUnitCount",
  "unownedSupportUnitCount",
  "derivedUnitCount",
]);

// The stream records invocations that reach a WasmGC generator. Corpus
// orchestration must provide explicit record/source/unit floors because parse
// and semantic failures before codegen cannot appear in this JSONL file.

const ROUTES = Object.freeze({
  compile: Object.freeze({ graph: "single", generator: "generateModule" }),
  compileSourceSync: Object.freeze({ graph: "single", generator: "generateModule" }),
  compileMulti: Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
  compileFiles: Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
  compileProject: Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
  "incremental.compile": Object.freeze({ graph: "single", generator: "generateModule" }),
  "incremental.compileMulti": Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
});

const LEGACY_ENTRY_POINTS = new Set([
  "compileDeclarations",
  "compileModuleInitBody",
  "compileFunctionBody",
  "compileClassBodies",
  "compileNestedFunctionDeclaration",
  "compileNestedClassDeclaration",
  "compileLiftedClosureBody",
  "compileArrowAsClosure",
  "compileStatement",
  "compileExpression",
]);

const UNIT_DISPOSITIONS = new Set([
  "legacy-ast-entry",
  "terminal-ir",
  "terminal-legacy",
  "owned-support-ir-owner",
  "owned-support-legacy-owner",
  "owned-support-unresolved-owner",
  "unowned-support",
  "unresolved-terminal",
]);

const DERIVED_DISPOSITIONS = new Set([
  "derived-ir-owner",
  "derived-legacy-owner",
  "derived-unresolved-owner",
  "derived-unowned",
]);

const SOURCE_KINDS = new Set(["entry", "source", "library", "synthetic"]);
const TARGETS = new Set(["gc", "linear", "wasi", "standalone"]);
const UNIT_KINDS = new Set([
  "top-level-function",
  "nested-function",
  "function-expression",
  "arrow-function",
  "class-constructor",
  "class-implicit-constructor",
  "class-instance-method",
  "class-static-method",
  "class-instance-getter",
  "class-static-getter",
  "class-instance-setter",
  "class-static-setter",
  "class-instance-field-initializer",
  "class-static-field-initializer",
  "class-static-block",
  "object-method",
  "object-getter",
  "object-setter",
  "export-assignment",
  "module-init",
  "synthetic-support",
]);
const TERMINAL_DISPOSITIONS = new Set(["legacy-ast-entry", "terminal-ir", "terminal-legacy", "unresolved-terminal"]);
const OWNED_SUPPORT_DISPOSITIONS = new Set([
  "owned-support-ir-owner",
  "owned-support-legacy-owner",
  "owned-support-unresolved-owner",
]);
const VIOLATION_CODES = new Set([
  "duplicate-outcome-unit",
  "unknown-outcome-unit",
  "missing-terminal-evidence",
  "missing-legacy-entry-evidence",
  "unresolved-legacy-entry",
  "unknown-legacy-class",
  "duplicate-derived-unit",
  "unknown-derived-source",
  "unknown-derived-parent",
  "unknown-derived-owner",
]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(line, code, message) {
  return Object.freeze({ ...(line === undefined ? {} : { line }), code, message });
}

function requiredString(object, field, errors, line, context) {
  const value = object[field];
  if (typeof value !== "string" || value.length === 0) {
    errors.push(error(line, "malformed-record", `${context}.${field} must be a non-empty string`));
    return undefined;
  }
  return value;
}

function optionalString(object, field, errors, line, context) {
  const value = object[field];
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    errors.push(error(line, "malformed-record", `${context}.${field} must be a non-empty string when present`));
    return undefined;
  }
  return value;
}

function requiredBoolean(object, field, errors, line, context) {
  const value = object[field];
  if (typeof value !== "boolean") {
    errors.push(error(line, "malformed-record", `${context}.${field} must be a boolean`));
    return undefined;
  }
  return value;
}

function requiredInteger(object, field, errors, line, context, minimum = 0) {
  const value = object[field];
  if (!Number.isInteger(value) || value < minimum) {
    errors.push(error(line, "malformed-record", `${context}.${field} must be an integer >= ${minimum}`));
    return undefined;
  }
  return value;
}

function requiredArray(object, field, errors, line, context) {
  const value = object[field];
  if (!Array.isArray(value)) {
    errors.push(error(line, "malformed-record", `${context}.${field} must be an array`));
    return [];
  }
  return value;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return [...duplicates].sort();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeIrCutoverCorpusManifestDigest(manifest) {
  if (!isObject(manifest)) return undefined;
  const { digest: _digest, ...unsigned } = manifest;
  return `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`;
}

function isNormalizedSourceKey(value) {
  return (
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function validateSources(audit, errors, line) {
  const sources = requiredArray(audit, "sources", errors, line, "audit");
  const ids = [];
  const orders = [];
  const sourceKeys = [];
  for (const [index, source] of sources.entries()) {
    const context = `audit.sources[${index}]`;
    if (!isObject(source)) {
      errors.push(error(line, "malformed-record", `${context} must be an object`));
      continue;
    }
    const id = requiredString(source, "id", errors, line, context);
    const order = requiredInteger(source, "order", errors, line, context);
    const kind = requiredString(source, "kind", errors, line, context);
    const sourceKey = requiredString(source, "sourceKey", errors, line, context);
    if (kind !== undefined && !SOURCE_KINDS.has(kind)) {
      errors.push(error(line, "unknown-source-kind", `${context}.kind is unknown: ${JSON.stringify(kind)}`));
    }
    if (id !== undefined) ids.push(id);
    if (order !== undefined) orders.push(order);
    if (sourceKey !== undefined) sourceKeys.push(sourceKey);
    if (order !== undefined && order !== index) {
      errors.push(
        error(line, "source-order-mismatch", `${context}.order must equal its canonical array index ${index}`),
      );
    }
    if (sourceKey !== undefined && !isNormalizedSourceKey(sourceKey)) {
      errors.push(error(line, "noncanonical-source-key", `${context}.sourceKey is not a normalized relative key`));
    }
  }
  for (const id of duplicateValues(ids)) {
    errors.push(error(line, "duplicate-source-id", `audit.sources repeats source identity ${JSON.stringify(id)}`));
  }
  for (const order of duplicateValues(orders)) {
    errors.push(error(line, "duplicate-source-order", `audit.sources repeats source order ${order}`));
  }
  for (const sourceKey of duplicateValues(sourceKeys)) {
    errors.push(error(line, "duplicate-source-key", `audit.sources repeats sourceKey ${JSON.stringify(sourceKey)}`));
  }
  return {
    sources,
    sourceIds: new Set(ids),
    sourceKeysById: new Map(
      sources.flatMap((source) =>
        isObject(source) && typeof source.id === "string" && typeof source.sourceKey === "string"
          ? [[source.id, source.sourceKey]]
          : [],
      ),
    ),
  };
}

function validateClasses(audit, sourceIds, errors, line) {
  const classes = requiredArray(audit, "classes", errors, line, "audit");
  const ids = [];
  for (const [index, record] of classes.entries()) {
    const context = `audit.classes[${index}]`;
    if (!isObject(record)) {
      errors.push(error(line, "malformed-record", `${context} must be an object`));
      continue;
    }
    const id = requiredString(record, "id", errors, line, context);
    const sourceId = requiredString(record, "sourceId", errors, line, context);
    if (record.lexicalOwnerId !== null && (typeof record.lexicalOwnerId !== "string" || !record.lexicalOwnerId)) {
      errors.push(error(line, "malformed-record", `${context}.lexicalOwnerId must be null or a non-empty string`));
    }
    const declarationKind = requiredString(record, "declarationKind", errors, line, context);
    requiredInteger(record, "ordinal", errors, line, context);
    optionalString(record, "syntheticRole", errors, line, context);
    requiredString(record, "displayName", errors, line, context);
    requiredInteger(record, "line", errors, line, context, 1);
    requiredInteger(record, "column", errors, line, context, 1);
    const declarationStart = requiredInteger(record, "declarationStart", errors, line, context);
    const declarationEnd = requiredInteger(record, "declarationEnd", errors, line, context);
    if (sourceId !== undefined && !sourceIds.has(sourceId)) {
      errors.push(error(line, "unknown-source-id", `${context} references unknown source ${JSON.stringify(sourceId)}`));
    }
    if (declarationKind !== undefined && declarationKind !== "declaration" && declarationKind !== "expression") {
      errors.push(error(line, "malformed-record", `${context}.declarationKind must be "declaration" or "expression"`));
    }
    if (declarationStart !== undefined && declarationEnd !== undefined && declarationEnd < declarationStart) {
      errors.push(error(line, "class-span-mismatch", `${context}.declarationEnd precedes declarationStart`));
    }
    if (id !== undefined) ids.push(id);
  }
  for (const id of duplicateValues(ids)) {
    errors.push(error(line, "duplicate-class-id", `audit.classes repeats class identity ${JSON.stringify(id)}`));
  }
  return {
    classes,
    classesById: new Map(
      classes.flatMap((record) => (isObject(record) && typeof record.id === "string" ? [[record.id, record]] : [])),
    ),
  };
}

function validateDispositions(audit, sourceIds, errors, line) {
  const dispositions = requiredArray(audit, "dispositions", errors, line, "audit");
  const ids = [];
  for (const [index, row] of dispositions.entries()) {
    const context = `audit.dispositions[${index}]`;
    if (!isObject(row)) {
      errors.push(error(line, "malformed-record", `${context} must be an object`));
      continue;
    }
    const sourceId = requiredString(row, "sourceId", errors, line, context);
    const unitId = requiredString(row, "unitId", errors, line, context);
    const unitKind = requiredString(row, "unitKind", errors, line, context);
    const terminal = requiredBoolean(row, "terminal", errors, line, context);
    const disposition = requiredString(row, "disposition", errors, line, context);
    if (row.terminalOwnerId !== null && (typeof row.terminalOwnerId !== "string" || row.terminalOwnerId.length === 0)) {
      errors.push(error(line, "malformed-record", `${context}.terminalOwnerId must be null or a non-empty string`));
    }
    if (sourceId !== undefined && !sourceIds.has(sourceId)) {
      errors.push(error(line, "unknown-source-id", `${context} references unknown source ${JSON.stringify(sourceId)}`));
    }
    if (disposition !== undefined && !UNIT_DISPOSITIONS.has(disposition)) {
      errors.push(error(line, "malformed-record", `${context}.disposition is unknown: ${JSON.stringify(disposition)}`));
    }
    if (unitKind !== undefined && !UNIT_KINDS.has(unitKind)) {
      errors.push(error(line, "unknown-unit-kind", `${context}.unitKind is unknown: ${JSON.stringify(unitKind)}`));
    }
    if (terminal === true && unitId !== undefined && row.terminalOwnerId !== unitId) {
      errors.push(error(line, "terminal-owner-mismatch", `${context} must own itself because it is terminal`));
    }
    if (unitId !== undefined) ids.push(unitId);
  }
  for (const id of duplicateValues(ids)) {
    errors.push(error(line, "duplicate-unit-id", `audit.dispositions repeats unit identity ${JSON.stringify(id)}`));
  }
  const terminalIds = new Set(
    dispositions
      .filter((row) => isObject(row) && row.terminal === true && typeof row.unitId === "string")
      .map((row) => row.unitId),
  );
  const terminalRowsById = new Map(
    dispositions.flatMap((row) =>
      isObject(row) && row.terminal === true && typeof row.unitId === "string" ? [[row.unitId, row]] : [],
    ),
  );
  for (const [index, row] of dispositions.entries()) {
    if (!isObject(row) || typeof row.disposition !== "string") continue;
    const context = `audit.dispositions[${index}]`;
    if (row.terminal === true) {
      if (!TERMINAL_DISPOSITIONS.has(row.disposition)) {
        errors.push(error(line, "terminal-disposition-mismatch", `${context} has a support-only disposition`));
      }
    } else if (typeof row.terminalOwnerId === "string") {
      const owner = terminalRowsById.get(row.terminalOwnerId);
      if (!terminalIds.has(row.terminalOwnerId)) {
        errors.push(
          error(line, "unknown-support-owner", `${context} references non-terminal owner ${row.terminalOwnerId}`),
        );
      } else if (owner?.sourceId !== row.sourceId) {
        errors.push(error(line, "support-owner-source-mismatch", `${context} owner belongs to a different source`));
      }
      if (row.disposition !== "legacy-ast-entry" && !OWNED_SUPPORT_DISPOSITIONS.has(row.disposition)) {
        errors.push(error(line, "support-disposition-mismatch", `${context} has a non-owned-support disposition`));
      } else if (row.disposition !== "legacy-ast-entry" && owner !== undefined) {
        const expectedDisposition =
          owner.disposition === "terminal-ir"
            ? "owned-support-ir-owner"
            : owner.disposition === "legacy-ast-entry" || owner.disposition === "terminal-legacy"
              ? "owned-support-legacy-owner"
              : "owned-support-unresolved-owner";
        if (row.disposition !== expectedDisposition) {
          errors.push(
            error(
              line,
              "support-owner-disposition-mismatch",
              `${context} requires ${expectedDisposition}, received ${row.disposition}`,
            ),
          );
        }
      }
    } else if (
      row.terminalOwnerId === null &&
      row.disposition !== "legacy-ast-entry" &&
      row.disposition !== "unowned-support"
    ) {
      errors.push(error(line, "support-disposition-mismatch", `${context} must use unowned-support`));
    }
  }
  return {
    dispositions,
    dispositionIds: new Set(ids),
    dispositionsById: new Map(
      dispositions.flatMap((row) => (isObject(row) && typeof row.unitId === "string" ? [[row.unitId, row]] : [])),
    ),
  };
}

function validateLegacyEntries(
  audit,
  sourceIds,
  sourceKeysById,
  classesById,
  dispositionsById,
  exactEvidenceRequired,
  errors,
  line,
) {
  const entries = requiredArray(audit, "legacyEntries", errors, line, "audit");
  const identities = [];
  const missingSourceEntries = [];
  for (const [index, entry] of entries.entries()) {
    const context = `audit.legacyEntries[${index}]`;
    if (!isObject(entry)) {
      errors.push(error(line, "malformed-record", `${context} must be an object`));
      continue;
    }
    const target = requiredString(entry, "target", errors, line, context);
    const entryPoint = requiredString(entry, "entryPoint", errors, line, context);
    const bodyName = requiredString(entry, "bodyName", errors, line, context);
    const file = requiredString(entry, "file", errors, line, context);
    const sourceId = optionalString(entry, "sourceId", errors, line, context);
    const unitId = optionalString(entry, "unitId", errors, line, context);
    const classId = optionalString(entry, "classId", errors, line, context);
    const entryUnitKind = optionalString(entry, "unitKind", errors, line, context);
    requiredInteger(entry, "line", errors, line, context, 1);
    requiredInteger(entry, "column", errors, line, context, 1);
    requiredInteger(entry, "count", errors, line, context, 1);
    if (entry.terminalOwnerId !== undefined && entry.terminalOwnerId !== null) {
      optionalString(entry, "terminalOwnerId", errors, line, context);
    }
    if (target !== undefined && target !== audit.target) {
      errors.push(error(line, "entry-target-mismatch", `${context}.target does not match audit.target`));
    }
    if (entryPoint !== undefined && !LEGACY_ENTRY_POINTS.has(entryPoint)) {
      errors.push(error(line, "malformed-record", `${context}.entryPoint is unknown: ${JSON.stringify(entryPoint)}`));
    }
    if (
      entryPoint === "compileDeclarations" &&
      (unitId !== undefined ||
        classId !== undefined ||
        entryUnitKind !== undefined ||
        entry.terminalOwnerId !== undefined)
    ) {
      errors.push(error(line, "declaration-entry-shape", `${context} must contain source-only census evidence`));
    }
    if (unitId === undefined && (entryUnitKind !== undefined || entry.terminalOwnerId !== undefined)) {
      errors.push(error(line, "unit-metadata-without-id", `${context} has unit metadata without unitId`));
    }
    if (sourceId === undefined) {
      missingSourceEntries.push({ index, unitId });
      if (exactEvidenceRequired) {
        errors.push(error(line, "missing-entry-source", `${context}.sourceId is required for exact evidence`));
      }
    }
    if (entryUnitKind !== undefined && !UNIT_KINDS.has(entryUnitKind)) {
      errors.push(error(line, "unknown-unit-kind", `${context}.unitKind is unknown: ${JSON.stringify(entryUnitKind)}`));
    }
    if (sourceId !== undefined && !sourceIds.has(sourceId)) {
      errors.push(error(line, "unknown-source-id", `${context} references unknown source ${JSON.stringify(sourceId)}`));
    }
    if (sourceId !== undefined && sourceKeysById.has(sourceId) && file !== sourceKeysById.get(sourceId)) {
      errors.push(
        error(
          line,
          "entry-source-key-mismatch",
          `${context}.file must equal the normalized sourceKey for ${JSON.stringify(sourceId)}`,
        ),
      );
    }
    const unit = unitId === undefined ? undefined : dispositionsById.get(unitId);
    const classRecord = classId === undefined ? undefined : classesById.get(classId);
    if (unitId !== undefined && unit === undefined) {
      errors.push(error(line, "unknown-unit-id", `${context} references unknown unit ${JSON.stringify(unitId)}`));
    }
    if (classId !== undefined && classRecord === undefined) {
      errors.push(error(line, "unknown-class-id", `${context} references unknown class ${JSON.stringify(classId)}`));
    }
    if (sourceId !== undefined && unit !== undefined && unit.sourceId !== sourceId) {
      errors.push(error(line, "entry-unit-source-mismatch", `${context}.unitId belongs to a different source`));
    }
    if (sourceId !== undefined && classRecord !== undefined && classRecord.sourceId !== sourceId) {
      errors.push(error(line, "entry-class-source-mismatch", `${context}.classId belongs to a different source`));
    }
    if (unit !== undefined && classRecord !== undefined && unit.sourceId !== classRecord.sourceId) {
      errors.push(
        error(line, "entry-unit-class-source-mismatch", `${context}.unitId and .classId belong to different sources`),
      );
    }
    if (unit !== undefined && entryUnitKind !== unit.unitKind) {
      errors.push(error(line, "entry-unit-kind-mismatch", `${context}.unitKind does not match its unit inventory row`));
    }
    if (unit !== undefined && entry.terminalOwnerId !== unit.terminalOwnerId) {
      errors.push(
        error(
          line,
          "entry-terminal-owner-mismatch",
          `${context}.terminalOwnerId does not match its unit inventory row`,
        ),
      );
    }
    identities.push(
      JSON.stringify([entryPoint, bodyName, sourceId ?? null, unitId ?? null, file, entry.line, entry.column]),
    );
  }
  for (const identity of duplicateValues(identities)) {
    errors.push(error(line, "duplicate-legacy-entry", `audit.legacyEntries repeats physical identity ${identity}`));
  }
  return { entries, missingSourceEntries };
}

function validateLegacyEntryDispositions(dispositions, legacyEntries, errors, line) {
  const physicalUnitIds = new Set(
    legacyEntries.flatMap((entry) =>
      isObject(entry) && entry.entryPoint !== "compileDeclarations" && typeof entry.unitId === "string"
        ? [entry.unitId]
        : [],
    ),
  );
  for (const [index, row] of dispositions.entries()) {
    if (!isObject(row) || typeof row.unitId !== "string") continue;
    const hasPhysicalEntry = physicalUnitIds.has(row.unitId);
    if ((row.disposition === "legacy-ast-entry") !== hasPhysicalEntry) {
      errors.push(
        error(
          line,
          "legacy-entry-disposition-mismatch",
          `audit.dispositions[${index}] physical-entry evidence does not match its disposition`,
        ),
      );
    }
  }
}

function validateDerivedUnits(audit, sourceIds, dispositionsById, errors, line) {
  const derivedUnits = requiredArray(audit, "derivedUnits", errors, line, "audit");
  const ids = [];
  for (const [index, unit] of derivedUnits.entries()) {
    const context = `audit.derivedUnits[${index}]`;
    if (!isObject(unit)) {
      errors.push(error(line, "malformed-record", `${context} must be an object`));
      continue;
    }
    const id = requiredString(unit, "id", errors, line, context);
    const sourceId = requiredString(unit, "sourceId", errors, line, context);
    requiredString(unit, "parentId", errors, line, context);
    requiredString(unit, "role", errors, line, context);
    requiredInteger(unit, "ordinal", errors, line, context);
    const disposition = requiredString(unit, "disposition", errors, line, context);
    if (
      unit.terminalOwnerId !== null &&
      (typeof unit.terminalOwnerId !== "string" || unit.terminalOwnerId.length === 0)
    ) {
      errors.push(error(line, "malformed-record", `${context}.terminalOwnerId must be null or a non-empty string`));
    }
    if (sourceId !== undefined && !sourceIds.has(sourceId)) {
      errors.push(error(line, "unknown-source-id", `${context} references unknown source ${JSON.stringify(sourceId)}`));
    }
    if (id !== undefined) ids.push(id);
    if (disposition !== undefined && !DERIVED_DISPOSITIONS.has(disposition)) {
      errors.push(error(line, "malformed-record", `${context}.disposition is unknown: ${JSON.stringify(disposition)}`));
    }
  }
  const derivedIds = new Set(ids);
  const dispositionIds = new Set(dispositionsById.keys());
  for (const id of duplicateValues(ids)) {
    errors.push(error(line, "duplicate-derived-id", `audit.derivedUnits repeats unit identity ${JSON.stringify(id)}`));
  }
  for (const id of derivedIds) {
    if (dispositionIds.has(id)) {
      errors.push(
        error(line, "duplicate-unit-id", `derived unit identity overlaps source inventory ${JSON.stringify(id)}`),
      );
    }
  }
  const derivedById = new Map(
    derivedUnits.flatMap((unit) => (isObject(unit) && typeof unit.id === "string" ? [[unit.id, unit]] : [])),
  );
  const allUnitsById = new Map([...dispositionsById, ...derivedById]);
  for (const [index, unit] of derivedUnits.entries()) {
    if (!isObject(unit)) continue;
    const parent = typeof unit.parentId === "string" ? allUnitsById.get(unit.parentId) : undefined;
    const owner = typeof unit.terminalOwnerId === "string" ? dispositionsById.get(unit.terminalOwnerId) : undefined;
    if (typeof unit.parentId === "string" && parent === undefined) {
      errors.push(
        error(
          line,
          "unknown-derived-parent",
          `audit.derivedUnits[${index}] references unknown parent ${unit.parentId}`,
        ),
      );
    } else if (parent !== undefined && parent.sourceId !== unit.sourceId) {
      errors.push(error(line, "derived-parent-source-mismatch", `audit.derivedUnits[${index}] parent source differs`));
    } else if (parent !== undefined && parent.terminalOwnerId !== unit.terminalOwnerId) {
      errors.push(error(line, "derived-parent-owner-mismatch", `audit.derivedUnits[${index}] parent owner differs`));
    }
    if (typeof unit.terminalOwnerId === "string" && owner?.terminal !== true) {
      errors.push(
        error(
          line,
          "unknown-derived-owner",
          `audit.derivedUnits[${index}] references non-terminal owner ${unit.terminalOwnerId}`,
        ),
      );
    } else if (owner !== undefined && owner.sourceId !== unit.sourceId) {
      errors.push(error(line, "derived-owner-source-mismatch", `audit.derivedUnits[${index}] owner source differs`));
    }
    const expectedDisposition =
      unit.terminalOwnerId === null
        ? "derived-unowned"
        : owner?.disposition === "terminal-ir"
          ? "derived-ir-owner"
          : owner?.disposition === "legacy-ast-entry" || owner?.disposition === "terminal-legacy"
            ? "derived-legacy-owner"
            : "derived-unresolved-owner";
    if (unit.disposition !== expectedDisposition) {
      errors.push(
        error(
          line,
          "derived-disposition-mismatch",
          `audit.derivedUnits[${index}] requires ${expectedDisposition}, received ${unit.disposition}`,
        ),
      );
    }
  }
  const reportedCycles = new Set();
  for (const unit of derivedById.values()) {
    const path = new Set();
    let current = unit;
    while (isObject(current) && typeof current.id === "string" && typeof current.parentId === "string") {
      if (path.has(current.id)) {
        if (!reportedCycles.has(current.id)) {
          reportedCycles.add(current.id);
          errors.push(error(line, "derived-parent-cycle", `audit.derivedUnits contains a cycle at ${current.id}`));
        }
        break;
      }
      path.add(current.id);
      current = derivedById.get(current.parentId);
    }
  }
  return derivedUnits;
}

function validateViolations(audit, errors, line) {
  const violations = requiredArray(audit, "violations", errors, line, "audit");
  for (const [index, violation] of violations.entries()) {
    const context = `audit.violations[${index}]`;
    if (!isObject(violation)) {
      errors.push(error(line, "malformed-record", `${context} must be an object`));
      continue;
    }
    const code = requiredString(violation, "code", errors, line, context);
    requiredString(violation, "detail", errors, line, context);
    optionalString(violation, "unitId", errors, line, context);
    if (code !== undefined && !VIOLATION_CODES.has(code)) {
      errors.push(error(line, "unknown-violation-code", `${context}.code is unknown: ${JSON.stringify(code)}`));
    }
  }
  return violations;
}

function validateMissingSourceViolations(missingSourceEntries, violations, errors, line) {
  const available = violations
    .map((violation, index) => ({ violation, index }))
    .filter(({ violation }) => isObject(violation) && violation.code === "unresolved-legacy-entry");
  const consumed = new Set();
  const matchedEntries = new Set();

  for (const entry of missingSourceEntries) {
    if (entry.unitId === undefined) continue;
    const match = available.find(({ violation, index }) => !consumed.has(index) && violation.unitId === entry.unitId);
    if (match !== undefined) {
      consumed.add(match.index);
      matchedEntries.add(entry.index);
    }
  }
  for (const entry of missingSourceEntries) {
    if (matchedEntries.has(entry.index)) continue;
    const match = available.find(({ violation, index }) => !consumed.has(index) && violation.unitId === undefined);
    if (match !== undefined) {
      consumed.add(match.index);
      matchedEntries.add(entry.index);
    }
  }
  for (const entry of missingSourceEntries) {
    if (matchedEntries.has(entry.index)) continue;
    const context = `audit.legacyEntries[${entry.index}]`;
    errors.push(
      error(
        line,
        "missing-unresolved-entry-violation",
        `${context} without sourceId requires its own unresolved-legacy-entry violation${
          entry.unitId === undefined ? "" : ` for unit ${entry.unitId}`
        }`,
      ),
    );
  }
}

function validateCounts(audit, sources, classes, dispositions, legacyEntries, violations, errors, line) {
  const declared = {
    sourceCount: requiredInteger(audit, "sourceCount", errors, line, "audit"),
    classCount: requiredInteger(audit, "classCount", errors, line, "audit"),
    allUnitCount: requiredInteger(audit, "allUnitCount", errors, line, "audit"),
    terminalUnitCount: requiredInteger(audit, "terminalUnitCount", errors, line, "audit"),
    ownedSupportUnitCount: requiredInteger(audit, "ownedSupportUnitCount", errors, line, "audit"),
    unownedSupportUnitCount: requiredInteger(audit, "unownedSupportUnitCount", errors, line, "audit"),
    unattributedLegacyEntryCount: requiredInteger(audit, "unattributedLegacyEntryCount", errors, line, "audit"),
  };
  const actual = {
    sourceCount: sources.length,
    classCount: classes.length,
    allUnitCount: dispositions.length,
    terminalUnitCount: dispositions.filter((row) => isObject(row) && row.terminal === true).length,
    ownedSupportUnitCount: dispositions.filter(
      (row) => isObject(row) && row.terminal === false && typeof row.terminalOwnerId === "string",
    ).length,
    unownedSupportUnitCount: dispositions.filter(
      (row) => isObject(row) && row.terminal === false && row.terminalOwnerId === null,
    ).length,
    unattributedLegacyEntryCount: legacyEntries.filter(
      (entry) =>
        isObject(entry) &&
        entry.unitId === undefined &&
        entry.classId === undefined &&
        entry.entryPoint !== "compileDeclarations",
    ).length,
  };
  for (const [field, value] of Object.entries(actual)) {
    if (declared[field] !== undefined && declared[field] !== value) {
      errors.push(error(line, "count-mismatch", `audit.${field} declares ${declared[field]}, observed ${value}`));
    }
  }
  if (
    declared.allUnitCount !== undefined &&
    declared.terminalUnitCount !== undefined &&
    declared.ownedSupportUnitCount !== undefined &&
    declared.unownedSupportUnitCount !== undefined &&
    declared.allUnitCount !==
      declared.terminalUnitCount + declared.ownedSupportUnitCount + declared.unownedSupportUnitCount
  ) {
    errors.push(error(line, "count-mismatch", "terminal and support counts do not reconcile to allUnitCount"));
  }
  const structurallyComplete = requiredBoolean(audit, "structurallyComplete", errors, line, "audit");
  if (structurallyComplete !== undefined && structurallyComplete !== (violations.length === 0)) {
    errors.push(
      error(
        line,
        "completeness-mismatch",
        `audit.structurallyComplete=${structurallyComplete} does not reconcile with ${violations.length} violations`,
      ),
    );
  }
}

function validateEnvelope(value, line) {
  const errors = [];
  if (!isObject(value)) {
    return { errors: [error(line, "malformed-envelope", "JSONL record must be an object")] };
  }
  if (value.schema !== IR_CUTOVER_AUDIT_SCHEMA) {
    errors.push(
      error(
        line,
        "schema-mismatch",
        `envelope.schema must be ${JSON.stringify(IR_CUTOVER_AUDIT_SCHEMA)}, received ${JSON.stringify(value.schema)}`,
      ),
    );
  }
  requiredBoolean(value, "success", errors, line, "envelope");
  if (!isObject(value.audit)) {
    errors.push(error(line, "malformed-envelope", "envelope.audit must be an object"));
    return { errors };
  }
  const audit = value.audit;
  const route = requiredString(audit, "route", errors, line, "audit");
  const target = requiredString(audit, "target", errors, line, "audit");
  if (target !== undefined && !TARGETS.has(target)) {
    errors.push(error(line, "unknown-target", `audit.target is unknown: ${JSON.stringify(target)}`));
  }
  const graph = requiredString(audit, "graph", errors, line, "audit");
  const generator = requiredString(audit, "generator", errors, line, "audit");
  const expected = route === undefined ? undefined : ROUTES[route];
  if (!expected) {
    errors.push(error(line, "unknown-route", `audit.route is unknown: ${JSON.stringify(route)}`));
  } else if (graph !== expected.graph || generator !== expected.generator) {
    errors.push(
      error(
        line,
        "route-mismatch",
        `route ${route} requires ${expected.graph}/${expected.generator}, received ${graph}/${generator}`,
      ),
    );
  }
  const { sources, sourceIds, sourceKeysById } = validateSources(audit, errors, line);
  const { classes, classesById } = validateClasses(audit, sourceIds, errors, line);
  const { dispositions, dispositionIds, dispositionsById } = validateDispositions(audit, sourceIds, errors, line);
  for (const [index, record] of classes.entries()) {
    if (!isObject(record) || typeof record.lexicalOwnerId !== "string") continue;
    const owner = classesById.get(record.lexicalOwnerId) ?? dispositionsById.get(record.lexicalOwnerId);
    if (owner === undefined) {
      errors.push(
        error(
          line,
          "unknown-class-owner",
          `audit.classes[${index}] references unknown lexical owner ${record.lexicalOwnerId}`,
        ),
      );
    } else if (owner.sourceId !== record.sourceId) {
      errors.push(
        error(line, "class-owner-source-mismatch", `audit.classes[${index}] owner belongs to a different source`),
      );
    }
  }
  const reportedClassCycles = new Set();
  for (const record of classesById.values()) {
    const path = new Set();
    let current = record;
    while (isObject(current) && typeof current.id === "string" && typeof current.lexicalOwnerId === "string") {
      if (path.has(current.id)) {
        if (!reportedClassCycles.has(current.id)) {
          reportedClassCycles.add(current.id);
          errors.push(error(line, "class-owner-cycle", `audit.classes contains an owner cycle at ${current.id}`));
        }
        break;
      }
      path.add(current.id);
      current = classesById.get(current.lexicalOwnerId);
    }
  }
  const { entries: legacyEntries, missingSourceEntries } = validateLegacyEntries(
    audit,
    sourceIds,
    sourceKeysById,
    classesById,
    dispositionsById,
    value.success === true || audit.structurallyComplete === true,
    errors,
    line,
  );
  validateLegacyEntryDispositions(dispositions, legacyEntries, errors, line);
  validateDerivedUnits(audit, sourceIds, dispositionsById, errors, line);
  const violations = validateViolations(audit, errors, line);
  validateMissingSourceViolations(missingSourceEntries, violations, errors, line);
  validateCounts(audit, sources, classes, dispositions, legacyEntries, violations, errors, line);
  return { envelope: value, errors };
}

function strictErrors(envelope, line) {
  const errors = [];
  const audit = envelope.audit;
  const physicalLegacy = audit.legacyEntries.filter((entry) => entry.entryPoint !== "compileDeclarations");
  if (physicalLegacy.length > 0) {
    const entryPoints = [...new Set(physicalLegacy.map((entry) => entry.entryPoint))].sort().join(", ");
    errors.push(error(line, "legacy-entry", `strict mode found direct body entries: ${entryPoints}`));
  }
  for (const row of audit.dispositions) {
    const expected = row.terminal ? "terminal-ir" : "owned-support-ir-owner";
    if (row.disposition !== expected) {
      errors.push(
        error(
          line,
          "legacy-disposition",
          `strict mode requires ${expected} for ${row.unitId}, received ${row.disposition}`,
        ),
      );
    }
  }
  for (const unit of audit.derivedUnits) {
    if (unit.disposition !== "derived-ir-owner") {
      errors.push(
        error(
          line,
          "legacy-derived-disposition",
          `strict mode requires derived-ir-owner for ${unit.id}, received ${unit.disposition}`,
        ),
      );
    }
  }
  return errors;
}

/** Validate one JSONL audit stream and return a deterministic, serializable gate report. */
export function evaluateIrCutoverAuditJsonl(text, options = {}) {
  const requiredRoutes = [...new Set(options.requiredRoutes ?? [])].sort();
  const requireNoLegacy = options.requireNoLegacy === true;
  const expectSuccessful = options.expectSuccessful;
  const minSources = options.minSources;
  const minUnits = options.minUnits;
  const input = options.input ?? "<memory>";
  const errors = [];
  for (const route of requiredRoutes) {
    if (!ROUTES[route]) errors.push(error(undefined, "unknown-required-route", `unknown required route ${route}`));
  }

  const rawLines = text.split(/\r?\n/u);
  if (rawLines.at(-1) === "") rawLines.pop();
  const records = [];
  for (const [index, rawLine] of rawLines.entries()) {
    const line = index + 1;
    if (rawLine.trim().length === 0) {
      errors.push(error(line, "blank-record", "blank JSONL record"));
      continue;
    }
    let value;
    try {
      value = JSON.parse(rawLine);
    } catch (cause) {
      errors.push(
        error(line, "invalid-json", `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
      continue;
    }
    const validated = validateEnvelope(value, line);
    errors.push(...validated.errors);
    if (validated.envelope && validated.errors.length === 0) records.push({ line, envelope: validated.envelope });
  }

  const standalone = records.filter(({ envelope }) => envelope.audit?.target === "standalone");
  const successful = standalone.filter(({ envelope }) => envelope.success === true);
  const failed = standalone.filter(({ envelope }) => envelope.success === false);
  const successfulSourceCount = successful.reduce((total, { envelope }) => total + envelope.audit.sourceCount, 0);
  const successfulUnitCount = successful.reduce((total, { envelope }) => total + envelope.audit.allUnitCount, 0);
  if (successful.length === 0) {
    errors.push(error(undefined, "no-successful-standalone-record", "no successful standalone audit record found"));
  }
  if (expectSuccessful !== undefined && (!Number.isInteger(expectSuccessful) || expectSuccessful < 1)) {
    errors.push(error(undefined, "invalid-successful-floor", "expectSuccessful must be an integer >= 1"));
  }
  if (minSources !== undefined && (!Number.isInteger(minSources) || minSources < 1)) {
    errors.push(error(undefined, "invalid-source-floor", "minSources must be an integer >= 1"));
  }
  if (minUnits !== undefined && (!Number.isInteger(minUnits) || minUnits < 1)) {
    errors.push(error(undefined, "invalid-unit-floor", "minUnits must be an integer >= 1"));
  }
  if (requireNoLegacy && (expectSuccessful === undefined || minSources === undefined || minUnits === undefined)) {
    errors.push(
      error(
        undefined,
        "strict-denominator-required",
        "--require-no-legacy requires explicit --expect-successful, --min-sources, and --min-units floors",
      ),
    );
  }
  if (requireNoLegacy) {
    for (const { line } of failed) {
      errors.push(
        error(
          line,
          "strict-failed-record",
          "strict mode rejects failed standalone generator records without an exact approved-failure manifest",
        ),
      );
    }
  }
  if (Number.isInteger(expectSuccessful) && expectSuccessful >= 1 && successful.length !== expectSuccessful) {
    errors.push(
      error(
        undefined,
        "successful-count-mismatch",
        `expected ${expectSuccessful} successful standalone records, observed ${successful.length}`,
      ),
    );
  }
  if (Number.isInteger(minSources) && minSources >= 1 && successfulSourceCount < minSources) {
    errors.push(
      error(
        undefined,
        "source-floor-miss",
        `required at least ${minSources} successful standalone sources, observed ${successfulSourceCount}`,
      ),
    );
  }
  if (Number.isInteger(minUnits) && minUnits >= 1 && successfulUnitCount < minUnits) {
    errors.push(
      error(
        undefined,
        "unit-floor-miss",
        `required at least ${minUnits} successful standalone units, observed ${successfulUnitCount}`,
      ),
    );
  }
  for (const { line, envelope } of successful) {
    const audit = envelope.audit;
    if (audit.sourceCount < 1) {
      errors.push(error(line, "empty-source-census", "successful generator record has no inventoried source"));
    }
    if (audit.structurallyComplete !== true) {
      errors.push(error(line, "incomplete-success", "successful standalone record is not structurally complete"));
    }
    if (Array.isArray(audit.violations) && audit.violations.length > 0) {
      errors.push(
        error(
          line,
          "successful-record-violations",
          `successful standalone record has ${audit.violations.length} violations`,
        ),
      );
    }
    if (audit.unattributedLegacyEntryCount !== 0) {
      errors.push(
        error(
          line,
          "unattributed-legacy-entry",
          `successful standalone record has ${audit.unattributedLegacyEntryCount} unattributed legacy entries`,
        ),
      );
    }
    for (const row of audit.dispositions) {
      if (
        row.disposition === "terminal-legacy" ||
        row.disposition === "unresolved-terminal" ||
        row.disposition === "owned-support-unresolved-owner"
      ) {
        errors.push(
          error(
            line,
            "incomplete-success-disposition",
            `successful standalone unit ${row.unitId} has incomplete disposition ${row.disposition}`,
          ),
        );
      }
    }
    for (const unit of audit.derivedUnits) {
      if (unit.disposition === "derived-unresolved-owner") {
        errors.push(
          error(
            line,
            "incomplete-success-disposition",
            `successful standalone derived unit ${unit.id} has incomplete disposition ${unit.disposition}`,
          ),
        );
      }
    }
    if (requireNoLegacy && Array.isArray(audit.legacyEntries)) errors.push(...strictErrors(envelope, line));
  }
  const observedSuccessfulRoutes = new Set(successful.map(({ envelope }) => envelope.audit.route));
  for (const route of requiredRoutes) {
    if (ROUTES[route] && !observedSuccessfulRoutes.has(route)) {
      errors.push(
        error(undefined, "missing-required-route", `no successful standalone record observed route ${route}`),
      );
    }
  }

  const routeCounts = {};
  for (const { envelope } of standalone) {
    const route = envelope.audit.route;
    if (typeof route === "string") routeCounts[route] = (routeCounts[route] ?? 0) + 1;
  }
  const sortedRouteCounts = Object.fromEntries(
    Object.entries(routeCounts).sort(([left], [right]) => left.localeCompare(right)),
  );
  return Object.freeze({
    schema: IR_CUTOVER_AUDIT_SCHEMA,
    ok: errors.length === 0,
    mode: requireNoLegacy ? "require-no-legacy" : "structural",
    input,
    counts: Object.freeze({
      total: rawLines.length,
      parsed: records.length,
      standalone: standalone.length,
      successfulStandalone: successful.length,
      failedStandalone: failed.length,
      ignoredNonStandalone: records.length - standalone.length,
      successfulSources: successfulSourceCount,
      successfulUnits: successfulUnitCount,
    }),
    routes: Object.freeze(sortedRouteCounts),
    requiredRoutes: Object.freeze(requiredRoutes),
    floors: Object.freeze({
      expectSuccessful: expectSuccessful ?? null,
      minSources: minSources ?? null,
      minUnits: minUnits ?? null,
    }),
    errors: Object.freeze(errors),
  });
}

function validateCorpusManifest(manifest) {
  const errors = [];
  if (!isObject(manifest)) {
    return { errors: [error(undefined, "malformed-manifest", "corpus manifest must be an object")] };
  }
  if (manifest.schema !== IR_CUTOVER_CORPUS_MANIFEST_SCHEMA) {
    errors.push(
      error(
        undefined,
        "manifest-schema-mismatch",
        `manifest.schema must be ${JSON.stringify(IR_CUTOVER_CORPUS_MANIFEST_SCHEMA)}`,
      ),
    );
  }
  requiredString(manifest, "id", errors, undefined, "manifest");
  const digest = requiredString(manifest, "digest", errors, undefined, "manifest");
  const observedDigest = computeIrCutoverCorpusManifestDigest(manifest);
  if (digest !== undefined && digest !== observedDigest) {
    errors.push(
      error(undefined, "manifest-digest-mismatch", `manifest digest declares ${digest}, observed ${observedDigest}`),
    );
  }

  const invocation = isObject(manifest.invocation) ? manifest.invocation : {};
  if (!isObject(manifest.invocation)) {
    errors.push(error(undefined, "malformed-manifest", "manifest.invocation must be an object"));
  }
  const route = requiredString(invocation, "route", errors, undefined, "manifest.invocation");
  const target = requiredString(invocation, "target", errors, undefined, "manifest.invocation");
  const graph = requiredString(invocation, "graph", errors, undefined, "manifest.invocation");
  const generator = requiredString(invocation, "generator", errors, undefined, "manifest.invocation");
  const routeIdentity = route === undefined ? undefined : ROUTES[route];
  if (!routeIdentity) {
    errors.push(error(undefined, "manifest-route-mismatch", `manifest route is unknown: ${route}`));
  } else if (graph !== routeIdentity.graph || generator !== routeIdentity.generator) {
    errors.push(
      error(
        undefined,
        "manifest-route-mismatch",
        `manifest route ${route} requires ${routeIdentity.graph}/${routeIdentity.generator}`,
      ),
    );
  }
  if (target !== "standalone") {
    errors.push(error(undefined, "manifest-target-mismatch", "corpus manifest target must be standalone"));
  }

  const sources = requiredArray(manifest, "sources", errors, undefined, "manifest");
  const sourceIds = [];
  const sourcePaths = [];
  const sourcesById = new Map();
  for (const [index, source] of sources.entries()) {
    const context = `manifest.sources[${index}]`;
    if (!isObject(source)) {
      errors.push(error(undefined, "malformed-manifest", `${context} must be an object`));
      continue;
    }
    const id = requiredString(source, "id", errors, undefined, context);
    const path = requiredString(source, "path", errors, undefined, context);
    requiredInteger(source, "bytes", errors, undefined, context, 1);
    const sourceDigest = requiredString(source, "sha256", errors, undefined, context);
    if (path !== undefined && !isNormalizedSourceKey(path)) {
      errors.push(error(undefined, "manifest-source-path", `${context}.path must be a normalized relative path`));
    }
    if (sourceDigest !== undefined && !/^[0-9a-f]{64}$/u.test(sourceDigest)) {
      errors.push(error(undefined, "manifest-source-digest", `${context}.sha256 must be 64 lowercase hex digits`));
    }
    if (id !== undefined) {
      sourceIds.push(id);
      sourcesById.set(id, source);
    }
    if (path !== undefined) sourcePaths.push(path);
  }
  for (const id of duplicateValues(sourceIds)) {
    errors.push(error(undefined, "duplicate-manifest-source", `manifest repeats source id ${id}`));
  }
  for (const path of duplicateValues(sourcePaths)) {
    errors.push(error(undefined, "duplicate-manifest-source", `manifest repeats source path ${path}`));
  }

  const cases = requiredArray(manifest, "cases", errors, undefined, "manifest");
  const caseIds = [];
  const caseSourceIds = [];
  const casesById = new Map();
  for (const [index, corpusCase] of cases.entries()) {
    const context = `manifest.cases[${index}]`;
    if (!isObject(corpusCase)) {
      errors.push(error(undefined, "malformed-manifest", `${context} must be an object`));
      continue;
    }
    const id = requiredString(corpusCase, "id", errors, undefined, context);
    const sourceId = requiredString(corpusCase, "sourceId", errors, undefined, context);
    const sourceKey = requiredString(corpusCase, "sourceKey", errors, undefined, context);
    const auditSourceId = requiredString(corpusCase, "auditSourceId", errors, undefined, context);
    if (sourceKey !== undefined && !isNormalizedSourceKey(sourceKey)) {
      errors.push(error(undefined, "manifest-source-key", `${context}.sourceKey must be normalized`));
    }
    if (sourceId !== undefined && !sourcesById.has(sourceId)) {
      errors.push(error(undefined, "unknown-manifest-source", `${context} references unknown source ${sourceId}`));
    }
    if (!isObject(corpusCase.expected)) {
      errors.push(error(undefined, "malformed-manifest", `${context}.expected must be an object`));
    } else {
      for (const field of CORPUS_COUNT_FIELDS) {
        requiredInteger(corpusCase.expected, field, errors, undefined, `${context}.expected`);
      }
      if (corpusCase.expected.sourceCount !== 1) {
        errors.push(error(undefined, "manifest-source-count", `${context}.expected.sourceCount must equal 1`));
      }
    }
    if (id !== undefined) {
      caseIds.push(id);
      casesById.set(id, corpusCase);
    }
    if (sourceId !== undefined) caseSourceIds.push(sourceId);
    void auditSourceId;
  }
  for (const id of duplicateValues(caseIds)) {
    errors.push(error(undefined, "duplicate-manifest-case", `manifest repeats case id ${id}`));
  }
  for (const sourceId of duplicateValues(caseSourceIds)) {
    errors.push(error(undefined, "duplicate-manifest-case-source", `manifest repeats case source ${sourceId}`));
  }
  for (const sourceId of sourceIds) {
    if (!caseSourceIds.includes(sourceId)) {
      errors.push(error(undefined, "unused-manifest-source", `manifest source ${sourceId} has no case`));
    }
  }

  const totals = isObject(manifest.totals) ? manifest.totals : {};
  if (!isObject(manifest.totals)) {
    errors.push(error(undefined, "malformed-manifest", "manifest.totals must be an object"));
  }
  const totalFields = ["caseCount", "sourceBytes", ...CORPUS_COUNT_FIELDS];
  for (const field of totalFields) requiredInteger(totals, field, errors, undefined, "manifest.totals");
  const computedTotals = {
    caseCount: cases.length,
    sourceBytes: sources.reduce(
      (total, source) => total + (isObject(source) && Number.isInteger(source.bytes) ? source.bytes : 0),
      0,
    ),
  };
  for (const field of CORPUS_COUNT_FIELDS) {
    computedTotals[field] = cases.reduce(
      (total, corpusCase) =>
        total +
        (isObject(corpusCase) && isObject(corpusCase.expected) && Number.isInteger(corpusCase.expected[field])
          ? corpusCase.expected[field]
          : 0),
      0,
    );
  }
  for (const [field, value] of Object.entries(computedTotals)) {
    if (totals[field] !== value) {
      errors.push(
        error(
          undefined,
          "manifest-total-mismatch",
          `manifest.totals.${field} declares ${totals[field]}, cases declare ${value}`,
        ),
      );
    }
  }
  return { errors, digest: observedDigest, invocation, sourcesById, casesById, cases, totals };
}

function corpusCaseErrors(corpusCase, source, envelope, invocation, line) {
  const errors = [];
  const audit = envelope.audit;
  for (const field of ["route", "target", "graph", "generator"]) {
    if (audit[field] !== invocation[field]) {
      errors.push(
        error(
          line,
          "case-invocation-mismatch",
          `${corpusCase.id} expected ${field}=${invocation[field]}, observed ${audit[field]}`,
        ),
      );
    }
  }
  const expectedSources = [corpusCase.auditSourceId];
  const observedSources = audit.sources.map((item) => item.id);
  if (
    JSON.stringify(observedSources) !== JSON.stringify(expectedSources) ||
    audit.sources[0]?.sourceKey !== corpusCase.sourceKey ||
    audit.sources[0]?.kind !== "entry" ||
    audit.sources[0]?.order !== 0
  ) {
    errors.push(
      error(
        line,
        "case-source-mismatch",
        `${corpusCase.id} expected entry source ${corpusCase.auditSourceId}/${corpusCase.sourceKey}`,
      ),
    );
  }
  const observed = {
    sourceCount: audit.sourceCount,
    classCount: audit.classCount,
    allUnitCount: audit.allUnitCount,
    terminalUnitCount: audit.terminalUnitCount,
    ownedSupportUnitCount: audit.ownedSupportUnitCount,
    unownedSupportUnitCount: audit.unownedSupportUnitCount,
    derivedUnitCount: audit.derivedUnits.length,
  };
  for (const field of CORPUS_COUNT_FIELDS) {
    if (observed[field] !== corpusCase.expected[field]) {
      errors.push(
        error(
          line,
          "case-count-mismatch",
          `${corpusCase.id} expected ${field}=${corpusCase.expected[field]}, observed ${observed[field]}`,
        ),
      );
    }
  }
  if (source === undefined) {
    errors.push(error(line, "unknown-manifest-source", `${corpusCase.id} has no pinned source`));
  }
  return errors;
}

/** Validate a runner receipt stream against one exact content-addressed corpus manifest. */
export function evaluateIrCutoverCorpusJsonl(text, manifest, options = {}) {
  const input = options.input ?? "<memory>";
  const manifestValidation = validateCorpusManifest(manifest);
  const errors = [...manifestValidation.errors];
  const rawLines = text.split(/\r?\n/u);
  if (rawLines.at(-1) === "") rawLines.pop();
  const attempts = new Map();
  const completions = new Map();
  const runIds = new Set();
  const validEnvelopes = [];
  const successfulCases = [];

  for (const [index, rawLine] of rawLines.entries()) {
    const line = index + 1;
    if (rawLine.trim().length === 0) {
      errors.push(error(line, "blank-receipt", "blank corpus receipt"));
      continue;
    }
    let receipt;
    try {
      receipt = JSON.parse(rawLine);
    } catch (cause) {
      errors.push(error(line, "invalid-receipt-json", cause instanceof Error ? cause.message : String(cause)));
      continue;
    }
    if (!isObject(receipt)) {
      errors.push(error(line, "malformed-receipt", "corpus receipt must be an object"));
      continue;
    }
    if (receipt.schema !== IR_CUTOVER_CORPUS_RECEIPT_SCHEMA) {
      errors.push(error(line, "receipt-schema-mismatch", `unexpected receipt schema ${receipt.schema}`));
    }
    const runId = requiredString(receipt, "runId", errors, line, "receipt");
    const manifestDigest = requiredString(receipt, "manifestDigest", errors, line, "receipt");
    const caseId = requiredString(receipt, "caseId", errors, line, "receipt");
    const kind = requiredString(receipt, "kind", errors, line, "receipt");
    if (runId !== undefined) runIds.add(runId);
    if (manifestDigest !== manifestValidation.digest) {
      errors.push(
        error(
          line,
          "stale-manifest-receipt",
          `receipt manifest ${manifestDigest} does not match ${manifestValidation.digest}`,
        ),
      );
    }
    const corpusCase = caseId === undefined ? undefined : manifestValidation.casesById?.get(caseId);
    if (caseId !== undefined && corpusCase === undefined) {
      errors.push(error(line, "extra-corpus-case", `receipt references unexpected case ${caseId}`));
    }
    if (kind !== "attempt" && kind !== "completion") {
      errors.push(error(line, "unknown-receipt-kind", `receipt.kind is unknown: ${kind}`));
      continue;
    }
    if (caseId === undefined) continue;
    const target = kind === "attempt" ? attempts : completions;
    const sameKind = target.get(caseId) ?? [];
    sameKind.push({ line, receipt });
    target.set(caseId, sameKind);
    if (kind !== "completion") continue;

    const success = requiredBoolean(receipt, "success", errors, line, "receipt");
    if (success !== true) {
      if (!isObject(receipt.failure)) {
        errors.push(error(line, "malformed-failure-receipt", `${caseId} failure completion lacks failure detail`));
      } else {
        requiredString(receipt.failure, "stage", errors, line, "receipt.failure");
        requiredString(receipt.failure, "message", errors, line, "receipt.failure");
      }
      errors.push(error(line, "failed-corpus-case", `${caseId} did not complete successfully`));
      continue;
    }
    if (!isObject(receipt.source)) {
      errors.push(error(line, "malformed-receipt", `${caseId} successful completion lacks source evidence`));
    } else if (corpusCase !== undefined) {
      const source = manifestValidation.sourcesById?.get(corpusCase.sourceId);
      if (receipt.source.bytes !== source?.bytes || receipt.source.sha256 !== source?.sha256) {
        errors.push(error(line, "source-receipt-mismatch", `${caseId} source receipt differs from its manifest`));
      }
    }
    const validated = validateEnvelope(receipt.envelope, line);
    errors.push(...validated.errors);
    if (validated.envelope === undefined || validated.errors.length > 0) continue;
    if (validated.envelope.success !== true) {
      errors.push(error(line, "failed-audit-envelope", `${caseId} successful completion wraps a failed audit`));
      continue;
    }
    validEnvelopes.push(validated.envelope);
    if (corpusCase !== undefined) {
      const source = manifestValidation.sourcesById?.get(corpusCase.sourceId);
      errors.push(...corpusCaseErrors(corpusCase, source, validated.envelope, manifestValidation.invocation, line));
      successfulCases.push({ corpusCase, source, receipt, envelope: validated.envelope });
    }
  }

  if (runIds.size !== 1) {
    errors.push(error(undefined, "mixed-corpus-run", `expected one runId, observed ${runIds.size}`));
  }
  for (const corpusCase of manifestValidation.cases ?? []) {
    const caseAttempts = attempts.get(corpusCase.id) ?? [];
    const caseCompletions = completions.get(corpusCase.id) ?? [];
    if (caseAttempts.length === 0) errors.push(error(undefined, "missing-corpus-attempt", corpusCase.id));
    if (caseAttempts.length > 1) errors.push(error(undefined, "duplicate-corpus-attempt", corpusCase.id));
    if (caseCompletions.length === 0) errors.push(error(undefined, "missing-corpus-completion", corpusCase.id));
    if (caseCompletions.length > 1) errors.push(error(undefined, "duplicate-corpus-completion", corpusCase.id));
  }

  const observedTotals = {
    caseCount: successfulCases.length,
    sourceBytes: successfulCases.reduce(
      (total, item) => total + (Number.isInteger(item.receipt.source?.bytes) ? item.receipt.source.bytes : 0),
      0,
    ),
  };
  for (const field of CORPUS_COUNT_FIELDS) {
    observedTotals[field] = successfulCases.reduce((total, item) => {
      if (field === "derivedUnitCount") return total + item.envelope.audit.derivedUnits.length;
      return total + item.envelope.audit[field];
    }, 0);
  }
  for (const [field, expected] of Object.entries(manifestValidation.totals ?? {})) {
    if (observedTotals[field] !== expected) {
      errors.push(
        error(undefined, "corpus-total-mismatch", `expected ${field}=${expected}, observed ${observedTotals[field]}`),
      );
    }
  }

  const auditText = validEnvelopes.map((envelope) => JSON.stringify(envelope)).join("\n");
  const requiredRoutes = [
    ...new Set([manifestValidation.invocation?.route, ...(options.requiredRoutes ?? [])].filter(Boolean)),
  ];
  const auditReport = evaluateIrCutoverAuditJsonl(auditText, {
    input: `${input}#audit-envelopes`,
    requireNoLegacy: options.requireNoLegacy === true,
    requiredRoutes,
    expectSuccessful: manifestValidation.totals?.caseCount,
    minSources: manifestValidation.totals?.sourceCount,
    minUnits: manifestValidation.totals?.allUnitCount,
  });
  errors.push(...auditReport.errors);

  return Object.freeze({
    schema: IR_CUTOVER_CORPUS_RECEIPT_SCHEMA,
    ok: errors.length === 0,
    mode: options.requireNoLegacy === true ? "require-no-legacy" : "structural",
    input,
    manifest: Object.freeze({
      id: manifest?.id ?? null,
      digest: manifestValidation.digest ?? null,
    }),
    runId: runIds.size === 1 ? [...runIds][0] : null,
    counts: Object.freeze({
      receipts: rawLines.length,
      attempts: [...attempts.values()].reduce((total, rows) => total + rows.length, 0),
      completions: [...completions.values()].reduce((total, rows) => total + rows.length, 0),
      successfulCompletions: successfulCases.length,
      ...observedTotals,
    }),
    expected: Object.freeze({ ...(manifestValidation.totals ?? {}) }),
    audit: auditReport,
    errors: Object.freeze(errors),
  });
}

export function formatIrCutoverCorpusReport(report) {
  const lines = [
    `Standalone IR cutover corpus: ${report.ok ? "PASS" : "FAIL"}`,
    `Input: ${report.input}`,
    `Mode: ${report.mode}`,
    `Manifest: ${report.manifest.id} (${report.manifest.digest})`,
    `Run: ${report.runId ?? "invalid/mixed"}`,
    `Receipts: attempts=${report.counts.attempts}/${report.expected.caseCount ?? "?"}, completions=${report.counts.completions}/${report.expected.caseCount ?? "?"}, successful=${report.counts.successfulCompletions}`,
    `Exact census: sources=${report.counts.sourceCount}/${report.expected.sourceCount ?? "?"}, units=${report.counts.allUnitCount}/${report.expected.allUnitCount ?? "?"}, terminal=${report.counts.terminalUnitCount}/${report.expected.terminalUnitCount ?? "?"}, derived=${report.counts.derivedUnitCount}/${report.expected.derivedUnitCount ?? "?"}`,
  ];
  for (const item of report.errors) {
    lines.push(`ERROR${item.line === undefined ? "" : ` line ${item.line}`} [${item.code}]: ${item.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatIrCutoverAuditReport(report) {
  const routes = Object.entries(report.routes)
    .map(([route, count]) => `${route}=${count}`)
    .join(", ");
  const lines = [
    `Standalone IR cutover audit: ${report.ok ? "PASS" : "FAIL"}`,
    `Input: ${report.input}`,
    `Mode: ${report.mode}`,
    `Records: total=${report.counts.total}, parsed=${report.counts.parsed}, standalone=${report.counts.standalone}, successful=${report.counts.successfulStandalone}, failed=${report.counts.failedStandalone}, ignored=${report.counts.ignoredNonStandalone}`,
    `Successful census: sources=${report.counts.successfulSources}, units=${report.counts.successfulUnits}`,
    `Routes: ${routes || "none"}`,
  ];
  if (report.requiredRoutes.length > 0) lines.push(`Required routes: ${report.requiredRoutes.join(", ")}`);
  if (report.floors.expectSuccessful !== null) {
    lines.push(
      `Floors: successful=${report.floors.expectSuccessful}, sources>=${report.floors.minSources ?? "unset"}, units>=${report.floors.minUnits ?? "unset"}`,
    );
  } else if (report.mode === "structural") {
    lines.push("Coverage: observational only; no corpus completeness floors supplied");
  }
  for (const item of report.errors) {
    lines.push(`ERROR${item.line === undefined ? "" : ` line ${item.line}`} [${item.code}]: ${item.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function usage() {
  return [
    "Usage: node scripts/check-standalone-ir-cutover.mjs --input <audit.jsonl> [options]",
    "",
    "Options:",
    "  --manifest <path>      Validate exact runner receipts against a pinned corpus manifest",
    "  --require-no-legacy     Require successful standalone records to be fully IR-owned",
    "  --require-route <route> Require a successful standalone record for a public compile route (repeatable)",
    "  --expect-successful <n> Require exactly n successful standalone generator records",
    "  --min-sources <n>       Require at least n inventoried sources across successful records",
    "  --min-units <n>         Require at least n inventoried units across successful records",
    "  --json                  Print the deterministic report as JSON",
    "",
    "The JSONL denominator is invocations reaching generateModule/generateMultiModule.",
    "Use explicit floors and route requirements to detect missing pre-codegen invocations.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { requiredRoutes: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--input") {
      if (options.input !== undefined) throw new Error("--input may be specified only once");
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--input requires a path");
      options.input = value;
    } else if (argument === "--manifest") {
      if (options.manifest !== undefined) throw new Error("--manifest may be specified only once");
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--manifest requires a path");
      options.manifest = value;
    } else if (argument === "--require-route") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--require-route requires a route");
      options.requiredRoutes.push(value);
    } else if (argument === "--require-no-legacy") {
      options.requireNoLegacy = true;
    } else if (argument === "--expect-successful" || argument === "--min-sources" || argument === "--min-units") {
      const value = argv[++index];
      if (!value || value.startsWith("--") || !/^\d+$/u.test(value)) throw new Error(`${argument} requires an integer`);
      const field =
        argument === "--expect-successful"
          ? "expectSuccessful"
          : argument === "--min-sources"
            ? "minSources"
            : "minUnits";
      options[field] = Number(value);
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argument)}`);
    }
  }
  return options;
}

function readInput(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`input does not exist: ${absolute}`);
  if (!statSync(absolute).isFile()) throw new Error(`input is not a file: ${absolute}`);
  try {
    accessSync(absolute, constants.R_OK);
    return { absolute, text: readFileSync(absolute, "utf8") };
  } catch (cause) {
    throw new Error(`input is not readable: ${absolute}`, { cause });
  }
}

export function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!options.input) throw new Error("--input is required");
  const input = readInput(options.input);
  if (options.manifest) {
    if (options.expectSuccessful !== undefined || options.minSources !== undefined || options.minUnits !== undefined) {
      throw new Error("--manifest supplies exact denominators; manual record/source/unit floors are not allowed");
    }
    const manifestInput = readInput(options.manifest);
    let manifest;
    try {
      manifest = JSON.parse(manifestInput.text);
    } catch (cause) {
      throw new Error(`manifest is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const report = evaluateIrCutoverCorpusJsonl(input.text, manifest, {
      input: input.absolute,
      requireNoLegacy: options.requireNoLegacy,
      requiredRoutes: options.requiredRoutes,
    });
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatIrCutoverCorpusReport(report));
    return report.ok ? 0 : 1;
  }
  const report = evaluateIrCutoverAuditJsonl(input.text, {
    input: input.absolute,
    requireNoLegacy: options.requireNoLegacy,
    requiredRoutes: options.requiredRoutes,
    expectSuccessful: options.expectSuccessful,
    minSources: options.minSources,
    minUnits: options.minUnits,
  });
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatIrCutoverAuditReport(report));
  return report.ok ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = runCli();
  } catch (cause) {
    process.stderr.write(
      `Standalone IR cutover audit: ERROR\n${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  }
}
