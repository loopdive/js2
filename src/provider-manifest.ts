// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Embedded manifest for separately compiled npm providers (#2527).
 *
 * The manifest is part of the provider artifact, not a sidecar description of
 * it.  The provider's own cache key is deliberately absent from the manifest:
 * the key is the SHA-256 of the finalized bytes, which avoids a self-hashing
 * cycle while still making the artifact content-addressed.
 */

import * as nodeCrypto from "node:crypto";
import type { LinkedProviderMetadata } from "./index.js";
import { WasmEncoder } from "./emit/encoder.js";

export const PROVIDER_MANIFEST_SECTION_NAME = "js2wasm.provider.v1" as const;
export const PROVIDER_MANIFEST_FORMAT_VERSION = 1 as const;
/** Bump when the compiler's provider-byte/metadata contract changes. */
export const PROVIDER_COMPILER_ABI_VERSION = "js2wasm-provider-compiler-v1" as const;
/**
 * The package-linker ABI is versioned independently from the section format.
 * v4 (#5226): every linked module imports its exception tag from `env.__exn`,
 * so a v3 artifact (module-local tag) cannot be instantiated by a v4 host.
 */
export const PROVIDER_LINKER_ABI_VERSION = "npm-link-v4" as const;

export interface ProviderDependencyManifest {
  packageName: string;
  cacheKey: string;
  namespace: string;
}

export type ProviderBoundaryKind = "function" | "getter" | "namespaceGetter";

export interface ProviderBoundaryManifest {
  kind: ProviderBoundaryKind;
  field: string;
}

export interface ProviderManifestV1 {
  section: typeof PROVIDER_MANIFEST_SECTION_NAME;
  version: typeof PROVIDER_MANIFEST_FORMAT_VERSION;
  compilerAbiVersion: typeof PROVIDER_COMPILER_ABI_VERSION;
  linkerAbiVersion: typeof PROVIDER_LINKER_ABI_VERSION;
  recgroupAbiVersion: number;
  /** Source/options/dependency identity, independent of this provider's key. */
  sourceFingerprint: string;
  packageName: string;
  dependencies: ProviderDependencyManifest[];
  exports: string[];
  exportSignatures: Record<string, string>;
  exportBoundaries: Record<string, ProviderBoundaryManifest>;
  initExport?: "__module_init";
  stringPool: string[];
  providerMetadata: LinkedProviderMetadata;
}

interface ProviderManifestExpectations {
  linkerAbiVersion?: string;
  compilerAbiVersion?: string;
  recgroupAbiVersion?: number;
}

interface WasmCustomSection {
  name: string;
  payload: Uint8Array;
}

const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively sort object keys while preserving array order. */
function canonicalValue(value: unknown, seen = new Set<unknown>()): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("provider manifest contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("provider manifest contains a non-JSON value");
  if (seen.has(value)) throw new TypeError("provider manifest contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = canonicalValue((value as Record<string, unknown>)[key], seen);
      // Match JSON's object semantics: optional undefined properties are not
      // serialized. Arrays are handled separately and retain their slots.
      if (child !== undefined) sorted[key] = child;
    }
    return sorted;
  } finally {
    seen.delete(value);
  }
}

export function canonicalProviderManifestJson(manifest: unknown): string {
  const json = JSON.stringify(canonicalValue(manifest));
  if (json === undefined) throw new TypeError("provider manifest did not serialize");
  return json;
}

function readU32(bytes: Uint8Array, offset: number, label: string): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (let count = 0; count < 5; count++) {
    if (pos >= bytes.length) throw new Error(`malformed Wasm ${label} length`);
    const byte = bytes[pos++];
    if (count === 4 && (byte & 0x7f) > 0x0f) throw new Error(`Wasm ${label} length overflows u32`);
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: pos };
    shift += 7;
  }
  throw new Error(`malformed Wasm ${label} length`);
}

function readUtf8Name(bytes: Uint8Array, offset: number, label: string): { value: string; next: number } {
  const lengthInfo = readU32(bytes, offset, `${label} name`);
  const length = lengthInfo.value;
  const end = lengthInfo.next + length;
  if (end > bytes.length) throw new Error(`malformed Wasm ${label} name`);
  return { value: UTF8_FATAL.decode(bytes.subarray(lengthInfo.next, end)), next: end };
}

