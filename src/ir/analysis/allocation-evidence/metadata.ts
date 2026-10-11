// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ALLOC_NAMESPACES } from "../alloc-registry.js";
import type { AllocRegistrySnapshot } from "../contracts/allocations.js";
import type { EscapeClass } from "../escape.js";
import { AccessSet, type Ownership } from "../lattice.js";
import type { AllocSiteId } from "../../core/nodes.js";
import type { IrStringEncoding } from "../../core/string-types.js";
import type { AllocationEvidenceCapture } from "./census.js";
import type { AllocationEvidenceFailure, AllocationEvidenceNamespaceMode } from "./contracts.js";

export interface RegistryEvidenceIndex {
  readonly registry: AllocRegistrySnapshot;
  readonly rows: ReadonlyMap<AllocSiteId, ReadonlyMap<string, unknown>>;
  readonly ownership: boolean;
  readonly escape: boolean;
  readonly mode: AllocationEvidenceNamespaceMode;
}

/** The adapter supplies a canonically screened complete snapshot, not arbitrary DATA. */
export function indexRegistryEvidence(registry: AllocRegistrySnapshot): RegistryEvidenceIndex {
  const rows = new Map<AllocSiteId, ReadonlyMap<string, unknown>>();
  let ownership = false;
  let hasEscape = false;
  for (const row of registry.metadata) {
    const entries = new Map<string, unknown>();
    for (const [namespace, value] of row.entries) {
      if (entries.has(namespace)) throw new Error("allocation evidence received a duplicate namespace");
      entries.set(namespace, value);
      ownership ||= namespace === ALLOC_NAMESPACES.ownership;
      hasEscape ||= namespace === ALLOC_NAMESPACES.escape;
    }
    if (rows.has(row.id)) throw new Error("allocation evidence received duplicate registry metadata rows");
    rows.set(row.id, entries);
  }
  const mode = ownership
    ? hasEscape
      ? "ownership-and-escape"
      : "ownership-only"
    : hasEscape
      ? "escape-only"
      : "encoding-only";
  return { registry, rows, ownership, escape: hasEscape, mode };
}

function exactFields(value: unknown, keys: readonly string[]): PropertyDescriptorMap | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => descriptors[key] && "value" in descriptors[key]!) ? descriptors : undefined;
}

function exactAccesses(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length ||
    !("value" in length) ||
    length.value !== expected.length ||
    Reflect.ownKeys(value).length !== expected.length + 1
  )
    return false;
  return expected.every((access, index) => {
    const entry = descriptors[String(index)];
    return entry !== undefined && "value" in entry && entry.value === access;
  });
}

// These tables validate serialized value domains; they do not infer body effects.
const OWNERSHIP_DOMAIN = { owned: true, borrowed: true, shared: true, escaped: true } satisfies Record<Ownership, true>;
const ESCAPE_DOMAIN = { local: true, returned: true, stored: true, captured: true, opaque: true } satisfies Record<
  EscapeClass,
  true
>;
const ENCODING_DOMAIN = { ascii: true, "utf8-guaranteed": true, wtf16: true } satisfies Record<IrStringEncoding, true>;

function inDomain(value: unknown, domain: object): boolean {
  return typeof value === "string" && Object.hasOwn(domain, value);
}

function ownershipDataDomain(value: unknown): boolean {
  const marked = value !== null && typeof value === "object" && Object.hasOwn(value, "stackCandidate");
  const fields = exactFields(value, marked ? ["state", "ops", "stackCandidate"] : ["state", "ops"]);
  if (!fields || !inDomain(fields.state?.value, OWNERSHIP_DOMAIN)) return false;
  if (marked && typeof fields.stackCandidate?.value !== "boolean") return false;
  const ops: unknown = fields.ops?.value;
  // Reuse the canonical access-set order, without re-running ownership inference.
  if (!Array.isArray(ops)) return false;
  const canonical = AccessSet.full().toArray();
  const descriptors = Object.getOwnPropertyDescriptors(ops);
  const length = Object.getOwnPropertyDescriptor(ops, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > canonical.length) return false;
  // Input arrays can shadow ordinary method names with DATA values. Read only
  // own indexed descriptors; never invoke their includes/iterator methods.
  const values: unknown[] = [];
  for (let index = 0; index < length; index++) values.push(descriptors[String(index)]?.value);
  return exactAccesses(
    ops,
    canonical.filter((op) => values.includes(op)),
  );
}

