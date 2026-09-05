// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2527 / #2514 — canonical runtime-type rec-group identity primitive.
//
// Core-wasm module linking in a shared store (the CHOSEN approach for #2527)
// relies on WasmGC *engine canonicalization*: two separately-compiled modules
// that declare structurally-identical rec groups get the SAME runtime type, so
// GC objects (String / Vec / boxed) flow across an import/export boundary with
// zero copy. Phase 0 (issue #2527) proved this holds on V8 and wasmtime.
//
// For that to work in practice, EVERY js2wasm artifact (a future shared
// `runtime.wasm` AND every user module) must emit the *identical* canonical rec
// group — canonicalization matches whole groups, not individual types, and is
// sensitive to member set, member order, and structure (but NOT to type names
// or absolute type indices). The documented main risk (#2514 risk #2) is that
// `wasm-opt` merges/reorders/renames types, which would break canonical
// equality silently.
//
// This module provides the *identity primitive* that makes the ABI verifiable:
//
//   1. RUNTIME_RECGROUP_TYPE_NAMES — the closed, ordered set of GC type names
//      that form the shared runtime-type boundary group.
//   2. canonicalHashOfTypeGroup() — a deterministic, name-independent,
//      absolute-index-independent structural hash of an ordered run of type
//      defs. Two structurally-identical groups (modulo names/indices) hash
//      equal; any structural or ordering difference changes the hash. This
//      mirrors WasmGC isorecursive canonicalization semantics, so an equal hash
//      is a sound proxy for "the engine will canonicalize these to the same
//      runtime type".
//   3. extractRuntimeGroup() / fingerprintRuntimeGroup() — locate the runtime
//      types in a module's flat type table and produce a stable fingerprint
//      usable as a drift gate (CI / post-`wasm-opt` verification).
//
// The analysis is also usable as a raw-byte drift gate: it reads the emitted
// type section without depending on Binaryen's names or absolute indices. The
// codegen side records one contiguous group for native-string modules, and the
// shared runtime provider exports the first helper family that consumes it.

import type {
  ArrayTypeDef,
  FieldDef,
  FuncTypeDef,
  StructTypeDef,
  SubTypeDef,
  TypeDef,
  ValType,
  WasmModule,
} from "../ir/types.js";

/**
 * The closed, ordered set of runtime GC type names that form the shared
 * runtime-type boundary rec group (#2514). These are the WasmGC types whose
 * objects cross a core-wasm link boundary between a user module and the shared
 * runtime: the string family and the eagerly reserved vec/array family.
 *
 * Order here is the *canonical* member order the ABI freezes. Codegen lays
 * these out contiguously in this order so every native-string artifact emits
 * the same recursive group. The hash below is order-sensitive, so this list
 * IS the versioned ABI contract for membership + order.
 *
 * Native-string codegen eagerly declares every member and the DCE pass roots
 * the whole range. The extractor still accepts subsets for analysis of older
 * or hand-built modules, but a linkable fingerprint must contain all members.
 *
 * IMPORTANT — names are the *in-memory* TypeDef names (no `$` prefix). The `$`
 * appears only in WAT rendering, not in the IR `name` field, so the verifier
 * (which reads `mod.types[i].name`) matches the bare names below.
 *
 * Only types with a *name-stable* identity belong here. The two eagerly
 * reserved externref/f64 vec families use stable names. Later
 * element-specific vec/array variants (for example `__arr_ref_6`, where `6`
 * is a referenced type index) are intentionally outside this closed ABI;
 * native-string modules still retain the reserved family even when no user
 * array is used.
 */
export const RUNTIME_RECGROUP_TYPE_NAMES: readonly string[] = [
  // These are eagerly registered, in this exact order, by
  // createCodegenContext. Keeping the complete prefix closed makes the group
  // independent of which subset an individual consumer happens to exercise.
  "__vec_base",
  "__arr_externref",
  "__vec_externref",
  "__arr_f64",
  "__vec_f64",
  "__str_data",
  "AnyString",
  "NativeString",
  "ConsString",
  "HashedString",
];

/** ABI version of the canonical runtime rec group. Bump on any membership,
 *  order, or structural change to a type in {@link RUNTIME_RECGROUP_TYPE_NAMES}. */
export const RUNTIME_RECGROUP_ABI_VERSION = 2;

const RUNTIME_NAME_SET = new Set(RUNTIME_RECGROUP_TYPE_NAMES);

/** A flat type table member (no nested `rec` wrappers). */
type FlatTypeDef = FuncTypeDef | StructTypeDef | ArrayTypeDef | SubTypeDef;

