// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { authenticateIrValidationPolicy, type IrValidationPolicy } from "./ir-validation-policy-evolution.js";

export const irRuntimeProgramPolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-evolution.json";
const receiptSha256 = "8e2589e90fbc697dceba56e1bbe53447250a94f3bcb03d99317ad4878bc1f58c";
const beforeData = "e8d0034c26f59e042da49dfcc4af562436b562421b9e231ae78d664ab70c73e3";
const currentData = "f24c0f10d4e8e9b5dc23471ec327f2fab7312890a5d4db035066e8c189ed2a11";
const edges = "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7";
const program = [
  "src/ir/program/owner.ts",
  "src/ir/program/draft-abi-lookup.ts",
  "src/ir/program/runtime-support-dependencies.ts",
];
const runtime = ["src/ir/runtime/generator-support.ts"];
const additions = [
  ...program.map((path) => ({ path, state: "clean", layer: "ir-program" })),
  ...runtime.map((path) => ({ path, state: "clean", layer: "ir-runtime" })),
];
const activations = [
  { layer: "ir-program", entries: program, minModules: 3 },
  { layer: "ir-runtime", entries: runtime, minModules: 1 },
];
interface Profile {
  source: { bytes: number; sha256: string; gitBlob: string };
  dataSha256: string;
  fileCount: number;
  filesSha256: string;
  activationCount: number;
  activationHistorySha256: string;
  layersSha256: string;
}
export interface IrRuntimeProgramPolicyReceipt {
  schema: number;
  kind: string;
  provenance: {
    reviewedBase: string;
    planSha256: string;
    immutableInputs: { path: string; bytes: number; sha256: string }[];
  };
  before: Profile;
  current: Profile;
  allowedEdgesSha256: string;
  layerDeltas: {
    index: number;
    id: string;
    beforeEntries: number;
    currentEntries: number;
    beforeMinModules: number;
    currentMinModules: number;
    roots: string[];
    additions: string[];
  }[];
  addedFiles: Record<string, string>[];
  activationAdditions: { layer: string; entries: string[]; minModules: number }[];
  census: Record<string, number>;
}
export interface MutableIrRuntimeProgramPolicy {
  layers: {
    id: string;
    status: string;
    required?: boolean;
    roots: string[];
    entries?: string[];
    minModules?: number;
  }[];
  files: Record<string, string>[];
  activationHistory: { layer: string; entries: string[]; minModules: number }[];
  allowedEdges: Record<string, string[]>;
  [key: string]: unknown;
}
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown): string => sha(JSON.stringify(value));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function fail(detail: string): never {
  throw new Error(`runtime program policy evolution: ${detail}`);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Inspect descriptors first; no caller property read or serialization precedes this capture. */
function capture(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== "object" || value === null || active.has(value)) fail("non-JSON or cyclic policy");
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) fail("foreign prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== "string") fail("symbol policy key");
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || (!descriptor.enumerable && !(array && key === "length")))
      fail("accessor or hidden policy field");
  }
  active.add(value);
  try {
    if (array) {
      const length = descriptors.length!.value as number;
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1)
        fail("array holes or extra fields");
      const result: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor) fail("array hole or inherited element");
        result.push(capture(descriptor.value, active));
      }
      return result;
    }
    // defineProperty also preserves a literal __proto__ key as ordinary owned data.
    const result: Record<string, unknown> = {};
    for (const key of keys as string[])
      Object.defineProperty(result, key, {
        value: capture(descriptors[key]!.value, active),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return result;
  } finally {
    active.delete(value);
  }
}

export function authenticateIrRuntimeProgramPolicyEvolution(
  text = readFileSync(new URL(`../../${irRuntimeProgramPolicyReceiptPath}`, import.meta.url), "utf8"),
): IrRuntimeProgramPolicyReceipt {
  if (sha(text) !== receiptSha256) fail("receipt digest mismatch");
  const receipt = JSON.parse(text) as IrRuntimeProgramPolicyReceipt;
  if (
    receipt.schema !== 1 ||
    receipt.kind !== "c1-exact-runtime-program-policy-evolution" ||
    receipt.before.dataSha256 !== beforeData ||
    receipt.current.dataSha256 !== currentData ||
    receipt.before.fileCount !== 1765 ||
    receipt.current.fileCount !== 1769 ||
    receipt.before.activationCount !== 94 ||
    receipt.current.activationCount !== 96 ||
    receipt.allowedEdgesSha256 !== edges ||
    !same(receipt.addedFiles, additions) ||
    !same(receipt.activationAdditions, activations) ||
    !same(
      receipt.layerDeltas.map((d) => [
        d.index,
        d.id,
        d.beforeEntries,
        d.currentEntries,
        d.beforeMinModules,
        d.currentMinModules,
        d.roots,
        d.additions,
      ]),
      [
        [9, "ir-program", 40, 43, 40, 43, ["src/ir/program"], program],
        [8, "ir-runtime", 18, 19, 18, 19, ["src/ir/runtime"], runtime],
      ],
    ) ||
    !same(receipt.census, {
      layers: 20,
      requiredProgram: 43,
      requiredRuntime: 19,
      requiredNative: 98,
      nativeFloor: 97,
      requiredAnalysis: 11,
      requiredCore: 29,
      classifiedProgram: 44,
      classifiedRuntime: 19,
      classifiedNative: 103,
    })
  )
    fail("fixed receipt population mismatch");
  // The unchanged real B guard is part of the authority, not a caller attestation.
  for (const [path, expected] of [
    [
      "tests/helpers/ir-validation-policy-evolution.ts",
      "a962c04960b945705e9ac5a354da3e96c8e0cf5543382847231dd3df9204fb40",
    ],
    [
      "tests/helpers/ir-validation-policy-evolution.json",
      "39dacc9d17fb52b6a369ed81d7498afc30b00bc06d89362bba039305aa96fa0e",
    ],
  ])
    if (sha(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")) !== expected) fail("B authority changed");
  return freeze(receipt);
}
function prove(value: unknown): { current: MutableIrRuntimeProgramPolicy; before: MutableIrRuntimeProgramPolicy } {
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = authenticateIrRuntimeProgramPolicyEvolution();
  if (digest(current) !== currentData) fail("complete current policy mismatch");
  if (
    current.files.length !== 1769 ||
    current.activationHistory.length !== 96 ||
    current.layers.length !== 20 ||
    digest(current.files) !== receipt.current.filesSha256 ||
    digest(current.activationHistory) !== receipt.current.activationHistorySha256 ||
    digest(current.layers) !== receipt.current.layersSha256 ||
    digest(current.allowedEdges) !== edges ||
    digest(current.files.slice(0, 1765)) !== receipt.before.filesSha256 ||
    digest(current.activationHistory.slice(0, 94)) !== receipt.before.activationHistorySha256 ||
    !same(current.files.slice(1765), additions) ||
    !same(current.activationHistory.slice(94), activations)
  )
    fail("current inventory or suffix mismatch");
  for (const [id, required, floor, classified] of [
    ["ir-program", 43, 43, 44],
    ["ir-runtime", 19, 19, 19],
    ["native-runtime", 98, 97, 103],
    ["ir-analysis", 11, 11, 11],
    ["ir-core", 29, 29, 29],
  ] as const) {
    const rows = current.layers.filter((row) => row.id === id);
    if (
      rows.length !== 1 ||
      rows[0]!.entries?.length !== required ||
      rows[0]!.minModules !== floor ||
      current.files.filter((row) => row.layer === id).length !== classified
    )
      fail("independent layer census mismatch");
  }
  const before = capture(current) as MutableIrRuntimeProgramPolicy;
  before.files.length = 1765;
  before.activationHistory.length = 94;
  for (const delta of receipt.layerDeltas) {
    const row = before.layers[delta.index]!;
    if (
      row.id !== delta.id ||
      row.status !== "active" ||
      row.required !== true ||
      !same(row.roots, delta.roots) ||
      row.entries?.length !== delta.currentEntries ||
      row.minModules !== delta.currentMinModules ||
      !same(row.entries.slice(delta.beforeEntries), delta.additions)
    )
      fail("layer delta mismatch");
    row.entries.length = delta.beforeEntries;
    row.minModules = delta.beforeMinModules;
  }
  if (digest(before.layers) !== receipt.before.layersSha256 || digest(before) !== beforeData)
    fail("complete B inverse mismatch");
  const verified = authenticateIrValidationPolicy(before);
  const replay = capture(verified) as MutableIrRuntimeProgramPolicy;
  replay.files.push(...(capture(additions) as Record<string, string>[]));
  replay.activationHistory.push(...(capture(activations) as MutableIrRuntimeProgramPolicy["activationHistory"]));
  for (const delta of receipt.layerDeltas) {
    replay.layers[delta.index]!.entries!.push(...delta.additions);
    replay.layers[delta.index]!.minModules = delta.currentMinModules;
  }
  if (!same(replay, current) || digest(replay) !== currentData) fail("complete reciprocal replay mismatch");
  return { current, before };
}
/** A newly owned, deeply frozen current snapshot; no identity-based acceptance cache. */
export function authenticateIrRuntimeProgramPolicy(value: unknown): IrValidationPolicy {
  return freeze(prove(value).current) as IrValidationPolicy;
}
/** A fresh mutable B copy for unchanged old mutation detectors, derived only from actual C1. */
export function beforeIrRuntimeProgramPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return prove(value).before;
}

// WKS successor proof is intentionally appended after the complete immutable C1 helper.
export const wellKnownSymbolPolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-well-known-symbols.json";
const wksReceiptSha256 = "5b28556311bb1548e3fb399fc8dee458fcec60f0d5366714e6298af123b73a61";
const wksData = "462b8a9a6047378eed5913e51441761734663ff8c53cbb804106368ff1a33be7";
const wksPrefix = { bytes: 10742, sha256: "2636bd52d821cbc1a7aaff425a03d1ea56fe29b584db5925d6ef099a893f5f3d" };
const wksContract = "src/runtime/contracts/well-known-symbols.ts";
const wksOwner = "src/backend/wasmgc/resources/native-well-known-symbols.ts";
const wksFiles = [
  { path: wksContract, state: "clean", layer: "runtime-contracts" },
  { path: wksOwner, state: "clean", layer: "backend-wasmgc" },
];
const wksActivations = [
  { layer: "runtime-contracts", entries: [wksContract], minModules: 1 },
  { layer: "backend-wasmgc", entries: [wksOwner], minModules: 1 },
];
const wksLayerDeltas = [
  {
    index: 10,
    id: "runtime-contracts",
    beforeEntries: 9,
    currentEntries: 10,
    beforeMinModules: 9,
    currentMinModules: 10,
    roots: ["src/runtime/contracts"],
    additions: [wksContract],
  },
  {
    index: 11,
    id: "backend-wasmgc",
    beforeEntries: 49,
    currentEntries: 50,
    beforeMinModules: 49,
    currentMinModules: 50,
    roots: ["src/backend/wasmgc"],
    additions: [wksOwner],
  },
];
const wksTopKeys = [
  "schema",
  "description",
  "sourceRoot",
  "tsconfig",
  "requireGitProvenance",
  "externalAssets",
  "frontendWrapper",
  "moduleExtensions",
  "layers",
  "allowedEdges",
  "externalPackages",
  "activationHistory",
  "nonModules",
  "moves",
  "evidence",
  "files",
];
const wksCensus = {
  layers: 20,
  files: 1771,
  histories: 98,
  requiredContracts: 10,
  contractsFloor: 10,
  classifiedContracts: 10,
  requiredBackend: 50,
  backendFloor: 50,
  classifiedBackend: 55,
  requiredProgram: 43,
  classifiedProgram: 44,
  requiredRuntime: 19,
  classifiedRuntime: 19,
  requiredNative: 98,
  nativeFloor: 97,
  classifiedNative: 103,
  requiredAnalysis: 11,
  requiredCore: 29,
};
export interface WellKnownSymbolPolicyReceipt extends IrRuntimeProgramPolicyReceipt {
  provenance: IrRuntimeProgramPolicyReceipt["provenance"] & { c1HelperPrefix: { bytes: number; sha256: string } };
  raw: {
    offsetUnit: "utf16-code-unit";
    spans: { role: string; beforeOffset: number; afterOffset: number; before: string; after: string }[];
  };
}
function wksFail(detail: string): never {
  throw new Error("well-known symbol policy evolution: " + detail);
}

/** One fixed root-authored receipt; alternate text is only a negative-test input. */
export function authenticateWellKnownSymbolPolicyEvolution(
  text = readFileSync(new URL(`../../${wellKnownSymbolPolicyReceiptPath}`, import.meta.url), "utf8"),
): WellKnownSymbolPolicyReceipt {
  if (typeof text !== "string" || sha(text) !== wksReceiptSha256) wksFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as WellKnownSymbolPolicyReceipt;
  const c1 = authenticateIrRuntimeProgramPolicyEvolution();
  if (
    !same(Object.keys(receipt), [
      "schema",
      "kind",
      "provenance",
      "before",
      "current",
      "allowedEdgesSha256",
      "layerDeltas",
      "addedFiles",
      "activationAdditions",
      "census",
      "raw",
    ]) ||
    receipt.schema !== 1 ||
    receipt.kind !== "wks-exact-runtime-program-policy-successor" ||
    receipt.provenance.reviewedBase !== "c7366c3c6d3eb9e4c5cff0b29b11c42e3faab4c7" ||
    receipt.provenance.planSha256 !== "803f3fcc5af93344f878b33dace6c9484d2d4aa1437e9537548c899f4204753c" ||
    !same(receipt.provenance.c1HelperPrefix, wksPrefix) ||
    !same(receipt.before, c1.current) ||
    receipt.current.dataSha256 !== wksData ||
    receipt.current.fileCount !== 1771 ||
    receipt.current.activationCount !== 98 ||
    receipt.allowedEdgesSha256 !== edges ||
    !same(receipt.layerDeltas, wksLayerDeltas) ||
    !same(receipt.addedFiles, wksFiles) ||
    !same(receipt.activationAdditions, wksActivations) ||
    !same(receipt.census, wksCensus)
  )
    wksFail("fixed receipt population mismatch");
  const expectedInputs = [
    { path: irRuntimeProgramPolicyReceiptPath, bytes: 6804, sha256: receiptSha256 },
    ...c1.provenance.immutableInputs,
  ];
  if (
    expectedInputs.length !== 19 ||
    new Set(expectedInputs.map((pin) => pin.path)).size !== 19 ||
    !same(receipt.provenance.immutableInputs, expectedInputs)
  )
    wksFail("immutable input membership mismatch");
  for (const pin of receipt.provenance.immutableInputs) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      wksFail("immutable input changed: " + pin.path);
  }
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  if (
    helper.length < wksPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, wksPrefix.bytes)).digest("hex") !== wksPrefix.sha256
  )
    wksFail("original C1 helper prefix changed");
  const roles = ["runtime-contracts-layer-tail", "backend-wasmgc-layer-tail", "activation-history-tail", "files-tail"];
  const starts = [
    '"src/runtime/contracts/native-realm-catalog.ts"',
    '"src/backend/wasmgc/resources/native-mixed-object-access.ts"',
    '    {\n      "layer": "ir-runtime",\n      "entries": ["src/ir/runtime/generator-support.ts"],\n      "minModules": 1\n    }',
    '    {\n      "path": "src/ir/runtime/generator-support.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    }',
  ];
  const beforeEnds = ['"minModules": 9', '"minModules": 49', '"nonModules"', "  ]\n}\n"];
  const afterEnds = ['"minModules": 10', '"minModules": 50', '"nonModules"', "  ]\n}\n"];
  if (receipt.raw.offsetUnit !== "utf16-code-unit" || receipt.raw.spans.length !== 4) wksFail("raw span population");
  let beforeEnd = -1,
    afterEnd = -1,
    displacement = 0;
  receipt.raw.spans.forEach((span, index) => {
    if (
      span.role !== roles[index] ||
      !Number.isSafeInteger(span.beforeOffset) ||
      !Number.isSafeInteger(span.afterOffset) ||
      span.beforeOffset <= beforeEnd ||
      span.afterOffset <= afterEnd ||
      span.afterOffset !== span.beforeOffset + displacement ||
      !span.before ||
      !span.after ||
      !span.before.startsWith(starts[index]!) ||
      !span.after.startsWith(starts[index]!) ||
      !span.before.endsWith(beforeEnds[index]!) ||
      !span.after.endsWith(afterEnds[index]!)
    )
      wksFail("raw span anchors or order");
    beforeEnd = span.beforeOffset + span.before.length;
    afterEnd = span.afterOffset + span.after.length;
    displacement += span.after.length - span.before.length;
  });
  return freeze(receipt);
}

