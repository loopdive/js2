// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Authoritative metadata for a statically merged npm-provider bundle (#2527).
 *
 * `wasm-merge` needs only core-Wasm imports and exports. js2wasm additionally
 * needs to retain the package/cache/ABI identities that are not representable
 * in the standard module sections, so the final bundle carries this custom
 * section after merge and metadata DCE have completed.
 */

import * as nodeCrypto from "node:crypto";
import { WasmEncoder } from "./emit/encoder.js";
import type { LinkedProviderMetadata } from "./index.js";
import {
  canonicalProviderManifestJson,
  PROVIDER_COMPILER_ABI_VERSION,
  PROVIDER_LINKER_ABI_VERSION,
  type ProviderBoundaryManifest,
} from "./provider-manifest.js";

export const BUNDLE_MANIFEST_SECTION_NAME = "js2wasm.bundle.v1" as const;
export const BUNDLE_MANIFEST_FORMAT_VERSION = 1 as const;

export interface BundleProviderManifest {
  packageName: string;
  namespace: string;
  cacheKey: string;
  dependencies: string[];
  exports: string[];
  exportBoundaries: Record<string, ProviderBoundaryManifest>;
  sourceFingerprint: string;
}

export interface BundleManifestV1 {
  section: typeof BUNDLE_MANIFEST_SECTION_NAME;
  version: typeof BUNDLE_MANIFEST_FORMAT_VERSION;
  compilerAbiVersion: typeof PROVIDER_COMPILER_ABI_VERSION;
  linkerAbiVersion: typeof PROVIDER_LINKER_ABI_VERSION;
  rootModule: "js2wasm:root";
  rootExports: string[];
  /** Provider-before-consumer initialization/link order. */
  providers: BundleProviderManifest[];
  /** Final single-instance host adapter contract after provider consolidation. */
  hostMetadata: LinkedProviderMetadata;
}

const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function customSectionPayloads(binary: Uint8Array, wanted: string): Uint8Array[] {
  if (binary.length < 8 || binary[0] !== 0 || binary[1] !== 0x61 || binary[2] !== 0x73 || binary[3] !== 0x6d) {
    throw new Error("bundle artifact is not a Wasm binary");
  }
  const payloads: Uint8Array[] = [];
  let offset = 8;
  while (offset < binary.length) {
    const id = binary[offset++];
    const size = readU32(binary, offset, "section");
    offset = size.next;
    const end = offset + size.value;
    if (end > binary.length) throw new Error("malformed Wasm section length");
    if (id === 0) {
      const nameLength = readU32(binary, offset, "custom section name");
      const nameEnd = nameLength.next + nameLength.value;
      if (nameEnd > end) throw new Error("malformed Wasm custom section name");
      const name = UTF8_FATAL.decode(binary.subarray(nameLength.next, nameEnd));
      if (name === wanted) payloads.push(binary.subarray(nameEnd, end));
    }
    offset = end;
  }
  return payloads;
}

