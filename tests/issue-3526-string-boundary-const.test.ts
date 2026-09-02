// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F2-S8 — the string LITERAL STORAGE seam moves under manifest authority.
//
// Family 2's last slice, and the one that finally gives a GLOBAL host
// capability a provider. Three things make it different from its five
// predecessors, and all three are why the catalogue had to grow:
//
//  * **the arms are VALUES, not callables.** `string.const` has no resolve-table
//    arm and no runtime symbol: the `IrGlobalRef` the instruction carries IS the
//    physical choice. So the manifest needs two new implementation kinds —
//    `host-global`, which names a GLOBAL capability record (`string_constants`,
//    field scheme `literal`), and `native-global`, which names the Program-ABI
//    role `native-string-literal`. Both are symbolic: the record fixes a field
//    SCHEME because there is one field per literal, and the role can never be an
//    index because the manifest freezes before `internNativeStringLiteral`
//    allocates one.
//
//  * **the attachment had to MOVE behind the freeze**, as F2-S4's did for the
//    length. The decision lived in `prepareStrings`, which runs before the
//    manifest exists; it now lives in `prepareStringConst`, inside
//    `prepareBuiltFnRuntimeManifest`. That pass sits AFTER the freeze's
//    `if (!runtime) return` early return, so it runs only because the demand is
//    part of the "freeze nothing at all" conjunction. Break that coupling and
//    every literal silently loses `storage` and falls back to the raw
//    `stringGlobalMap` lookup — the same bytes on the host lane, and therefore
//    invisible to any byte matrix. Section (b) pins the coupling directly.
//
//  * **TWO features, one policy.** `js.string.const` is the surrogate-free
//    literal; `js.string.const.utf16` is the lone-surrogate literal (#2880),
//    which cannot be its own import field name and lives in `string_constants16`
//    keyed by the hex of its UTF-16 code units. Two features so a surrogate-free
//    module's frozen `hostCapabilityRecords` names exactly the one namespace it
//    imports; the split itself stays a per-literal DERIVATION inside the host
//    arm, never an arm of its own.
//
// **What the policy governs, plainly: the LABEL, not the mint.** Measured at the
// census grounding, 38 of 39 host `string_constants` mints came from the legacy
// import collector's finalize pass, and `prepareStrings`' own pre-registration
// was a no-op on every required fixture. This slice moves no registration and no
// import order — sections (c) and (d) pin both.
//
// What it does NOT retire: the no-storage fallback in `emitResolvedStringConst`.
// Measured on this branch's own base and again after, over 90 byte cells: it is
// reached exactly TWICE, both times by `extern.regex`'s pattern and flags on the
// gc-host lane, and ZERO times by a `string.const`. Retiring it needs the regex
// seam to carry a `storage` of its own, which is the next slice's work.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult } from "../src/index.js";
import { generateModule } from "../src/codegen/index.js";
import { irImportGlobalRef, irSupportGlobalRef } from "../src/ir/abi-bindings.js";
import { irIntrinsicFuncRef } from "../src/ir/callable-bindings.js";
import type { IrBindingOwnerId } from "../src/ir/identity.js";
import {
  prepareIrRuntimeManifest,
  preparedStringConstProvider,
  stringConstFeatureFor,
} from "../src/ir/intrinsic-support.js";
import { EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE, INTRINSIC_SIGNATURE_VERSION } from "../src/ir/intrinsics.js";
import {
  asBlockId,
  asValueId,
  forEachInstrDeep,
  irVal,
  type IrFuncRef,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrType,
} from "../src/ir/nodes.js";
import {
  projectRuntimeBackendRequirements,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  RUNTIME_PROVIDERS,
  STRING_CONST_POLICY_DISABLED,
  STRING_CONST_RUNTIME_FEATURES,
  STRING_CONST_RUNTIME_PROVIDER_IDS,
  STRING_COMPARE_POLICY_DISABLED,
  STRING_CONCAT_POLICY_DISABLED,
  STRING_EQ_POLICY_DISABLED,
  STRING_LEN_POLICY_DISABLED,
  type RuntimeManifestPolicy,
  type RuntimeProviderDefinition,
  type StringConstPolicy,
} from "../src/ir/runtime-manifest.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { attachIrStringConstStorage } from "../src/ir/string-support.js";
import type { WasmModule } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-string-boundary-const");
const STRING: IrType = { kind: "string" };
const OWNER = "issue-3526-f2s8" as IrBindingOwnerId;

const HOST_CONST: StringConstPolicy = { storage: "host" };
const NATIVE_CONST: StringConstPolicy = { storage: "native" };

/** A lone high surrogate — not a Unicode scalar, so it cannot be its own field name. */
const LONE = "x\uD800y";