/** The name a TypeDef carries, if any (func types may be anonymous). */
function typeDefName(t: TypeDef): string | undefined {
  switch (t.kind) {
    case "func":
    case "struct":
    case "array":
      return t.name;
    case "sub":
      return t.name;
    case "rec":
      return undefined;
  }
}

/**
 * Canonicalize a ValType to a name-independent token. Ref types are encoded
 * relative to the group: a ref to a member of the group is `r<localIndex>`
 * (intra-group topology, position-relative — what canonicalization actually
 * compares), a ref outside the group is `x` (an opaque external marker — its
 * absolute index is not part of THIS group's canonical identity), and abstract
 * heap types pass through structurally.
 *
 * `localOf` maps an absolute type index to its 0-based position within the
 * group, or undefined if the index is not a group member.
 */
function valTypeToken(t: ValType, localOf: (absIdx: number) => number | undefined): string {
  switch (t.kind) {
    case "ref":
    case "ref_null": {
      const local = localOf(t.typeIdx);
      const nul = t.kind === "ref_null" ? "n" : "";
      if (local !== undefined) return `${nul}r${local}`;
      return `${nul}x`;
    }
    case "i32":
      return t.boolean ? "i32b" : "i32";
    case "i64":
      return t.bigint ? "i64big" : "i64";
    default:
      return t.kind;
  }
}

function fieldToken(f: FieldDef, localOf: (absIdx: number) => number | undefined): string {
  return `${f.mutable ? "m" : ""}${valTypeToken(f.type, localOf)}`;
}

/** Structural token for a single (already-unwrapped) type def, relative to the group. */
function structuralToken(t: FlatTypeDef, localOf: (absIdx: number) => number | undefined): string {
  switch (t.kind) {
    case "func": {
      const p = t.params.map((v) => valTypeToken(v, localOf)).join(",");
      const r = t.results.map((v) => valTypeToken(v, localOf)).join(",");
      return `func(${p})->(${r})`;
    }
    case "struct": {
      const sup =
        t.superTypeIdx !== undefined && t.superTypeIdx >= 0
          ? (() => {
              const local = localOf(t.superTypeIdx);
              return local !== undefined ? `sub r${local}${t.final ? "!" : ""} ` : `sub x${t.final ? "!" : ""} `;
            })()
          : "";
      const fields = t.fields.map((f) => fieldToken(f, localOf)).join(";");
      return `${sup}struct{${fields}}`;
    }
    case "array":
      return `array<${t.mutable ? "m" : ""}${valTypeToken(t.element, localOf)}>`;
    case "sub": {
      const sup =
        t.superType !== null
          ? (() => {
              const local = localOf(t.superType);
              return local !== undefined ? `sub r${local}${t.final ? "!" : ""} ` : `sub x${t.final ? "!" : ""} `;
            })()
          : t.final
            ? "final "
            : "";
      return `${sup}${structuralToken(t.type, localOf)}`;
    }
  }
}

/** FNV-1a 64-bit over a string; returns a 16-char lowercase hex digest. */
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * Compute a deterministic, name-independent, absolute-index-independent
 * structural canonical hash of an ordered group of type defs.
 *
 * `absIndices[i]` is the absolute type index of `group[i]` in the owning
 * module's type space (used to resolve intra-group refs to local positions).
 *
 * Two groups that are structurally identical modulo type names and absolute
 * placement produce the same hash; any change in member set, member order, or
 * the structure/intra-group topology of any member changes it. This is the
 * soundness proxy for "the engine canonicalizes these to the same runtime
 * type".
 */
export function canonicalHashOfTypeGroup(group: readonly FlatTypeDef[], absIndices: readonly number[]): string {
  const indexToLocal = new Map<number, number>();
  for (let i = 0; i < absIndices.length; i++) indexToLocal.set(absIndices[i]!, i);
  const localOf = (absIdx: number): number | undefined => indexToLocal.get(absIdx);

  const parts: string[] = [`v${RUNTIME_RECGROUP_ABI_VERSION}`, `n${group.length}`];
  for (let i = 0; i < group.length; i++) {
    parts.push(`${i}:${structuralToken(group[i]!, localOf)}`);
  }
  return fnv1a64(parts.join("|"));
}

/** A member of the extracted runtime group: its name + absolute index + def. */
export interface RuntimeGroupMember {
  /** Type name within the runtime rec-group. */
  name: string;
  /** Absolute type index of the member in the module's type table. */
  absIndex: number;
  /** Flattened structural definition of the member type. */
  def: FlatTypeDef;
}

