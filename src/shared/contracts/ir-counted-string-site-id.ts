// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrSourceId, IrUnitId } from "./ir-identity.js";
import type { IrSourceKind, IrUnitKind } from "./ir-unit-inventory.js";
import type {
  IrCountedStringAppendSiteId,
  IrCountedStringAppendSiteIdentity,
  IrCountedStringAppendSiteClaim,
} from "./ir-counted-string-identity.js";

const SITE_PREFIX = "ir-counted-string-append-site:v1";
const SITE_PATTERN = /^ir-counted-string-append-site:v1:([^:]+):([^:]+):([0-9]{16}):([0-9]{16})$/;
const SOURCE_ID_PATTERN = /^ir-source:v1:([0-9]{16}):([^:]+):([^:]+)$/;
const SOURCE_OWNED_UNIT_ID_PATTERN = /^ir-unit:v1:([^:]+):([^:]+):([^:]+):([0-9]{16})$/;
const SOURCE_OWNED_CLASS_ID_PATTERN = /^ir-class:v1:([^:]+):([^:]+):([^:]+):([0-9]{16})$/;
const SOURCE_KIND_AUTHORITY: Readonly<Record<IrSourceKind, true>> = {
  entry: true,
  source: true,
  library: true,
  synthetic: true,
};
const SOURCE_KINDS: ReadonlySet<string> = new Set(Object.keys(SOURCE_KIND_AUTHORITY));
const UNIT_KIND_AUTHORITY: Readonly<Record<IrUnitKind, true>> = {
  "top-level-function": true,
  "nested-function": true,
  "function-expression": true,
  "arrow-function": true,
  "class-constructor": true,
  "class-implicit-constructor": true,
  "class-instance-method": true,
  "class-static-method": true,
  "class-instance-getter": true,
  "class-static-getter": true,
  "class-instance-setter": true,
  "class-static-setter": true,
  "class-instance-field-initializer": true,
  "class-static-field-initializer": true,
  "class-static-block": true,
  "object-method": true,
  "object-getter": true,
  "object-setter": true,
  "export-assignment": true,
  "module-init": true,
  "synthetic-support": true,
};
const UNIT_KINDS: ReadonlySet<string> = new Set(Object.keys(UNIT_KIND_AUTHORITY));
const MAX_LEXICAL_OWNER_DEPTH = 64;