function escapeDataDomain(value: unknown): boolean {
  const fields = exactFields(value, ["classification", "stackAllocatable"]);
  return (
    fields !== undefined &&
    inDomain(fields.classification?.value, ESCAPE_DOMAIN) &&
    typeof fields.stackAllocatable?.value === "boolean" &&
    fields.stackAllocatable.value === (fields.classification?.value === "local")
  );
}

/**
 * Only the value domains of present canonical namespace cells. Call after
 * descriptor/DATA, snapshot, contextual and J1 validation. Absence stays absent;
 * extension namespaces are outside this helper's authority. Success proves no
 * relationship between a metadata value and any body and grants no coverage.
 */
export function checkRegistryEvidenceMetadataDomain(
  index: RegistryEvidenceIndex,
): Extract<AllocationEvidenceFailure, { kind: "invalid" }> | undefined {
  for (const [site, entries] of index.rows) {
    for (const [namespace, value] of entries) {
      const valid =
        namespace === ALLOC_NAMESPACES.ownership
          ? ownershipDataDomain(value)
          : namespace === ALLOC_NAMESPACES.escape
            ? escapeDataDomain(value)
            : namespace === ALLOC_NAMESPACES.encoding
              ? inDomain(value, ENCODING_DOMAIN)
              : true;
      if (!valid) return { kind: "invalid", code: "namespace-value", at: { kind: "site", site } };
    }
  }
  return undefined;
}

function ownershipMismatch(
  value: unknown,
  accesses: readonly string[],
): "namespace-value" | "noncanonical-ownership-marker" | undefined {
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "stackCandidate"))
    return "noncanonical-ownership-marker";
  const fields = exactFields(value, ["state", "ops"]);
  return fields?.state?.value === "owned" && exactAccesses(fields.ops?.value, accesses) ? undefined : "namespace-value";
}

function escapeMatches(value: unknown): boolean {
  const fields = exactFields(value, ["classification", "stackAllocatable"]);
  return fields?.classification?.value === "local" && fields.stackAllocatable?.value === true;
}

function mismatch(
  code: Extract<AllocationEvidenceFailure, { kind: "invalid" }>["code"],
  site: AllocSiteId,
): AllocationEvidenceFailure {
  return { kind: "invalid", code, at: { kind: "site", site } };
}

function compareSite(
  index: RegistryEvidenceIndex,
  census: AllocationEvidenceCapture,
  site: AllocSiteId,
): AllocationEvidenceFailure | undefined {
  const entries = index.rows.get(site);
  const accesses = census.allocations.get(site);
  const encodingPresent = entries?.has(ALLOC_NAMESPACES.encoding) ?? false;
  if (!accesses) {
    if (
      encodingPresent ||
      (index.ownership && entries?.has(ALLOC_NAMESPACES.ownership)) ||
      (index.escape && entries?.has(ALLOC_NAMESPACES.escape))
    )
      return mismatch("unused-site-evidence", site);
    return undefined;
  }
  if (encodingPresent) return mismatch("namespace-presence", site);
  if (index.ownership) {
    if (!entries?.has(ALLOC_NAMESPACES.ownership)) return mismatch("namespace-presence", site);
    const code = ownershipMismatch(entries.get(ALLOC_NAMESPACES.ownership), accesses.toArray());
    if (code) return mismatch(code, site);
  }
  if (index.escape) {
    if (!entries?.has(ALLOC_NAMESPACES.escape)) return mismatch("namespace-presence", site);
    if (!escapeMatches(entries.get(ALLOC_NAMESPACES.escape))) return mismatch("namespace-value", site);
  }
  return undefined;
}

/** Compare requested cells on every original slot, including unused slots. */
export function compareRegistryEvidence(
  index: RegistryEvidenceIndex,
  census: AllocationEvidenceCapture,
): AllocationEvidenceFailure | undefined {
  for (let offset = 0; offset < index.registry.size; offset++) {
    const site = index.registry.entries[offset];
    if (!site) throw new Error("allocation evidence received an incomplete registry denominator");
    const id = offset as AllocSiteId;
    const failure = compareSite(index, census, id);
    if (failure) return failure;
  }
  return undefined;
}