/**
 * Locate the runtime-type members present in a module's flat type table, in
 * the module's emission order. Only types whose name is in
 * {@link RUNTIME_RECGROUP_TYPE_NAMES} are returned (a module that doesn't use
 * strings/vecs simply yields a subset, or none).
 *
 * Requires a *flat* type table (no nested `rec` wrappers), which is the shape
 * codegen produces today (`computeRecGroups` derives groups at emit time, the
 * `mod.types` array itself is flat).
 */
export function extractRuntimeGroup(mod: WasmModule): RuntimeGroupMember[] {
  const out: RuntimeGroupMember[] = [];
  const types = mod.types;
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    if (t.kind === "rec") continue; // not expected in the flat table; skip defensively
    const name = typeDefName(t);
    if (name !== undefined && RUNTIME_NAME_SET.has(name)) {
      out.push({ name, absIndex: i, def: t });
    }
  }
  return out;
}

/** Result of fingerprinting a module's runtime rec group. */
export interface RuntimeGroupFingerprint {
  /** ABI version this fingerprint was computed under. */
  abiVersion: number;
  /** Canonical structural hash (the identity proxy). */
  hash: string;
  /** Member names in emission order — the membership+order half of the ABI. */
  members: string[];
  /** Number of runtime types present. */
  count: number;
}

/**
 * Result of checking the type section of an emitted binary against a frozen
 * runtime-group fingerprint.
 *
 * This deliberately reports a structured result instead of throwing. The
 * optimizer can then fail safe to the pre-optimized bytes while keeping the
 * diagnostic actionable for callers that want to reject the artifact.
 */
export interface RuntimeRecGroupBinaryVerification {
  /** ABI version used by the expected fingerprint. */
  abiVersion: number;
  /** Whether an exact matching recursive group was found. */
  valid: boolean;
  /** Structural hash observed in the matching candidate, when available. */
  hash?: string;
  /** Absolute type-table start of the candidate group, when available. */
  start?: number;
  /** Absolute type-table end of the candidate group, when available. */
  end?: number;
  /** Number of members in the candidate group, when available. */
  count?: number;
  /** Human-readable reason for a failed check. */
  detail?: string;
}

interface BinaryCursor {
  readonly bytes: Uint8Array;
  offset: number;
}

interface ParsedBinaryTypeGroup {
  start: number;
  end: number;
  recursive: boolean;
  defs: FlatTypeDef[];
}

const BINARY_TYPE = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  v128: 0x7b,
  funcref: 0x70,
  externref: 0x6f,
  struct: 0x5f,
  array: 0x5e,
  func: 0x60,
  rec: 0x4e,
  sub: 0x50,
  subFinal: 0x4f,
  ref: 0x64,
  refNull: 0x63,
  any: 0x6e,
  eq: 0x6d,
  i31: 0x6c,
  structHeap: 0x6b,
  arrayHeap: 0x6a,
  none: 0x71,
  noExtern: 0x72,
  noFunc: 0x73,
  i8: 0x78,
  i16: 0x77,
} as const;

function readByte(c: BinaryCursor): number {
  if (c.offset >= c.bytes.length) throw new Error("truncated Wasm type section");
  return c.bytes[c.offset++]!;
}

function readUnsignedLeb(c: BinaryCursor): number {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const byte = readByte(c);
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
  throw new Error("invalid u32 LEB in Wasm type section");
}

function readSignedLeb33(c: BinaryCursor): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  for (let i = 0; i < 5; i++) {
    byte = readByte(c);
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      if ((byte & 0x40) !== 0 && shift < 33) value -= 2 ** shift;
      return value;
    }
  }
  throw new Error("invalid s33 LEB in Wasm type section");
}

/**
 * Decode the heap type that follows the binary `ref` / `ref null` prefix.
 * Abstract heap types use the same signed-LEB encoding as type indices, but
 * are represented by their one-byte tags (for example `any` = 0x6e), so they
 * must be recognized before treating the byte as a numeric index.
 */
function parseBinaryRefType(c: BinaryCursor, nullable: boolean): ValType {
  const next = c.bytes[c.offset];
  switch (next) {
    case BINARY_TYPE.any:
      c.offset++;
      return { kind: "anyref" };
    case BINARY_TYPE.eq:
      c.offset++;
      return { kind: "eqref" };
    case BINARY_TYPE.i31:
    case BINARY_TYPE.structHeap:
    case BINARY_TYPE.arrayHeap:
    case BINARY_TYPE.none:
      c.offset++;
      return { kind: "anyref" };
    case BINARY_TYPE.noExtern:
      c.offset++;
      return { kind: "externref" };
    case BINARY_TYPE.noFunc:
    case BINARY_TYPE.funcref:
      c.offset++;
      return { kind: "funcref" };
    case BINARY_TYPE.externref:
      c.offset++;
      return nullable ? { kind: "externref" } : { kind: "ref_extern" };
    default: {
      const typeIdx = readSignedLeb33(c);
      return nullable ? { kind: "ref_null", typeIdx } : { kind: "ref", typeIdx };
    }
  }
}

