// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F2-S2 — capability-record schema widening (family 2, slice 2).
//
// **THIS SLICE MOVES NO BOUNDARY.** Not one resolve arm, provider row, policy
// field or emitted import changes. It widens the central capability-record
// schema so that family 2's remaining host crossings become EXPRESSIBLE as
// exact-ABI catalogue rows, and stops there:
//
//  * `wasm:js-string.{charCodeAt,concat,equals,length}` are func imports in a
//    NON-`env` namespace. Before this slice `RuntimeHostCapabilityRecord`
//    spelled `module` as the literal `"env"`, so those crossings could not be
//    written down at all.
//  * a string literal reaches the host lane as a GLOBAL import whose import
//    FIELD is the literal itself (`string_constants."f"`), or the hex of its
//    UTF-16 code units when it holds a lone surrogate
//    (`string_constants16."d800"`, #2880). A closed catalogue cannot enumerate
//    per-literal field names, so a global row fixes the field SCHEME instead.
//
// Byte identity holds BY CONSTRUCTION, not by luck: `freeze()` derives
// `hostCapabilityRecords` from the capabilities that selected PROVIDERS
// request, and no provider names any of the six new rows. The pins below
// assert that construction directly (section d), so a future slice that wires
// a provider up cannot do it silently under cover of "the schema already
// allowed it".
//
// What each section is for:
//   (a) the kind-discriminated schema itself — closed unions, both id halves
//   (b) the six new rows, whole-shape, and their canonical identity
//   (c) the ABI MEASURED against the registration sites, not restated
//   (d) nothing selects them: providers, frozen manifests, canonicalization
//   (e) the async projection still excludes them, now on TWO axes
//   (f) validator rejections, one per closed axis
//   (g) fail-closed kind guards at every func-assuming consumer
//   (h) the boundary is still where it was — the un-migrated arms still read
//       `ctx.nativeStrings`, pinned so a reviewer cannot mistake this slice
//       for the move it prepares
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { ASYNC_HOST_CAPABILITY_RECORDS, asAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";
import { preparedGeneratorNumberBoxProvider, preparedStringCompareProvider } from "../src/ir/intrinsic-support.js";
import {
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  RUNTIME_PROVIDERS,
  type RuntimeProviderDefinition,
} from "../src/ir/runtime-manifest.js";
import {
  asCallableRuntimeHostCapabilityRecord,
  canonicalizeRuntimeHostCapabilityCatalog,
  isRuntimeHostCapabilityFuncId,
  isRuntimeHostCapabilityGlobalId,
  resolveRuntimeHostCapabilityFuncRecord,
  resolveRuntimeHostCapabilityRecord,
  RUNTIME_HOST_CAPABILITY_FIELD_SCHEMES,
  RUNTIME_HOST_CAPABILITY_FUNC_IDS,
  RUNTIME_HOST_CAPABILITY_FUNC_MODULES,
  RUNTIME_HOST_CAPABILITY_GLOBAL_IDS,
  RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES,
  RUNTIME_HOST_CAPABILITY_IDS,
  RUNTIME_HOST_CAPABILITY_KINDS,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type RuntimeHostCapabilityId,
  type RuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { hexCodeUnits } from "../src/string-surrogate.js";
import type { Import, ValType, WasmModule } from "../src/ir/types.js";

/** The six ids this slice adds. Nothing else in the catalogue may move. */
const NEW_IDS = [
  "string.char_code_at",
  "string.concat",
  "string.const",
  "string.const.utf16",
  "string.eq",
  "string.len",
] as const;

const NEW_ID_SET: ReadonlySet<string> = new Set(NEW_IDS);

/**
 * (#3526 F2-S4) The four of those six that STILL have no provider row.
 *
 * `string.eq` left this set in F2-S3 and `string.len` in F2-S4, each when its
 * seam moved under manifest authority; the other four are untouched and the
 * fence below still holds them for F2-S5 and later.
 */
const PROVIDED_IDS = ["string.eq", "string.len"] as const;
const STILL_UNPROVIDED_IDS = NEW_IDS.filter((id) => !(PROVIDED_IDS as readonly string[]).includes(id));

function row(capability: RuntimeHostCapabilityId): RuntimeHostCapabilityRecord {
  return resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, capability);
}

function mathOnlyFreezeWith(records: readonly RuntimeHostCapabilityRecord[]) {
  const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" }, { hostCapabilityRecords: records });
  builder.requestFeature("math.sqrt");
  return () => builder.freeze();
}

/**
 * Replace ONE row in the central catalogue, leaving every other row the exact
 * canonical object. The F1-S1 `capabilityCatalogWith` idiom, kind-agnostic.
 */
function catalogueWith(capability: string, update: (record: RuntimeHostCapabilityRecord) => unknown) {
  return RUNTIME_HOST_CAPABILITY_RECORDS.map((record) =>
    record.capability === capability ? update(record) : record,
  ) as readonly RuntimeHostCapabilityRecord[];
}

const CATALOGUE_INVALID = expect.objectContaining<RuntimeManifestInvariantError>({
  code: "invalid-host-capability-catalog",
});

// --------------------------------------------------------------------------
// (a) the kind-discriminated schema
// --------------------------------------------------------------------------

describe("#3526 F2-S2 the capability schema is kind-discriminated and closed", () => {
  it("splits the id union into a func half and a global half, disjoint and total", () => {
    expect([...RUNTIME_HOST_CAPABILITY_GLOBAL_IDS]).toEqual(["string.const", "string.const.utf16"]);
    // Disjoint.
    for (const id of RUNTIME_HOST_CAPABILITY_GLOBAL_IDS) {
      expect(RUNTIME_HOST_CAPABILITY_FUNC_IDS as readonly string[]).not.toContain(id);
      expect(isRuntimeHostCapabilityGlobalId(id)).toBe(true);
      expect(isRuntimeHostCapabilityFuncId(id)).toBe(false);
    }
    // Total, and sorted — the completeness axis `canonicalize` checks against.
    expect([...RUNTIME_HOST_CAPABILITY_IDS]).toEqual(
      [...RUNTIME_HOST_CAPABILITY_FUNC_IDS, ...RUNTIME_HOST_CAPABILITY_GLOBAL_IDS].sort(),
    );
    expect(RUNTIME_HOST_CAPABILITY_IDS).toHaveLength(18);
    expect([...RUNTIME_HOST_CAPABILITY_IDS]).toEqual([
      "async.callback.wrap",
      "async.promise.capability.create",
      "async.promise.react",
      "async.promise.resolve",
      "async.promise.settle.fulfill",
      "async.promise.settle.reject",
      "async.value.undefined",
      "boolean.box",
      "extern.is_undefined",
      "number.box",
      "number.unbox",
      "string.char_code_at",
      "string.compare",
      "string.concat",
      "string.const",
      "string.const.utf16",
      "string.eq",
      "string.len",
    ]);
  });

  it("closes the module namespaces PER KIND, so env.<global> is unrepresentable", () => {
    expect([...RUNTIME_HOST_CAPABILITY_FUNC_MODULES]).toEqual(["env", "wasm:js-string"]);
    expect([...RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES]).toEqual(["string_constants", "string_constants16"]);
    expect([...RUNTIME_HOST_CAPABILITY_KINDS]).toEqual(["func", "global"]);
    expect([...RUNTIME_HOST_CAPABILITY_FIELD_SCHEMES]).toEqual(["literal", "literal-utf16-hex"]);
    // No overlap between the two module namespaces: the kind arm decides which
    // set applies, so no record can sit in both.
    for (const module of RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES) {
      expect(RUNTIME_HOST_CAPABILITY_FUNC_MODULES as readonly string[]).not.toContain(module);
    }
  });

  it("keeps the catalogue complete and every record on its own kind's axes", () => {
    expect(RUNTIME_HOST_CAPABILITY_RECORDS).toHaveLength(RUNTIME_HOST_CAPABILITY_IDS.length);
    for (const record of RUNTIME_HOST_CAPABILITY_RECORDS) {
      if (record.kind === "func") {
        expect(isRuntimeHostCapabilityFuncId(record.capability)).toBe(true);
        expect(RUNTIME_HOST_CAPABILITY_FUNC_MODULES as readonly string[]).toContain(record.module);
        expect(typeof record.field).toBe("string");
      } else {
        expect(isRuntimeHostCapabilityGlobalId(record.capability)).toBe(true);
        expect(RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES as readonly string[]).toContain(record.module);
        expect(RUNTIME_HOST_CAPABILITY_FIELD_SCHEMES as readonly string[]).toContain(record.field.scheme);
      }
    }
  });

  it("grows the value union by exactly ref_extern, and only concat uses it", () => {
    // `wasm:js-string.concat` returns `(ref extern)`, not a nullable externref.
    // That distinction is why the union had to grow at all.
    const usingRefExtern = RUNTIME_HOST_CAPABILITY_RECORDS.filter(
      (record) =>
        record.kind === "func" && [...record.params, ...record.results].some((entry) => entry === "ref_extern"),
    ).map((record) => record.capability);
    expect(usingRefExtern).toEqual(["string.concat"]);
  });
});

// --------------------------------------------------------------------------
// (b) the six new rows, whole-shape
// --------------------------------------------------------------------------

describe("#3526 F2-S2 the six new rows", () => {
  it("spells the four wasm:js-string builtins exactly", () => {
    expect(row("string.char_code_at")).toEqual({
      capability: "string.char_code_at",
      module: "wasm:js-string",
      field: "charCodeAt",
      kind: "func",
      params: ["externref", "i32"],
      results: ["i32"],
    });
    expect(row("string.concat")).toEqual({
      capability: "string.concat",
      module: "wasm:js-string",
      field: "concat",
      kind: "func",
      params: ["externref", "externref"],
      results: ["ref_extern"],
    });
    expect(row("string.eq")).toEqual({
      capability: "string.eq",
      module: "wasm:js-string",
      field: "equals",
      kind: "func",
      params: ["externref", "externref"],
      results: ["i32"],
    });
    expect(row("string.len")).toEqual({
      capability: "string.len",
      module: "wasm:js-string",
      field: "length",
      kind: "func",
      params: ["externref"],
      results: ["i32"],
    });
  });

  it("spells the two string-literal GLOBAL namespaces as field SCHEMES", () => {
    // The field is derived from the literal, so the row can only fix the
    // derivation rule. Both are immutable externref globals.
    expect(row("string.const")).toEqual({
      capability: "string.const",
      module: "string_constants",
      field: { scheme: "literal" },
      kind: "global",
      valueType: "externref",
      mutable: false,
    });
    expect(row("string.const.utf16")).toEqual({
      capability: "string.const.utf16",
      module: "string_constants16",
      field: { scheme: "literal-utf16-hex" },
      kind: "global",
      valueType: "externref",
      mutable: false,
    });
  });

  it("returns the exact canonical objects, not structural copies", () => {
    for (const id of NEW_IDS) {
      const record = row(id);
      expect(RUNTIME_HOST_CAPABILITY_RECORDS).toContain(record);
      expect(Object.isFrozen(record)).toBe(true);
      if (record.kind === "global") expect(Object.isFrozen(record.field)).toBe(true);
    }
  });

  it("leaves the twelve pre-existing rows untouched, env and func to a row", () => {
    const old = RUNTIME_HOST_CAPABILITY_RECORDS.filter((record) => !NEW_ID_SET.has(record.capability));
    expect(old).toHaveLength(12);
    for (const record of old) {
      expect(record.kind).toBe("func");
      expect(record.module).toBe("env");
    }
  });
});

// --------------------------------------------------------------------------
// (c) the ABI, MEASURED against the registration site
// --------------------------------------------------------------------------

const ABI_SOURCE = `export function pick(i: number): string {
  if (i === 0) return "";
  if (i === 1) return "f";
  if (i === 2) return "\\uD800";
  return "ab" + "cd";
}
export function eq(a: string, b: string): boolean { return a === b; }
export function cat(a: string, b: string): string { return a + b; }
export function len(s: string): number { return s.length; }
export function code(s: string, i: number): number { return s.charCodeAt(i); }`;

function hostLaneModule(): WasmModule {
  return generateModule(analyzeSource(ABI_SOURCE, "issue-3526-f2s2-abi.ts"), { experimentalIR: true }).module;
}

function importOf(module: WasmModule, namespace: string, field: string): Import {
  const found = module.imports.find((entry) => entry.module === namespace && entry.name === field);
  if (!found) throw new Error(`no ${namespace}.${field} import in the emitted module`);
  return found;
}

function valTypeOf(entry: string): ValType {
  return { kind: entry } as ValType;
}

describe("#3526 F2-S2 each row's ABI equals its registration site", () => {
  // The rows are not restatements: each one is compared against the type the
  // compiler actually registers for that import (`registry/imports.ts`
  // `addStringImports` / `addStringConstantGlobal`).
  it("matches the emitted wasm:js-string func signatures exactly", () => {
    const module = hostLaneModule();
    for (const id of ["string.char_code_at", "string.concat", "string.eq", "string.len"] as const) {
      const record = row(id);
      if (record.kind !== "func") throw new Error(`${id} is not a func record`);
      const imported = importOf(module, record.module, record.field);
      expect(imported.desc.kind, `${id} import kind`).toBe("func");
      if (imported.desc.kind !== "func") throw new Error("unreachable");
      const type = module.types[imported.desc.typeIdx];
      expect(type?.kind, `${id} type kind`).toBe("func");
      if (!type || type.kind !== "func") throw new Error("unreachable");
      expect(type.params, `${id} params`).toEqual(record.params.map(valTypeOf));
      expect(type.results, `${id} results`).toEqual(record.results.map(valTypeOf));
    }
  });

  it("matches the emitted string-constant GLOBAL descriptors and both field schemes", () => {
    const module = hostLaneModule();
    // `literal` — the field IS the literal, empty string included.
    for (const literal of ["", "f", "ab"]) {
      const imported = importOf(module, "string_constants", literal);
      expect(imported.desc).toEqual({ kind: "global", type: { kind: "externref" }, mutable: false });
    }
    // `literal-utf16-hex` — the lone-surrogate route (#2880).
    const surrogate = importOf(module, "string_constants16", hexCodeUnits("\uD800"));
    expect(surrogate.desc).toEqual({ kind: "global", type: { kind: "externref" }, mutable: false });

    for (const id of ["string.const", "string.const.utf16"] as const) {
      const record = row(id);
      if (record.kind !== "global") throw new Error(`${id} is not a global record`);
      const sample = id === "string.const" ? importOf(module, "string_constants", "f") : surrogate;
      expect(sample.desc).toEqual({
        kind: "global",
        type: valTypeOf(record.valueType),
        mutable: record.mutable,
      });
      expect(sample.module).toBe(record.module);
    }
  });

  it("derives the surrogate field the way the row's scheme says", () => {
    // The scheme is the whole content of the row's `field`, so it has to be
    // checked against the derivation, not against a name.
    expect(hexCodeUnits("\uD800")).toBe("d800");
    const module = hostLaneModule();
    expect(module.imports.some((entry) => entry.module === "string_constants16" && entry.name === "d800")).toBe(true);
    // …and a surrogate-free literal never lands in the utf16 namespace.
    expect(module.imports.some((entry) => entry.module === "string_constants16" && entry.name === "f")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// (d) nothing selects them — this is what makes the slice byte-neutral
// --------------------------------------------------------------------------

describe("#3526 F2-S2 no provider selects a new row", () => {
  it("has no provider naming any of the four STILL-unprovided capabilities", () => {
    // (#3526 F2-S4) Narrowed again, from five to four: `string.len` now HAS a
    // provider (`host.js.string.len`), which is exactly what this slice moved.
    // The pin is the regression fence for the NEXT slice, so the correct edit is
    // to shrink it by the id that landed — not to delete it. The remaining four
    // are still un-provided and this keeps saying so.
    const named = new Set<string>();
    for (const provider of RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]) {
      if (provider.implementation.kind === "host-callable") named.add(provider.implementation.capability);
      for (const capability of provider.hostCapabilities) named.add(capability);
    }
    expect(STILL_UNPROVIDED_IDS).toHaveLength(4);
    for (const id of STILL_UNPROVIDED_IDS) expect([...named]).not.toContain(id);
    for (const id of PROVIDED_IDS) expect([...named]).toContain(id);
  });

  it("keeps Math-only, async-only and compare-only manifests free of every new row", () => {
    const mathOnly = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    mathOnly.requestFeature("math.sqrt");
    expect(mathOnly.freeze().hostCapabilityRecords).toEqual([]);

    const asyncOnly = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    for (const feature of ["promise.resolve", "promise.react"] as const) asyncOnly.requestFeature(feature);
    const asyncFrozen = asyncOnly.freeze();
    for (const id of NEW_IDS) expect(asyncFrozen.hostCapabilities).not.toContain(id);

    const compareOnly = new RuntimeManifestBuilder({
      target: "host",
      backend: "wasmgc",
      stringCompare: { compare: "host" },
    });
    compareOnly.requestFeature("js.string.compare");
    const compareFrozen = compareOnly.freeze();
    expect(compareFrozen.hostCapabilities).toEqual(["string.compare"]);
    for (const id of NEW_IDS) expect(compareFrozen.hostCapabilities).not.toContain(id);
  });

  it("canonicalizes a REVERSED catalogue to the identical array, new rows included", () => {
    const forward = canonicalizeRuntimeHostCapabilityCatalog(RUNTIME_HOST_CAPABILITY_RECORDS);
    const reversed = canonicalizeRuntimeHostCapabilityCatalog([...RUNTIME_HOST_CAPABILITY_RECORDS].reverse());
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(reversed.every((record, index) => record === forward[index])).toBe(true);
    expect(forward.map((record) => record.capability)).toEqual([...RUNTIME_HOST_CAPABILITY_IDS]);
  });

  it("still rejects an incomplete catalogue — dropping a NEW row is a hard failure", () => {
    for (const id of NEW_IDS) {
      expect(
        mathOnlyFreezeWith(RUNTIME_HOST_CAPABILITY_RECORDS.filter((record) => record.capability !== id)),
      ).toThrowError(CATALOGUE_INVALID);
    }
  });
});

// --------------------------------------------------------------------------
// (e) the async projection excludes them on TWO axes now
// --------------------------------------------------------------------------

describe("#3526 F2-S2 the async projection is unmoved", () => {
  it("still carries exactly the seven async rows", () => {
    expect(ASYNC_HOST_CAPABILITY_RECORDS).toHaveLength(7);
    for (const id of NEW_IDS) {
      expect(ASYNC_HOST_CAPABILITY_RECORDS.map((record) => record.capability)).not.toContain(id);
    }
  });

  it("refuses every new row, func and global alike, by the ID filter", () => {
    for (const id of NEW_IDS) {
      expect(() => asAsyncHostAdapter(row(id))).toThrowError(/is not an async capability/);
    }
  });

  it("refuses a GLOBAL record that carries an async id — the kind guard, not the filter", () => {
    // The id filter cannot catch this one, which is exactly why the kind guard
    // sits before the value-type walk: a global record has no `params` at all.
    const impostor = {
      capability: "async.promise.resolve",
      module: "string_constants",
      field: { scheme: "literal" },
      kind: "global",
      valueType: "externref",
      mutable: false,
    } as unknown as RuntimeHostCapabilityRecord;
    expect(() => asAsyncHostAdapter(impostor)).toThrowError(/is not a callable host capability/);
  });
});

// --------------------------------------------------------------------------
// (f) validator rejections — one per closed axis
// --------------------------------------------------------------------------

describe("#3526 F2-S2 the validator rejects every cross-kind row", () => {
  it("rejects env + global and wasm:js-string + global", () => {
    expect(mathOnlyFreezeWith(catalogueWith("string.const", (record) => ({ ...record, module: "env" })))).toThrowError(
      /unknown host capability string\.const module env/,
    );
    expect(
      mathOnlyFreezeWith(catalogueWith("string.const", (record) => ({ ...record, module: "wasm:js-string" }))),
    ).toThrowError(/unknown host capability string\.const module wasm:js-string/);
  });

  it("rejects string_constants + func", () => {
    expect(
      mathOnlyFreezeWith(catalogueWith("string.len", (record) => ({ ...record, module: "string_constants" }))),
    ).toThrowError(/unknown host capability string\.len module string_constants/);
  });

  it("rejects an unknown module and an unknown kind", () => {
    expect(mathOnlyFreezeWith(catalogueWith("string.len", (record) => ({ ...record, module: "banana" })))).toThrowError(
      /unknown host capability string\.len module banana/,
    );
    expect(mathOnlyFreezeWith(catalogueWith("string.len", (record) => ({ ...record, kind: "table" })))).toThrowError(
      /unknown host capability string\.len kind table/,
    );
  });

  it("rejects a kind SWAP in both directions", () => {
    expect(mathOnlyFreezeWith(catalogueWith("string.len", (record) => ({ ...record, kind: "global" })))).toThrowError(
      /host capability string\.len kind global does not match func/,
    );
    expect(mathOnlyFreezeWith(catalogueWith("string.const", (record) => ({ ...record, kind: "func" })))).toThrowError(
      /host capability string\.const kind func does not match global/,
    );
  });

  it("rejects a wrong mutable, a wrong valueType and a wrong or unknown field scheme", () => {
    expect(mathOnlyFreezeWith(catalogueWith("string.const", (record) => ({ ...record, mutable: true })))).toThrowError(
      /host capability string\.const mutable true does not match false/,
    );
    expect(
      mathOnlyFreezeWith(catalogueWith("string.const", (record) => ({ ...record, valueType: "i32" }))),
    ).toThrowError(/host capability string\.const valueType .* do not match/);
    expect(
      mathOnlyFreezeWith(
        catalogueWith("string.const", (record) => ({ ...record, field: { scheme: "literal-utf16-hex" } })),
      ),
    ).toThrowError(/host capability string\.const field scheme literal-utf16-hex does not match literal/);
    expect(
      mathOnlyFreezeWith(catalogueWith("string.const", (record) => ({ ...record, field: { scheme: "nope" } }))),
    ).toThrowError(/unknown host capability string\.const field scheme nope/);
    expect(mathOnlyFreezeWith(catalogueWith("string.const", (record) => ({ ...record, field: "f" })))).toThrowError(
      /host capability string\.const field f does not match a global field scheme/,
    );
  });

  it("rejects a func-shaped global row and a global-shaped func row on their key lists", () => {
    // `params`/`results` are not global keys; `valueType`/`mutable` are not func
    // keys. The exact-key check is per kind, so each rejects the other's shape.
    expect(
      mathOnlyFreezeWith(
        catalogueWith("string.const", (record) => {
          const { valueType: _valueType, mutable: _mutable, ...rest } = record as Record<string, unknown>;
          return { ...rest, params: [], results: ["externref"] };
        }),
      ),
    ).toThrowError(CATALOGUE_INVALID);
    expect(
      mathOnlyFreezeWith(
        catalogueWith("string.len", (record) => {
          const { params: _params, results: _results, ...rest } = record as Record<string, unknown>;
          return { ...rest, valueType: "externref", mutable: false };
        }),
      ),
    ).toThrowError(CATALOGUE_INVALID);
  });

  it("rejects a structurally valid but non-canonical clone of a new row", () => {
    for (const id of NEW_IDS) {
      expect(mathOnlyFreezeWith(catalogueWith(id, (record) => ({ ...record })))).toThrowError(CATALOGUE_INVALID);
    }
  });
});

// --------------------------------------------------------------------------
// (g) fail-closed kind guards at every func-assuming consumer
// --------------------------------------------------------------------------

const IR_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/ir");

function irSource(file: string): string {
  return readFileSync(join(IR_DIR, file), "utf8");
}

/** A frozen-manifest stand-in whose ONE provider names a global capability. */
function preparedWithGlobalProvider(feature: string, id: string) {
  return {
    manifest: {
      providers: [{ id: "host.js.number.box", feature, implementation: { kind: "host-callable", capability: id } }],
      hostCapabilityRecords: RUNTIME_HOST_CAPABILITY_RECORDS,
    },
  } as never;
}

describe("#3526 F2-S2 every func-assuming consumer fails closed on a global row", () => {
  it("throws from the shared guard, naming the capability", () => {
    for (const id of ["string.const", "string.const.utf16"] as const) {
      expect(() => asCallableRuntimeHostCapabilityRecord(row(id))).toThrowError(
        new RegExp(`host capability ${id.replace(/\./g, "\\.")} is not a callable host capability`),
      );
    }
    // …and passes every func row straight through, so it is not a blanket refusal.
    for (const record of RUNTIME_HOST_CAPABILITY_RECORDS) {
      if (record.kind === "func") expect(asCallableRuntimeHostCapabilityRecord(record)).toBe(record);
    }
  });

  it("throws from the func resolver even when the id is smuggled past the type", () => {
    expect(() =>
      resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.const" as never),
    ).toThrowError(/host capability string\.const is not a callable host capability/);
  });

  it("throws from the generator and string-compare provider derivations", () => {
    expect(() =>
      preparedGeneratorNumberBoxProvider(preparedWithGlobalProvider("js.generator.number-box", "string.const")),
    ).toThrowError(/is not a callable host capability/);
    expect(() =>
      preparedStringCompareProvider(preparedWithGlobalProvider("js.string.compare", "string.const.utf16")),
    ).toThrowError(/is not a callable host capability/);
  });

  it("refuses a manifest whose host-callable provider names a global capability", () => {
    // The runtime twin of the `host-callable` type narrowing, in the place a
    // hand-built or deserialized provider table would enter.
    const freezeOnce = () => {
      const builder = new RuntimeManifestBuilder(
        { target: "host", backend: "wasmgc" },
        {
          providers: RUNTIME_PROVIDERS.map((provider) =>
            provider.id === "host.js.number.box"
              ? { ...provider, implementation: { kind: "host-callable", capability: "string.const" } }
              : provider,
          ) as never,
        },
      );
      builder.requestFeature("math.sqrt");
      return () => builder.freeze();
    };
    expect(freezeOnce()).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "unknown-host-capability" }),
    );
    expect(freezeOnce()).toThrowError(
      /host-callable provider host\.js\.number\.box names non-callable host capability string\.const/,
    );
  });

  it("routes every func-assuming src/ir consumer through a guard", () => {
    // Source pins, not behaviour pins, for the two sites whose reachable
    // failure needs a whole async attachment to construct. The #2955 grep-gate
    // idiom, scoped to the guard's name.
    const support = irSource("intrinsic-support.ts");
    expect(support).toContain("resolveRuntimeHostCapabilityFuncRecord");
    // No unguarded resolution survives in the file that materializes callables.
    expect(support).not.toMatch(/[^c]resolveRuntimeHostCapabilityRecord\(/);
    expect(irSource("async-plan.ts")).toContain("asCallableRuntimeHostCapabilityRecord(");
    expect(irSource("async-runtime-providers.ts")).toContain("asCallableRuntimeHostCapabilityRecord(");
    expect(irSource("runtime-manifest.ts")).toContain("isRuntimeHostCapabilityFuncId(");
  });
});

// --------------------------------------------------------------------------
// (h) the boundary has NOT moved
// --------------------------------------------------------------------------

const INTEGRATION_PATH = join(IR_DIR, "integration.ts");

function integrationSlice(startMarker: string, endMarker: string): string {
  const raw = readFileSync(INTEGRATION_PATH, "utf8");
  const start = raw.indexOf(startMarker);
  expect(start, `the ${startMarker} site must exist`).toBeGreaterThan(-1);
  const rest = raw.slice(start);
  const end = rest.indexOf(endMarker);
  expect(end, `the ${startMarker} site must be followed by ${endMarker}`).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe("#3526 F2-S2 the un-migrated arms still read the lane", () => {
  it("keeps the CONCAT resolve arm on ctx.nativeStrings and the raw import lookup", () => {
    // (#3526 F2-S3) F2-S3 lifted `string.eq` out of what was a three-symbol arm,
    // so this pin is now concat-only and the eq half is INVERTED in
    // `issue-3526-string-boundary-eq.test.ts` (which asserts the arm reads no
    // lane discriminator at all). The concat pair is still UNGOVERNED, and
    // pinning that is what stops F2-S5 from being mistaken for having landed.
    // The `field` variable went with the eq half — after the split the arm names
    // its one spelling directly.
    const arm = integrationSlice(
      "symbol === IR_STRING_CONCAT_FN || symbol === IR_STRING_CONCAT_OWNED_FN",
      "\n  } else if (",
    );
    expect(arm).toContain("ctx.nativeStrings");
    expect(arm).toContain('exactCallableImportIndex(ctx, "wasm:js-string", "concat")');
    expect(arm).not.toContain("hostCapabilityRecords");
    expect(arm).not.toContain("IR_STRING_EQUALS_FN");
  });

  // (#3526 F2-S4) The `string.len` twin of the pin above is GONE, not shrunk.
  // It fenced `prepareStrings`'s `if (usesStringLen) { … }` decision block,
  // which F2-S4 deleted outright: the length provider is now built from the
  // frozen manifest in `prepareStringLength`, inside the freeze. There is no
  // remaining half to re-scope the way the concat/eq pin was, so the assertion
  // is INVERTED into `issue-3526-string-boundary-len.test.ts`, which pins that
  // `prepareStrings` no longer names a length provider at all and that the new
  // site reads neither `ctx.nativeStrings` nor `ctx.anyStrTypeIdx`.

  it("adds no string-literal storage authority — storageForConst still reads the lane", () => {
    const slice = integrationSlice("const storageForConst = (instr: IrInstrStringConst)", "\n  const materializerRefs");
    expect(slice).toContain("ctx.nativeStrings");
    expect(slice).toContain("programAbiStringConstantRef(ctx, instr.value)");
  });
});