function readCustomSections(binary: Uint8Array): WasmCustomSection[] {
  if (binary.length < 8 || binary[0] !== 0x00 || binary[1] !== 0x61 || binary[2] !== 0x73 || binary[3] !== 0x6d) {
    throw new Error("provider artifact is not a Wasm binary");
  }
  if (binary[4] !== 0x01 || binary[5] !== 0x00 || binary[6] !== 0x00 || binary[7] !== 0x00) {
    throw new Error("provider artifact has an unsupported Wasm version");
  }
  const sections: WasmCustomSection[] = [];
  let offset = 8;
  while (offset < binary.length) {
    const id = binary[offset++];
    const sizeInfo = readU32(binary, offset, "section");
    offset = sizeInfo.next;
    const end = offset + sizeInfo.value;
    if (end > binary.length) throw new Error("malformed Wasm section length");
    if (id === 0) {
      const name = readUtf8Name(binary.subarray(offset, end), 0, "custom section");
      sections.push({ name: name.value, payload: binary.subarray(offset + name.next, end) });
    }
    offset = end;
  }
  return sections;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`provider manifest has invalid ${label}`);
  }
  return value.slice() as string[];
}

function signatures(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("provider manifest has invalid export signatures");
  const result: Record<string, string> = {};
  for (const [key, signature] of Object.entries(value)) {
    if (typeof signature !== "string") throw new Error("provider manifest has a non-string export signature");
    result[key] = signature;
  }
  return result;
}

function boundaries(value: unknown, exports: readonly string[]): Record<string, ProviderBoundaryManifest> {
  if (!isRecord(value)) throw new Error("provider manifest has invalid export boundaries");
  const result: Record<string, ProviderBoundaryManifest> = {};
  for (const name of exports) {
    const boundary = value[name];
    if (
      !isRecord(boundary) ||
      (boundary.kind !== "function" && boundary.kind !== "getter" && boundary.kind !== "namespaceGetter")
    ) {
      throw new Error(`provider manifest has invalid boundary for ${name}`);
    }
    if (typeof boundary.field !== "string" || boundary.field.length === 0) {
      throw new Error(`provider manifest has an invalid boundary field for ${name}`);
    }
    result[name] = { kind: boundary.kind, field: boundary.field };
  }
  if (value["*"] !== undefined) {
    const boundary = value["*"];
    if (!isRecord(boundary) || boundary.kind !== "namespaceGetter") {
      throw new Error("provider manifest has invalid namespace boundary");
    }
    if (typeof boundary.field !== "string" || boundary.field.length === 0) {
      throw new Error("provider manifest has an invalid namespace boundary field");
    }
    result["*"] = { kind: "namespaceGetter", field: boundary.field };
  }
  if (Object.keys(value).some((name) => name !== "*" && !exports.includes(name))) {
    throw new Error("provider manifest has a boundary for an undeclared export");
  }
  const fields = Object.values(result).map((boundary) => boundary.field);
  if (new Set(fields).size !== fields.length) throw new Error("provider manifest has duplicate boundary fields");
  return result;
}

function validateProviderMetadata(value: unknown): asserts value is LinkedProviderMetadata {
  if (!isRecord(value) || !Array.isArray(value.imports) || !Array.isArray(value.stringPool)) {
    throw new Error("provider manifest has invalid provider metadata");
  }
  if (value.stringPool.some((entry) => typeof entry !== "string")) {
    throw new Error("provider manifest has invalid provider metadata string pool");
  }
  for (const entry of value.imports) {
    if (!isRecord(entry) || typeof entry.module !== "string" || typeof entry.name !== "string") {
      throw new Error("provider manifest has an invalid import descriptor");
    }
    if (entry.kind !== "func" && entry.kind !== "global") {
      throw new Error("provider manifest has an invalid import kind");
    }
    if (!isRecord(entry.intent)) throw new Error("provider manifest has an invalid import intent");
    if (
      entry.paramCount !== undefined &&
      (typeof entry.paramCount !== "number" || !Number.isInteger(entry.paramCount) || entry.paramCount < 0)
    ) {
      throw new Error("provider manifest has an invalid import parameter count");
    }
  }
}