function canonicalPosition(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, received ${value}`);
  }
  return value.toString(10).padStart(16, "0");
}

function canonicalIdentityComponent(value: string): string {
  return encodeURIComponent(value);
}

function parseCanonicalIdentityComponent(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && canonicalIdentityComponent(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function hasCanonicalOrdinal(value: string): boolean {
  const ordinal = Number(value);
  return Number.isSafeInteger(ordinal) && ordinal >= 0 && canonicalPosition(ordinal, "identity ordinal") === value;
}

function isCanonicalSourceId(value: string): value is IrSourceId {
  const match = SOURCE_ID_PATTERN.exec(value);
  return !!(
    match &&
    hasCanonicalOrdinal(match[1]!) &&
    SOURCE_KINDS.has(match[2]!) &&
    parseCanonicalIdentityComponent(match[3]!) !== undefined
  );
}

function isCanonicalLexicalOwner(component: string, sourceId: IrSourceId, depth: number): boolean {
  if (component === "root") return true;
  const ownerId = parseCanonicalIdentityComponent(component);
  if (!ownerId || depth >= MAX_LEXICAL_OWNER_DEPTH) return false;
  return (
    isCanonicalSourceOwnedUnitId(ownerId, sourceId, depth + 1) ||
    isCanonicalSourceOwnedClassId(ownerId, sourceId, depth + 1)
  );
}

/** Canonical source-qualified grammar only; inventory terminal membership is proven at later boundaries. */
function isCanonicalSourceOwnedUnitId(value: string, sourceId: IrSourceId, depth = 0): value is IrUnitId {
  const match = SOURCE_OWNED_UNIT_ID_PATTERN.exec(value);
  if (!match || depth > MAX_LEXICAL_OWNER_DEPTH) return false;
  const decodedSourceId = parseCanonicalIdentityComponent(match[1]!);
  return !!(
    decodedSourceId === sourceId &&
    isCanonicalLexicalOwner(match[2]!, sourceId, depth) &&
    UNIT_KINDS.has(match[3]!) &&
    hasCanonicalOrdinal(match[4]!)
  );
}

function isCanonicalSourceOwnedClassId(value: string, sourceId: IrSourceId, depth: number): boolean {
  const match = SOURCE_OWNED_CLASS_ID_PATTERN.exec(value);
  if (!match || depth > MAX_LEXICAL_OWNER_DEPTH) return false;
  const decodedSourceId = parseCanonicalIdentityComponent(match[1]!);
  return !!(
    decodedSourceId === sourceId &&
    isCanonicalLexicalOwner(match[2]!, sourceId, depth) &&
    (match[3] === "declaration" || match[3] === "expression") &&
    hasCanonicalOrdinal(match[4]!)
  );
}

/** Derive the sole canonical encoding of an exact source/owner/loop-span tuple. */
export function createIrCountedStringAppendSiteId(
  identity: IrCountedStringAppendSiteIdentity,
): IrCountedStringAppendSiteId {
  if (!isCanonicalSourceId(identity.sourceId)) {
    throw new TypeError("sourceId is not a canonical source identity");
  }
  if (!isCanonicalSourceOwnedUnitId(identity.ownerUnitId, identity.sourceId)) {
    throw new TypeError("ownerUnitId is not a canonical source-qualified non-derived identity for sourceId");
  }
  const loopStart = canonicalPosition(identity.loopStart, "loopStart");
  const loopEnd = canonicalPosition(identity.loopEnd, "loopEnd");
  if (identity.loopEnd <= identity.loopStart) {
    throw new RangeError(`loopEnd must be greater than loopStart, received ${identity.loopStart}..${identity.loopEnd}`);
  }
  return `${SITE_PREFIX}:${canonicalIdentityComponent(identity.sourceId)}:${canonicalIdentityComponent(
    identity.ownerUnitId,
  )}:${loopStart}:${loopEnd}` as IrCountedStringAppendSiteId;
}

/** Parse only the canonical v1 grammar; malformed and alternate encodings fail closed. */
export function parseIrCountedStringAppendSiteId(
  value: string,
): Readonly<IrCountedStringAppendSiteIdentity> | undefined {
  if (typeof value !== "string") return undefined;
  const match = SITE_PATTERN.exec(value);
  if (!match) return undefined;
  const sourceId = parseCanonicalIdentityComponent(match[1]!);
  const ownerUnitId = parseCanonicalIdentityComponent(match[2]!);
  if (!sourceId || !ownerUnitId) return undefined;
  if (!isCanonicalSourceId(sourceId) || !isCanonicalSourceOwnedUnitId(ownerUnitId, sourceId)) return undefined;

  const loopStart = Number(match[3]);
  const loopEnd = Number(match[4]);
  if (
    !Number.isSafeInteger(loopStart) ||
    !Number.isSafeInteger(loopEnd) ||
    canonicalPosition(loopStart, "loopStart") !== match[3] ||
    canonicalPosition(loopEnd, "loopEnd") !== match[4] ||
    loopEnd <= loopStart
  ) {
    return undefined;
  }
  return Object.freeze({
    sourceId: sourceId as IrSourceId,
    ownerUnitId: ownerUnitId as IrUnitId,
    loopStart,
    loopEnd,
  });
}

/** True only when a canonical site still denotes the exact authoritative tuple. */
export function irCountedStringAppendSiteIdIsCurrent(
  siteId: string,
  identity: IrCountedStringAppendSiteIdentity,
): siteId is IrCountedStringAppendSiteId {
  try {
    return (
      parseIrCountedStringAppendSiteId(siteId) !== undefined && createIrCountedStringAppendSiteId(identity) === siteId
    );
  } catch {
    return false;
  }
}

/**
 * Fail closed before constructing an expected-by-site index. Every claim must
 * be canonical, current for its exact source/owner/span, and unique.
 */
export function assertUniqueCurrentIrCountedStringAppendSites(claims: readonly IrCountedStringAppendSiteClaim[]): void {
  const seen = new Set<IrCountedStringAppendSiteId>();
  for (const claim of claims) {
    const siteId = claim.siteId;
    if (!irCountedStringAppendSiteIdIsCurrent(siteId, claim)) {
      throw new TypeError("counted-string append site is malformed or detached from its exact source/owner/span");
    }
    if (seen.has(siteId)) {
      throw new TypeError(`duplicate counted-string append site ${siteId}`);
    }
    seen.add(siteId);
  }
}