function parseBinaryValType(c: BinaryCursor, storage: boolean): ValType {
  const tag = readByte(c);
  switch (tag) {
    case BINARY_TYPE.i32:
      return { kind: "i32" };
    case BINARY_TYPE.i64:
      return { kind: "i64" };
    case BINARY_TYPE.f32:
      return { kind: "f32" };
    case BINARY_TYPE.f64:
      return { kind: "f64" };
    case BINARY_TYPE.v128:
      return { kind: "v128" };
    case BINARY_TYPE.funcref:
      return { kind: "funcref" };
    case BINARY_TYPE.externref:
      return { kind: "externref" };
    case BINARY_TYPE.i8:
      if (!storage) throw new Error("packed i8 in a value position");
      return { kind: "i8" };
    case BINARY_TYPE.i16:
      if (!storage) throw new Error("packed i16 in a value position");
      return { kind: "i16" };
    case BINARY_TYPE.ref:
      return parseBinaryRefType(c, false);
    case BINARY_TYPE.refNull:
      return parseBinaryRefType(c, true);
    case BINARY_TYPE.any:
      return { kind: "anyref" };
    case BINARY_TYPE.eq:
      return { kind: "eqref" };
    case BINARY_TYPE.i31:
      // The IR does not model Wasm's abstract heap-type lattice separately.
      // The canonical runtime group never contains these abstract bottoms,
      // but parsing them as the nearest existing opaque carrier lets the
      // verifier skip unrelated groups without rejecting a valid module.
      return { kind: "anyref" };
    case BINARY_TYPE.none:
      return { kind: "anyref" };
    case BINARY_TYPE.noExtern:
      return { kind: "externref" };
    case BINARY_TYPE.noFunc:
      return { kind: "funcref" };
    case BINARY_TYPE.structHeap:
      return { kind: "anyref" };
    case BINARY_TYPE.arrayHeap:
      return { kind: "anyref" };
    default:
      throw new Error(`unsupported Wasm value type byte 0x${tag.toString(16)}`);
  }
}

function parseBinaryTypeDef(c: BinaryCursor): FlatTypeDef {
  const tag = readByte(c);
  if (tag === BINARY_TYPE.func) {
    const paramCount = readUnsignedLeb(c);
    const params = Array.from({ length: paramCount }, () => parseBinaryValType(c, false));
    const resultCount = readUnsignedLeb(c);
    const results = Array.from({ length: resultCount }, () => parseBinaryValType(c, false));
    return { kind: "func", params, results };
  }
  if (tag === BINARY_TYPE.struct) {
    const fieldCount = readUnsignedLeb(c);
    const fields: FieldDef[] = [];
    for (let i = 0; i < fieldCount; i++) {
      fields.push({
        name: `field${i}`,
        type: parseBinaryValType(c, true),
        mutable: readByte(c) === 1,
      });
    }
    return { kind: "struct", name: `#${c.offset}`, fields };
  }
  if (tag === BINARY_TYPE.array) {
    const element = parseBinaryValType(c, true);
    return { kind: "array", name: `#${c.offset}`, element, mutable: readByte(c) === 1 };
  }
  if (tag === BINARY_TYPE.sub || tag === BINARY_TYPE.subFinal) {
    const superCount = readUnsignedLeb(c);
    // The compiler emits at most one supertype. Rejecting a wider shape keeps
    // this verifier conservative if a future optimizer introduces multiple
    // supertypes that this ABI hash does not model yet.
    if (superCount > 1) throw new Error("multiple supertypes are not supported by the ABI verifier");
    const superType = superCount === 1 ? readUnsignedLeb(c) : null;
    const inner = parseBinaryTypeDef(c);
    if (inner.kind === "sub") throw new Error("nested subtype is not supported by the ABI verifier");
    return {
      kind: "sub",
      name: `#${c.offset}`,
      superType,
      final: tag === BINARY_TYPE.subFinal,
      type: inner,
    };
  }
  throw new Error(`unsupported Wasm type definition byte 0x${tag.toString(16)}`);
}