function validateManifest(value: unknown, expectations: ProviderManifestExpectations): ProviderManifestV1 {
  if (!isRecord(value)) throw new Error("provider manifest is not an object");
  if (value.section !== PROVIDER_MANIFEST_SECTION_NAME) throw new Error("provider manifest section name mismatch");
  if (value.version !== PROVIDER_MANIFEST_FORMAT_VERSION) throw new Error("unsupported provider manifest version");
  if (
    typeof value.compilerAbiVersion !== "string" ||
    value.compilerAbiVersion !== (expectations.compilerAbiVersion ?? PROVIDER_COMPILER_ABI_VERSION)
  ) {
    throw new Error("provider manifest compiler ABI mismatch");
  }
  if (
    typeof value.linkerAbiVersion !== "string" ||
    value.linkerAbiVersion !== (expectations.linkerAbiVersion ?? PROVIDER_LINKER_ABI_VERSION)
  ) {
    throw new Error("provider manifest linker ABI mismatch");
  }
  if (!Number.isInteger(value.recgroupAbiVersion) || value.recgroupAbiVersion !== expectations.recgroupAbiVersion) {
    throw new Error("provider manifest rec-group ABI mismatch");
  }
  if (typeof value.sourceFingerprint !== "string" || value.sourceFingerprint.length === 0) {
    throw new Error("provider manifest has invalid source fingerprint");
  }
  if (typeof value.packageName !== "string" || value.packageName.length === 0) {
    throw new Error("provider manifest has invalid package name");
  }
  const exports = stringArray(value.exports, "exports");
  if (new Set(exports).size !== exports.length) throw new Error("provider manifest has duplicate exports");
  const exportSignatures = signatures(value.exportSignatures);
  for (const name of exports) {
    if (typeof exportSignatures[name] !== "string")
      throw new Error(`provider manifest is missing signature for ${name}`);
  }
  if (Object.keys(exportSignatures).some((name) => !exports.includes(name))) {
    throw new Error("provider manifest has a signature for an undeclared export");
  }
  const exportBoundaries = boundaries(value.exportBoundaries, exports);
  if (value.initExport !== undefined && value.initExport !== "__module_init") {
    throw new Error("provider manifest has an unsupported initializer export");
  }
  const stringPoolValues = stringArray(value.stringPool, "string pool");
  if (!Array.isArray(value.dependencies)) throw new Error("provider manifest has invalid dependencies");
  const dependencies: ProviderDependencyManifest[] = value.dependencies.map((dependency) => {
    if (
      !isRecord(dependency) ||
      typeof dependency.packageName !== "string" ||
      typeof dependency.cacheKey !== "string" ||
      typeof dependency.namespace !== "string"
    ) {
      throw new Error("provider manifest has an invalid dependency identity");
    }
    return {
      packageName: dependency.packageName,
      cacheKey: dependency.cacheKey,
      namespace: dependency.namespace,
    };
  });
  if (new Set(dependencies.map((dependency) => dependency.namespace)).size !== dependencies.length) {
    throw new Error("provider manifest has duplicate dependency namespaces");
  }
  validateProviderMetadata(value.providerMetadata);
  if (
    canonicalProviderManifestJson(value.providerMetadata.stringPool) !== canonicalProviderManifestJson(stringPoolValues)
  ) {
    throw new Error("provider manifest string pool disagrees with provider metadata");
  }
  const manifest = {
    section: PROVIDER_MANIFEST_SECTION_NAME,
    version: PROVIDER_MANIFEST_FORMAT_VERSION,
    compilerAbiVersion: value.compilerAbiVersion,
    linkerAbiVersion: value.linkerAbiVersion,
    recgroupAbiVersion: value.recgroupAbiVersion,
    sourceFingerprint: value.sourceFingerprint,
    packageName: value.packageName,
    dependencies,
    exports,
    exportSignatures,
    exportBoundaries,
    ...(value.initExport === undefined ? {} : { initExport: value.initExport }),
    stringPool: stringPoolValues,
    providerMetadata: value.providerMetadata,
  } as ProviderManifestV1;
  return manifest;
}

/** Decode and validate the authoritative embedded provider manifest. */
export function decodeProviderManifest(
  binary: Uint8Array,
  expectations: Required<ProviderManifestExpectations>,
): ProviderManifestV1 {
  const matching = readCustomSections(binary).filter((section) => section.name === PROVIDER_MANIFEST_SECTION_NAME);
  if (matching.length === 0) throw new Error("provider artifact is missing its manifest custom section");
  if (matching.length !== 1) throw new Error("provider artifact has duplicate manifest custom sections");
  let json: string;
  try {
    json = UTF8_FATAL.decode(matching[0]!.payload);
  } catch {
    throw new Error("provider manifest is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("provider manifest is not valid JSON");
  }
  const manifest = validateManifest(parsed, expectations);
  if (canonicalProviderManifestJson(manifest) !== json) throw new Error("provider manifest is not canonical JSON");
  return manifest;
}

/** Append the manifest as a normal Wasm custom section. */
export function appendProviderManifest(binary: Uint8Array, manifest: ProviderManifestV1): Uint8Array {
  // Refuse duplicate sections rather than creating an artifact whose authority
  // depends on which decoder happens to return first.
  if (readCustomSections(binary).some((section) => section.name === PROVIDER_MANIFEST_SECTION_NAME)) {
    throw new Error("provider artifact already contains a manifest custom section");
  }
  const enc = new WasmEncoder();
  enc.bytes(binary);
  enc.section(0, (section) => {
    section.name(PROVIDER_MANIFEST_SECTION_NAME);
    section.bytes(UTF8.encode(canonicalProviderManifestJson(manifest)));
  });
  return enc.finish();
}

/** Content hash of the finalized provider bytes. */
export function providerArtifactHash(binary: Uint8Array, manifest: ProviderManifestV1): string {
  const hash = nodeCrypto.createHash("sha256");
  hash.update(binary);
  // Keep the manifest argument in the API so callers must pass the decoded
  // finalized artifact rather than accidentally hashing pre-manifest bytes.
  void manifest;
  return hash.digest("hex");
}