function policy(stringConst?: StringConstPolicy): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", ...(stringConst ? { stringConst } : {}) };
}

function instrsOf(fn: IrFunction): IrInstr[] {
  const found: IrInstr[] = [];
  const scan = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) forEachInstrDeep(root, (instr) => found.push(instr));
  };
  for (const block of fn.blocks) scan(block.instrs);
  for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  return found;
}

/**
 * One hand-built owner carrying exactly the `string.const` instructions
 * from-ast emits for the given literals, and nothing else.
 *
 * It carries no `intrinsic` instruction and no async plan — which is the whole
 * point: without `stringConstDemand` this owner freezes NO manifest at all, and
 * the attachment that now lives inside the freeze would never run.
 */
function constFunction(name: string, values: readonly string[]): IrFunction {
  const instrs: IrInstr[] = values.map(
    (value, index) =>
      ({
        kind: "string.const",
        value,
        result: asValueId(index),
        resultType: irVal({ kind: "externref" }),
      }) as unknown as IrInstr,
  );
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [],
    resultTypes: [STRING],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [asValueId(0)] },
      },
    ],
    exported: false,
    valueCount: values.length,
    funcKind: "regular",
  } as unknown as IrFunction;
}

function prepare(values: readonly string[], stringConst: StringConstPolicy, name = "consts") {
  const utf16 = values.some((value) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value));
  const prepared = prepareIrRuntimeManifest({
    functions: [constFunction(name, values)],
    sourceFile: "/repo/string-const.ts",
    policy: policy(stringConst),
    stringConstDemand: { literal: values.length > 0, utf16 },
  });
  if (!prepared) throw new Error("expected a non-empty runtime manifest");
  return prepared;
}

function hostLaneModule(source: string): WasmModule {
  return generateModule(analyzeSource(source, "issue-3526-f2s8-const.ts"), { experimentalIR: true }).module;
}

/** The emitted module's own import section, ordered, with per-kind indices. */
function orderedImports(module: WasmModule): string[] {
  let funcIndex = 0;
  let globalIndex = 0;
  return module.imports.map((entry) => {
    if (entry.desc.kind === "func") return `func ${entry.module}.${entry.name}#${funcIndex++}`;
    if (entry.desc.kind === "global") return `global ${entry.module}.${JSON.stringify(entry.name)}@${globalIndex++}`;
    return `${entry.desc.kind} ${entry.module}.${entry.name}`;
  });
}

async function instantiate(result: CompileResult): Promise<Record<string, (...args: never[]) => unknown>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, (...args: never[]) => unknown>;
}

// --------------------------------------------------------------------------
// (a) contract — two feature rows, four arms, ONE new signature
// --------------------------------------------------------------------------