function validateBundleManifest(value: unknown): BundleManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bundle manifest is not an object");
  const manifest = value as Partial<BundleManifestV1>;
  if (manifest.section !== BUNDLE_MANIFEST_SECTION_NAME) throw new Error("bundle manifest section name mismatch");
  if (manifest.version !== BUNDLE_MANIFEST_FORMAT_VERSION) throw new Error("unsupported bundle manifest version");
  if (manifest.compilerAbiVersion !== PROVIDER_COMPILER_ABI_VERSION) throw new Error("bundle compiler ABI mismatch");
  if (manifest.linkerAbiVersion !== PROVIDER_LINKER_ABI_VERSION) throw new Error("bundle linker ABI mismatch");
  if (manifest.rootModule !== "js2wasm:root") throw new Error("bundle root module mismatch");
  if (!Array.isArray(manifest.rootExports) || manifest.rootExports.some((name) => typeof name !== "string")) {
    throw new Error("bundle manifest has invalid root exports");
  }
  if (new Set(manifest.rootExports).size !== manifest.rootExports.length) {
    throw new Error("bundle manifest has duplicate root exports");
  }
  if (!Array.isArray(manifest.providers)) throw new Error("bundle manifest has invalid providers");
  const availableProviders = new Set<string>();
  for (const provider of manifest.providers) {
    if (
      !provider ||
      typeof provider !== "object" ||
      typeof provider.packageName !== "string" ||
      typeof provider.namespace !== "string" ||
      typeof provider.cacheKey !== "string" ||
      typeof provider.sourceFingerprint !== "string" ||
      !Array.isArray(provider.dependencies) ||
      provider.dependencies.some((name) => typeof name !== "string") ||
      !Array.isArray(provider.exports) ||
      provider.exports.some((name) => typeof name !== "string") ||
      !provider.exportBoundaries ||
      typeof provider.exportBoundaries !== "object"
    ) {
      throw new Error("bundle manifest has an invalid provider");
    }
    if (!/^[0-9a-f]{64}$/.test(provider.cacheKey) || !/^[0-9a-f]{64}$/.test(provider.sourceFingerprint)) {
      throw new Error("bundle manifest has an invalid provider hash");
    }
    if (
      !provider.namespace.startsWith(`js2wasm:npm:${provider.packageName}:`) ||
      !provider.namespace.endsWith(provider.cacheKey.slice(0, 16)) ||
      availableProviders.has(provider.namespace)
    ) {
      throw new Error("bundle manifest has an invalid provider namespace");
    }
    if (provider.dependencies.some((dependency) => !availableProviders.has(dependency))) {
      throw new Error("bundle manifest providers are not in dependency order");
    }
    if (new Set(provider.exports).size !== provider.exports.length) {
      throw new Error("bundle manifest has duplicate provider exports");
    }
    const boundaries = provider.exportBoundaries as unknown as Record<string, unknown>;
    for (const name of provider.exports) {
      const boundary = boundaries[name];
      if (
        !isRecord(boundary) ||
        (boundary.kind !== "function" && boundary.kind !== "getter" && boundary.kind !== "namespaceGetter") ||
        typeof boundary.field !== "string" ||
        boundary.field.length === 0
      ) {
        throw new Error("bundle manifest has an invalid provider boundary");
      }
    }
    availableProviders.add(provider.namespace);
  }
  if (
    !manifest.hostMetadata ||
    typeof manifest.hostMetadata !== "object" ||
    !Array.isArray(manifest.hostMetadata.imports) ||
    !Array.isArray(manifest.hostMetadata.stringPool) ||
    manifest.hostMetadata.stringPool.some((value) => typeof value !== "string")
  ) {
    throw new Error("bundle manifest has invalid host metadata");
  }
  for (const entry of manifest.hostMetadata.imports) {
    if (
      !isRecord(entry) ||
      typeof entry.module !== "string" ||
      typeof entry.name !== "string" ||
      (entry.kind !== "func" && entry.kind !== "global") ||
      !isRecord(entry.intent)
    ) {
      throw new Error("bundle manifest has an invalid host import descriptor");
    }
  }
  return manifest as BundleManifestV1;
}

export function appendBundleManifest(binary: Uint8Array, manifest: BundleManifestV1): Uint8Array {
  if (customSectionPayloads(binary, BUNDLE_MANIFEST_SECTION_NAME).length !== 0) {
    throw new Error("bundle artifact already contains a manifest custom section");
  }
  const enc = new WasmEncoder();
  enc.bytes(binary);
  enc.section(0, (section) => {
    section.name(BUNDLE_MANIFEST_SECTION_NAME);
    section.bytes(UTF8.encode(canonicalProviderManifestJson(manifest)));
  });
  return enc.finish();
}

export function decodeBundleManifest(binary: Uint8Array): BundleManifestV1 {
  const matching = customSectionPayloads(binary, BUNDLE_MANIFEST_SECTION_NAME);
  if (matching.length === 0) throw new Error("bundle artifact is missing its manifest custom section");
  if (matching.length !== 1) throw new Error("bundle artifact has duplicate manifest custom sections");
  let json: string;
  try {
    json = UTF8_FATAL.decode(matching[0]);
  } catch {
    throw new Error("bundle manifest is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("bundle manifest is not valid JSON");
  }
  const manifest = validateBundleManifest(parsed);
  if (canonicalProviderManifestJson(manifest) !== json) throw new Error("bundle manifest is not canonical JSON");
  return manifest;
}

export function bundleArtifactHash(binary: Uint8Array): string {
  return nodeCrypto.createHash("sha256").update(binary).digest("hex");
}