function parseBinaryTypeGroups(binary: Uint8Array): ParsedBinaryTypeGroup[] {
  if (binary.length < 8 || binary[0] !== 0 || binary[1] !== 0x61 || binary[2] !== 0x73 || binary[3] !== 0x6d) {
    throw new Error("not a Wasm binary");
  }
  const groups: ParsedBinaryTypeGroup[] = [];
  let offset = 8;
  let typeSection: Uint8Array | undefined;
  while (offset < binary.length) {
    const sectionId = binary[offset++]!;
    const lengthCursor: BinaryCursor = { bytes: binary, offset };
    const sectionLength = readUnsignedLeb(lengthCursor);
    offset = lengthCursor.offset;
    const end = offset + sectionLength;
    if (end > binary.length) throw new Error("truncated Wasm section");
    if (sectionId === 1) typeSection = binary.subarray(offset, end);
    offset = end;
  }
  if (!typeSection) return groups;
  const c: BinaryCursor = { bytes: typeSection, offset: 0 };
  const typeCount = readUnsignedLeb(c);
  let absolute = 0;
  for (let i = 0; i < typeCount; i++) {
    const tag = typeSection[c.offset];
    if (tag === BINARY_TYPE.rec) {
      readByte(c);
      const count = readUnsignedLeb(c);
      const start = absolute;
      const defs = Array.from({ length: count }, () => parseBinaryTypeDef(c));
      absolute += count;
      groups.push({ start, end: absolute - 1, recursive: true, defs });
    } else {
      const start = absolute++;
      groups.push({ start, end: start, recursive: false, defs: [parseBinaryTypeDef(c)] });
    }
  }
  if (c.offset !== typeSection.length) throw new Error("trailing bytes in Wasm type section");
  return groups;
}

/**
 * Verify that raw emitted bytes still contain the exact canonical runtime
 * recursive group. This is intentionally independent of names and absolute
 * type indices, so it works after Binaryen has renamed and renumbered types.
 */
export function verifyRuntimeRecGroupBinary(
  binary: Uint8Array,
  expected: RuntimeGroupFingerprint,
): RuntimeRecGroupBinaryVerification {
  const base = { abiVersion: expected.abiVersion };
  if (expected.abiVersion !== RUNTIME_RECGROUP_ABI_VERSION) {
    return {
      ...base,
      valid: false,
      detail: `unsupported runtime rec-group ABI version ${expected.abiVersion} (expected ${RUNTIME_RECGROUP_ABI_VERSION})`,
    };
  }
  let groups: ParsedBinaryTypeGroup[];
  try {
    groups = parseBinaryTypeGroups(binary);
  } catch (error) {
    return {
      ...base,
      valid: false,
      detail: `could not parse Wasm type section: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const candidates = groups.filter((group) => group.recursive && group.defs.length === expected.count);
  if (candidates.length === 0) {
    return {
      ...base,
      valid: false,
      detail: `missing recursive runtime group (expected ${expected.count} members)`,
    };
  }
  const hashes = candidates.map((group) => ({
    group,
    hash: canonicalHashOfTypeGroup(
      group.defs,
      Array.from({ length: group.defs.length }, (_, i) => group.start + i),
    ),
  }));
  const match = hashes.find(({ hash }) => hash === expected.hash);
  if (!match) {
    return {
      ...base,
      valid: false,
      detail: `runtime rec-group fingerprint changed (expected ${expected.hash}, observed ${hashes
        .map(({ hash }) => hash)
        .join(", ")})`,
    };
  }
  return {
    ...base,
    valid: true,
    hash: match.hash,
    start: match.group.start,
    end: match.group.end,
    count: match.group.defs.length,
  };
}

/**
 * Produce a stable fingerprint of a module's runtime rec group: the structural
 * canonical hash plus the ordered member list. Equal fingerprints across two
 * artifacts ⇒ their runtime GC types will canonicalize to the same runtime
 * type, so GC objects can cross a core-wasm link between them.
 *
 * This is the building block for a drift gate: capture the fingerprint of a
 * reference artifact (e.g. the future `runtime.wasm`) and assert every user
 * module reproduces it, including AFTER `wasm-opt` (the #2514 risk #2 check).
 */
export function fingerprintRuntimeGroup(mod: WasmModule): RuntimeGroupFingerprint {
  const members = extractRuntimeGroup(mod);
  return {
    abiVersion: RUNTIME_RECGROUP_ABI_VERSION,
    hash: canonicalHashOfTypeGroup(
      members.map((m) => m.def),
      members.map((m) => m.absIndex),
    ),
    members: members.map((m) => m.name),
    count: members.length,
  };
}