describe("#3526 F2-S8 string-const contract", () => {
  it("adds TWO feature rows — one per import NAMESPACE, not one per authority", () => {
    expect([...STRING_CONST_RUNTIME_FEATURES]).toEqual(["js.string.const", "js.string.const.utf16"]);
    expect(stringConstFeatureFor(false)).toBe("js.string.const");
    expect(stringConstFeatureFor(true)).toBe("js.string.const.utf16");
  });

  it("mints ONE signature, and it is the catalogue's only empty-parameter one", () => {
    expect(EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE).toEqual({
      version: INTRINSIC_SIGNATURE_VERSION,
      params: [],
      result: irVal({ kind: "externref" }),
    });
    // The whole point of the signature: it describes a VALUE. Nothing else in
    // the catalogue does, so an empty-params row can only be a storage row.
    const emptyParamRows = (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).filter(
      (provider) => provider.signature !== undefined && provider.signature.params.length === 0,
    );
    expect(emptyParamRows.map((provider) => provider.id).sort()).toEqual([...STRING_CONST_RUNTIME_PROVIDER_IDS].sort());
  });

  it("is FOUR-armed — two authorities × two namespaces", () => {
    expect([...STRING_CONST_RUNTIME_PROVIDER_IDS]).toEqual([
      "host.js.string.const",
      "host.js.string.const.utf16",
      "native.js.string.const",
      "native.js.string.const.utf16",
    ]);
    const rows = (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).filter((provider) =>
      (STRING_CONST_RUNTIME_PROVIDER_IDS as readonly string[]).includes(provider.id),
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.signature).toBe(EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE);
  });

  it("names the two GLOBAL capability records on the host rows, and no capability on the native ones", () => {
    const byId = new Map(
      (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).map((provider) => [provider.id, provider]),
    );
    expect(byId.get("host.js.string.const")!.implementation).toEqual({
      kind: "host-global",
      capability: "string.const",
    });
    expect(byId.get("host.js.string.const.utf16")!.implementation).toEqual({
      kind: "host-global",
      capability: "string.const.utf16",
    });
    expect(byId.get("host.js.string.const")!.hostCapabilities).toEqual(["string.const"]);
    expect(byId.get("host.js.string.const.utf16")!.hostCapabilities).toEqual(["string.const.utf16"]);
    // The native twins name the SAME ABI role: natively a lone surrogate is a
    // plain u16 code unit in an interned literal, so there is no second
    // namespace to select.
    for (const id of ["native.js.string.const", "native.js.string.const.utf16"] as const) {
      expect(byId.get(id)!.implementation).toEqual({ kind: "native-global", role: "native-string-literal" });
      expect(byId.get(id)!.hostCapabilities).toEqual([]);
    }
    // The records the host rows point at — module and SCHEME, never a field.
    const literal = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.const");
    const utf16 = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.const.utf16");
    expect(literal).toMatchObject({ kind: "global", module: "string_constants", field: { scheme: "literal" } });
    expect(utf16).toMatchObject({
      kind: "global",
      module: "string_constants16",
      field: { scheme: "literal-utf16-hex" },
    });
  });

  it("is invisible to the async backend projection", () => {
    const rows = (RUNTIME_PROVIDERS as readonly RuntimeProviderDefinition[]).filter((provider) =>
      (STRING_CONST_RUNTIME_PROVIDER_IDS as readonly string[]).includes(provider.id),
    );
    expect(projectRuntimeBackendRequirements(rows)).toEqual([]);
    const frozen = prepare(["hello"], HOST_CONST).manifest;
    expect(frozen.backendRequirements).toEqual([]);
  });

  it("carries NO intrinsic instruction — the demand is requested at freeze", () => {
    const fn = constFunction("literals", ["hello", ""]);
    expect(instrsOf(fn).some((instr) => instr.kind === "intrinsic")).toBe(false);
    const frozen = prepare(["hello", ""], HOST_CONST).manifest;
    expect(frozen.intrinsicUses).toEqual([]);
    // A surrogate-free module freezes exactly ONE row.
    expect(frozen.features).toEqual(["js.string.const"]);
    // …and a module with a lone surrogate freezes BOTH: the surrogate-free
    // literals still need `string_constants`.
    expect(prepare(["hello", LONE], HOST_CONST).manifest.features).toEqual([
      "js.string.const",
      "js.string.const.utf16",
    ]);
  });
});

// --------------------------------------------------------------------------
// (b) policy — the frozen row is the authority
// --------------------------------------------------------------------------

