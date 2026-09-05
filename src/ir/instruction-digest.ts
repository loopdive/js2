// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrInstr } from "./nodes.js";

/**
 * Canonical in-memory digest used to detect final-IR tampering.
 *
 * This is deliberately not an executable interchange serializer: it has no
 * decoder and confers no persistence compatibility. Every enumerable field,
 * including provider identity, allocation provenance, and producer evidence,
 * participates in the digest.
 */
function canonicalDigestValue(value: unknown, references = new Map<object, number>()): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (Object.is(value, -0)) return "number:-0";
    if (value === Infinity) return "number:+Infinity";
    if (value === -Infinity) return "number:-Infinity";
    return `number:${String(value)}`;
  }
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "boolean:true" : "boolean:false";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const existingReference = references.get(value);
    if (existingReference !== undefined) return `reference:${existingReference}`;
    const reference = references.size;
    references.set(value, reference);
    return `array:${reference}[${value.map((entry) => canonicalDigestValue(entry, references)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const existingReference = references.get(object);
    if (existingReference !== undefined) return `reference:${existingReference}`;
    const reference = references.size;
    references.set(object, reference);
    return `object:${reference}{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalDigestValue(object[key], references)}`)
      .join(",")}}`;
  }
  throw new TypeError(`unsupported IR digest value: ${typeof value}`);
}

/** Stable 64-bit FNV-1a digest of a final instruction sequence. */
export function digestIrInstructions(instructions: readonly IrInstr[]): string {
  const input = canonicalDigestValue(instructions);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