function wksSemanticProfile(policy: MutableIrRuntimeProgramPolicy, profile: Profile): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256
  )
    wksFail("complete policy profile mismatch");
}
function proveWellKnownSymbolPolicy(value: unknown): {
  current: MutableIrRuntimeProgramPolicy;
  before: MutableIrRuntimeProgramPolicy;
} {
  // The old private capture rejects descriptors/non-JSON data before any serialization or borrowed field read.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = authenticateWellKnownSymbolPolicyEvolution();
  wksSemanticProfile(current, receipt.current);
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    digest(current.allowedEdges) !== edges ||
    digest(current.files.slice(0, 1769)) !== receipt.before.filesSha256 ||
    digest(current.activationHistory.slice(0, 96)) !== receipt.before.activationHistorySha256 ||
    !same(current.files.slice(1769), wksFiles) ||
    !same(current.activationHistory.slice(96), wksActivations)
  )
    wksFail("ordered current prefix or suffix mismatch");
  for (const [id, entries, floor, classified] of [
    ["runtime-contracts", 10, 10, 10],
    ["backend-wasmgc", 50, 50, 55],
    ["ir-program", 43, 43, 44],
    ["ir-runtime", 19, 19, 19],
    ["native-runtime", 98, 97, 103],
    ["ir-analysis", 11, 11, 11],
    ["ir-core", 29, 29, 29],
  ] as const) {
    const rows = current.layers.filter((row) => row.id === id);
    if (
      rows.length !== 1 ||
      rows[0]!.entries?.length !== entries ||
      rows[0]!.minModules !== floor ||
      current.files.filter((row) => row.layer === id).length !== classified
    )
      wksFail("independent layer census mismatch");
  }
  const before = capture(current) as MutableIrRuntimeProgramPolicy;
  before.files.length = 1769;
  before.activationHistory.length = 96;
  for (const delta of wksLayerDeltas) {
    const layer = before.layers[delta.index]!;
    if (
      layer.id !== delta.id ||
      layer.status !== "active" ||
      layer.required !== true ||
      !same(layer.roots, delta.roots) ||
      layer.entries?.length !== delta.currentEntries ||
      layer.minModules !== delta.currentMinModules ||
      !same(layer.entries.slice(delta.beforeEntries), delta.additions)
    )
      wksFail("exact layer delta mismatch");
    layer.entries.length = delta.beforeEntries;
    layer.minModules = delta.beforeMinModules;
  }
  wksSemanticProfile(before, receipt.before);
  const genuineC1 = authenticateIrRuntimeProgramPolicy(before); // This unchanged guard really derives/authenticates B.
  const replay = capture(genuineC1) as MutableIrRuntimeProgramPolicy;
  replay.files.push(...(capture(wksFiles) as MutableIrRuntimeProgramPolicy["files"]));
  replay.activationHistory.push(...(capture(wksActivations) as MutableIrRuntimeProgramPolicy["activationHistory"]));
  for (const delta of wksLayerDeltas) {
    replay.layers[delta.index]!.entries!.push(...delta.additions);
    replay.layers[delta.index]!.minModules = delta.currentMinModules;
  }
  wksSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) wksFail("complete independent reciprocal replay mismatch");
  return { current, before };
}
/** Fresh detached deeply frozen actual WKS current data; no cached completion authority. */
export function authenticateWellKnownSymbolPolicy(value: unknown): IrValidationPolicy {
  return freeze(proveWellKnownSymbolPolicy(value).current) as IrValidationPolicy;
}
/** Fresh mutable exact C1 data for the unchanged predecessor mutation controls. */
export function beforeWellKnownSymbolPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveWellKnownSymbolPolicy(value).before;
}
function wksRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw, "utf8");
  const blob = createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex");
  if (bytes !== profile.source.bytes || sha(raw) !== profile.source.sha256 || blob !== profile.source.gitBlob)
    wksFail("complete raw source profile mismatch");
}
/** Fixed offsets always address the original input; slices never drift after an earlier replacement. */
function applyWellKnownSymbolRaw(raw: string, receipt: WellKnownSymbolPolicyReceipt, forward: boolean): string {
  wksRawProfile(raw, forward ? receipt.before : receipt.current);
  let end = 0;
  const pieces: string[] = [];
  for (const span of receipt.raw.spans) {
    const offset = forward ? span.beforeOffset : span.afterOffset;
    const from = forward ? span.before : span.after;
    const to = forward ? span.after : span.before;
    if (
      offset < end ||
      raw.slice(offset, offset + from.length) !== from ||
      raw.indexOf(from) !== offset ||
      raw.lastIndexOf(from) !== offset
    )
      wksFail("raw fragment missing, duplicated or reordered");
    pieces.push(raw.slice(end, offset), to);
    end = offset + from.length;
  }
  pieces.push(raw.slice(end));
  const output = pieces.join("");
  wksRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** Exact current raw -> exact C1 raw, cross-checked against the genuine semantic inverse and reciprocal replay. */
export function beforeWellKnownSymbolPolicySource(raw: string): string {
  if (typeof raw !== "string") wksFail("raw input must be a primitive string");
  const receipt = authenticateWellKnownSymbolPolicyEvolution();
  const before = applyWellKnownSymbolRaw(raw, receipt, false);
  const semantic = proveWellKnownSymbolPolicy(JSON.parse(raw));
  const parsedBefore = JSON.parse(before) as MutableIrRuntimeProgramPolicy;
  wksSemanticProfile(parsedBefore, receipt.before);
  authenticateIrRuntimeProgramPolicy(parsedBefore);
  if (!same(parsedBefore, semantic.before) || applyWellKnownSymbolRaw(before, receipt, true) !== raw)
    wksFail("raw and semantic reciprocal proof disagree");
  return before;
}

// Number prerequisites are a fixed successor; the complete C1 and WKS helpers above remain immutable.
export const numberPrerequisitePolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-number-prerequisites.json";
const numberReceiptSha256 = "92c0539b00d3b8ba5bb58951c1612f62fa334627f2b928e6ff1485ae9cd25845";
const numberPrefix = {
  bytes: 23854,
  sha256: "fe575facb2aedc750760ba302ded54ab37ac223ff70e0d07f25faa804de84474",
};
const numberBeforeProfile = {
  source: {
    bytes: 565875,
    sha256: "451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59",
    gitBlob: "74dc1b073145713d122e28a0b45f34c0cc41a066",
  },
  dataSha256: "462b8a9a6047378eed5913e51441761734663ff8c53cbb804106368ff1a33be7",
  fileCount: 1771,
  filesSha256: "fb09eb31db052006e682dbad6dd421488a7ccc1093169ca18779e33a80ec929d",
  activationCount: 98,
  activationHistorySha256: "66367385757ebdd22d24656c46f0317f97aaf4b104a431e94c4b566753b53eac",
  layersSha256: "091f25a5fee65a0185b62916ecbdd60afabd96409fa914cf02cb17616a1f0d7c",
};
const numberCurrentProfile = {
  source: {
    bytes: 567166,
    sha256: "8213f6d2d3bf112544ca2aa50b68e585f4ba2c1f9795acc240c9e8495712e7df",
    gitBlob: "0d90f336925232fd22c98c438121b93e7e5bcf52",
  },
  dataSha256: "5dea4a676b8ddbc6fc50c7c77446e799ee4db12f4113c1fdf4edff33de848b21",
  fileCount: 1775,
  filesSha256: "82448a8b5bf6373b7ef203924f3ac4f0d33e69ca1df77b322812b63613fe8bec",
  activationCount: 100,
  activationHistorySha256: "f6716a46656b3e4e7292e6d6c2cfdb5681becc9fb0e688ebad01a49c48d044ab",
  layersSha256: "ab456c917964e4e4d51c7110ce854e8c8648827a72eb4e6e61e2d74dc7f08a05",
};
const numberSourceInputs = [
  {
    path: "src/runtime/wasmgc/values/bigint-to-number-body.ts",
    bytes: 9195,
    sha256: "a698e80ad9054d7dd66ed33e17798b339b3ae2c16c7b9efdd004394d52e91d80",
  },
  {
    path: "src/runtime/wasmgc/values/number-from-value-body.ts",
    bytes: 9609,
    sha256: "00376356e12a0d70976addeff7911b1ec5401375b1f4eb0d7c81450568c20b59",
  },
  {
    path: "src/backend/wasmgc/resources/native-bigint-number.ts",
    bytes: 15683,
    sha256: "ccc1c66d4fc734339cc9a192dc29f24d08483fb7a559b777a903a622b64c3cc6",
  },
  {
    path: "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
    bytes: 21040,
    sha256: "210c30e3f2928952ebfceeafb8f6545930054b0c5ed9c1ec66ca2afcc41e7161",
  },
  {
    path: "tests/issue-3518-bigint-to-number-body.test.ts",
    bytes: 11598,
    sha256: "f80b9fe1701a8f289a458a5032d3d4bd0af4910d723eabe343476b4814c3f130",
  },
  {
    path: "tests/issue-3518-native-bigint-number-owner.test.ts",
    bytes: 29455,
    sha256: "b266965df90630f184a136f07c6867f99b59507f1ee11f0ca141c047e6b8f621",
  },
  {
    path: "tests/issue-3518-native-number-primitive-classifier.test.ts",
    bytes: 43687,
    sha256: "45ad86969dd28b1597eef4e8e0a53531ea4f3dc54e90e2784ca6cb01baec626d",
  },
  {
    path: "tests/issue-3518-number-from-value-body.test.ts",
    bytes: 36900,
    sha256: "2abc9c96ebd7fcda5547c8f093530d08d56796b4ab4b636b64a4d3b0ff5ae969",
  },
];
const numberLayerDeltas = [
  {
    index: 11,
    id: "backend-wasmgc",
    beforeEntries: 50,
    currentEntries: 52,
    beforeMinModules: 50,
    currentMinModules: 52,
    roots: ["src/backend/wasmgc"],
    additions: [
      "src/backend/wasmgc/resources/native-bigint-number.ts",
      "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
    ],
  },
  {
    index: 12,
    id: "native-runtime",
    beforeEntries: 98,
    currentEntries: 100,
    beforeMinModules: 97,
    currentMinModules: 99,
    roots: ["src/runtime/wasmgc"],
    additions: [
      "src/runtime/wasmgc/values/bigint-to-number-body.ts",
      "src/runtime/wasmgc/values/number-from-value-body.ts",
    ],
  },
];
const numberFiles = [
  {
    path: "src/runtime/wasmgc/values/bigint-to-number-body.ts",
    state: "clean",
    layer: "native-runtime",
  },
  {
    path: "src/runtime/wasmgc/values/number-from-value-body.ts",
    state: "clean",
    layer: "native-runtime",
  },
  {
    path: "src/backend/wasmgc/resources/native-bigint-number.ts",
    state: "clean",
    layer: "backend-wasmgc",
  },
  {
    path: "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
    state: "clean",
    layer: "backend-wasmgc",
  },
];
const numberActivations = [
  {
    layer: "native-runtime",
    entries: [
      "src/runtime/wasmgc/values/bigint-to-number-body.ts",
      "src/runtime/wasmgc/values/number-from-value-body.ts",
    ],
    minModules: 2,
  },
  {
    layer: "backend-wasmgc",
    entries: [
      "src/backend/wasmgc/resources/native-bigint-number.ts",
      "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
    ],
    minModules: 2,
  },
];
const numberCensus = {
  layers: 20,
  files: 1775,
  histories: 100,
  requiredContracts: 10,
  contractsFloor: 10,
  classifiedContracts: 10,
  requiredBackend: 52,
  backendFloor: 52,
  classifiedBackend: 57,
  requiredProgram: 43,
  classifiedProgram: 44,
  requiredRuntime: 19,
  classifiedRuntime: 19,
  requiredNative: 100,
  nativeFloor: 99,
  classifiedNative: 105,
  requiredAnalysis: 11,
  requiredCore: 29,
};
export interface NumberPrerequisitePolicyReceipt extends IrRuntimeProgramPolicyReceipt {
  provenance: IrRuntimeProgramPolicyReceipt["provenance"] & {
    wksHelperPrefix: { bytes: number; sha256: string };
    sourceInputs: { path: string; bytes: number; sha256: string }[];
  };
  raw: WellKnownSymbolPolicyReceipt["raw"];
}
function numberFail(detail: string): never {
  throw new Error("Number prerequisite policy evolution: " + detail);
}
/** Fresh authority and all 28 complete files are checked on every public action. */
export function authenticateNumberPrerequisitePolicyEvolution(
  text = readFileSync(new URL(`../../${numberPrerequisitePolicyReceiptPath}`, import.meta.url), "utf8"),
): NumberPrerequisitePolicyReceipt {
  if (typeof text !== "string" || sha(text) !== numberReceiptSha256) numberFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as NumberPrerequisitePolicyReceipt;
  const wks = authenticateWellKnownSymbolPolicyEvolution();
  const expectedInputs = [
    { path: wellKnownSymbolPolicyReceiptPath, bytes: 9470, sha256: wksReceiptSha256 },
    ...wks.provenance.immutableInputs,
  ];
  if (
    !same(Object.keys(receipt), [
      "schema",
      "kind",
      "provenance",
      "before",
      "current",
      "allowedEdgesSha256",
      "layerDeltas",
      "addedFiles",
      "activationAdditions",
      "census",
      "raw",
    ]) ||
    receipt.schema !== 1 ||
    receipt.kind !== "number-prerequisites-exact-runtime-program-policy-successor" ||
    receipt.provenance.reviewedBase !== "345616935e6ad070f1c39f9eb360131241acbbae" ||
    receipt.provenance.planSha256 !== "ba0fa7a97e9bdb4971bda4b7fffe50fc83976bc2b49b5b77127c0931b1865c3b" ||
    !same(receipt.provenance.wksHelperPrefix, numberPrefix) ||
    !same(receipt.before, wks.current) ||
    !same(receipt.before, numberBeforeProfile) ||
    !same(receipt.current, numberCurrentProfile) ||
    receipt.allowedEdgesSha256 !== edges ||
    !same(receipt.layerDeltas, numberLayerDeltas) ||
    !same(receipt.addedFiles, numberFiles) ||
    !same(receipt.activationAdditions, numberActivations) ||
    !same(receipt.census, numberCensus)
  )
    numberFail("fixed receipt population mismatch");
  const pins = [...expectedInputs, ...numberSourceInputs];
  if (
    expectedInputs.length !== 20 ||
    pins.length !== 28 ||
    new Set(pins.map((pin) => pin.path)).size !== 28 ||
    !same(receipt.provenance.immutableInputs, expectedInputs) ||
    !same(receipt.provenance.sourceInputs, numberSourceInputs)
  )
    numberFail("fixed full-file input membership mismatch");
  for (const pin of pins) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      numberFail("full-file input changed: " + pin.path);
  }
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  if (
    helper.length < numberPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, numberPrefix.bytes)).digest("hex") !== numberPrefix.sha256
  )
    numberFail("original WKS helper prefix changed");
  const roles = ["backend-wasmgc-layer-tail", "native-runtime-layer-tail", "activation-history-tail", "files-tail"];
  const starts = [
    '"src/backend/wasmgc/resources/native-well-known-symbols.ts"',
    '"src/runtime/wasmgc/values/mixed-object-access-bodies.ts"',
    '    {\n      "layer": "backend-wasmgc",\n      "entries": ["src/backend/wasmgc/resources/native-well-known-symbols.ts"],\n      "minModules": 1\n    }',
    '    {\n      "path": "src/backend/wasmgc/resources/native-well-known-symbols.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    }',
  ];
  const beforeEnds = ['"minModules": 50', '"minModules": 97', '"nonModules"', "  ]\n}\n"];
  const afterEnds = ['"minModules": 52', '"minModules": 99', '"nonModules"', "  ]\n}\n"];
  const offsets = [
    [12886, 12886],
    [19261, 19403],
    [65258, 65525],
    [565726, 566450],
  ];
  if (receipt.raw.offsetUnit !== "utf16-code-unit" || receipt.raw.spans.length !== 4) numberFail("raw span population");
  let beforeEnd = -1,
    afterEnd = -1,
    displacement = 0;
  receipt.raw.spans.forEach((span, index) => {
    if (
      span.role !== roles[index] ||
      !Number.isSafeInteger(span.beforeOffset) ||
      !Number.isSafeInteger(span.afterOffset) ||
      !same([span.beforeOffset, span.afterOffset], offsets[index]) ||
      span.beforeOffset <= beforeEnd ||
      span.afterOffset <= afterEnd ||
      span.afterOffset !== span.beforeOffset + displacement ||
      !span.before ||
      !span.after ||
      !span.before.startsWith(starts[index]!) ||
      !span.after.startsWith(starts[index]!) ||
      !span.before.endsWith(beforeEnds[index]!) ||
      !span.after.endsWith(afterEnds[index]!)
    )
      numberFail("raw span anchors or order");
    beforeEnd = span.beforeOffset + span.before.length;
    afterEnd = span.afterOffset + span.after.length;
    displacement += span.after.length - span.before.length;
  });
  return freeze(receipt);
}
function numberSemanticProfile(policy: MutableIrRuntimeProgramPolicy, profile: Profile): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256
  )
    numberFail("complete policy profile mismatch");
}
function proveNumberPrerequisitePolicy(
  value: unknown,
  freshlyVerifiedReceipt?: NumberPrerequisitePolicyReceipt,
): {
  current: MutableIrRuntimeProgramPolicy;
  before: MutableIrRuntimeProgramPolicy;
} {
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateNumberPrerequisitePolicyEvolution();
  numberSemanticProfile(current, numberCurrentProfile);
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    digest(current.allowedEdges) !== edges ||
    digest(current.files.slice(0, 1771)) !== numberBeforeProfile.filesSha256 ||
    digest(current.activationHistory.slice(0, 98)) !== numberBeforeProfile.activationHistorySha256 ||
    !same(current.files.slice(1771), numberFiles) ||
    !same(current.activationHistory.slice(98), numberActivations)
  )
    numberFail("ordered current prefix or suffix mismatch");
  for (const [id, entries, floor, classified] of [
    ["runtime-contracts", 10, 10, 10],
    ["backend-wasmgc", 52, 52, 57],
    ["ir-program", 43, 43, 44],
    ["ir-runtime", 19, 19, 19],
    ["native-runtime", 100, 99, 105],
    ["ir-analysis", 11, 11, 11],
    ["ir-core", 29, 29, 29],
  ] as const) {
    const rows = current.layers.filter((row) => row.id === id);
    if (
      rows.length !== 1 ||
      rows[0]!.entries?.length !== entries ||
      rows[0]!.minModules !== floor ||
      current.files.filter((row) => row.layer === id).length !== classified
    )
      numberFail("independent layer census mismatch");
  }
  const before = capture(current) as MutableIrRuntimeProgramPolicy;
  before.files.length = 1771;
  before.activationHistory.length = 98;
  for (const delta of numberLayerDeltas) {
    const layer = before.layers[delta.index]!;
    if (
      layer.id !== delta.id ||
      layer.status !== "active" ||
      layer.required !== true ||
      !same(layer.roots, delta.roots) ||
      layer.entries?.length !== delta.currentEntries ||
      layer.minModules !== delta.currentMinModules ||
      !same(layer.entries.slice(delta.beforeEntries), delta.additions)
    )
      numberFail("exact layer delta mismatch");
    layer.entries.length = delta.beforeEntries;
    layer.minModules = delta.beforeMinModules;
  }
  numberSemanticProfile(before, receipt.before);
  // This unchanged guard independently derives C1 and B from the real WKS predecessor.
  const verifiedWks = authenticateWellKnownSymbolPolicy(before);
  const replay = capture(verifiedWks) as MutableIrRuntimeProgramPolicy;
  replay.files.push(...(capture(numberFiles) as MutableIrRuntimeProgramPolicy["files"]));
  replay.activationHistory.push(...(capture(numberActivations) as MutableIrRuntimeProgramPolicy["activationHistory"]));
  for (const delta of numberLayerDeltas) {
    replay.layers[delta.index]!.entries!.push(...delta.additions);
    replay.layers[delta.index]!.minModules = delta.currentMinModules;
  }
  numberSemanticProfile(replay, numberCurrentProfile);
  if (!same(replay, current)) numberFail("complete independent reciprocal replay mismatch");
  return { current, before };
}
/** Fresh detached deeply frozen Number current, with no successful-object cache. */
export function authenticateNumberPrerequisitePolicy(value: unknown): IrValidationPolicy {
  return freeze(proveNumberPrerequisitePolicy(value).current) as IrValidationPolicy;
}
/** Fresh mutable WKS derived only from actual Number current. */
export function beforeNumberPrerequisitePolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveNumberPrerequisitePolicy(value).before;
}
function numberRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw, "utf8");
  const blob = createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex");
  if (bytes !== profile.source.bytes || sha(raw) !== profile.source.sha256 || blob !== profile.source.gitBlob)
    numberFail("complete raw source profile mismatch");
}
function applyNumberPrerequisiteRaw(raw: string, receipt: NumberPrerequisitePolicyReceipt, forward: boolean): string {
  numberRawProfile(raw, forward ? receipt.before : receipt.current);
  let end = 0;
  const pieces: string[] = [];
  for (const span of receipt.raw.spans) {
    const offset = forward ? span.beforeOffset : span.afterOffset;
    const from = forward ? span.before : span.after;
    const to = forward ? span.after : span.before;
    if (
      offset < end ||
      raw.slice(offset, offset + from.length) !== from ||
      raw.indexOf(from) !== offset ||
      raw.lastIndexOf(from) !== offset
    )
      numberFail("raw fragment missing, duplicated or reordered");
    pieces.push(raw.slice(end, offset), to);
    end = offset + from.length;
  }
  pieces.push(raw.slice(end));
  const output = pieces.join("");
  numberRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** Reconstruct actual WKS bytes, compare semantic inverse, and exercise the unchanged WKS raw inverse. */
export function beforeNumberPrerequisitePolicySource(raw: string): string {
  if (typeof raw !== "string") numberFail("raw input must be a primitive string");
  const receipt = authenticateNumberPrerequisitePolicyEvolution();
  const before = applyNumberPrerequisiteRaw(raw, receipt, false);
  const semantic = proveNumberPrerequisitePolicy(JSON.parse(raw), receipt);
  const parsedBefore = JSON.parse(before) as MutableIrRuntimeProgramPolicy;
  numberSemanticProfile(parsedBefore, receipt.before);
  beforeWellKnownSymbolPolicySource(before);
  if (!same(parsedBefore, semantic.before) || applyNumberPrerequisiteRaw(before, receipt, true) !== raw)
    numberFail("raw and semantic reciprocal proof disagree");
  return before;
}

// C2a: one fixed runtime-preparation successor; historical guards above are unchanged.
export const runtimePreparationPolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-runtime-preparation.json";
const preparationReceiptSha256 = "3ebfca62d268ca5bcc8b1c461ef6e71b55bd513a5649bf6bce3fe6ee689032ca";
const preparationBeforeProfile = {
  source: {
    bytes: 567166,
    sha256: "8213f6d2d3bf112544ca2aa50b68e585f4ba2c1f9795acc240c9e8495712e7df",
    gitBlob: "0d90f336925232fd22c98c438121b93e7e5bcf52",
  },
  dataSha256: "5dea4a676b8ddbc6fc50c7c77446e799ee4db12f4113c1fdf4edff33de848b21",
  fileCount: 1775,
  filesSha256: "82448a8b5bf6373b7ef203924f3ac4f0d33e69ca1df77b322812b63613fe8bec",
  activationCount: 100,
  activationHistorySha256: "f6716a46656b3e4e7292e6d6c2cfdb5681becc9fb0e688ebad01a49c48d044ab",
  layersSha256: "ab456c917964e4e4d51c7110ce854e8c8648827a72eb4e6e61e2d74dc7f08a05",
};
const preparationCurrentProfile = {
  source: {
    bytes: 567465,
    sha256: "92d653aff02d823339071f24721b803d88da4f31bdbd721859b0ac48b6c9c7f7",
    gitBlob: "70b280c7cf2a56cbd5cbfa88b484b57414d2ef7c",
  },
  dataSha256: "28ae111b7b9f0f6eda144d5d57beaf76fd5c7617b474846d39409a56cc196e08",
  fileCount: 1776,
  filesSha256: "ca4d9d7d5c999a4e742abd7773d847f1652ca8fe995a491a594fca1e5cf37a1a",
  activationCount: 101,
  activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
  layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
};
const preparationPrefix = {
  bytes: 40368,
  sha256: "2b6358379b9f9145b54a5287b6a74f61a89ef9deff215ce6fb21a2174ee1845e",
};
const preparationNumberReceipt = {
  path: "tests/helpers/ir-runtime-program-policy-number-prerequisites.json",
  bytes: 12726,
  sha256: "92c0539b00d3b8ba5bb58951c1612f62fa334627f2b928e6ff1485ae9cd25845",
};
const preparationSourceInputs = [
  {
    path: "src/ir/intrinsic-support.ts",
    bytes: 850,
    sha256: "584322a7384556a6f3b82dc85cc30c2213510fe70f2cd437ccbef97826156351",
  },
  {
    path: "src/ir/runtime/intrinsic-preparation.ts",
    bytes: 49541,
    sha256: "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",
  },
  {
    path: "tests/helpers/ir-runtime-preparation-relocation.json",
    bytes: 19505,
    sha256: "226efc69784e601980b4285fb0e562aed23f225be4d8735c233ecc6070000458",
  },
  {
    path: "tests/helpers/ir-runtime-preparation-relocation.ts",
    bytes: 7007,
    sha256: "8adf44a0f063d8b7fb7ed413a37e693c2c3e420b5a52cf6f9161cfceb9a901df",
  },
];
const preparationLayer = {
  index: 8,
  id: "ir-runtime",
  beforeEntries: 19,
  currentEntries: 20,
  beforeMinModules: 19,
  currentMinModules: 20,
  beforeClassified: 19,
  currentClassified: 20,
};
const preparationFile = {
  path: "src/ir/runtime/intrinsic-preparation.ts",
  state: "clean",
  layer: "ir-runtime",
};
const preparationActivation = {
  layer: "ir-runtime",
  entries: ["src/ir/runtime/intrinsic-preparation.ts"],
  minModules: 1,
};
const preparationRawPins = [
  {
    role: "runtime-layer-tail",
    beforeOffset: 6444,
    afterOffset: 6444,
    beforeSha256: "30d6b3d2844adec2c20019162f41b792554a8318ffaf593562dfe64a9b2984db",
    afterSha256: "0fb91016dca1d3ba652a1e1c1622f4a486292e82384be2e46a08a01dfc86d058",
  },
  {
    role: "activation-history-tail",
    beforeOffset: 65731,
    afterOffset: 65782,
    beforeSha256: "0e51cdca0a46e556233d7346ebbcbe9d8c6013789926f4392698734146ecc610",
    afterSha256: "a014b410b320473b7b40780c7b6b88ecd10c39bdbdfaf1fffb89af040add274f",
  },
  {
    role: "files-tail",
    beforeOffset: 566806,
    afterOffset: 566983,
    beforeSha256: "690dc5485a5f7cabaf4cc1cbdca969dfafd96a79976728b6e4a1eacbddfb244c",
    afterSha256: "5b58f77c2d14008613ef192e5ed99eda9e3c4d414e6f8b9cb7f2a9e9e0ccfd4c",
  },
];
interface RuntimePreparationPolicyReceipt {
  schema: string;
  baseMain: string;
  before: Profile;
  current: Profile;
  allowedEdgesSha256: string;
  helperPrefix: { bytes: number; sha256: string };
  numberReceipt: { path: string; bytes: number; sha256: string };
  sourceInputs: { path: string; bytes: number; sha256: string }[];
  runtimeLayer: typeof preparationLayer;
  fileAppend: typeof preparationFile;
  activationAppend: typeof preparationActivation;
  raw: {
    offsetUnit: string;
    spans: {
      role: string;
      beforeOffset: number;
      afterOffset: number;
      before: string;
      after: string;
      beforeSha256: string;
      afterSha256: string;
    }[];
  };
}
function preparationFail(detail: string): never {
  throw new Error("runtime preparation policy evolution: " + detail);
}
/** Bind the root's exact receipt, complete sources and original helper prefix afresh. */
export function authenticateRuntimePreparationPolicyEvolution(
  text = readFileSync(new URL(`../../${runtimePreparationPolicyReceiptPath}`, import.meta.url), "utf8"),
): RuntimePreparationPolicyReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") !== 6239 || sha(text) !== preparationReceiptSha256)
    preparationFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as RuntimePreparationPolicyReceipt;
  if (
    !same(Object.keys(receipt), [
      "schema",
      "baseMain",
      "before",
      "current",
      "allowedEdgesSha256",
      "helperPrefix",
      "numberReceipt",
      "sourceInputs",
      "runtimeLayer",
      "fileAppend",
      "activationAppend",
      "raw",
    ]) ||
    receipt.schema !== "ir-runtime-program-policy-runtime-preparation-v1" ||
    receipt.baseMain !== "3444df3d6d355aa745301ee248ce8f7ea2a80be7" ||
    !same(receipt.before, preparationBeforeProfile) ||
    !same(receipt.current, preparationCurrentProfile) ||
    receipt.allowedEdgesSha256 !== edges ||
    !same(receipt.helperPrefix, preparationPrefix) ||
    !same(receipt.numberReceipt, preparationNumberReceipt) ||
    !same(receipt.sourceInputs, preparationSourceInputs) ||
    !same(receipt.runtimeLayer, preparationLayer) ||
    !same(receipt.fileAppend, preparationFile) ||
    !same(receipt.activationAppend, preparationActivation) ||
    receipt.raw.offsetUnit !== "utf16-code-unit" ||
    receipt.raw.spans.length !== 3
  )
    preparationFail("fixed receipt population mismatch");
  let beforeEnd = -1,
    afterEnd = -1,
    displacement = 0;
  receipt.raw.spans.forEach((span, index) => {
    const { before, after, ...pin } = span;
    if (
      !same(pin, preparationRawPins[index]) ||
      !before ||
      !after ||
      sha(before) !== span.beforeSha256 ||
      sha(after) !== span.afterSha256 ||
      span.beforeOffset <= beforeEnd ||
      span.afterOffset <= afterEnd ||
      span.afterOffset !== span.beforeOffset + displacement
    )
      preparationFail("raw span anchors or order");
    beforeEnd = span.beforeOffset + before.length;
    afterEnd = span.afterOffset + after.length;
    displacement += after.length - before.length;
  });
  for (const pin of [preparationNumberReceipt, ...preparationSourceInputs]) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      preparationFail("full-file input changed: " + pin.path);
  }
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  if (
    helper.length < preparationPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, preparationPrefix.bytes)).digest("hex") !== preparationPrefix.sha256
  )
    preparationFail("original Number helper prefix changed");
  const number = authenticateNumberPrerequisitePolicyEvolution();
  if (!same(number.current, preparationBeforeProfile)) preparationFail("Number predecessor authority mismatch");
  return freeze(receipt);
}
function preparationSemanticProfile(policy: MutableIrRuntimeProgramPolicy, profile: Profile): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256
  )
    preparationFail("complete policy profile mismatch");
}
function proveRuntimePreparationPolicy(
  value: unknown,
  freshlyVerifiedReceipt?: RuntimePreparationPolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; before: MutableIrRuntimeProgramPolicy } {
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateRuntimePreparationPolicyEvolution();
  preparationSemanticProfile(current, receipt.current);
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    digest(current.allowedEdges) !== edges ||
    digest(current.files.slice(0, 1775)) !== preparationBeforeProfile.filesSha256 ||
    digest(current.activationHistory.slice(0, 100)) !== preparationBeforeProfile.activationHistorySha256 ||
    !same(current.files.slice(1775), [preparationFile]) ||
    !same(current.activationHistory.slice(100), [preparationActivation]) ||
    current.files.filter((row) => row.layer === "ir-runtime").length !== 20
  )
    preparationFail("ordered current prefix or suffix mismatch");
  const before = capture(current) as MutableIrRuntimeProgramPolicy;
  const layer = before.layers[8]!;
  if (
    layer.id !== "ir-runtime" ||
    layer.status !== "active" ||
    layer.required !== true ||
    !same(layer.roots, ["src/ir/runtime"]) ||
    layer.entries?.length !== 20 ||
    layer.minModules !== 20 ||
    !same(layer.entries.slice(19), [preparationFile.path])
  )
    preparationFail("exact layer delta mismatch");
  before.files.length = 1775;
  before.activationHistory.length = 100;
  layer.entries.length = 19;
  layer.minModules = 19;
  preparationSemanticProfile(before, receipt.before);
  // This unchanged guard independently proves Number -> WKS -> C1 -> B.
  const verifiedNumber = authenticateNumberPrerequisitePolicy(before);
  const replay = capture(verifiedNumber) as MutableIrRuntimeProgramPolicy;
  replay.files.push(capture(preparationFile) as MutableIrRuntimeProgramPolicy["files"][number]);
  replay.activationHistory.push(
    capture(preparationActivation) as MutableIrRuntimeProgramPolicy["activationHistory"][number],
  );
  replay.layers[8]!.entries!.push(preparationFile.path);
  replay.layers[8]!.minModules = 20;
  preparationSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) preparationFail("complete independent reciprocal replay mismatch");
  return { current, before };
}
/** Fresh detached frozen C2a current; prior policy stages are not accepted here. */
export function authenticateRuntimePreparationPolicy(value: unknown): IrValidationPolicy {
  return freeze(proveRuntimePreparationPolicy(value).current) as IrValidationPolicy;
}
/** Derive a fresh mutable Number predecessor without substituting caller mutations. */
export function beforeRuntimePreparationPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveRuntimePreparationPolicy(value).before;
}
function preparationRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw, "utf8");
  const blob = createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex");
  if (bytes !== profile.source.bytes || sha(raw) !== profile.source.sha256 || blob !== profile.source.gitBlob)
    preparationFail("complete raw source profile mismatch");
}
function applyRuntimePreparationRaw(raw: string, receipt: RuntimePreparationPolicyReceipt, forward: boolean): string {
  preparationRawProfile(raw, forward ? receipt.before : receipt.current);
  let end = 0;
  const pieces: string[] = [];
  for (const span of receipt.raw.spans) {
    const offset = forward ? span.beforeOffset : span.afterOffset;
    const from = forward ? span.before : span.after;
    const to = forward ? span.after : span.before;
    if (
      offset < end ||
      raw.slice(offset, offset + from.length) !== from ||
      raw.indexOf(from) !== offset ||
      raw.lastIndexOf(from) !== offset
    )
      preparationFail("raw fragment missing, duplicated or reordered");
    pieces.push(raw.slice(end, offset), to);
    end = offset + from.length;
  }
  pieces.push(raw.slice(end));
  const output = pieces.join("");
  preparationRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** Exact three-span inverse, semantic agreement and unchanged Number raw proof. */
export function beforeRuntimePreparationPolicySource(raw: string): string {
  if (typeof raw !== "string") preparationFail("raw input must be a primitive string");
  const receipt = authenticateRuntimePreparationPolicyEvolution();
  const before = applyRuntimePreparationRaw(raw, receipt, false);
  const semantic = proveRuntimePreparationPolicy(JSON.parse(raw), receipt);
  const parsedBefore = JSON.parse(before) as MutableIrRuntimeProgramPolicy;
  preparationSemanticProfile(parsedBefore, receipt.before);
  beforeNumberPrerequisitePolicySource(before);
  if (!same(parsedBefore, semantic.before) || applyRuntimePreparationRaw(before, receipt, true) !== raw)
    preparationFail("raw and semantic reciprocal proof disagree");
  return before;
}

// Exact external-main inventory successor; all preceding policy proofs stay unchanged.
export const dynamicCodePolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-dynamic-code.json";
const dynamicReceiptSha256 = "785ef0a740ac17ba636bb75b15cf4eed2266ac4ca0ec588e1eb4cff3642a708f";
const dynamicBeforeProfile = { ...preparationCurrentProfile, allowedEdgesSha256: edges };
const dynamicCurrentProfile = {
  source: {
    bytes: 567908,
    sha256: "5c1c4a16928b421c112eb81180a315d31e116ff442a40375e8c6efb4f220c685",
    gitBlob: "59bdd78821afa174b9273c100a03ec79713249b4",
  },
  dataSha256: "65b382b173594abd15ffdef1a51f96daf017f4d91bd60e47f6308da434ab97b3",
  fileCount: 1778,
  filesSha256: "c306548d8e3f44695a102d10ef8a9503860e39ef6168719f88f874f616563f54",
  activationCount: 101,
  activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
  layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
  allowedEdgesSha256: edges,
};
const dynamicPrefix = {
  path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
  bytes: 53693,
  sha256: "dd8399e266770753fca08984c4ba33cba9e1486d3243571d988416569cbc981a",
};
const dynamicC2aReceipt = {
  path: runtimePreparationPolicyReceiptPath,
  bytes: 6239,
  sha256: "3ebfca62d268ca5bcc8b1c461ef6e71b55bd513a5649bf6bce3fe6ee689032ca",
};
interface DynamicInventoryAddition {
  fileIndex: number;
  beforeIndex: number;
  row: Record<string, string>;
  previous: Record<string, string>;
  next: Record<string, string>;
  sourcePin: { path: string; bytes: number; sha256: string };
  // All offsets explicitly use UTF-16 code units, as in the unchanged C2a raw proof.
  rawSpan: {
    beforeOffset: number;
    afterOffset: number;
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
  };
}
// Literal reviewed authority, never selected or populated from a supplied receipt.
const dynamicAdditions: DynamicInventoryAddition[] = [
  {
    fileIndex: 202,
    beforeIndex: 202,
    row: {
      path: "src/codegen/array-method-arg-order.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "backend-wasmgc",
      owner: "3518-coordinator",
      nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
    },
    previous: {
      path: "src/codegen/array-literal-any-carrier.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "backend-wasmgc",
      owner: "3518-coordinator",
      nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
    },
    next: {
      path: "src/codegen/array-method-host.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "backend-wasmgc",
      owner: "3518-coordinator",
      nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
    },
    sourcePin: {
      path: "src/codegen/array-method-arg-order.ts",
      bytes: 6032,
      sha256: "9a4527970fd0fd12f7f0fc7210e92a63f64872b143c4d5bc5931ea0f8be03f0b",
    },
    rawSpan: {
      beforeOffset: 109891,
      afterOffset: 109891,
      before:
        '    {\n      "path": "src/codegen/array-method-host.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
      after:
        '    {\n      "path": "src/codegen/array-method-arg-order.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array-method-host.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
      beforeSha256: "4cf17df2ddb36ff6c0a270a0c0f4542cccca6806d155c1f8720027ed04030a22",
      afterSha256: "c1c44f40e1731fe2ae2adef0e0ee5d357fcdf8388d9f311bf2ca20982ccf2cb1",
    },
  },
  {
    fileIndex: 1404,
    beforeIndex: 1403,
    row: {
      path: "src/runtime/dynamic-code-policy.ts",
      state: "unmigrated",
      layer: "legacy-host",
    },
    previous: {
      path: "src/runtime/dom-capability-adapter.ts",
      state: "unmigrated",
      layer: "legacy-host",
    },
    next: {
      path: "src/runtime/dynamic-function-import.ts",
      state: "unmigrated",
      layer: "legacy-host",
    },
    sourcePin: {
      path: "src/runtime/dynamic-code-policy.ts",
      bytes: 3863,
      sha256: "afad7fbda3469347671a99f6564de57d45e135c0dee989da5b6f0c1d249ad5af",
    },
    rawSpan: {
      beforeOffset: 488814,
      afterOffset: 489134,
      before:
        '    {\n      "path": "src/runtime/dynamic-function-import.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n',
      after:
        '    {\n      "path": "src/runtime/dynamic-code-policy.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n    {\n      "path": "src/runtime/dynamic-function-import.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n',
      beforeSha256: "8705064bdfb67310ae65cb3203cc2d97840244bcf27f229d71e2f3707e5ed240",
      afterSha256: "254eeb01645faa832948ed42ca47120523a67c845ac23da752f1d129971fced1",
    },
  },
];
interface DynamicCodePolicyReceipt {
  schema: string;
  kind: string;
  checkpoint: string;
  incomingMain: string;
  before: Profile & { allowedEdgesSha256: string };
  current: Profile & { allowedEdgesSha256: string };
  helperPrefix: typeof dynamicPrefix;
  c2aReceipt: typeof dynamicC2aReceipt;
  additions: DynamicInventoryAddition[];
}
function dynamicFail(detail: string): never {
  throw new Error("dynamic code inventory policy evolution: " + detail);
}
/** Authenticate immutable successor authority on every action, never from a cached success. */
export function authenticateDynamicCodePolicyEvolution(
  text = readFileSync(new URL(`../../${dynamicCodePolicyReceiptPath}`, import.meta.url), "utf8"),
): DynamicCodePolicyReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text) !== 6159 || sha(text) !== dynamicReceiptSha256)
    dynamicFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as DynamicCodePolicyReceipt;
  if (
    !same(Object.keys(receipt), [
      "schema",
      "kind",
      "checkpoint",
      "incomingMain",
      "before",
      "current",
      "helperPrefix",
      "c2aReceipt",
      "additions",
    ]) ||
    receipt.schema !== "ir-runtime-program-policy-dynamic-code-v1" ||
    receipt.kind !== "external-main-inventory-successor" ||
    receipt.checkpoint !== "b7699b35670290296b43cd83f8bb0146873e2b36" ||
    receipt.incomingMain !== "9ba8f119a715a4fac719d82014f48baa43f4433d" ||
    !same(receipt.before, dynamicBeforeProfile) ||
    !same(receipt.current, dynamicCurrentProfile) ||
    !same(receipt.helperPrefix, dynamicPrefix) ||
    !same(receipt.c2aReceipt, dynamicC2aReceipt) ||
    !same(receipt.additions, dynamicAdditions) ||
    receipt.additions.length !== 2
  )
    dynamicFail("fixed receipt population mismatch");
  let beforeEnd = -1,
    afterEnd = -1,
    displacement = 0;
  for (const [index, addition] of receipt.additions.entries()) {
    const span = addition.rawSpan;
    if (
      !same(Object.keys(addition), ["fileIndex", "beforeIndex", "row", "previous", "next", "sourcePin", "rawSpan"]) ||
      addition.fileIndex !== addition.beforeIndex + index ||
      !span.before ||
      !span.after ||
      sha(span.before) !== span.beforeSha256 ||
      sha(span.after) !== span.afterSha256 ||
      span.beforeOffset <= beforeEnd ||
      span.afterOffset <= afterEnd ||
      span.afterOffset !== span.beforeOffset + displacement ||
      span.after.length - span.before.length !== (index === 0 ? 320 : 123)
    )
      dynamicFail("fixed addition membership, raw anchors or order mismatch");
    beforeEnd = span.beforeOffset + span.before.length;
    afterEnd = span.afterOffset + span.after.length;
    displacement += span.after.length - span.before.length;
  }
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  if (
    helper.length < dynamicPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, dynamicPrefix.bytes)).digest("hex") !== dynamicPrefix.sha256
  )
    dynamicFail("original helper prefix changed");
  for (const pin of [dynamicC2aReceipt, ...dynamicAdditions.map((addition) => addition.sourcePin)]) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      dynamicFail("full-file input changed: " + pin.path);
  }
  const c2a = authenticateRuntimePreparationPolicyEvolution();
  if (!same(c2a.current, preparationCurrentProfile)) dynamicFail("C2a predecessor authority mismatch");
  return freeze(receipt);
}
function dynamicSemanticProfile(
  policy: MutableIrRuntimeProgramPolicy,
  profile: DynamicCodePolicyReceipt["current"],
): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256 ||
    digest(policy.allowedEdges) !== profile.allowedEdgesSha256
  )
    dynamicFail("complete policy profile mismatch");
}
function proveDynamicCodeInventoryPolicy(
  value: unknown,
  freshlyVerifiedReceipt?: DynamicCodePolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; predecessor: MutableIrRuntimeProgramPolicy } {
  // Descriptor capture must precede authority I/O and any caller property read.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateDynamicCodePolicyEvolution();
  dynamicSemanticProfile(current, receipt.current);
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    current.files.filter((row) => row.layer === "legacy-host").length !== 55
  )
    dynamicFail("fixed inventory population mismatch");
  // Validate both rows against the untouched current array before removing either.
  for (const addition of receipt.additions) {
    if (
      !same(Object.keys(current.files[addition.fileIndex]!), Object.keys(addition.row)) ||
      !same(current.files[addition.fileIndex - 1], addition.previous) ||
      !same(current.files[addition.fileIndex], addition.row) ||
      !same(current.files[addition.fileIndex + 1], addition.next) ||
      current.files.filter((row) => row.path === addition.row.path).length !== 1
    )
      dynamicFail("fixed file row schema/order or neighbors mismatch");
  }
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  for (const addition of [...receipt.additions].reverse()) predecessor.files.splice(addition.fileIndex, 1);
  dynamicSemanticProfile(predecessor, receipt.before);
  // Unchanged C2a proves the entire Number -> WKS -> C1 -> B authority chain.
  const verifiedC2a = authenticateRuntimePreparationPolicy(predecessor);
  const replay = capture(verifiedC2a) as MutableIrRuntimeProgramPolicy;
  // Validate all predecessor neighbors before replay inserts either fixed row.
  for (const addition of receipt.additions)
    if (
      !same(replay.files[addition.beforeIndex - 1], addition.previous) ||
      !same(replay.files[addition.beforeIndex], addition.next)
    )
      dynamicFail("predecessor replay neighbors mismatch");
  for (const [index, addition] of receipt.additions.entries())
    replay.files.splice(
      addition.beforeIndex + index,
      0,
      capture(addition.row) as MutableIrRuntimeProgramPolicy["files"][number],
    );
  dynamicSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) dynamicFail("complete independent reciprocal replay mismatch");
  return { current, predecessor };
}
export function authenticateDynamicCodeInventoryPolicy(value: unknown): IrValidationPolicy {
  return freeze(proveDynamicCodeInventoryPolicy(value).current) as IrValidationPolicy;
}
export function beforeDynamicCodeInventoryPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveDynamicCodeInventoryPolicy(value).predecessor;
}
function dynamicRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw);
  if (
    bytes !== profile.source.bytes ||
    sha(raw) !== profile.source.sha256 ||
    createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex") !== profile.source.gitBlob
  )
    dynamicFail("complete raw source profile mismatch");
}
function applyDynamicCodeInventoryRaw(raw: string, receipt: DynamicCodePolicyReceipt, forward: boolean): string {
  dynamicRawProfile(raw, forward ? receipt.before : receipt.current);
  let end = 0;
  const pieces: string[] = [];
  // Slice the unchanged input in ascending offsets; never apply stale offsets to an edited string.
  for (const addition of receipt.additions) {
    const span = addition.rawSpan,
      at = forward ? span.beforeOffset : span.afterOffset;
    const from = forward ? span.before : span.after,
      to = forward ? span.after : span.before;
    if (
      !from ||
      !to ||
      at < end ||
      Buffer.byteLength(raw.slice(0, at)) !== at ||
      raw.slice(at, at + from.length) !== from ||
      raw.indexOf(from) !== at ||
      raw.lastIndexOf(from) !== at
    )
      dynamicFail("raw fragment missing, duplicated or reordered");
    pieces.push(raw.slice(end, at), to);
    end = at + from.length;
  }
  pieces.push(raw.slice(end));
  const output = pieces.join("");
  dynamicRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** Exact raw insertion inverse, semantic agreement and unchanged full C2a raw chain. */
export function beforeDynamicCodeInventoryPolicySource(raw: string): string {
  if (typeof raw !== "string") dynamicFail("raw input must be a primitive string");
  const receipt = authenticateDynamicCodePolicyEvolution();
  const predecessor = applyDynamicCodeInventoryRaw(raw, receipt, false);
  const semantic = proveDynamicCodeInventoryPolicy(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  dynamicSemanticProfile(parsed, receipt.before);
  beforeRuntimePreparationPolicySource(predecessor);
  if (!same(parsed, semantic.predecessor) || applyDynamicCodeInventoryRaw(predecessor, receipt, true) !== raw)
    dynamicFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

// Exact host-carrier inventory successor over the complete committed two-row proof.
export const hostCarrierPolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-host-carrier.json";
const hostCarrierReceiptSha256 = "30c0912d7868e4da44c083243bb68073e48e70e7eb4b26dbc1b1e73090a5f583";
const hostCarrierBeforeProfile = dynamicCurrentProfile;
const hostCarrierCurrentProfile = {
  source: {
    bytes: 568231,
    sha256: "f3af1f31d813eaef9bd2b955466390616e9549f36e1e7ffffdcead812a611ac3",
    gitBlob: "d61ee74048fa3d16c2986fd3e448d234f4e5594b",
  },
  dataSha256: "89780e5ff7c660518ca92981369dab0e341b77e55f02f8e23d2312b615a97856",
  fileCount: 1779,
  filesSha256: "ced3f8116817be3978f55f438b657ca6b36ec8d50827db92bd7d708c2940853b",
  activationCount: 101,
  activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
  layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
  allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
};
const hostCarrierPrefix = {
  path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
  bytes: 68822,
  sha256: "90dce1410780cf924e78bdd4086be5b1b8c35cdbeb676c46126ac7e0f5f47c5c",
};
const hostCarrierDynamicReceipt = {
  path: "tests/helpers/ir-runtime-program-policy-dynamic-code.json",
  bytes: 6159,
  sha256: "785ef0a740ac17ba636bb75b15cf4eed2266ac4ca0ec588e1eb4cff3642a708f",
};
// Literal fixed authority; never derive membership or expected spans from caller input.
const hostCarrierAddition: DynamicInventoryAddition = {
  fileIndex: 605,
  beforeIndex: 605,
  row: {
    path: "src/codegen/host-carrier-to-primitive.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  previous: {
    path: "src/codegen/host-bridge-exports.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  next: {
    path: "src/codegen/host-fnctor-method-driver.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  sourcePin: {
    path: "src/codegen/host-carrier-to-primitive.ts",
    bytes: 14025,
    sha256: "6f74bd8c4b97789a1dbfe92dc18dd6e71e11860b0e8efd913c523bca032ce504",
  },
  rawSpan: {
    beforeOffset: 239710,
    afterOffset: 239710,
    before:
      '    {\n      "path": "src/codegen/host-fnctor-method-driver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    after:
      '    {\n      "path": "src/codegen/host-carrier-to-primitive.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/host-fnctor-method-driver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    beforeSha256: "3e551509901b9201393becb318e31b2c40e5a8be0d17fa97975556e33dda6bdc",
    afterSha256: "84ec8fc955578c6b77c59141a048c9233b0be087e2e45d3f5a11eb2e275a36db",
  },
};
interface HostCarrierPolicyReceipt {
  schema: string;
  kind: string;
  checkpoint: string;
  incomingMain: string;
  before: Profile & { allowedEdgesSha256: string };
  current: Profile & { allowedEdgesSha256: string };
  helperPrefix: typeof hostCarrierPrefix;
  dynamicReceipt: typeof hostCarrierDynamicReceipt;
  addition: DynamicInventoryAddition;
}
function hostCarrierFail(detail: string): never {
  throw new Error("host carrier inventory policy evolution: " + detail);
}
/** Recheck the exact receipt, complete prior helper and both source/receipt authorities afresh. */
export function authenticateHostCarrierPolicyEvolution(
  text = readFileSync(new URL(`../../${hostCarrierPolicyReceiptPath}`, import.meta.url), "utf8"),
): HostCarrierPolicyReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text) !== 4673 || sha(text) !== hostCarrierReceiptSha256)
    hostCarrierFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as HostCarrierPolicyReceipt;
  if (
    !same(Object.keys(receipt), [
      "schema",
      "kind",
      "checkpoint",
      "incomingMain",
      "before",
      "current",
      "helperPrefix",
      "dynamicReceipt",
      "addition",
    ]) ||
    receipt.schema !== "ir-runtime-program-policy-host-carrier-v1" ||
    receipt.kind !== "external-main-host-carrier-inventory-successor" ||
    receipt.checkpoint !== "f145ce94178071753e418021a586631441d19977" ||
    receipt.incomingMain !== "4509239df1d3454163b4656d39dfe8733714a47b" ||
    !same(receipt.before, hostCarrierBeforeProfile) ||
    !same(receipt.current, hostCarrierCurrentProfile) ||
    !same(receipt.helperPrefix, hostCarrierPrefix) ||
    !same(receipt.dynamicReceipt, hostCarrierDynamicReceipt) ||
    !same(receipt.addition, hostCarrierAddition)
  )
    hostCarrierFail("fixed receipt population mismatch");
  const span = receipt.addition.rawSpan;
  if (
    receipt.addition.fileIndex !== 605 ||
    receipt.addition.beforeIndex !== 605 ||
    !span.before ||
    !span.after ||
    span.beforeOffset !== 239710 ||
    span.afterOffset !== 239710 ||
    sha(span.before) !== span.beforeSha256 ||
    sha(span.after) !== span.afterSha256 ||
    Buffer.byteLength(span.after) - Buffer.byteLength(span.before) !== 323
  )
    hostCarrierFail("fixed row or raw anchor mismatch");
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  if (
    helper.length < hostCarrierPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, hostCarrierPrefix.bytes)).digest("hex") !== hostCarrierPrefix.sha256
  )
    hostCarrierFail("complete predecessor helper prefix changed");
  for (const pin of [hostCarrierDynamicReceipt, hostCarrierAddition.sourcePin]) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      hostCarrierFail("full-file input changed: " + pin.path);
  }
  const predecessor = authenticateDynamicCodePolicyEvolution();
  if (!same(predecessor.current, hostCarrierBeforeProfile)) hostCarrierFail("two-row predecessor authority mismatch");
  return freeze(receipt);
}
function hostCarrierSemanticProfile(
  policy: MutableIrRuntimeProgramPolicy,
  profile: HostCarrierPolicyReceipt["current"],
): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256 ||
    digest(policy.allowedEdges) !== profile.allowedEdgesSha256
  )
    hostCarrierFail("complete policy profile mismatch");
}
function proveHostCarrierInventoryPolicy(
  value: unknown,
  freshlyVerifiedReceipt?: HostCarrierPolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; predecessor: MutableIrRuntimeProgramPolicy } {
  // Descriptor-safe capture precedes authority I/O, caller reads and serialization.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateHostCarrierPolicyEvolution();
  hostCarrierSemanticProfile(current, receipt.current);
  const addition = receipt.addition;
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    !same(Object.keys(current.files[605]!), Object.keys(addition.row)) ||
    !same(current.files[604], addition.previous) ||
    !same(current.files[605], addition.row) ||
    !same(current.files[606], addition.next) ||
    current.files.filter((row) => row.path === addition.row.path).length !== 1
  )
    hostCarrierFail("fixed file row schema/order or neighbors mismatch");
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  predecessor.files.splice(605, 1);
  hostCarrierSemanticProfile(predecessor, receipt.before);
  // Preserve the unchanged two-row -> C2a -> Number -> WKS -> C1 -> B guards.
  const verified = authenticateDynamicCodeInventoryPolicy(predecessor);
  const replay = capture(verified) as MutableIrRuntimeProgramPolicy;
  if (!same(replay.files[604], addition.previous) || !same(replay.files[605], addition.next))
    hostCarrierFail("predecessor replay neighbors mismatch");
  replay.files.splice(605, 0, capture(addition.row) as MutableIrRuntimeProgramPolicy["files"][number]);
  hostCarrierSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) hostCarrierFail("complete independent reciprocal replay mismatch");
  return { current, predecessor };
}
export function authenticateHostCarrierInventoryPolicy(value: unknown): IrValidationPolicy {
  return freeze(proveHostCarrierInventoryPolicy(value).current) as IrValidationPolicy;
}
export function beforeHostCarrierInventoryPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveHostCarrierInventoryPolicy(value).predecessor;
}
function hostCarrierRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw);
  if (
    bytes !== profile.source.bytes ||
    sha(raw) !== profile.source.sha256 ||
    createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex") !== profile.source.gitBlob
  )
    hostCarrierFail("complete raw source profile mismatch");
}
function applyHostCarrierInventoryRaw(raw: string, receipt: HostCarrierPolicyReceipt, forward: boolean): string {
  hostCarrierRawProfile(raw, forward ? receipt.before : receipt.current);
  const span = receipt.addition.rawSpan,
    at = forward ? span.beforeOffset : span.afterOffset;
  const from = forward ? span.before : span.after,
    to = forward ? span.after : span.before;
  // Explicit UTF-16 code-unit offsets; both frozen prefixes also have equal UTF-8 byte counts.
  if (
    !from ||
    !to ||
    Buffer.byteLength(raw.slice(0, at)) !== at ||
    raw.slice(at, at + from.length) !== from ||
    raw.indexOf(from) !== at ||
    raw.lastIndexOf(from) !== at
  )
    hostCarrierFail("raw fragment missing, duplicated or reordered");
  const output = raw.slice(0, at) + to + raw.slice(at + from.length);
  hostCarrierRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** One fixed anchored raw inverse, semantic agreement and unchanged full two-row raw proof. */
export function beforeHostCarrierInventoryPolicySource(raw: string): string {
  if (typeof raw !== "string") hostCarrierFail("raw input must be a primitive string");
  const receipt = authenticateHostCarrierPolicyEvolution();
  const predecessor = applyHostCarrierInventoryRaw(raw, receipt, false);
  const semantic = proveHostCarrierInventoryPolicy(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  hostCarrierSemanticProfile(parsed, receipt.before);
  beforeDynamicCodeInventoryPolicySource(predecessor);
  if (!same(parsed, semantic.predecessor) || applyHostCarrierInventoryRaw(predecessor, receipt, true) !== raw)
    hostCarrierFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

// Exact generator inventory successor over the complete committed host-carrier proof.
export const generatorInventoryPolicyReceiptPath =
  "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json";
const generatorInventoryReceiptSha256 = "5d78bc26201d43531d1a299d42f0ac0ae91a638de71620b94f675378572ccc8c";
const generatorInventoryBeforeProfile = hostCarrierCurrentProfile;
const generatorInventoryCurrentProfile = {
  source: {
    bytes: 568552,
    sha256: "64103a2fb337874fd435614d461bdd0d46cdfdc8a8dbd61603a4c7cbaf3915ff",
    gitBlob: "b9b8b1787cc202906c4e76cebc598cf460a7f0ae",
  },
  dataSha256: "2f35e7e2045dd0d024a13b48c8f413fc7fb9e74c63503fafee4e56993d1da1a6",
  fileCount: 1780,
  filesSha256: "bcd724252a8ff0cdf6799b01f7e0b9eeceead2c6a3e1f49f9625de233b6710e6",
  activationCount: 101,
  activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
  layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
  allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
};
const generatorInventoryPrefix = {
  path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
  bytes: 80917,
  sha256: "2d33fdce750f57d745344fe9c08ecfdd2236bafaca48935bb2376f57255fce8f",
};
const generatorInventoryHostReceipt = {
  path: "tests/helpers/ir-runtime-program-policy-host-carrier.json",
  bytes: 4673,
  sha256: "30c0912d7868e4da44c083243bb68073e48e70e7eb4b26dbc1b1e73090a5f583",
};
// Literal fixed authority, never populated from caller input or a mutable receipt.
const generatorInventoryAddition: DynamicInventoryAddition = {
  fileIndex: 1615,
  beforeIndex: 1615,
  row: {
    path: "src/codegen/generator-eager-refusal.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  previous: {
    path: "src/codegen/fnctor-instance-names.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  next: {
    path: "src/codegen/generator-function-dynamic.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  sourcePin: {
    path: "src/codegen/generator-eager-refusal.ts",
    bytes: 10619,
    sha256: "b44d14368759f11f18b11d75d2a5abb93fc448e0dc5cb7d8501eb0afe6272535",
  },
  rawSpan: {
    beforeOffset: 529175,
    afterOffset: 529175,
    before:
      '    {\n      "path": "src/codegen/generator-function-dynamic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    after:
      '    {\n      "path": "src/codegen/generator-eager-refusal.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/generator-function-dynamic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    beforeSha256: "eaa7278e51f6b98fed1c30f4ba59a0db4736a03c489c860549288c0aa3c1ad1d",
    afterSha256: "44584a36ba540f0e339e6e15bda22765c85db81114312d418cbec9041f086da3",
  },
};
interface GeneratorInventoryPolicyReceipt {
  schema: string;
  kind: string;
  checkpoint: string;
  incomingMain: string;
  before: Profile & { allowedEdgesSha256: string };
  current: Profile & { allowedEdgesSha256: string };
  helperPrefix: typeof generatorInventoryPrefix;
  hostReceipt: typeof generatorInventoryHostReceipt;
  addition: DynamicInventoryAddition;
}
function generatorInventoryFail(detail: string): never {
  throw new Error("generator inventory policy evolution: " + detail);
}
/** Recheck the exact receipt, complete prior helper and both source/receipt authorities afresh. */
export function authenticateGeneratorInventoryPolicyEvolution(
  text = readFileSync(new URL(`../../${generatorInventoryPolicyReceiptPath}`, import.meta.url), "utf8"),
): GeneratorInventoryPolicyReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text) !== 4693 || sha(text) !== generatorInventoryReceiptSha256)
    generatorInventoryFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as GeneratorInventoryPolicyReceipt;
  if (
    !same(Object.keys(receipt), [
      "schema",
      "kind",
      "checkpoint",
      "incomingMain",
      "before",
      "current",
      "helperPrefix",
      "hostReceipt",
      "addition",
    ]) ||
    receipt.schema !== "ir-runtime-program-policy-generator-eager-refusal-v1" ||
    receipt.kind !== "external-main-generator-eager-refusal-inventory-successor" ||
    receipt.checkpoint !== "6ef874eb31bc70b5c138a6ea51824b24488edbcf" ||
    receipt.incomingMain !== "092ae4451c68ba1aa5bd9cdf76933d2e0d857fbf" ||
    !same(receipt.before, generatorInventoryBeforeProfile) ||
    !same(receipt.current, generatorInventoryCurrentProfile) ||
    !same(receipt.helperPrefix, generatorInventoryPrefix) ||
    !same(receipt.hostReceipt, generatorInventoryHostReceipt) ||
    !same(receipt.addition, generatorInventoryAddition)
  )
    generatorInventoryFail("fixed receipt population mismatch");
  const span = receipt.addition.rawSpan;
  if (
    receipt.addition.fileIndex !== 1615 ||
    receipt.addition.beforeIndex !== 1615 ||
    !span.before ||
    !span.after ||
    span.beforeOffset !== 529175 ||
    span.afterOffset !== 529175 ||
    sha(span.before) !== span.beforeSha256 ||
    sha(span.after) !== span.afterSha256 ||
    Buffer.byteLength(span.after) - Buffer.byteLength(span.before) !== 321
  )
    generatorInventoryFail("fixed row or raw anchor mismatch");
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  if (
    helper.length < generatorInventoryPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, generatorInventoryPrefix.bytes)).digest("hex") !==
      generatorInventoryPrefix.sha256
  )
    generatorInventoryFail("complete predecessor helper prefix changed");
  for (const pin of [generatorInventoryHostReceipt, generatorInventoryAddition.sourcePin]) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      generatorInventoryFail("full-file input changed: " + pin.path);
  }
  const predecessor = authenticateHostCarrierPolicyEvolution();
  if (!same(predecessor.current, generatorInventoryBeforeProfile))
    generatorInventoryFail("host predecessor authority mismatch");
  return freeze(receipt);
}
function generatorInventorySemanticProfile(
  policy: MutableIrRuntimeProgramPolicy,
  profile: GeneratorInventoryPolicyReceipt["current"],
): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256 ||
    digest(policy.allowedEdges) !== profile.allowedEdgesSha256
  )
    generatorInventoryFail("complete policy profile mismatch");
}
function proveGeneratorInventoryPolicy(
  value: unknown,
  freshlyVerifiedReceipt?: GeneratorInventoryPolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; predecessor: MutableIrRuntimeProgramPolicy } {
  // Descriptor-safe capture precedes authority I/O, caller reads and serialization.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateGeneratorInventoryPolicyEvolution();
  generatorInventorySemanticProfile(current, receipt.current);
  const addition = receipt.addition;
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    !same(Object.keys(current.files[1615]!), Object.keys(addition.row)) ||
    !same(current.files[1614], addition.previous) ||
    !same(current.files[1615], addition.row) ||
    !same(current.files[1616], addition.next) ||
    current.files.filter((row) => row.path === addition.row.path).length !== 1
  )
    generatorInventoryFail("fixed file row schema/order or neighbors mismatch");
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  predecessor.files.splice(1615, 1);
  generatorInventorySemanticProfile(predecessor, receipt.before);
  // Preserve the unchanged host -> two-row -> C2a -> Number -> WKS -> C1 -> B guards.
  const verified = authenticateHostCarrierInventoryPolicy(predecessor);
  const replay = capture(verified) as MutableIrRuntimeProgramPolicy;
  if (!same(replay.files[1614], addition.previous) || !same(replay.files[1615], addition.next))
    generatorInventoryFail("predecessor replay neighbors mismatch");
  replay.files.splice(1615, 0, capture(addition.row) as MutableIrRuntimeProgramPolicy["files"][number]);
  generatorInventorySemanticProfile(replay, receipt.current);
  if (!same(replay, current)) generatorInventoryFail("complete independent reciprocal replay mismatch");
  return { current, predecessor };
}
export function authenticateGeneratorInventoryPolicy(value: unknown): IrValidationPolicy {
  return freeze(proveGeneratorInventoryPolicy(value).current) as IrValidationPolicy;
}
export function beforeGeneratorInventoryPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveGeneratorInventoryPolicy(value).predecessor;
}
function generatorInventoryRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw);
  if (
    bytes !== profile.source.bytes ||
    sha(raw) !== profile.source.sha256 ||
    createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex") !== profile.source.gitBlob
  )
    generatorInventoryFail("complete raw source profile mismatch");
}
function applyGeneratorInventoryRaw(raw: string, receipt: GeneratorInventoryPolicyReceipt, forward: boolean): string {
  generatorInventoryRawProfile(raw, forward ? receipt.before : receipt.current);
  const span = receipt.addition.rawSpan,
    at = forward ? span.beforeOffset : span.afterOffset;
  const from = forward ? span.before : span.after,
    to = forward ? span.after : span.before;
  // Explicit UTF-16 code-unit offsets; both frozen prefixes also have equal UTF-8 byte counts.
  if (
    !from ||
    !to ||
    Buffer.byteLength(raw.slice(0, at)) !== at ||
    raw.slice(at, at + from.length) !== from ||
    raw.indexOf(from) !== at ||
    raw.lastIndexOf(from) !== at
  )
    generatorInventoryFail("raw fragment missing, duplicated or reordered");
  const output = raw.slice(0, at) + to + raw.slice(at + from.length);
  generatorInventoryRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** One fixed anchored raw inverse, semantic agreement and unchanged full host raw proof. */
export function beforeGeneratorInventoryPolicySource(raw: string): string {
  if (typeof raw !== "string") generatorInventoryFail("raw input must be a primitive string");
  const receipt = authenticateGeneratorInventoryPolicyEvolution();
  const predecessor = applyGeneratorInventoryRaw(raw, receipt, false);
  const semantic = proveGeneratorInventoryPolicy(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  generatorInventorySemanticProfile(parsed, receipt.before);
  beforeHostCarrierInventoryPolicySource(predecessor);
  if (!same(parsed, semantic.predecessor) || applyGeneratorInventoryRaw(predecessor, receipt, true) !== raw)
    generatorInventoryFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}