describe("#3526 F2-S8 provider policy", () => {
  it("selects the host arm through the GLOBAL record, publishing module and scheme", () => {
    const prepared = prepare(["hello"], HOST_CONST);
    expect(preparedStringConstProvider(prepared, "js.string.const")).toEqual({
      arm: "host",
      module: "string_constants",
      scheme: "literal",
    });
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["host.js.string.const"]);
    expect(prepared.manifest.hostCapabilities).toEqual(["string.const"]);
  });

  it("selects the utf16 host arm through its OWN record and namespace", () => {
    const prepared = prepare([LONE], HOST_CONST);
    expect(preparedStringConstProvider(prepared, "js.string.const.utf16")).toEqual({
      arm: "host",
      module: "string_constants16",
      scheme: "literal-utf16-hex",
    });
  });

  it("selects the native arm by ROLE, requesting NO host capability", () => {
    const prepared = prepare(["hello", LONE], NATIVE_CONST);
    for (const feature of STRING_CONST_RUNTIME_FEATURES) {
      expect(preparedStringConstProvider(prepared, feature)).toEqual({
        arm: "native",
        role: "native-string-literal",
      });
    }
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.hostCapabilityRecords).toEqual([]);
  });

  it("refuses the arm its caller resolved to unsupported, naming the seam and the policy", () => {
    // A failed freeze puts the builder in its terminal `failed` state, so each
    // assertion needs its own builder rather than a second call on one.
    const refuse = (feature: "js.string.const" | "js.string.const.utf16") => {
      const builder = new RuntimeManifestBuilder(policy(STRING_CONST_POLICY_DISABLED));
      builder.requestFeature(feature);
      return () => builder.freeze();
    };
    expect(refuse("js.string.const")).toThrowError(
      /runtime feature js\.string\.const is unavailable under string-const policy storage=unsupported/,
    );
    expect(refuse("js.string.const.utf16")).toThrowError(
      /runtime feature js\.string\.const\.utf16 is unavailable under string-const policy storage=unsupported/,
    );
    expect(refuse("js.string.const")).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }),
    );
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    const frozen = builder.freeze();
    expect(frozen.policy.stringConst).toEqual(STRING_CONST_POLICY_DISABLED);
    expect(STRING_CONST_POLICY_DISABLED).toEqual({ storage: "unsupported" });
  });

  it("resolves independently of every sibling string policy", () => {
    const prepared = prepareIrRuntimeManifest({
      functions: [constFunction("independent", ["hello"])],
      sourceFile: "/repo/string-const.ts",
      policy: {
        target: "host",
        backend: "wasmgc",
        stringCompare: STRING_COMPARE_POLICY_DISABLED,
        stringEq: STRING_EQ_POLICY_DISABLED,
        stringLen: STRING_LEN_POLICY_DISABLED,
        stringConcat: STRING_CONCAT_POLICY_DISABLED,
        stringConst: NATIVE_CONST,
      },
      stringConstDemand: { literal: true, utf16: false },
    });
    expect(preparedStringConstProvider(prepared, "js.string.const")).toEqual({
      arm: "native",
      role: "native-string-literal",
    });
    expect(prepared!.manifest.policy.stringCompare).toEqual(STRING_COMPARE_POLICY_DISABLED);
    expect(prepared!.manifest.policy.stringConst).toEqual(NATIVE_CONST);
  });

  it("names ONLY the namespaces the module actually imports", () => {
    // A surrogate-free module must not claim `string_constants16`; that is the
    // whole reason the seam has two features rather than one row asking for
    // both capabilities.
    const plain = prepare(["hello", "", "ab"], HOST_CONST).manifest;
    expect(plain.hostCapabilities).toEqual(["string.const"]);
    expect(plain.hostCapabilityRecords.map((record) => record.capability)).toEqual(["string.const"]);
    const surrogate = prepare(["hello", LONE], HOST_CONST).manifest;
    expect(surrogate.hostCapabilities).toEqual(["string.const", "string.const.utf16"]);
  });

  it("freezes NOTHING when the demand is absent — the early-return coupling, stated", () => {
    // `prepareStringConst` runs after `prepareBuiltFnRuntimeManifest`'s
    // `if (!runtime) return { entries }`. An owner carrying only `string.const`
    // has no intrinsic and no async plan, so WITHOUT the demand the freeze
    // returns undefined and no literal would ever be given `storage` — the same
    // bytes on the host lane, and therefore invisible to a byte matrix. This is
    // the pin that makes the coupling falsifiable.
    const withoutDemand = prepareIrRuntimeManifest({
      functions: [constFunction("no-demand", ["hello"])],
      sourceFile: "/repo/string-const.ts",
      policy: policy(HOST_CONST),
    });
    expect(withoutDemand).toBeUndefined();
    const withDemand = prepareIrRuntimeManifest({
      functions: [constFunction("with-demand", ["hello"])],
      sourceFile: "/repo/string-const.ts",
      policy: policy(HOST_CONST),
      stringConstDemand: { literal: true, utf16: false },
    });
    expect(withDemand).toBeDefined();
    expect(withDemand!.manifest.features).toEqual(["js.string.const"]);
  });

  it("counts a regex literal as demand, so a regex-only module names its namespace", async () => {
    // The caveat, pinned rather than left implicit: `extern.regex` lowers its
    // pattern and flags through two `emitStringConst` calls and DOES occupy
    // `string_constants` globals on the host lane, so the frozen row is honest
    // about the import. Their EMISSION still goes through the no-storage
    // fallback — the manifest claims the capability, the seam does not yet
    // route those two literals through it.
    const result = await compile(`export function f(s: string): boolean { return /ab+c/i.test(s); }`);
    expect(result.success).toBe(true);
    const module = hostLaneModule(`export function f(s: string): boolean { return /ab+c/i.test(s); }`);
    expect(orderedImports(module).filter((entry) => entry.includes("string_constants"))).toEqual([
      'global string_constants."f"@0',
      'global string_constants."ab+c"@1',
      'global string_constants."i"@2',
      'global string_constants.""@3',
    ]);
  });
});

// --------------------------------------------------------------------------
// (c) end-to-end behaviour is unchanged — the label moved, nothing else
// --------------------------------------------------------------------------

describe("#3526 F2-S8 end-to-end behaviour is unchanged", () => {
  it("binds the host lane's literal at the SAME import position", () => {
    expect(orderedImports(hostLaneModule(`export function f(): string { return "hello"; }`))).toEqual([
      'global string_constants."f"@0',
      'global string_constants."hello"@1',
      'global string_constants.""@2',
    ]);
  });

  it("keeps the string_constants16 namespace INTERLEAVED in scan order", () => {
    // The two namespaces are one arm: `hasLoneSurrogate` picks per literal, in
    // the order the collector registered them. A policy that grouped or sorted
    // by namespace would move these three indices.
    expect(orderedImports(hostLaneModule(`export function f(): string { return "x\\uD800y"; }`))).toEqual([
      'global string_constants."f"@0',
      'global string_constants16."0078d8000079"@1',
      'global string_constants.""@2',
    ]);
  });

  it("keeps the FUNC import ahead of the IR-only literals it mints", () => {
    // The one fixture where `prepareStrings` mints host globals itself (the
    // boolean brand's "true"/"false"). Their position — after the collector's
    // globals and after the `wasm:js-string.concat` func import — is exactly
    // what a freeze-time registration would have moved.
    expect(orderedImports(hostLaneModule("export function f(b: boolean): string { return `${b}`; }"))).toEqual([
      "func wasm:js-string.concat#0",
      'global string_constants."f"@0',
      'global string_constants.""@1',
      'global string_constants."true"@2',
      'global string_constants."false"@3',
    ]);
  });

  it("imports no string_constants namespace on any native-strings lane", async () => {
    for (const options of [{ nativeStrings: true }, { target: "standalone" as const }, { target: "wasi" as const }]) {
      const result = await compile(`export function f(): string { return "hello"; }`, options);
      expect(result.success).toBe(true);
      expect(result.wat).not.toContain('(import "string_constants"');
      expect(result.wat).not.toContain('(import "string_constants16"');
    }
  });

  it("interns a duplicated native literal exactly ONCE", async () => {
    const interned = async (source: string): Promise<string[]> => {
      const result = await compile(source, { target: "standalone" });
      expect(result.success).toBe(true);
      return [...result.wat.matchAll(/\(global \$(__strlit_\d+)/g)].map((match) => match[1]!);
    };
    // `"same"` is returned by two different functions and still interns once,
    // so DUP carries exactly as many literal globals as the single-use ASCII
    // fixture does.
    const single = await interned(`export function f(): string { return "hello"; }`);
    const duplicated = await interned(
      `export function f(): string { return "same"; }\nexport function g(): string { return "same"; }`,
    );
    expect(duplicated).toHaveLength(single.length);
  });

  it("materializes an oversized native literal through a minted helper, not a global", async () => {
    // Past `ARRAY_NEW_FIXED_MAX` the literal is built by a helper function. The
    // manifest is deliberately SILENT about that: no implementation kind can
    // name a function minted per literal, so the frozen row selects the
    // authority and the literal's SIZE still selects the shape.
    const result = await compile(`export function f(): string { return "${"y".repeat(12000)}"; }`, {
      target: "standalone",
    });
    expect(result.success).toBe(true);
    expect([...result.wat.matchAll(/\(global \$(__strlit_\d+)/g)]).toHaveLength(3);
    expect(result.wat).toMatch(/\(func \$__strlit_materialize_\d+/);
  });

  it("answers every hazardous literal shape exactly as JavaScript does", async () => {
    const source = `
export function empty(): string { return ""; }
export function ascii(): string { return "hello"; }
export function bmp(): string { return "grüße→ä"; }
export function pair(): string { return "a\u{1F600}b"; }
export function lone(): string { return "x\uD800y"; }
export function loneLength(): number { return "x\uD800y".length; }
export function long2000(): string { return "${"x".repeat(2000)}"; }
export function sharedA(): string { return "shared"; }
export function sharedB(): string { return "shared"; }
`;
    const result = await compile(source);
    expect(result.success).toBe(true);
    const exports = await instantiate(result);
    expect(exports.empty!()).toBe("");
    expect(exports.ascii!()).toBe("hello");
    expect(exports.bmp!()).toBe("grüße→ä");
    expect(exports.pair!()).toBe("a\u{1F600}b");
    expect(exports.lone!()).toBe("x\uD800y");
    // The lone surrogate is TWO UTF-16 code units plus the two ASCII ones.
    expect(exports.loneLength!()).toBe(3);
    expect(exports.long2000!()).toBe("x".repeat(2000));
    expect(exports.sharedA!()).toBe("shared");
    expect(exports.sharedB!()).toBe(exports.sharedA!());
  });

  it("compiles the same literals on a native-strings lane and on linear", async () => {
    const nativeSource = `
export function empty(): string { return ""; }
export function ascii(): string { return "hello"; }
export function bmp(): string { return "grüße→ä"; }
export function pair(): string { return "a\u{1F600}b"; }
export function lone(): string { return "x\uD800y"; }
export function long2000(): string { return "${"x".repeat(2000)}"; }
`;
    for (const options of [{ nativeStrings: true }, { target: "standalone" as const }]) {
      const result = await compile(nativeSource, options);
      expect(result.success).toBe(true);
      expect(result.binary.length).toBeGreaterThan(0);
    }
    // Linear admits only literals with an ASCII proof — the non-ASCII ones are
    // REJECTED there, and that rejection is a control, not a regression.
    const linear = await compile(
      `export function ascii(): string { return "hello"; }\nexport function empty(): string { return ""; }`,
      { target: "linear" },
    );
    expect(linear.success).toBe(true);
    expect(linear.binary.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// (d) the attachment reads the frozen manifest, and prepareStrings does not
// --------------------------------------------------------------------------

const IR_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/ir");
const INTEGRATION_SOURCE = readFileSync(join(IR_DIR, "integration.ts"), "utf8");

function integrationSlice(startMarker: string, endMarker: string): string {
  const start = INTEGRATION_SOURCE.indexOf(startMarker);
  expect(start, `the ${startMarker} site must exist`).toBeGreaterThan(-1);
  const rest = INTEGRATION_SOURCE.slice(start);
  const end = rest.indexOf(endMarker);
  expect(end, `the ${startMarker} site must be followed by ${endMarker}`).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe("#3526 F2-S8 the attachment reads the frozen manifest", () => {
  const attachSite = () => integrationSlice("function prepareStringConst(", "\nfunction atomicDeferred");

  it("consults the prepared string-const provider, by the ONE derivation", () => {
    const slice = attachSite();
    expect(slice).toContain("preparedStringConstProvider(");
    expect(slice).toContain("stringConstFeatureFor(hasLoneSurrogate(value))");
  });

  it("reads NO lane discriminator", () => {
    // `ctx.nativeStrTypeIdx` survives as a PHYSICAL skip (there is no carrier
    // type to intern into), but the decision itself no longer reads the lane.
    expect(attachSite()).not.toContain("ctx.nativeStrings");
  });

  it("fails closed when the recovered global is not the record's namespace", () => {
    expect(attachSite()).toContain("prepared string.const has no exact ${arm.module} import global");
    expect(attachSite()).toContain('ref.binding.kind !== "import" || ref.binding.module !== arm.module');
  });

  it("attaches through the CONST-only pass, not the omnibus one", () => {
    const slice = attachSite();
    expect(slice).toContain("attachIrStringConstStorage(entry.fn, storageForConst, materializerForConst)");
    expect(slice).not.toContain("attachIrStringSupport(");
  });

  it("has left prepareStrings — that pass decides no literal storage at all", () => {
    const prepareStringsSource = integrationSlice("function prepareStrings(ctx: CodegenContext", "\nfunction prepareVectors(");
    expect(prepareStringsSource).not.toContain("const storageForConst");
    expect(prepareStringsSource).not.toContain("programAbiStringConstantRef");
    expect(prepareStringsSource).toContain("storageForConst: () => undefined");
    // The pre-registration and the literal SCAN stay exactly where they were —
    // this slice moves no registration and no import order.
    expect(prepareStringsSource).toContain("addStringConstantGlobal(ctx, value)");
    expect(prepareStringsSource).toContain("addStringImports(ctx)");
  });

  it("requests the demand at freeze from the same scan the partition runs", () => {
    expect(INTEGRATION_SOURCE).toContain("stringConstDemand: irStringConstDemand(entries.map((entry) => entry.fn))");
    expect(INTEGRATION_SOURCE).toContain("string literal storage has no provider under string-const policy ");
    expect(INTEGRATION_SOURCE).toContain("storage=${stringConstPolicy.storage}");
  });

  it("partitions an unsupported storage policy owner-locally, naming the policy", () => {
    const partition = integrationSlice(
      "const stringConstDemand = irStringConstDemand([entry.fn]);",
      "// (#3526 F1-S2) The boolean boundary",
    );
    expect(partition).toContain('stringConstPolicy.storage === "unsupported"');
    expect(partition).toContain("late-preparation-unsupported");
    expect(partition).toContain("string-const policy");
  });
});

// --------------------------------------------------------------------------
// (e) validation — the two new kinds are policed at both ends
// --------------------------------------------------------------------------

function freezeWithProviders(mutate: (provider: RuntimeProviderDefinition) => RuntimeProviderDefinition) {
  const builder = new RuntimeManifestBuilder(
    { target: "host", backend: "wasmgc", stringConst: HOST_CONST },
    { providers: RUNTIME_PROVIDERS.map(mutate) as never },
  );
  builder.requestFeature("js.string.const");
  return () => builder.freeze();
}

describe("#3526 F2-S8 host-global / native-global validation", () => {
  it("refuses a host-global provider naming a FUNC capability", () => {
    expect(
      freezeWithProviders((provider) =>
        provider.id === "host.js.string.const"
          ? ({
              ...provider,
              implementation: { kind: "host-global", capability: "string.len" },
              hostCapabilities: ["string.len"],
            } as never)
          : provider,
      ),
    ).toThrowError(/host-global provider host\.js\.string\.const names non-global host capability string\.len/);
  });

  it("refuses a host-global provider that does not request its own capability", () => {
    expect(
      freezeWithProviders((provider) =>
        provider.id === "host.js.string.const" ? ({ ...provider, hostCapabilities: [] } as never) : provider,
      ),
    ).toThrowError(
      /host-global provider host\.js\.string\.const does not request its own host capability string\.const/,
    );
  });

  it("refuses a native-global provider that requests a host capability", () => {
    const builder = new RuntimeManifestBuilder(
      { target: "host", backend: "wasmgc", stringConst: NATIVE_CONST },
      {
        providers: RUNTIME_PROVIDERS.map((provider) =>
          provider.id === "native.js.string.const"
            ? ({ ...provider, hostCapabilities: ["string.const"] } as never)
            : provider,
        ) as never,
      },
    );
    builder.requestFeature("js.string.const");
    expect(() => builder.freeze()).toThrowError(
      /native-global provider native\.js\.string\.const cannot request concrete host capabilities/,
    );
  });

  it("refuses an unknown ABI role", () => {
    const builder = new RuntimeManifestBuilder(
      { target: "host", backend: "wasmgc", stringConst: NATIVE_CONST },
      {
        providers: RUNTIME_PROVIDERS.map((provider) =>
          provider.id === "native.js.string.const"
            ? ({ ...provider, implementation: { kind: "native-global", role: "vec" } } as never)
            : provider,
        ) as never,
      },
    );
    builder.requestFeature("js.string.const");
    expect(() => builder.freeze()).toThrowError(
      /native-global provider native\.js\.string\.const names unknown ABI role vec/,
    );
  });

  it("keeps the ABI role closed at the TYPE level too", () => {
    // @ts-expect-error — `role` admits exactly one spelling; a second one is a
    // compile error rather than a lowering-time surprise.
    const bad: RuntimeProviderDefinition["implementation"] = { kind: "native-global", role: "vec" };
    expect(bad).toBeDefined();
  });

  it("STILL refuses a host-callable provider naming a global capability", () => {
    // The F2-S2 refusal is kept, not inverted: giving a global capability a
    // provider is exactly why a SECOND kind exists.
    const builder = new RuntimeManifestBuilder(
      { target: "host", backend: "wasmgc" },
      {
        providers: RUNTIME_PROVIDERS.map((provider) =>
          provider.id === "host.js.number.box"
            ? ({ ...provider, implementation: { kind: "host-callable", capability: "string.const" } } as never)
            : provider,
        ) as never,
      },
    );
    builder.requestFeature("math.sqrt");
    expect(() => builder.freeze()).toThrowError(
      /host-callable provider host\.js\.number\.box names non-callable host capability string\.const/,
    );
  });

  it("refuses a provider whose implementation is not a literal-storage one", () => {
    const prepared = {
      manifest: {
        providers: [
          {
            id: "host.js.string.const",
            feature: "js.string.const",
            implementation: { kind: "host-callable", capability: "string.len" },
          },
        ],
        hostCapabilityRecords: RUNTIME_HOST_CAPABILITY_RECORDS,
      },
    } as never;
    expect(() => preparedStringConstProvider(prepared, "js.string.const")).toThrowError(
      /IR string-const provider host\.js\.string\.const is not a literal-storage implementation/,
    );
  });
});

// --------------------------------------------------------------------------
// (f) the const-only attach pass
// --------------------------------------------------------------------------

const GLOBAL_A: IrGlobalRef = irImportGlobalRef(OWNER, "string_constants", "hello", "__str_1", 1);
const GLOBAL_B: IrGlobalRef = irImportGlobalRef(OWNER, "string_constants", "other", "__str_2", 2);
const NATIVE_GLOBAL: IrGlobalRef = irSupportGlobalRef(OWNER, "native-string-literal", "__strlit_0", 0);
const MATERIALIZER: IrFuncRef = irIntrinsicFuncRef("__ir_string_literal_materialize:0");
const OTHER_MATERIALIZER: IrFuncRef = irIntrinsicFuncRef("__ir_string_literal_materialize:1");

describe("#3526 F2-S8 string.const has ONE attach authority", () => {
  const constOnly = (values: readonly string[]) => constFunction(`attach-${values.join("-")}`, values);

  it("attaches whichever storage the caller supplies, and only when unattached", () => {
    const attached = attachIrStringConstStorage(
      constOnly(["hello"]),
      () => GLOBAL_A,
      () => undefined,
    );
    const instr = instrsOf(attached).find((candidate) => candidate.kind === "string.const")!;
    expect((instr as { storage?: IrGlobalRef }).storage).toEqual(GLOBAL_A);
    // Idempotent: re-running with the SAME binding is a no-op, not a rebind.
    expect(
      attachIrStringConstStorage(
        attached,
        () => GLOBAL_A,
        () => undefined,
      ),
    ).toBe(attached);
  });

  it("attaches a materializer when the arm answers with one", () => {
    const attached = attachIrStringConstStorage(
      constOnly(["oversized"]),
      () => undefined,
      () => MATERIALIZER,
    );
    const instr = instrsOf(attached).find((candidate) => candidate.kind === "string.const")!;
    expect((instr as { materializer?: IrFuncRef }).materializer).toEqual(MATERIALIZER);
  });

  it("refuses both at once, and refuses a DIFFERENT binding", () => {
    expect(() =>
      attachIrStringConstStorage(
        constOnly(["both"]),
        () => GLOBAL_A,
        () => MATERIALIZER,
      ),
    ).toThrowError("IR string.const cannot carry both prepared storage and a materializer");

    const withStorage = attachIrStringConstStorage(
      constOnly(["rebind"]),
      () => GLOBAL_A,
      () => undefined,
    );
    expect(() =>
      attachIrStringConstStorage(
        withStorage,
        () => GLOBAL_B,
        () => undefined,
      ),
    ).toThrowError("IR string.const already carries a different prepared storage binding");
    expect(() =>
      attachIrStringConstStorage(
        withStorage,
        () => undefined,
        () => MATERIALIZER,
      ),
    ).toThrowError("IR string.const storage conflicts with a prepared materializer");

    const withMaterializer = attachIrStringConstStorage(
      constOnly(["remat"]),
      () => undefined,
      () => MATERIALIZER,
    );
    expect(() =>
      attachIrStringConstStorage(
        withMaterializer,
        () => undefined,
        () => OTHER_MATERIALIZER,
      ),
    ).toThrowError("IR string.const already carries a different prepared materializer binding");
    expect(() =>
      attachIrStringConstStorage(
        withMaterializer,
        () => GLOBAL_A,
        () => undefined,
      ),
    ).toThrowError("IR string.const materializer conflicts with prepared storage");
  });

  it("accepts a native support global as readily as an imported one", () => {
    const attached = attachIrStringConstStorage(
      constOnly(["native"]),
      () => NATIVE_GLOBAL,
      () => undefined,
    );
    const instr = instrsOf(attached).find((candidate) => candidate.kind === "string.const")!;
    expect((instr as { storage?: IrGlobalRef }).storage).toEqual(NATIVE_GLOBAL);
  });

  it("touches ONLY string.const — the omnibus pass would re-decide six other seams", () => {
    // The F2-S4 defect, reduced to a unit: `attachIrStringSupport`'s callable
    // arm is unconditional, so a caller settling one seam through it re-derives
    // every other seam's provider. This pass leaves them all alone.
    const repeat: IrInstr = {
      kind: "string.repeat",
      value: asValueId(0),
      count: asValueId(1),
      encodingEvidence: "utf16",
      countedStringAppendTripCount: 4,
      provider: irIntrinsicFuncRef("__ir_string_repeat_counted_native"),
      result: asValueId(2),
      resultType: STRING,
    } as unknown as IrInstr;
    const len: IrInstr = {
      kind: "string.len",
      value: asValueId(2),
      result: asValueId(3),
      resultType: irVal({ kind: "f64" }),
    } as unknown as IrInstr;
    const literal: IrInstr = {
      kind: "string.const",
      value: "tail",
      result: asValueId(4),
      resultType: irVal({ kind: "externref" }),
    } as unknown as IrInstr;
    const fn = {
      unitId: identities.next("mixed").unitId,
      name: "mixed",
      params: [
        { name: "s", type: STRING, value: asValueId(0) },
        { name: "n", type: irVal({ kind: "f64" }), value: asValueId(1) },
      ],
      resultTypes: [STRING],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [repeat, len, literal],
          terminator: { kind: "return", values: [asValueId(4)] },
        },
      ],
      exported: false,
      valueCount: 5,
      funcKind: "regular",
    } as unknown as IrFunction;

    const attached = attachIrStringConstStorage(
      fn,
      () => GLOBAL_A,
      () => undefined,
    );
    const instrs = instrsOf(attached);
    const repeatAfter = instrs.find((candidate) => candidate.kind === "string.repeat")!;
    const lenAfter = instrs.find((candidate) => candidate.kind === "string.len")!;
    const constAfter = instrs.find((candidate) => candidate.kind === "string.const")!;
    // The repeat keeps its counted-native binding and the length keeps having none.
    expect((repeatAfter as { provider?: IrFuncRef }).provider).toEqual(
      irIntrinsicFuncRef("__ir_string_repeat_counted_native"),
    );
    expect((lenAfter as { provider?: unknown }).provider).toBeUndefined();
    expect((constAfter as { storage?: IrGlobalRef }).storage).toEqual(GLOBAL_A);
  });
});
